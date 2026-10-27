/**
 * The ArmLab's closed loop, DOM-free: the arm (model.ts) at 8 kHz, a moteus-like board per joint every physics step, and a
 * host loop at a selectable rate behind a selectable state->torque delay that calls the ported impedance law.
 *
 *   trajectory (the dragged target, rate-limited) --host tick, every 1/rate--> impedanceCommand(...) --+ delay--> boards latch
 *   boards (every physics step): tau = kp_scale kp_base (q_c - q) + kd_scale kd_base (qd_c - qd) + feed-forward, capped,
 *   q_c advancing at the commanded velocity (moteus' control position) -> arm.step
 *
 * The same structure as the Python comparison's sim/loop.py: the host reads the state at t_k, the command latches on the
 * boards at t_k + delay; "stiff" skips the law and sends the trajectory point at scale 1 (today's baseline). What is NOT
 * modelled: encoder quantization, the boards' sensing delay and velocity filter, the torque loop's bandwidth, belt friction.
 */

import {
  type ActuatorCommand,
  type FrictionLatchState,
  type ImpedanceConfig,
  ImpedanceMode,
  type JointServoLimits,
  contactAwareFriction,
  impedanceCommand,
  hostKpLimits,
  hostWnCeiling,
  initialFrictionLatch,
  realizedCartesianStiffness,
  referenceKeyedFriction,
} from '../impedance'
import { Arm2d, type ArmParams, DEFAULT_ARM, type Mat2, type Vec2, inverseKinematics, reachable, solve2 } from './model'

export type LabMode = 'stiff' | ImpedanceMode
export type FrictionFeedforward = 'off' | 'reference' | 'contact_aware'
export type JointFrictionLevel = 'none' | 'light' | 'jmc'

export interface LabSettings {
  mode: LabMode
  /** the requested Cartesian stiffness along world x and z (N/m) */
  kx: number
  kz: number
  /** damping ratio (the law's INERTIA design: D from the arm's own inertia) */
  zeta: number
  hostRateHz: number
  delayMs: number
  frictionFeedforward: FrictionFeedforward
  /** host_kp_max = each joint's host ceiling / 2 (stability.host_kp_limits): the law then softens the spring (s < 1) */
  hostGuard: boolean
  jointFriction: JointFrictionLevel
  /** the trajectory's speed limit (m/s) */
  speedLimit: number
}

export const MODES: { id: LabMode; label: string; board: string; host: string }[] = [
  { id: 'stiff', label: 'Stiff joint PD', board: 'the base gains (today)', host: 'the trajectory only' },
  { id: ImpedanceMode.JOINT, label: 'Joint', board: 'kp, kd = diag(JᵀKJ), diag(JᵀDJ)', host: 'gravity + friction only' },
  { id: ImpedanceMode.JOINT_COUPLED, label: 'Joint coupled', board: 'that diagonal', host: 'the off-diagonal coupling' },
  { id: ImpedanceMode.HOST_SPRING, label: 'Host spring', board: 'the damper (kd only)', host: 'the exact spring' },
  { id: ImpedanceMode.TORQUE, label: 'Torque', board: 'nothing (kp = kd = 0)', host: 'spring and damper' },
]

export const PHYSICS_HZ = 8000
export const SURFACE_Z = -0.3
/** where the tool rests at start: 5 cm above the belt */
export const HOME_TARGET: Vec2 = [0.42, -0.25]
/** the board's base gains: today's tuning, wn 40 rad/s at zeta 1 on the home pose's inertia */
export const BOARD_WN = 40
/** the board-rate ceiling the PID tuner would measure on a QDD moteus (wn ~150 rad/s) */
export const BOARD_WN_MAX = 150
export const FRICTION_LEVELS: Record<JointFrictionLevel, number> = { none: 0, light: 0.027, jmc: 0.23 }
const TARGET_BOUNDS = { xMin: -0.22, xMax: 0.78, zMin: SURFACE_Z - 0.08, zMax: 0.3 }
const REFERENCE_ACCEL = 3 // m/s^2
const REFERENCE_GAIN = 10 // 1/s: the approach slows inside the last ~speed/10 m
const HISTORY_HZ = 250
const HISTORY_S = 8
const RIPPLE_TAU_S = 0.25

