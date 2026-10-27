// The live pick: sim/loop.py's cascade on the MuJoCo WASM bindings, tick for tick. No DOM: the worker drives it in the browser and
// tests/unit/livepick.faithful.test.ts drives it in Node against the Python's reference runs.
//
// Board (each joint, every physics tick, 4 kHz): ArmSim's sensing - the true position delayed by measurement_delay_s and quantized
// to the encoder, the true velocity through a first-order velocity_filter_hz filter - then moteus' controller_tick on the latched
// command (kp, kd, the control position integrating the commanded velocity, the feed-forward), clamped to the cap, then a
// first-order torque_bandwidth_hz lag.
// Host (every 1 / host rate): the trajectory controller's next sample, `impedanceCommand` (lib/impedance, held to the Python by
// golden vectors) with kinematics from the NOMINAL model; the command LATCHES on the boards host delay later. "stiff" skips the
// law: the sample goes to the boards at scale 1. WHY the order inside a tick (host sample, latch, board, step) is the Python's: the
// host builds its command from the sensing of the tick before - the 7 ms is the delay AFTER that.

import type { MainModule, MjData, MjModel } from '@mujoco/mujoco'
import {
  type ActuatorCommand,
  DampingDesign,
  type FrictionLatchState,
  type ImpedanceConfig,
  ImpedanceMode,
  type JointServoLimits,
  type KinematicsSample,
  contactAwareFriction,
  hostKpLimits,
  impedanceCommand,
  initialFrictionLatch,
} from '../impedance'
import { type LiveConfig, type LiveParams, type SceneParams, planFor } from './config'
import { MujocoKinematics } from './kinematics'
import { type FinePath, type JointGrid, type Phases, cartesianReference, descentSegments, ikArrays, jointGrid, phases } from './path'

const TAU = 2 * Math.PI
const MODES: Record<string, ImpedanceMode> = {
  torque: ImpedanceMode.TORQUE,
  joint: ImpedanceMode.JOINT,
  joint_coupled: ImpedanceMode.JOINT_COUPLED,
  host_spring: ImpedanceMode.HOST_SPRING,
}

/** The XML text of the scene's models, keyed by the config's model paths (e.g. "models/pick_live_true.xml"). */
export type ModelTexts = Record<string, string>

export interface Command {
  position: number[]
  velocity: number[]
  kp: number[]
  kd: number[]
  ff: number[]
}

export interface PickMetrics {
  firstTouchS: number | null
  impactPeakN: number
  impactPeakS: number | null
  dwellMeanN: number | null
  dwellMaxN: number | null
  maxFzN: number
  saturation: number
  diverged: boolean
  reason: string
  stiffnessScaleMin: number
}

/** A run's shared, reusable pieces for one scene: the compiled models, the path and the controller grids. */
interface Rig {
  scene: SceneParams
  trueModel: MjModel
  nominal: MjModel
  kinematics: MujocoKinematics
  path: FinePath
  grids: Map<number, JointGrid>
  qpos: number[]
  dofs: number[]
  tipBody: number
  tipGeom: number
  beltBody: number
  beltQpos: number
  beltDof: number
  compQpos: number
  tcpSite: number
  massAtPick: number[]
}

export class PickSim {
  readonly mujoco: MainModule
  readonly config: LiveConfig
  private readonly texts: ModelTexts
  private rig: Rig | null = null
  data: MjData | null = null

  live: LiveParams
  scene: SceneParams
  plan: ReturnType<typeof planFor>
  phases!: Phases
  private segments!: [number, number, number][]

