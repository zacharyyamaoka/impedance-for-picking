// The conveyor pick as the trajectory controller sees it - a port of sim/reference.py: the Cartesian path (match the belt,
// descend at the descent speed with raised-cosine ramps - slowing to the approach speed over the last 30 mm when asked - dwell,
// lift, slow down), damped-least-squares IK on the NOMINAL model (IK on every 4th fine row, a cubic Hermite between with the
// exact slope J^-1 twist at the knots), qdd by numpy.gradient's differences, and the controller's grid: every host period's
// sample with the nominal mj_inverse as its effort (the Coulomb feed-forward is kept apart: the page switches its keying).
// tests/unit/livepick.faithful.test.ts holds this to the Python's own grid (livepick-reference.json's `paths`).

import type { MainModule, MjModel } from '@mujoco/mujoco'
import { type Mat, linalg, poseError } from '../impedance'
import type { PlanConfig } from './config'
import type { MujocoKinematics } from './kinematics'

export function moveS(plan: PlanConfig): number {
  const distance = plan.approach_m + plan.press_in_m
  return 2 * plan.ramp_s + (distance - plan.descent_speed_m_s * plan.ramp_s) / plan.descent_speed_m_s
}

/** (duration, speed at start, speed at end) per piece; equal speeds = a cruise, unequal = a raised-cosine ramp. */
export function descentSegments(plan: PlanConfig): [number, number, number][] {
  const fast = plan.descent_speed_m_s
  const ramp = plan.ramp_s
  const distance = plan.approach_m + plan.press_in_m
  const slow = plan.contact_speed_m_s
  if (slow == null || Math.abs(slow - fast) < 1e-12)
    return [
      [ramp, 0, fast],
      [(distance - fast * ramp) / fast, fast, fast],
      [ramp, fast, 0],
    ]
  const zone = plan.slow_zone_m + plan.press_in_m
  const fastCruise = distance - 0.5 * fast * ramp - 0.5 * (fast + slow) * ramp - zone
  const slowCruise = zone - 0.5 * slow * ramp
  if (fastCruise < -1e-12 || slowCruise < -1e-12) throw new Error('the slow zone and the ramps do not fit in the descent')
  return [
    [ramp, 0, fast],
    [Math.max(fastCruise, 0) / fast, fast, fast],
    [ramp, fast, slow],
    [Math.max(slowCruise, 0) / slow, slow, slow],
    [ramp, slow, 0],
  ]
}

export function descentS(plan: PlanConfig): number {
  return descentSegments(plan).reduce((sum, [duration]) => sum + duration, 0)
}

export interface Phases {
  descend: number
  dwell: number
  lift: number
  lifted: number
  belt_stop: number
  end: number
  disturbance_on: number
  disturbance_off: number
}

/** Phase boundaries in metric time (0 = the end of the lead hold). */
export function phases(plan: PlanConfig): Phases {
  const descend = plan.belt_ramp_s + plan.hold_before_s
  const dwell = descend + descentS(plan)
  const lift = dwell + plan.dwell_s
  const lifted = lift + moveS(plan)
  const stop = lifted + plan.hold_after_s
  const end = stop + plan.belt_ramp_s + plan.tail_s
  const middle = dwell + 0.5 * plan.dwell_s
  return {
    descend,
    dwell,
    lift,
    lifted,
    belt_stop: stop,
    end,
    disturbance_on: middle - 0.5 * plan.disturbance_s,
    disturbance_off: middle + 0.5 * plan.disturbance_s,
  }
}

/** Raised-cosine velocity 0 -> speed over `duration`: (distance, velocity, acceleration) at `tau` (clamped). */
function ramp(tau: number, duration: number, speed: number): [number, number, number] {
  tau = Math.min(Math.max(tau, 0), duration)
  const phase = (Math.PI * tau) / duration
  return [
    0.5 * speed * (tau - (duration / Math.PI) * Math.sin(phase)),
    0.5 * speed * (1 - Math.cos(phase)),
    ((0.5 * speed * Math.PI) / duration) * Math.sin(phase),
  ]
}

function move(tau: number, plan: PlanConfig): [number, number, number] {
  const total = moveS(plan)
  const rampS = plan.ramp_s
  const speed = plan.descent_speed_m_s
  const distance = plan.approach_m + plan.press_in_m
  if (tau <= 0) return [0, 0, 0]
  if (tau >= total) return [distance, 0, 0]
  if (tau < rampS) return ramp(tau, rampS, speed)
  const cruiseEnd = total - rampS
  const rampDistance = 0.5 * speed * rampS
  if (tau <= cruiseEnd) return [rampDistance + speed * (tau - rampS), speed, 0]
  const [remaining, velocity, acceleration] = ramp(total - tau, rampS, speed)
  return [distance - remaining, velocity, -acceleration]
}