export const DEFAULT_SETTINGS: LabSettings = {
  mode: ImpedanceMode.HOST_SPRING,
  kx: 3000,
  kz: 600,
  zeta: 1,
  hostRateHz: 100,
  delayMs: 7,
  frictionFeedforward: 'reference',
  hostGuard: false,
  jointFriction: 'jmc',
  speedLimit: 0.3,
}

export interface ScriptStep {
  at: number
  target?: Vec2
  speed?: number
  push?: { force: Vec2; duration: number }
  mark?: string
  settings?: Partial<LabSettings>
}

export interface Preset {
  id: string
  label: string
  blurb: string
  settings: Partial<LabSettings>
  start: Vec2
  script: ScriptStep[]
}

const BELOW = (depth: number): Vec2 => [0.42, SURFACE_Z - depth]

export const PRESETS: Preset[] = [
  {
    id: 'press',
    label: 'Press into the belt',
    blurb: 'Soft z, stiff x: the target goes 3 cm into the belt and the spring decides the force.',
    settings: { mode: ImpedanceMode.HOST_SPRING, kx: 3000, kz: 600, zeta: 1, speedLimit: 0.1 },
    start: HOME_TARGET,
    script: [{ at: 0.6, target: BELOW(0.03), mark: 'press 3 cm' }],
  },
  {
    id: 'push',
    label: 'Sideways push',
    blurb: 'Pressed on the belt, a 15 N shove along x: stiff x holds, soft z keeps pressing.',
    settings: { mode: ImpedanceMode.HOST_SPRING, kx: 3000, kz: 600, zeta: 1, speedLimit: 0.1 },
    start: BELOW(0.03),
    script: [
      { at: 1.0, push: { force: [15, 0], duration: 0.6 }, mark: '+15 N x' },
      { at: 2.6, push: { force: [-15, 0], duration: 0.6 }, mark: '-15 N x' },
    ],
  },
  {
    id: 'approach',
    label: 'Approach fast vs slow',
    blurb: 'The same press at 0.5 m/s, then at 0.05 m/s: the touch peak follows the speed.',
    settings: { mode: ImpedanceMode.HOST_SPRING, kx: 3000, kz: 600, zeta: 1 },
    start: [0.42, -0.24],
    script: [
      { at: 0.5, speed: 0.5, target: BELOW(0.02), mark: 'fast 0.5 m/s' },
      { at: 1.9, speed: 0.3, target: [0.42, -0.24] },
      { at: 2.8, speed: 0.05, target: BELOW(0.02), mark: 'slow 0.05 m/s' },
    ],
  },
  {
    id: 'unstable',
    label: 'Torque at 100 Hz / 7 ms',
    blurb: 'The whole law on the host, behind the rack\'s delay, at high K: the delayed damper goes unstable.',
    settings: { mode: ImpedanceMode.TORQUE, kx: 5000, kz: 5000, zeta: 1, hostRateHz: 100, delayMs: 7, hostGuard: false },
    start: HOME_TARGET,
    script: [],
  },
]

interface BoardCommand {
  position: number
  velocity: number
  kp: number
  kd: number
  feedforward: number
  /** the feed-forward split: gravity, friction and the law's own (host) part; they sum to `feedforward` */
  gravity: number
  friction: number
  host: number
}

interface Pending {
  applyAt: number
  board: [BoardCommand, BoardCommand]
}

export interface TorqueSplit {
  boardPd: number
  hostFf: number
  frictionFf: number
  gravityFf: number
  total: number
  cap: number
  /** the fraction of this frame's physics steps the joint sat at its cap */
  saturated: number
}