  // timing
  readonly dt: number
  tick = 0
  totalTicks = 0
  hostTicks = 40
  delayTicks = 28
  // the trajectory controller: the next sample it hands out (it holds the last one at the end)
  private sampleIndex = 0
  private grid!: JointGrid
  // per joint state (loop.simulate's lists)
  private q0: number[] = []
  qTrue: number[] = []
  qdTrue: number[] = []
  qSeen: number[] = []
  qdSeen: number[] = []
  private qdFiltered: number[] = []
  tauApplied: number[] = []
  tauRequest: number[] = []
  /** the board's PD part of the last request (-(kp e + kd e')), before the clamp */
  boardPd: number[] = []
  private controlQ: number[] = []
  private controlQd: number[] = []
  latched!: Command
  private pending: { at: number; command: Command }[] = []
  private history: number[][] = []
  private historySize = 8
  private frictionState: FrictionLatchState = initialFrictionLatch()
  // per joint constants
  private caps: number[] = []
  private lagAlpha: number[] = []
  private filterAlpha: number[] = []
  private senseDelay: number[] = []
  private quantum: number[] = []
  // what the run logged
  fz!: Float64Array
  private saturated = 0
  private steps = 0
  contactSeen = false
  firstTouchTick = -1
  diverged = false
  reason = 'complete'
  done = false
  stiffnessScale = 1
  stiffnessScaleMinDwell = Infinity
  clamped: boolean[] = []
  /** the reference tcp of the last host command (the ghost on the page) */
  referenceTcp: number[] = [0, 0, 0]
  private impedance: ImpedanceConfig | null = null
  private limits: JointServoLimits[] = []
  private needsMeasured = false
  private contactAware = false
  private efcContact = 0
  private efcFrictionDof = 1
  /** recent board samples at the cap (the page's stability badge): one entry per physics tick, last 0.25 s */
  private recentSaturation: Uint8Array
  private recentIndex = 0

  constructor(mujoco: MainModule, config: LiveConfig, texts: ModelTexts, scene: SceneParams, live: LiveParams) {
    this.mujoco = mujoco
    this.config = config
    this.texts = texts
    this.scene = scene
    this.live = live
    this.dt = 1 / config.loop_hz
    this.plan = planFor(config.plan, scene.approachMS)
    this.efcContact = mujoco.mjtConstraint.mjCNSTR_CONTACT_ELLIPTIC.value
    this.efcFrictionDof = mujoco.mjtConstraint.mjCNSTR_FRICTION_DOF.value
    this.recentSaturation = new Uint8Array(Math.round(0.25 * config.loop_hz))
    this.loadScene(scene)
    this.reset()
  }

  // ------------------------------------------------------------------------------------------------------------------ the scene