function profile(tau: number, segments: [number, number, number][]): [number, number, number] {
  let travelled = 0
  for (const [duration, start, end] of segments) {
    if (tau <= 0) return [travelled, duration ? start : 0, 0]
    if (tau < duration) {
      const phase = (Math.PI * tau) / duration
      const change = end - start
      return [
        travelled + start * tau + 0.5 * change * (tau - (duration / Math.PI) * Math.sin(phase)),
        start + 0.5 * change * (1 - Math.cos(phase)),
        ((0.5 * change * Math.PI) / duration) * Math.sin(phase),
      ]
    }
    travelled += start * duration + 0.5 * (end - start) * duration
    tau -= duration
  }
  return [travelled, 0, 0]
}

/** The tcp's (position, velocity) at metric time `time` (reference.cartesian_reference; before 0: the start pose). */
export function cartesianReference(plan: PlanConfig, surfaceZ: number, time: number, cache?: { phases: Phases; segments: [number, number, number][] }): { position: number[]; velocity: number[] } {
  const ph = cache?.phases ?? phases(plan)
  const segments = cache?.segments ?? descentSegments(plan)
  const rampS = plan.belt_ramp_s
  const speed = plan.belt_speed_m_s
  const stop = ph.belt_stop
  const xRampDistance = 0.5 * speed * rampS
  const middle = ph.dwell + 0.5 * plan.dwell_s
  const xStart = plan.center_xy[0] - (xRampDistance + speed * (middle - rampS))
  const zStart = surfaceZ + plan.approach_m
  let x: number
  let vx: number
  if (time <= rampS) {
    ;[x, vx] = ramp(time, rampS, speed)
  } else if (time <= stop) {
    x = xRampDistance + speed * (time - rampS)
    vx = speed
  } else {
    const tau = Math.min(time - stop, rampS)
    const [gone, rampV] = ramp(tau, rampS, speed)
    x = xRampDistance + speed * (stop - rampS) + speed * tau - gone
    vx = speed - rampV
    if (time - stop > rampS) vx = 0
  }
  const [down, downV] = profile(time - ph.descend, segments)
  const [up, upV] = move(time - ph.lift, plan)
  return { position: [xStart + x, plan.center_xy[1], zStart - down + up], velocity: [vx, 0, -downV + upV] }
}

export interface IkSettings {
  tolerance: number
  damping: number
  iterations: number
}

/** Damped least squares to the tcp pose, warm-started at `seed`; throws if it does not converge. */
export function solveIk(kinematics: MujocoKinematics, position: number[], rotation: Mat, seed: ArrayLike<number>, settings: IkSettings): number[] {
  let q = Array.from(seed)
  let residual = Infinity
  for (let iteration = 0; iteration < settings.iterations; iteration++) {
    const sample = kinematics.poseJacobian(q)
    const error = poseError(position, rotation, sample.position, sample.rotation)
    residual = Math.sqrt(error.reduce((sum, value) => sum + value * value, 0))
    if (residual < settings.tolerance) return q
    const jacobian = sample.jacobian
    const jjt = linalg.matMul(jacobian, linalg.transpose(jacobian))
    for (let i = 0; i < 6; i++) jjt[i][i] += settings.damping
    const step = linalg.matTVec(jacobian, linalg.solve(jjt, error))
    q = q.map((value, i) => value + step[i])
  }
  throw new Error(`IK did not converge to ${position.map((v) => v.toFixed(4))} (residual ${residual.toExponential(3)})`)
}

/** IK by continuation from the seed's own tcp, so the solution stays on the seed's branch (reference.solve_ik_from). */
export function solveIkFrom(kinematics: MujocoKinematics, position: number[], rotation: Mat, seed: ArrayLike<number>, settings: IkSettings, steps = 40): number[] {
  let q = Array.from(seed)
  const start = kinematics.poseJacobian(q).position
  for (let k = 1; k <= steps; k++) {
    const fraction = k / steps
    q = solveIk(kinematics, start.map((value, i) => value + fraction * (position[i] - value)), rotation, q, settings)
  }
  return q
}

/** The whole pick on the fine grid: t, q, qd, qdd (rows x 6, row-major). */
export interface FinePath {
  t: Float64Array
  q: Float64Array
  qd: Float64Array
  qdd: Float64Array
  rows: number
}

