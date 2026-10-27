/**
 * The impedance controller's contracts, ported from `bam_impedance_controller/types.py` (lane
 * `claude/bam-impedance-controller` in ~/bam_ws), generic over the task dimension m and the joint count n.
 *
 * - m = 6: the Python package's own task - (linear xyz, angular xyz), the pose error's angular part a rotation vector, the
 *   impedance axes a 3x3 rotation applied as blockdiag(R, R). This is what the golden vectors pin (n = 5, 6, 7).
 * - m < 6 (2 for the planar arm, 3 for a position-only task): a position task; the error is p_d - p, the axes an m x m
 *   rotation. Its golden vectors are planar cases embedded in the 6-D law (the x and z rows of a 6 x n Jacobian).
 *
 * Units SI: m, rad, N, N.m; translational stiffness N/m, rotational N.m/rad; joint kp N.m/rad, kd N.m.s/rad.
 * Field names follow the Python in camelCase.
 *
 * The four modes (`ImpedanceMode`), where the spring and the damper live:
 * - TORQUE: board PD off; the host sends the whole Cartesian law as torque, at host rate behind the state/torque delay.
 * - JOINT: the board's PD renders diag(J^T K J) / diag(J^T D J); the cross-joint coupling is dropped.
 * - JOINT_COUPLED: that diagonal on the board, the off-diagonal terms as host feed-forward.
 * - HOST_SPRING: the host renders the exact spring, the board the damping (kp_scale 0, kd_scale > 0). WHY: a delayed DAMPER is
 *   what destabilizes a host loop; at 100 Hz / 7 ms the host spring's ceiling rises from wn ~56 to ~234 rad/s.
 */

import type { Mat, Vec } from './linalg'

export const ImpedanceMode = {
  TORQUE: 'torque',
  JOINT: 'joint',
  JOINT_COUPLED: 'joint_coupled',
  HOST_SPRING: 'host_spring',
} as const
export type ImpedanceMode = (typeof ImpedanceMode)[keyof typeof ImpedanceMode]

/** How the Coulomb feed-forward is keyed (`ImpedanceConfig.frictionCompensation`). */
export const FrictionCompensation = {
  REFERENCE: 'reference',
  CONTACT_AWARE: 'contact_aware',
} as const
export type FrictionCompensation = (typeof FrictionCompensation)[keyof typeof FrictionCompensation]

export const DampingDesign = {
  /** D from the arm's own inertia: D = 2 zeta sqrt(Lambda K) (Albu-Schaffer's factorization); needs a mass matrix */
  INERTIA: 'inertia',
  /** D = 2 zeta sqrt(K): franka's cartesian_impedance_example convention, which silently assumes a unit mass per axis */
  UNIT_MASS: 'unit_mass',
} as const
export type DampingDesign = (typeof DampingDesign)[keyof typeof DampingDesign]

export const ORTHONORMAL_TOLERANCE = 1e-6

/**
 * The spring and damper the tool should feel, diagonal in `axes`.
 * `stiffness`: m values. `dampingRatio`: one zeta or m. `axes`: the rotation whose COLUMNS are the directions the diagonal is
 * expressed in (null: the world's axes); 3x3 when m = 6 (applied to the linear and angular blocks), else m x m.
 * `wrenchFf`: a world-frame feed-forward wrench added in every mode. `damping`: absolute damping in `axes`, overriding the design.
 */
export interface TaskImpedance {
  stiffness: Vec
  dampingRatio?: number | Vec
  axes?: Mat | null
  wrenchFf?: Vec
  damping?: Vec | null
}

/**
 * One joint as the impedance layer sees it: the board's configured gains (what a scale multiplies) and its ceilings.
 * `kpMax`: the board-rate stability ceiling the PID tuner measured. `scaleMax`: the largest kp/kd scale the board may be sent.
 * `coulombNm`: the identified kinetic Coulomb friction, read only by the contact-aware friction compensation.
 */
export interface JointServoLimits {
  name: string
  kpBase: number
  kdBase: number
  kpMax: number
  torqueCapNm: number
  kdMax?: number | null
  scaleMax?: number
  coulombNm?: number | null
}

/** The loop the host-side terms run in: its period and the measured state/torque delay (rack: 100 Hz, ~7 ms). */
export interface HostLoop {
  periodS: number
  delayS: number
}

/**
 * Everything the law needs besides the per-tick inputs. The law keeps no state: switch modes by passing a config with a
 * different `mode`; it takes effect on the next tick. `hostKpMax` (per joint, N.m/rad) caps the joint stiffness the HOST
 * loop renders (TORQUE, HOST_SPRING) and the host's coupling (JOINT_COUPLED).
 */
export interface ImpedanceConfig {
  mode: ImpedanceMode
  impedance: TaskImpedance
  joints: JointServoLimits[]
  host?: HostLoop
  dampingDesign?: DampingDesign
  hostKpMax?: Vec | null
  frictionCompensation?: FrictionCompensation
}

/**
 * The arm at one configuration, evaluated by the caller: tool position (3 for m = 6, else m), tool rotation (3x3, m = 6
 * only), the m x n world-frame Jacobian (for m = 6: linear rows, then angular) and, for DampingDesign.INERTIA, the n x n
 * joint-space mass matrix.
 */