  /** Compile the TRUE and NOMINAL models for `scene`, apply scene.build_scene's post-compile edits, build the path and grids. */
  loadScene(scene: SceneParams) {
    const { mujoco, config } = this
    this.disposeRig()
    this.scene = { ...scene }
    this.plan = planFor(config.plan, scene.approachMS)
    this.phases = phases(this.plan)
    this.segments = descentSegments(this.plan)
    const build = config.builds[scene.build]
    const trueModel = mujoco.MjModel.from_xml_string(this.texts[scene.compensator ? build.models.true_comp : build.models.true])
    const nominal = mujoco.MjModel.from_xml_string(this.texts[build.models.nominal])
    const kinematics = new MujocoKinematics(mujoco, nominal, config.sites.tcp, config.joints)
    const data = new mujoco.MjData(trueModel)
    const id = (kind: number, name: string) => mujoco.mj_name2id(trueModel, kind, name)
    const JOINT = mujoco.mjtObj.mjOBJ_JOINT.value
    const BODY = mujoco.mjtObj.mjOBJ_BODY.value
    const GEOM = mujoco.mjtObj.mjOBJ_GEOM.value
    const SITE = mujoco.mjtObj.mjOBJ_SITE.value
    const jointIds = config.joints.map((name) => id(JOINT, name))
    const qposadr = trueModel.jnt_qposadr as Int32Array
    const dofadr = trueModel.jnt_dofadr as Int32Array
    const qpos = jointIds.map((joint) => qposadr[joint])
    const dofs = jointIds.map((joint) => dofadr[joint])
    const beltJoint = id(JOINT, config.sites.belt_joint)
    const compJoint = id(JOINT, config.sites.compensator_joint)
    // scene.build_scene: the truth's armature (or the build's), dry friction (it sticks: stiff friction solref + noslip), viscous damping
    const armature = trueModel.dof_armature as Float64Array
    const frictionloss = trueModel.dof_frictionloss as Float64Array
    const damping = trueModel.dof_damping as Float64Array
    const dofSolref = trueModel.dof_solref as Float64Array
    dofs.forEach((dof, i) => {
      armature[dof] = build.armature_true[i]
      frictionloss[dof] = build.coulomb_nm[i]
      damping[dof] = build.viscous_nm_s_rad[i]
      dofSolref[2 * dof] = config.friction_solref[0]
      dofSolref[2 * dof + 1] = config.friction_solref[1]
    })
    const nominalArmature = nominal.dof_armature as Float64Array
    kinematics.dofIndex.forEach((dof, i) => (nominalArmature[dof] = build.armature_nominal[i]))
    // the calibrated contact (scene.calibrate_contact's solref for this object) and the TRUE surface, delta above the believed one
    const tipGeom = id(GEOM, config.sites.tip_geom)
    const solref = build.calibration[scene.compensator ? 'comp' : 'bare'].solref[scene.object]
    const geomSolref = trueModel.geom_solref as Float64Array
    geomSolref[2 * tipGeom] = solref[0]
    geomSolref[2 * tipGeom + 1] = solref[1]
    const beltBody = id(BODY, config.sites.belt_body)
    const bodyPos = trueModel.body_pos as Float64Array
    bodyPos[3 * beltBody + 2] = config.belt.surface_z + scene.surfaceOffsetM - config.belt.half_size[2]
    // the path (IK on the nominal kinematics) and, lazily, one controller grid per host rate
    const fineDt = config.path.fine_dt
    const path = ikArrays(
      kinematics,
      this.plan,
      config.belt.surface_z,
      config.home_seed,
      config.path.rotation,
      fineDt,
      { tolerance: config.path.ik_tolerance, damping: config.path.ik_damping, iterations: config.path.ik_iterations },
      config.path.ik_stride,
    )
    const pick = kinematics.sample(build.q_pick)
    this.rig = {
      scene: { ...scene },
      trueModel,
      nominal,
      kinematics,
      path,
      grids: new Map(),
      qpos,
      dofs,
      tipBody: id(BODY, config.sites.tip_body),
      tipGeom,
      beltBody,
      beltQpos: beltJoint >= 0 ? qposadr[beltJoint] : -1,
      beltDof: beltJoint >= 0 ? dofadr[beltJoint] : -1,
      compQpos: compJoint >= 0 ? qposadr[compJoint] : -1,
      tcpSite: id(SITE, config.sites.tcp),
      massAtPick: pick.massMatrix!.map((row, i) => row[i]),
    }
    this.data = data
    // per joint constants (loop.simulate)
    const truths = config.truths
    this.caps = config.torque_cap_nm.slice()
    this.lagAlpha = truths.map((truth) => 1 - Math.exp(-TAU * truth.torque_bandwidth_hz * this.dt))
    this.filterAlpha = truths.map((truth) => 1 - Math.exp(-TAU * truth.velocity_filter_hz * this.dt))
    this.senseDelay = truths.map((truth) => Math.round(truth.measurement_delay_s * config.loop_hz))
    this.quantum = truths.map((truth) => TAU / truth.encoder_counts_per_rev)
    this.historySize = Math.max(...this.senseDelay) + 2
  }

  get model(): MjModel {
    return this.rig!.trueModel
  }

  get indices() {
    const rig = this.rig!
    return { qpos: rig.qpos, dofs: rig.dofs, beltQpos: rig.beltQpos, compQpos: rig.compQpos, tcpSite: rig.tcpSite, tipGeom: rig.tipGeom }
  }

  private gridFor(rateHz: number): JointGrid {
    const rig = this.rig!
    const period = 1 / rateHz
    let grid = rig.grids.get(period)
    if (!grid) {
      const build = this.config.builds[this.scene.build]
      grid = jointGrid(this.mujoco, rig.nominal, rig.kinematics.qposIndex, rig.kinematics.dofIndex, rig.path, period, this.config.path.fine_dt,
        build.coulomb_nm, this.config.path.coulomb_band_rad_s)
      rig.grids.set(period, grid)
    }
    return grid
  }

  // ------------------------------------------------------------------------------------------------------------------ the knobs