/** reference.ik_arrays: continuation DLS IK at the knots, a cubic Hermite between, qdd by central differences. */
export function ikArrays(kinematics: MujocoKinematics, plan: PlanConfig, surfaceZ: number, seed: number[], rotation: Mat, fineDt: number, settings: IkSettings, stride: number): FinePath {
  const leadRows = Math.round(plan.lead_s / fineDt)
  const ph = phases(plan)
  const rowsAfter = Math.ceil(ph.end / fineDt / 20) * 20 + 1 // a multiple of every host period's stride (1-10 ms)
  const rows = leadRows + rowsAfter
  const t = new Float64Array(rows)
  for (let r = 0; r < rows; r++) t[r] = (r - leadRows) * fineDt
  const cache = { phases: ph, segments: descentSegments(plan) }
  const reference = (r: number) => cartesianReference(plan, surfaceZ, Math.max(t[r], 0), cache)
  let guess = seed.slice()
  const first = reference(0).position
  const start = kinematics.poseJacobian(guess).position
  if (Math.hypot(start[0] - first[0], start[1] - first[1], start[2] - first[2]) > 0.02) guess = solveIkFrom(kinematics, first, rotation, guess, settings)
  const knots: number[] = []
  for (let r = 0; r < rows; r += stride) knots.push(r)
  if (knots[knots.length - 1] !== rows - 1) knots.push(rows - 1)
  const qKnots = knots.map(() => new Array<number>(6).fill(0))
  const qdKnots = knots.map(() => new Array<number>(6).fill(0))
  knots.forEach((row, k) => {
    const { position, velocity } = reference(row)
    guess = solveIk(kinematics, position, rotation, guess, settings)
    qKnots[k] = guess
    if (t[row] > 0) qdKnots[k] = linalg.solve(kinematics.poseJacobian(guess).jacobian, [...velocity, 0, 0, 0])
  })
  // the cubic Hermite (reference._hermite): segment = searchsorted(knot_t, t, 'right') - 1, clipped to the last segment
  const q = new Float64Array(rows * 6)
  const qd = new Float64Array(rows * 6)
  let segment = 0
  for (let r = 0; r < rows; r++) {
    while (segment < knots.length - 2 && t[knots[segment + 1]] <= t[r]) segment++
    const t0 = t[knots[segment]]
    const width = t[knots[segment + 1]] - t0
    const s = (t[r] - t0) / width
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    const d00 = 6 * s2 - 6 * s
    const d10 = 3 * s2 - 4 * s + 1
    const d01 = -6 * s2 + 6 * s
    const d11 = 3 * s2 - 2 * s
    for (let j = 0; j < 6; j++) {
      const p0 = qKnots[segment][j]
      const p1 = qKnots[segment + 1][j]
      const m0 = qdKnots[segment][j] * width
      const m1 = qdKnots[segment + 1][j] * width
      q[r * 6 + j] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
      qd[r * 6 + j] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / width
    }
  }
  // numpy.gradient(qd, dt, axis=0): central differences inside, one-sided first order at the ends
  const qdd = new Float64Array(rows * 6)
  for (let r = 0; r < rows; r++)
    for (let j = 0; j < 6; j++) {
      if (r === 0) qdd[j] = (qd[6 + j] - qd[j]) / fineDt
      else if (r === rows - 1) qdd[r * 6 + j] = (qd[r * 6 + j] - qd[(r - 1) * 6 + j]) / fineDt
      else qdd[r * 6 + j] = (qd[(r + 1) * 6 + j] - qd[(r - 1) * 6 + j]) / (2 * fineDt)
    }
  return { t, q, qd, qdd, rows }
}

/** The controller's grid: every `stride`-th fine row, its effort the NOMINAL mj_inverse; the Coulomb term c tanh(qd / band) apart. */
export interface JointGrid {
  periodS: number
  samples: number
  q: Float64Array
  qd: Float64Array
  inverse: Float64Array
  coulomb: Float64Array
}

export function jointGrid(mujoco: MainModule, nominal: MjModel, qposIndex: number[], dofIndex: number[], path: FinePath, periodS: number, fineDt: number, coulombNm: number[], band: number): JointGrid {
  const stride = Math.round(periodS / fineDt)
  if (Math.abs(periodS / fineDt - stride) > 1e-9) throw new Error(`control period ${periodS} is not a multiple of ${fineDt}`)
  const samples = Math.floor((path.rows - 1) / stride) + 1
  const q = new Float64Array(samples * 6)
  const qd = new Float64Array(samples * 6)
  const inverse = new Float64Array(samples * 6)
  const coulomb = new Float64Array(samples * 6)
  const data = new mujoco.MjData(nominal)
  try {
    for (let k = 0; k < samples; k++) {
      const row = k * stride
      const qpos = data.qpos as Float64Array
      const qvel = data.qvel as Float64Array
      const qacc = data.qacc as Float64Array
      for (let j = 0; j < 6; j++) {
        qpos[qposIndex[j]] = path.q[row * 6 + j]
        qvel[dofIndex[j]] = path.qd[row * 6 + j]
        qacc[dofIndex[j]] = path.qdd[row * 6 + j]
      }
      mujoco.mj_inverse(nominal, data)
      const tau = data.qfrc_inverse as Float64Array
      for (let j = 0; j < 6; j++) {
        q[k * 6 + j] = path.q[row * 6 + j]
        qd[k * 6 + j] = path.qd[row * 6 + j]
        inverse[k * 6 + j] = tau[dofIndex[j]]
        coulomb[k * 6 + j] = coulombNm[j] * Math.tanh(path.qd[row * 6 + j] / band)
      }
    }
  } finally {
    data.delete()
  }
  return { periodS, samples, q, qd, inverse, coulomb }
}