export type CeilingStatus = 'ok' | 'margin' | 'unstable' | 'board'

export interface CeilingReport {
  status: CeilingStatus
  /** the host's ceiling wn (rad/s) at the chosen rate / delay / zeta, or null when the spring lives on the board */
  wnCeiling: number | null
  boardDamping: boolean
  /** each joint's natural frequency of what the host renders, sqrt(K_host,ii / M_ii) */
  jointWn: [number, number]
  /** max jointWn / wnCeiling */
  ratio: number
}

export interface LabSnapshot {
  t: number
  q: Vec2
  qRef: Vec2
  tool: Vec2
  toolRef: Vec2
  target: Vec2
  contactForce: number
  externalForce: Vec2
  torque: [TorqueSplit, TorqueSplit]
  stiffnessScale: number
  clamped: [boolean, boolean]
  requestedK: Mat2 | null
  realizedK: Mat2
  ceiling: CeilingReport
  /** RMS of the tool's velocity error against the reference over ~0.25 s (m/s): the oscillation readout */
  ripple: number
  frictionLatched: boolean
  diverged: number
  settings: LabSettings
}

export class Lab {
  readonly params: ArmParams
  readonly arm: Arm2d
  readonly joints: [JointServoLimits, JointServoLimits]
  settings: LabSettings
  t = 0
  target: Vec2
  refPos: Vec2
  refVel: Vec2 = [0, 0]
  /** contact-force history for the scrolling plot (ring buffer) */
  readonly history = { t: new Float64Array(HISTORY_HZ * HISTORY_S), force: new Float64Array(HISTORY_HZ * HISTORY_S), head: 0, size: 0 }
  marks: { t: number; label: string; peak: number }[] = []
  diverged = 0

  private readonly dt = 1 / PHYSICS_HZ
  private board: [BoardCommand, BoardCommand]
  private queue: Pending[] = []
  private nextHost = 0
  private latch: FrictionLatchState = initialFrictionLatch()
  private push: { force: Vec2; until: number } | null = null
  private script: { start: number; steps: ScriptStep[] } | null = null
  private lastCommand: ActuatorCommand | null = null
  private lastCeiling: CeilingReport = { status: 'board', wnCeiling: null, boardDamping: false, jointWn: [0, 0], ratio: 0 }
  private ceilingCache = new Map<string, number>()
  private rippleSquared = 0
  private historyAccumulator = 0
  private contactForce = 0
  private sums = this.emptySums()

  constructor(settings: Partial<LabSettings> = {}, params: ArmParams = DEFAULT_ARM) {
    this.params = params
    this.settings = { ...DEFAULT_SETTINGS, ...settings }
    this.target = [...HOME_TARGET]
    this.refPos = reachable(params, ...HOME_TARGET)
    const qHome = inverseKinematics(params, ...HOME_TARGET)
    this.arm = new Arm2d(params, { q: qHome, surfaceZ: SURFACE_Z, coulomb: this.coulomb() })
    const mass = this.arm.massMatrix(qHome)
    this.joints = [0, 1].map((i) => ({
      name: i === 0 ? 'shoulder' : 'elbow',
      kpBase: mass[i][i] * BOARD_WN * BOARD_WN,
      kdBase: 2 * mass[i][i] * BOARD_WN,
      kpMax: mass[i][i] * BOARD_WN_MAX * BOARD_WN_MAX,
      torqueCapNm: params.torqueCap[i],
      scaleMax: 2,
      coulombNm: this.coulomb()[i],
    })) as [JointServoLimits, JointServoLimits]
    this.board = this.holdCommand()
  }

  private coulomb(): Vec2 {
    const fraction = FRICTION_LEVELS[this.settings.jointFriction]
    return [fraction * this.params.torqueCap[0], fraction * this.params.torqueCap[1]]
  }