  /** The host's view of the live params: the impedance config (null for "stiff") with its ceilings, rebuilt on every change. */
  private applyLive() {
    const { config, live } = this
    const build = config.builds[this.scene.build]
    const zetaKey = `${live.zeta}`
    const limits = build.limits[zetaKey]
    if (!limits) throw new Error(`no board limits for zeta ${live.zeta} (the grid: ${config.zeta_grid})`)
    // run_case: the contact-aware keying takes the Coulomb term out of the trajectory's effort (for every controller)
    this.contactAware = live.friction === 'contact_aware'
    const mode = MODES[live.controller]
    this.limits = limits
    if (!mode) {
      this.impedance = null
      this.needsMeasured = false
      return
    }
    const period = 1 / live.hostRateHz
    let hostKpMax: number[] | null = null
    // tuning.host_ceilings: TORQUE the plain ceiling, HOST_SPRING the board-damped one, on M_ii at the pick pose, / the margin;
    // JOINT none; JOINT_COUPLED none (pick.PickCase.coupled_host_cap is off by default)
    if (live.guard && (mode === ImpedanceMode.TORQUE || mode === ImpedanceMode.HOST_SPRING))
      hostKpMax = hostKpLimits(this.rig!.massAtPick, period, live.hostDelayS, live.zeta, mode === ImpedanceMode.HOST_SPRING, config.host_margin)
    const joints = this.contactAware ? limits.map((joint, i) => ({ ...joint, coulombNm: build.coulomb_nm[i] })) : limits
    const stiffness = [live.kxy, live.kxy, live.kz, ...config.default_stiffness.slice(3)]
    this.impedance = {
      mode,
      impedance: { stiffness, dampingRatio: live.zeta },
      joints,
      host: { periodS: period, delayS: live.hostDelayS },
      dampingDesign: DampingDesign.INERTIA,
      hostKpMax,
      frictionCompensation: this.contactAware ? 'contact_aware' : 'reference',
    }
    this.needsMeasured = mode === ImpedanceMode.TORQUE || mode === ImpedanceMode.HOST_SPRING
  }

  /** Change what the host reads; it takes effect at the next host tick (a new rate re-grids the trajectory controller). */
  setLive(live: LiveParams) {
    const rateChanged = live.hostRateHz !== this.live.hostRateHz
    const frictionChanged = live.friction !== this.live.friction
    this.live = { ...live }
    this.applyLive()
    this.setTiming()
    if (frictionChanged) this.frictionState = initialFrictionLatch()
    if (rateChanged) {
      this.grid = this.gridFor(live.hostRateHz)
      // the next host tick is the next multiple of the new period; its sample is the one for that time
      this.sampleIndex = Math.ceil(this.tick / this.hostTicks)
    }
  }

  private setTiming() {
    const hostTicks = this.config.loop_hz / this.live.hostRateHz
    const delayTicks = this.live.hostDelayS * this.config.loop_hz
    if (Math.abs(hostTicks - Math.round(hostTicks)) > 1e-9 || Math.abs(delayTicks - Math.round(delayTicks)) > 1e-9)
      throw new Error(`host period and delay must be whole physics ticks at ${this.config.loop_hz} Hz`)
    this.hostTicks = Math.round(hostTicks)
    this.delayTicks = Math.round(delayTicks)
  }

  // ------------------------------------------------------------------------------------------------------------------ the run

  /** Back to the start pose (loop.simulate's set-up), with `scene` rebuilt first when it differs. */
  reset(scene?: SceneParams) {
    if (scene && JSON.stringify(scene) !== JSON.stringify(this.scene)) this.loadScene(scene)
    const { mujoco, config } = this
    const rig = this.rig!
    const model = rig.trueModel
    const data = this.data!
    this.applyLive()
    this.setTiming()
    this.grid = this.gridFor(this.live.hostRateHz)
    this.tick = 0
    this.totalTicks = Math.round((this.plan.lead_s + this.phases.end) * config.loop_hz)
    this.sampleIndex = 0
    this.q0 = Array.from(this.grid.q.subarray(0, 6))
    mujoco.mj_resetData(model, data)
    const qpos = data.qpos as Float64Array
    rig.qpos.forEach((adr, i) => (qpos[adr] = this.q0[i]))
    if (rig.beltDof >= 0) {
      ;(data.qvel as Float64Array)[rig.beltDof] = config.belt.speed_m_s
      ;(data.ctrl as Float64Array)[0] = config.belt.speed_m_s
    }
    mujoco.mj_forward(model, data)
    const n = 6
    this.qTrue = this.q0.slice()
    this.qdTrue = new Array(n).fill(0)
    this.qSeen = this.q0.slice()
    this.qdSeen = new Array(n).fill(0)
    this.qdFiltered = new Array(n).fill(0)
    this.tauApplied = new Array(n).fill(0)
    this.tauRequest = new Array(n).fill(0)
    this.boardPd = new Array(n).fill(0)
    this.history = [this.q0.slice()]
    this.pending = []
    this.frictionState = initialFrictionLatch()
    this.fz = new Float64Array(this.totalTicks)
    this.saturated = 0
    this.steps = 0
    this.contactSeen = false
    this.firstTouchTick = -1
    this.diverged = false
    this.reason = 'complete'
    this.done = false
    this.stiffnessScaleMinDwell = Infinity
    this.recentSaturation.fill(0)
    // the arm starts already holding under this controller (no delay on the very first command)
    this.latched = this.hostCommand(0)
    this.controlQ = this.latched.position.slice()
    this.controlQd = this.latched.velocity.slice()
  }