export interface KinematicsSample {
  position: Vec
  rotation?: Mat
  jacobian: Mat
  massMatrix?: Mat | null
}

/** What the trajectory controller hands down each tick; `effort` (the model feed-forward) may be null. */
export interface JointReference {
  positions: Vec
  velocities: Vec
  effort?: Vec | null
}

export interface MeasuredState {
  positions: Vec
  velocities: Vec
}

/**
 * One moteus-shaped command per joint: the board runs
 * tau = kpScale kpBase (position - q) + kdScale kdBase (velocity - qd) + feedforwardTorque.
 * `renderedJointStiffness` / `renderedJointDamping`: what the whole command renders around the reference (board diagonal plus
 * host terms). `stiffnessScale` < 1: a ceiling softened the whole spring keeping its shape. `clamped`: each joint that hit a
 * ceiling, a scale limit or its torque cap.
 */
export interface ActuatorCommand {
  position: Vec
  velocity: Vec
  kpScale: Vec
  kdScale: Vec
  feedforwardTorque: Vec
  renderedJointStiffness: Mat
  renderedJointDamping: Mat
  stiffnessScale: number
  clamped: boolean[]
  mode: ImpedanceMode
}

/** The validated, filled-in form of a TaskImpedance (types.py's __post_init__). */
export interface ResolvedImpedance {
  stiffness: Vec
  dampingRatio: Vec
  axes: Mat | null
  wrenchFf: Vec
  damping: Vec | null
}

function finiteVector(values: Vec, length: number, name: string): Vec {
  if (values.length !== length) throw new Error(`${name} must have ${length} values, got ${values.length}`)
  if (!values.every(Number.isFinite)) throw new Error(`${name} must be finite`)
  return values.slice()
}

/** Validate a TaskImpedance for a task of dimension m (types.CartesianImpedance.__post_init__). */
export function resolveImpedance(impedance: TaskImpedance, m: number): ResolvedImpedance {
  const stiffness = finiteVector(impedance.stiffness, m, 'stiffness')
  if (stiffness.some((value) => value < 0)) throw new Error('stiffness must be non-negative')
  const ratio = impedance.dampingRatio ?? 1
  const dampingRatio = typeof ratio === 'number' ? new Array<number>(m).fill(ratio) : finiteVector(ratio, m, 'damping_ratio')
  if (!dampingRatio.every((value) => Number.isFinite(value) && value >= 0)) throw new Error('damping_ratio must be finite and non-negative')
  let axes: Mat | null = null
  if (impedance.axes) {
    const size = m === 6 ? 3 : m
    const matrix = impedance.axes
    if (matrix.length !== size || matrix.some((row) => row.length !== size)) throw new Error(`axes must be ${size}x${size}`)
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++) {
        let product = 0
        for (let k = 0; k < size; k++) product += matrix[k][i] * matrix[k][j]
        if (Math.abs(product - (i === j ? 1 : 0)) > ORTHONORMAL_TOLERANCE + 1e-5 * Math.abs(i === j ? 1 : 0))
          throw new Error('axes must be an orthonormal matrix')
      }
    if (determinant(matrix) < 0) throw new Error('axes must be a rotation (det +1)')
    axes = matrix.map((row) => row.slice())
  }
  const wrenchFf = finiteVector(impedance.wrenchFf ?? new Array<number>(m).fill(0), m, 'wrench_ff')
  let damping: Vec | null = null
  if (impedance.damping) {
    damping = finiteVector(impedance.damping, m, 'damping')
    if (damping.some((value) => value < 0)) throw new Error('damping must be non-negative')
  }
  return { stiffness, dampingRatio, axes, wrenchFf, damping }
}

function determinant(matrix: Mat): number {
  const size = matrix.length
  const a = matrix.map((row) => row.slice())
  let det = 1
  for (let k = 0; k < size; k++) {
    let pivot = k
    for (let i = k + 1; i < size; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i
    if (a[pivot][k] === 0) return 0
    if (pivot !== k) {
      ;[a[k], a[pivot]] = [a[pivot], a[k]]
      det = -det
    }
    det *= a[k][k]
    for (let i = k + 1; i < size; i++) {
      const factor = a[i][k] / a[k][k]
      for (let j = k; j < size; j++) a[i][j] -= factor * a[k][j]
    }
  }
  return det
}

/** Validate one joint (types.JointServoLimits.__post_init__) and fill its defaults (scaleMax 2). */
export function resolveJoint(joint: JointServoLimits): Required<JointServoLimits> {
  for (const name of ['kpBase', 'kdBase', 'kpMax', 'torqueCapNm'] as const) {
    const value = joint[name]
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`)
  }
  const scaleMax = joint.scaleMax ?? 2
  if (!Number.isFinite(scaleMax) || scaleMax <= 0) throw new Error('scaleMax must be positive and finite')
  if (joint.kdMax != null && (!Number.isFinite(joint.kdMax) || joint.kdMax <= 0)) throw new Error('kdMax must be positive and finite')
  if (joint.coulombNm != null && (!Number.isFinite(joint.coulombNm) || joint.coulombNm < 0))
    throw new Error('coulombNm must be finite and non-negative')
  return { ...joint, kdMax: joint.kdMax ?? null, scaleMax, coulombNm: joint.coulombNm ?? null }
}