  private emptySums() {
    return { steps: 0, pd: [0, 0], host: [0, 0], friction: [0, 0], gravity: [0, 0], total: [0, 0], saturated: [0, 0] }
  }

  /** a command that holds the current pose (board PD at the base gains, gravity feed-forward) */
  private holdCommand(): [BoardCommand, BoardCommand] {
    const gravity = this.arm.gravityTorque(this.arm.q)
    return [0, 1].map((i) => ({
      position: this.arm.q[i],
      velocity: 0,
      kp: this.joints[i].kpBase,
      kd: this.joints[i].kdBase,
      feedforward: gravity[i],
      gravity: gravity[i],
      friction: 0,
      host: 0,
    })) as [BoardCommand, BoardCommand]
  }

  update(settings: Partial<LabSettings>) {
    const before = this.settings
    this.settings = { ...this.settings, ...settings }
    if (settings.jointFriction && settings.jointFriction !== before.jointFriction) {
      this.arm.coulomb = this.coulomb()
      this.joints.forEach((joint, i) => (joint.coulombNm = this.arm.coulomb[i]))
    }
    if (settings.hostRateHz && settings.hostRateHz !== before.hostRateHz) this.nextHost = this.t
    if (settings.mode && settings.mode !== before.mode) this.latch = initialFrictionLatch()
  }

  setTarget(x: number, z: number) {
    this.target = [Math.min(TARGET_BOUNDS.xMax, Math.max(TARGET_BOUNDS.xMin, x)), Math.min(TARGET_BOUNDS.zMax, Math.max(TARGET_BOUNDS.zMin, z))]
  }

  /** Put the arm back at rest on the reference's pose (after an instability, or for a preset). */
  reset(at?: Vec2) {
    if (at) this.setTarget(...at)
    // WHY start the tool ON the surface when the target is inside the belt: placing it 3 cm deep is a 3 kN contact spike
    const start = reachable(this.params, this.target[0], Math.max(this.target[1], SURFACE_Z + 0.001))
    this.refPos = start
    this.refVel = [0, 0]
    this.arm.q = inverseKinematics(this.params, ...start)
    this.arm.v = [0, 0]
    this.queue = []
    this.board = this.holdCommand()
    this.latch = initialFrictionLatch()
    this.push = null
    this.rippleSquared = 0
    this.nextHost = this.t
  }

  /** Apply a preset: its settings, a fresh start at its pose, then its script. */
  runPreset(preset: Preset) {
    this.update(preset.settings)
    if (preset.settings.speedLimit === undefined) this.settings.speedLimit = DEFAULT_SETTINGS.speedLimit
    this.reset(preset.start)
    this.marks = []
    this.history.size = 0
    this.history.head = 0
    this.script = { start: this.t, steps: preset.script.map((step) => ({ ...step })) }
  }

  /** Drop a preset's remaining steps (the user took the target). */
  cancelScript() {
    this.script = null
  }

  pushTool(force: Vec2, duration: number) {
    this.push = { force, until: this.t + duration }
  }

  /** Run the physics for `seconds` of simulated time (whole 1/8000 s steps). */
  advance(seconds: number) {
    const steps = Math.max(0, Math.round(seconds / this.dt))
    for (let i = 0; i < steps; i++) this.physicsStep()
  }

  private runScript() {
    if (!this.script) return
    const elapsed = this.t - this.script.start
    while (this.script.steps.length && this.script.steps[0].at <= elapsed + 1e-9) {
      const step = this.script.steps.shift()!
      if (step.settings) this.update(step.settings)
      if (step.speed !== undefined) this.settings.speedLimit = step.speed
      if (step.target) this.setTarget(...step.target)
      if (step.push) this.pushTool(step.push.force, step.push.duration)
      if (step.mark) this.marks.push({ t: this.t, label: step.mark, peak: 0 })
    }
    if (!this.script.steps.length) this.script = null
  }