  /** Metric time of physics tick `tick` (0 = the end of the lead hold). */
  timeAt(tick: number): number {
    return tick * this.dt - this.plan.lead_s
  }

  get time(): number {
    return this.timeAt(this.tick)
  }

  private nextSample(): { positions: number[]; velocities: number[]; effort: number[] } {
    const grid = this.grid
    const k = Math.min(this.sampleIndex, grid.samples - 1)
    this.sampleIndex = Math.min(this.sampleIndex + 1, grid.samples)
    const at = k * 6
    const positions = Array.from(grid.q.subarray(at, at + 6))
    const velocities = Array.from(grid.qd.subarray(at, at + 6))
    // the effort: nominal inverse dynamics + the Coulomb feed-forward keyed on the reference velocity (off when contact-aware)
    const effort = Array.from(grid.inverse.subarray(at, at + 6))
    if (!this.contactAware) for (let j = 0; j < 6; j++) effort[j] += grid.coulomb[at + j]
    return { positions, velocities, effort }
  }

  private hostCommand(tick: number): Command {
    const caps = this.caps
    const measured = { positions: this.qSeen.slice(), velocities: this.qdSeen.slice() }
    let point = this.nextSample()
    const config = this.impedance
    const kinematics = this.rig!.kinematics
    let command: Command
    let atReference: KinematicsSample | null = null
    if (!config) {
      command = {
        position: point.positions,
        velocity: point.velocities,
        kp: this.limits.map((joint) => joint.kpBase),
        kd: this.limits.map((joint) => joint.kdBase),
        ff: point.effort.map((value, i) => Math.min(caps[i], Math.max(-caps[i], value))),
      }
      this.stiffnessScale = 1
      this.clamped = point.effort.map((value, i) => Math.abs(value) >= caps[i])
    } else {
      atReference = kinematics.sample(point.positions)
      const atMeasured = this.needsMeasured ? kinematics.sample(measured.positions) : null
      if (this.contactAware) {
        const [friction, state] = contactAwareFriction(config, point, measured, atReference, atMeasured ?? kinematics.sample(measured.positions), this.frictionState)
        this.frictionState = state
        point = { ...point, effort: point.effort.map((value, i) => value + friction[i]) }
      }
      const actuator: ActuatorCommand = impedanceCommand(config, point, measured, atReference, atMeasured)
      command = {
        position: actuator.position,
        velocity: actuator.velocity,
        kp: actuator.kpScale.map((scale, i) => scale * this.limits[i].kpBase),
        kd: actuator.kdScale.map((scale, i) => scale * this.limits[i].kdBase),
        ff: actuator.feedforwardTorque.map((value, i) => Math.min(caps[i], Math.max(-caps[i], value))),
      }
      this.stiffnessScale = actuator.stiffnessScale
      this.clamped = actuator.clamped
    }
    const t = this.timeAt(tick)
    if (t >= this.phases.dwell && t < this.phases.lift) this.stiffnessScaleMinDwell = Math.min(this.stiffnessScaleMinDwell, this.stiffnessScale)
    this.referenceTcp = cartesianReference(this.plan, this.config.belt.surface_z, Math.max(t, 0), { phases: this.phases, segments: this.segments }).position
    return command
  }