  private updateReference() {
    const goal = reachable(this.params, ...this.target)
    const dx = goal[0] - this.refPos[0]
    const dz = goal[1] - this.refPos[1]
    const distance = Math.hypot(dx, dz)
    const speed = distance > 1e-9 ? Math.min(this.settings.speedLimit, Math.sqrt(2 * REFERENCE_ACCEL * 0.8 * distance), REFERENCE_GAIN * distance) : 0
    const wanted: Vec2 = distance > 1e-9 ? [(dx / distance) * speed, (dz / distance) * speed] : [0, 0]
    let ax = wanted[0] - this.refVel[0]
    let az = wanted[1] - this.refVel[1]
    const change = Math.hypot(ax, az)
    const limit = REFERENCE_ACCEL * this.dt
    if (change > limit) {
      ax *= limit / change
      az *= limit / change
    }
    this.refVel = [this.refVel[0] + ax, this.refVel[1] + az]
    this.refPos = [this.refPos[0] + this.refVel[0] * this.dt, this.refPos[1] + this.refVel[1] * this.dt]
  }

  private ceilingWn(boardDamping: boolean): number {
    const s = this.settings
    const key = `${s.hostRateHz}|${s.delayMs}|${s.zeta}|${boardDamping}`
    let value = this.ceilingCache.get(key)
    if (value === undefined) {
      value = hostWnCeiling(1 / s.hostRateHz, s.delayMs / 1000, s.zeta, boardDamping)
      this.ceilingCache.set(key, value)
    }
    return value
  }

  /** One host tick at this.t: sample the state, run the trajectory point through the law, queue the command. */
  private hostTick() {
    const s = this.settings
    const arm = this.arm
    const q: Vec2 = [...arm.q]
    const v: Vec2 = [...arm.v]
    const qRef = inverseKinematics(this.params, ...this.refPos)
    const jacobianRef = arm.jacobian(qRef)
    const det = jacobianRef[0][0] * jacobianRef[1][1] - jacobianRef[0][1] * jacobianRef[1][0]
    const qdRef: Vec2 = Math.abs(det) > 1e-4 ? solve2(jacobianRef, this.refVel) : [0, 0]
    const gravity = arm.gravityTorque(qRef)
    const massMeasured = arm.massMatrix(q)
    const atReference = { position: arm.tool(qRef), jacobian: jacobianRef as number[][], massMatrix: arm.massMatrix(qRef) as number[][] }
    const atMeasured = { position: arm.tool(q), jacobian: arm.jacobian(q) as number[][], massMatrix: massMeasured as number[][] }
    const period = 1 / s.hostRateHz
    const delay = s.delayMs / 1000
    const hostSpring = s.mode === ImpedanceMode.HOST_SPRING
    const config: ImpedanceConfig = {
      mode: s.mode === 'stiff' ? ImpedanceMode.JOINT : s.mode,
      impedance: { stiffness: [s.kx, s.kz], dampingRatio: s.zeta },
      joints: this.joints,
      host: { periodS: period, delayS: delay },
      dampingDesign: 'inertia',
      hostKpMax: s.hostGuard ? hostKpLimits([massMeasured[0][0], massMeasured[1][1]], period, delay, s.zeta, hostSpring) : null,
      frictionCompensation: s.frictionFeedforward === 'contact_aware' ? 'contact_aware' : 'reference',
    }
    let friction: Vec2 = [0, 0]
    const coulomb = this.joints.map((joint) => joint.coulombNm ?? 0)
    if (s.frictionFeedforward === 'reference') friction = referenceKeyedFriction(coulomb, qdRef) as Vec2
    else if (s.frictionFeedforward === 'contact_aware') {
      const [torque, next] = contactAwareFriction(config, { positions: qRef, velocities: qdRef }, { positions: q, velocities: v }, atReference, atMeasured, this.latch)
      friction = torque as Vec2
      this.latch = next
    }
    const effort: Vec2 = [gravity[0] + friction[0], gravity[1] + friction[1]]
    const caps = this.params.torqueCap
    let board: [BoardCommand, BoardCommand]
    if (s.mode === 'stiff') {
      board = [0, 1].map((i) => {
        const feedforward = Math.max(-caps[i], Math.min(caps[i], effort[i]))
        return { position: qRef[i], velocity: qdRef[i], kp: this.joints[i].kpBase, kd: this.joints[i].kdBase, feedforward, gravity: gravity[i], friction: friction[i], host: feedforward - effort[i] }
      }) as [BoardCommand, BoardCommand]
      this.lastCommand = null
      const realized = realizedCartesianStiffness([[this.joints[0].kpBase, 0], [0, this.joints[1].kpBase]], atMeasured.jacobian)
      this.realizedK = realized as Mat2
      this.lastCeiling = { status: 'board', wnCeiling: null, boardDamping: false, jointWn: [0, 0], ratio: 0 }
    } else {
      const command = impedanceCommand(config, { positions: qRef, velocities: qdRef, effort }, { positions: q, velocities: v }, atReference, atMeasured)
      this.lastCommand = command
      board = [0, 1].map((i) => ({
        position: command.position[i],
        velocity: command.velocity[i],
        kp: command.kpScale[i] * this.joints[i].kpBase,
        kd: command.kdScale[i] * this.joints[i].kdBase,
        feedforward: command.feedforwardTorque[i],
        gravity: gravity[i],
        friction: friction[i],
        host: command.feedforwardTorque[i] - gravity[i] - friction[i],
      })) as [BoardCommand, BoardCommand]
      this.realizedK = realizedCartesianStiffness(command.renderedJointStiffness, atMeasured.jacobian) as Mat2
      this.lastCeiling = this.ceilingReport(command, massMeasured)
    }
    this.queue.push({ applyAt: this.t + delay, board })
  }

  private realizedK: Mat2 = [
    [0, 0],
    [0, 0],
  ]

  /** How close what the HOST renders is to the host loop's stability ceiling (stability.host_wn_ceiling). */
  private ceilingReport(command: ActuatorCommand, mass: Mat2): CeilingReport {
    const mode = this.settings.mode
    if (mode === ImpedanceMode.JOINT) return { status: 'board', wnCeiling: null, boardDamping: false, jointWn: [0, 0], ratio: 0 }
    const boardDamping = mode === ImpedanceMode.HOST_SPRING
    const wnCeiling = this.ceilingWn(boardDamping)
    const k = command.renderedJointStiffness
    // TORQUE / HOST_SPRING: the host renders the whole joint spring; JOINT_COUPLED only the off-diagonal coupling (its row sum)
    const hostStiffness = mode === ImpedanceMode.JOINT_COUPLED ? [Math.abs(k[0][1]), Math.abs(k[1][0])] : [k[0][0], k[1][1]]
    const jointWn: Vec2 = [Math.sqrt(Math.max(hostStiffness[0], 0) / mass[0][0]), Math.sqrt(Math.max(hostStiffness[1], 0) / mass[1][1])]
    const ratio = Math.max(jointWn[0], jointWn[1]) / wnCeiling
    const status: CeilingStatus = ratio >= 1 ? 'unstable' : ratio >= Math.SQRT1_2 ? 'margin' : 'ok'
    return { status, wnCeiling, boardDamping, jointWn, ratio }
  }