  /** One physics tick of loop.simulate. Returns false once the pick is over (complete or diverged). */
  step(): boolean {
    if (this.done) return false
    const { mujoco } = this
    const rig = this.rig!
    const model = rig.trueModel
    const data = this.data!
    const tick = this.tick
    const t = this.timeAt(tick)
    const limit = this.config.diverged
    if (tick >= this.hostTicks && tick % this.hostTicks === 0) {
      this.pending.push({ at: tick + this.delayTicks, command: this.hostCommand(tick) })
      if (this.qdTrue.some((value) => value !== value || Math.abs(value) > limit.speed_rad_s)) return this.finish(`diverged: joint speed passed ${limit.speed_rad_s} rad/s`)
      const tcp = this.tcp()
      const reference = cartesianReference(this.plan, this.config.belt.surface_z, Math.max(t, 0), { phases: this.phases, segments: this.segments }).position
      if (!(Math.hypot(tcp[0] - reference[0], tcp[1] - reference[1], tcp[2] - reference[2]) < limit.tool_error_m))
        return this.finish(`diverged: the tool strayed ${Math.round(1000 * limit.tool_error_m)} mm`)
    }
    while (this.pending.length && this.pending[0].at <= tick) {
      this.latched = this.pending.shift()!.command
      this.controlQ = this.latched.position.slice() // a new command latches the control positions
      this.controlQd = this.latched.velocity.slice()
    }
    this.boardStep(tick)
    const qfrc = data.qfrc_applied as Float64Array
    rig.dofs.forEach((dof, i) => (qfrc[dof] = this.tauApplied[i]))
    this.applyDisturbance(t)
    mujoco.mj_step(model, data)
    const qpos = data.qpos as Float64Array
    const qvel = data.qvel as Float64Array
    this.qTrue = rig.qpos.map((adr) => qpos[adr])
    this.qdTrue = rig.dofs.map((dof) => qvel[dof])
    this.history.push(this.qTrue)
    if (this.history.length > this.historySize) this.history.shift()
    const fz = this.contactForce()
    this.fz[tick] = fz
    if (fz > 0 && !this.contactSeen && t >= 0) {
      this.contactSeen = true
      this.firstTouchTick = tick
    }
    this.tick = tick + 1
    this.steps++
    if (this.tick >= this.totalTicks) return this.finish('complete')
    return true
  }

  private finish(reason: string): false {
    this.done = true
    this.reason = reason
    this.diverged = reason !== 'complete'
    return false
  }

  /** Every joint's board for one physics tick (loop.simulate's board_step). */
  private boardStep(tick: number) {
    const { kp, kd, ff } = this.latched
    const caps = this.caps
    // history holds q after ticks (tick - historySize + 1 .. tick); history[last] is q at the start of this tick
    const newest = this.history.length - 1
    let atCap = 0
    for (let i = 0; i < 6; i++) {
      const delayed = tick - this.senseDelay[i]
      const seen = delayed >= 0 ? this.history[newest - this.senseDelay[i]][i] : this.q0[i]
      const step = this.quantum[i]
      this.qSeen[i] = Math.floor(seen / step + 0.5) * step
      this.qdFiltered[i] += this.filterAlpha[i] * (this.qdTrue[i] - this.qdFiltered[i])
      this.qdSeen[i] = this.qdFiltered[i]
      // servo_sim.controller_tick (ki = 0): the control position integrates the commanded velocity
      this.controlQ[i] += this.controlQd[i] * this.dt
      const error = this.qSeen[i] - this.controlQ[i]
      const errorRate = this.qdSeen[i] - this.controlQd[i]
      const pd = -(kp[i] * error + kd[i] * errorRate)
      let torque = pd + ff[i]
      torque = torque < -caps[i] ? -caps[i] : torque > caps[i] ? caps[i] : torque
      this.boardPd[i] = pd
      this.tauRequest[i] = torque
      if (Math.abs(torque) >= caps[i] * (1 - 1e-9)) {
        this.saturated++
        atCap = 1
      }
      this.tauApplied[i] += this.lagAlpha[i] * (torque - this.tauApplied[i])
    }
    this.recentSaturation[this.recentIndex] = atCap
    this.recentIndex = (this.recentIndex + 1) % this.recentSaturation.length
  }

  /** The plan's side push (pick.run_case's disturbance): a world force at the tcp during the push window. */
  private applyDisturbance(t: number) {
    const rig = this.rig!
    const data = this.data!
    const xfrc = data.xfrc_applied as Float64Array
    const base = 6 * rig.tipBody
    const plan = this.plan
    if (this.phases.disturbance_on <= t && t < this.phases.disturbance_off) {
      const force = [plan.disturbance_n * Math.cos(plan.disturbance_angle_rad), plan.disturbance_n * Math.sin(plan.disturbance_angle_rad), 0]
      const siteXpos = data.site_xpos as Float64Array
      const xipos = data.xipos as Float64Array
      const s = 3 * rig.tcpSite
      const b = 3 * rig.tipBody
      const lever = [siteXpos[s] - xipos[b], siteXpos[s + 1] - xipos[b + 1], siteXpos[s + 2] - xipos[b + 2]]
      xfrc[base] = force[0]
      xfrc[base + 1] = force[1]
      xfrc[base + 2] = force[2]
      xfrc[base + 3] = lever[1] * force[2] - lever[2] * force[1]
      xfrc[base + 4] = lever[2] * force[0] - lever[0] * force[2]
      xfrc[base + 5] = lever[0] * force[1] - lever[1] * force[0]
    } else {
      for (let k = 0; k < 6; k++) xfrc[base + k] = 0
    }
  }