  private physicsStep() {
    this.runScript()
    this.updateReference()
    if (this.t >= this.nextHost - 1e-9) {
      this.hostTick()
      this.nextHost += 1 / this.settings.hostRateHz
      if (this.nextHost < this.t) this.nextHost = this.t + 1 / this.settings.hostRateHz
    }
    while (this.queue.length && this.queue[0].applyAt <= this.t + 1e-9) this.board = this.queue.shift()!.board
    const arm = this.arm
    const caps = this.params.torqueCap
    const tau: Vec2 = [0, 0]
    const sums = this.sums
    for (let i = 0; i < 2; i++) {
      const command = this.board[i]
      command.position += command.velocity * this.dt // moteus: the control position integrates the commanded velocity
      const pd = command.kp * (command.position - arm.q[i]) + command.kd * (command.velocity - arm.v[i])
      const raw = pd + command.feedforward
      tau[i] = Math.max(-caps[i], Math.min(caps[i], raw))
      sums.pd[i] += pd
      sums.host[i] += command.host
      sums.friction[i] += command.friction
      sums.gravity[i] += command.gravity
      sums.total[i] += tau[i]
      if (Math.abs(raw) >= caps[i]) sums.saturated[i] += 1
    }
    sums.steps += 1
    let external: Vec2 = [0, 0]
    if (this.push) {
      if (this.t < this.push.until) external = this.push.force
      else this.push = null
    }
    this.externalForce = external
    const result = arm.step(this.dt, tau, external)
    this.contactForce = result.contactForce
    this.t += this.dt
    if (!Number.isFinite(arm.q[0] + arm.q[1] + arm.v[0] + arm.v[1]) || Math.abs(arm.v[0]) + Math.abs(arm.v[1]) > 400) {
      this.diverged += 1
      this.reset()
      return
    }
    const toolVelocity = arm.toolVelocity()
    const error = (toolVelocity[0] - this.refVel[0]) ** 2 + (toolVelocity[1] - this.refVel[1]) ** 2
    this.rippleSquared += (this.dt / RIPPLE_TAU_S) * (error - this.rippleSquared)
    this.historyAccumulator += this.dt * HISTORY_HZ
    if (this.historyAccumulator >= 1) {
      this.historyAccumulator -= 1
      const h = this.history
      h.t[h.head] = this.t
      h.force[h.head] = this.contactForce
      h.head = (h.head + 1) % h.t.length
      h.size = Math.min(h.size + 1, h.t.length)
    }
    const mark = this.marks[this.marks.length - 1]
    if (mark && this.t - mark.t < 1.3) mark.peak = Math.max(mark.peak, this.contactForce)
  }

  private externalForce: Vec2 = [0, 0]

  /** The state for drawing; the torque split is averaged over the steps since the last snapshot. */
  snapshot(): LabSnapshot {
    const arm = this.arm
    const sums = this.sums
    const n = Math.max(1, sums.steps)
    const torque = [0, 1].map((i) => ({
      boardPd: sums.pd[i] / n,
      hostFf: sums.host[i] / n,
      frictionFf: sums.friction[i] / n,
      gravityFf: sums.gravity[i] / n,
      total: sums.total[i] / n,
      cap: this.params.torqueCap[i],
      saturated: sums.saturated[i] / n,
    })) as [TorqueSplit, TorqueSplit]
    if (sums.steps) this.sums = this.emptySums()
    const qRef = inverseKinematics(this.params, ...this.refPos)
    const command = this.lastCommand
    const s = this.settings
    return {
      t: this.t,
      q: [...arm.q],
      qRef,
      tool: arm.tool(),
      toolRef: [...this.refPos],
      target: [...this.target],
      contactForce: this.contactForce,
      externalForce: [...this.externalForce],
      torque,
      stiffnessScale: command ? command.stiffnessScale : 1,
      clamped: command ? [command.clamped[0], command.clamped[1]] : [false, false],
      requestedK: s.mode === 'stiff' ? null : [[s.kx, 0], [0, s.kz]],
      realizedK: this.realizedK,
      ceiling: this.lastCeiling,
      ripple: Math.sqrt(this.rippleSquared),
      frictionLatched: this.latch.latched,
      diverged: this.diverged,
      settings: { ...s },
    }
  }
}