  /** The summed tool-belt normal force. WHY the constraint rows, not data.contact: the bindings copy the contact array on every
   *  read; with an elliptic cone (the scene's) mj_contactForce's normal component IS the contact's first efc row, and the tip and
   *  the belt are the only colliding geoms, so every contact is a tool-belt one. */
  contactForce(): number {
    const data = this.data!
    const nefc = data.nefc
    if (!nefc) return 0
    const types = data.efc_type as Int32Array
    const ids = data.efc_id as Int32Array
    const force = data.efc_force as Float64Array
    let total = 0
    let previous = -1
    for (let row = 0; row < nefc; row++) {
      if (types[row] !== this.efcContact) continue
      if (ids[row] !== previous) total += force[row]
      previous = ids[row]
    }
    return total
  }

  tcp(): number[] {
    const xpos = this.data!.site_xpos as Float64Array
    const s = 3 * this.rig!.tcpSite
    return [xpos[s], xpos[s + 1], xpos[s + 2]]
  }

  /** The fraction of the last 0.25 s of physics ticks with a joint at its torque cap. */
  get recentSaturationFraction(): number {
    let sum = 0
    for (let i = 0; i < this.recentSaturation.length; i++) sum += this.recentSaturation[i]
    return sum / this.recentSaturation.length
  }

  /** pick.score's impact peak and dwell force over what has run so far. */
  metrics(): PickMetrics {
    const dt = this.dt
    const window = Math.round(this.config.metrics.impact_window_s / dt)
    let impactPeak = 0
    let impactPeakTick = -1
    if (this.firstTouchTick >= 0) {
      const end = Math.min(this.tick, this.firstTouchTick + window + 1)
      // pick.score: t in [t_first, t_first + 0.1), compared in time - the same ticks
      for (let k = this.firstTouchTick; k < end; k++)
        if (this.timeAt(k) < this.timeAt(this.firstTouchTick) + this.config.metrics.impact_window_s && this.fz[k] > impactPeak) {
          impactPeak = this.fz[k]
          impactPeakTick = k
        }
    }
    let sum = 0
    let count = 0
    let dwellMax = 0
    let maxFz = 0
    for (let k = 0; k < this.tick; k++) {
      const value = this.fz[k]
      if (value > maxFz) maxFz = value
      const t = this.timeAt(k)
      if (t >= this.phases.dwell && t < this.phases.lift) {
        sum += value
        count++
        if (value > dwellMax) dwellMax = value
      }
    }
    return {
      firstTouchS: this.firstTouchTick >= 0 ? this.timeAt(this.firstTouchTick) : null,
      impactPeakN: impactPeak,
      impactPeakS: impactPeakTick >= 0 ? this.timeAt(impactPeakTick) : null,
      dwellMeanN: count ? sum / count : null,
      dwellMaxN: count ? dwellMax : null,
      maxFzN: maxFz,
      saturation: this.saturated / Math.max(1, this.steps * 6),
      diverged: this.diverged,
      reason: this.reason,
      stiffnessScaleMin: this.stiffnessScaleMinDwell,
    }
  }

  /** The efc_R of the first tool-belt contact row right now (null when apart): the calibration check. */
  contactRegularizer(): number | null {
    const data = this.data!
    const nefc = data.nefc
    if (!nefc) return null
    const types = data.efc_type as Int32Array
    const r = data.efc_R as Float64Array
    for (let row = 0; row < nefc; row++) if (types[row] === this.efcContact) return r[row]
    return null
  }

  private disposeRig() {
    if (!this.rig) return
    this.rig.kinematics.delete()
    this.data?.delete()
    this.rig.trueModel.delete()
    this.rig.nominal.delete()
    this.rig = null
    this.data = null
  }

  dispose() {
    this.disposeRig()
  }
}
