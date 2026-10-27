/**
 * The impedance law: one pure function per tick, `impedanceCommand`, plus the matrices it is built from - a line-for-line
 * port of `bam_impedance_controller/law.py`, generic over the task dimension m (see types.ts).
 *
 * Contract (K = the world stiffness, w = wrenchFf, J_r / J_m = the Jacobian at the reference / measured configuration,
 * effort = reference.effort or zeros):
 * - Kq = J_r^T K J_r and Dq = J_r^T D J_r, with D = cartesianDamping(impedance, atReference, design).
 * - JOINT: board kp_i = min(Kq_ii, kp_max_i, scale_max kp_base_i); board kd_i = Dq_ii sqrt(kp_i / Kq_ii) (a clamp keeps zeta),
 *   then min(kd, kd_max, scale_max kd_base). feedforward = effort + J_r^T w.
 * - JOINT_COUPLED: one scale s <= 1 keeps every Kq_ii inside min(kp_max_i, scale_max kp_base_i), every sqrt(s) Dq_ii inside
 *   min(kd_max_i, scale_max kd_base_i) and, with hostKpMax, every off-diagonal row sum sum_{j != i} |s Kq_ij| inside it.
 *   Board kp_i = s Kq_ii, kd_i = sqrt(s) Dq_ii; feedforward = effort + J_r^T w - offdiag(s Kq)(q_m - q_r) - offdiag(sqrt(s) Dq)(qd_m - qd_r).
 * - HOST_SPRING (needs atMeasured): kp_scale = 0; s <= 1 keeps every (J_m^T K J_m)_ii inside hostKpMax and every sqrt(s) Dq_ii
 *   inside the board's kd limit; board kd_i = sqrt(s) Dq_ii; feedforward = J_m^T (s K e + w) + effort - offdiag(sqrt(s) Dq)(qd_m - qd_r).
 * - TORQUE (needs atMeasured): kp_scale = kd_scale = 0; s <= 1 keeps every (J_m^T K J_m)_ii inside hostKpMax;
 *   F = s K e + sqrt(s) D_m (J_r qd_r - J_m qd_m) + w; feedforward = J_m^T F + effort.
 * - WHY a damping limit softens the whole spring (JOINT_COUPLED, HOST_SPRING): clamping kd alone left the spring under-damped;
 *   scaling K by s and D by sqrt(s) keeps the spring's shape AND its damping ratio.
 * - Every mode: position / velocity = the reference's; feedforward clamped to +-torqueCapNm (that joint marked clamped).
 */

import {
  type Mat,
  type Vec,
  SingularMatrixError,
  blockDiag,
  diag,
  diagOf,
  eye,
  inv,
  matAdd,
  matMul,
  matMul3,
  matScale,
  matTVec,
  matVec,
  offDiagonal,
  pinvHermitian,
  solve,
  symmetricRoot,
  symmetrize,
  transpose,
  vecSub,
} from './linalg'
import {
  type ActuatorCommand,
  DampingDesign,
  type ImpedanceConfig,
  ImpedanceMode,
  type JointReference,
  type KinematicsSample,
  type MeasuredState,
  type ResolvedImpedance,
  type TaskImpedance,
  resolveImpedance,
  resolveJoint,
} from './types'

/** relative eigenvalue floor of a pseudo-inverse (Lambda near a singularity, a rank-deficient compliance) */
export const SINGULAR_RCOND = 1e-9

/**
 * log(R) as a rotation vector, exact up to pi. WHY via a quaternion (Shepperd's branch on the largest component): the
 * arccos-of-the-trace form loses the axis near pi and its precision near 0.
 */
export function rotationVector(m: Mat): Vec {
  const trace = m[0][0] + m[1][1] + m[2][2]
  const candidates = [trace, m[0][0], m[1][1], m[2][2]]
  let branch = 0
  for (let i = 1; i < 4; i++) if (candidates[i] > candidates[branch]) branch = i
  let w: number, x: number, y: number, z: number
  if (branch === 0) {
    const root = 2 * Math.sqrt(1 + trace)
    ;[w, x, y, z] = [0.25 * root, (m[2][1] - m[1][2]) / root, (m[0][2] - m[2][0]) / root, (m[1][0] - m[0][1]) / root]
  } else if (branch === 1) {
    const root = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2])
    ;[w, x, y, z] = [(m[2][1] - m[1][2]) / root, 0.25 * root, (m[0][1] + m[1][0]) / root, (m[0][2] + m[2][0]) / root]
  } else if (branch === 2) {
    const root = 2 * Math.sqrt(1 - m[0][0] + m[1][1] - m[2][2])
    ;[w, x, y, z] = [(m[0][2] - m[2][0]) / root, (m[0][1] + m[1][0]) / root, 0.25 * root, (m[1][2] + m[2][1]) / root]
  } else {
    const root = 2 * Math.sqrt(1 - m[0][0] - m[1][1] + m[2][2])
    ;[w, x, y, z] = [(m[1][0] - m[0][1]) / root, (m[0][2] + m[2][0]) / root, (m[1][2] + m[2][1]) / root, 0.25 * root]
  }
  let axis = [x, y, z]
  if (w < 0) {
    // the short way round: angle in [0, pi]
    w = -w
    axis = axis.map((value) => -value)
  }
  const sine = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2])
  if (sine < 1e-12) return axis.map((value) => 2 * value) // small angle: angle / sin(angle / 2) -> 2
  const factor = (2 * Math.atan2(sine, w)) / sine
  return axis.map((value) => factor * value)
}

/** (p_d - p, rotation vector of R_d R^T): the world-frame twist that carries the measured pose onto the reference (m = 6). */
export function poseError(positionD: Vec, rotationD: Mat, position: Vec, rotation: Mat): Vec {
  const linear = vecSub(positionD, position)
  return [...linear, ...rotationVector(matMul(rotationD, transpose(rotation)))]
}

/** The task-space error, reference minus measured: the pose error for m = 6, p_d - p for a position task. */
export function taskError(atReference: KinematicsSample, atMeasured: KinematicsSample, m: number): Vec {
  if (m === 6) {
    if (!atReference.rotation || !atMeasured.rotation) throw new Error('a 6-D task needs both samples\' rotation')
    return poseError(atReference.position, atReference.rotation, atMeasured.position, atMeasured.rotation)
  }
  return vecSub(atReference.position.slice(0, m), atMeasured.position.slice(0, m))
}

/** The m x m rotation the impedance's diagonal lives in: blockdiag(R, R) for m = 6, R itself for a position task. */
export function taskRotation(impedance: ResolvedImpedance, m: number): Mat {
  if (!impedance.axes) return eye(m)
  return m === 6 ? blockDiag(impedance.axes, impedance.axes) : impedance.axes
}

/** World-frame stiffness: R diag(k) R^T. */
export function stiffnessMatrix(impedance: ResolvedImpedance, m: number): Mat {
  const rotation = taskRotation(impedance, m)
  return matMul3(rotation, diag(impedance.stiffness), transpose(rotation))
}

/** Lambda = (J M^-1 J^T)^-1, the inertia the tool feels (pseudo-inverse near a singularity). Needs massMatrix. */
export function operationalSpaceInertia(sample: KinematicsSample): Mat {
  if (!sample.massMatrix) throw new Error('operationalSpaceInertia needs the sample\'s massMatrix')
  const jacobian = sample.jacobian
  const mobility = matMul(jacobian, solve(sample.massMatrix, transpose(jacobian)))
  return pinvHermitian(symmetrize(mobility), SINGULAR_RCOND)
}

/**
 * m x m world damping. UNIT_MASS: R diag(2 zeta sqrt(k)) R^T. INERTIA: the factorization design (Albu-Schaffer et al. 2003)
 * D = A Z K1 + K1 Z A with A = Lambda^1/2, K1 = K^1/2 (symmetric roots), Z the zeta matrix in the impedance axes.
 * `impedance.damping` given: R diag(damping) R^T, whatever the design.
 */
export function cartesianDamping(impedance: TaskImpedance, sample: KinematicsSample, design: DampingDesign, m?: number): Mat {
  const size = m ?? sample.jacobian.length
  const resolved = resolveImpedance(impedance, size) // idempotent on an already resolved impedance
  const rotation = taskRotation(resolved, size)
  const rotationT = transpose(rotation)
  if (resolved.damping) return matMul3(rotation, diag(resolved.damping), rotationT)
  const ratios = resolved.dampingRatio
  const stiffness = resolved.stiffness
  if (design === DampingDesign.UNIT_MASS) {
    return matMul3(rotation, diag(stiffness.map((k, i) => 2 * ratios[i] * Math.sqrt(k))), rotationT)
  }
  const rootInertia = symmetricRoot(operationalSpaceInertia(sample))
  const rootStiffness = matMul3(rotation, diag(stiffness.map(Math.sqrt)), rotationT)
  const zeta = matMul3(rotation, diag(ratios), rotationT)
  const damping = matAdd(matMul3(rootInertia, zeta, rootStiffness), matMul3(rootStiffness, zeta, rootInertia))
  return symmetrize(damping)
}

/** J^T K J */
export function jointStiffness(stiffness: Mat, jacobian: Mat): Mat {
  return matMul3(transpose(jacobian), stiffness, jacobian)
}

/** The task-space spring a joint stiffness renders at the tool: (J Kq^-1 J^T)^-1. */
export function realizedCartesianStiffness(jointStiffnessMatrix: Mat, jacobian: Mat): Mat {
  const jacobianT = transpose(jacobian)
  let compliance: Mat
  try {
    compliance = matMul(jacobian, solve(jointStiffnessMatrix, jacobianT))
  } catch (error) {
    if (!(error instanceof SingularMatrixError)) throw error
    // numpy's general pinv here; the joint stiffness is symmetric in every mode, so the Hermitian form is the same matrix
    compliance = matMul3(jacobian, pinvHermitian(symmetrize(jointStiffnessMatrix), SINGULAR_RCOND), jacobianT)
  }
  compliance = symmetrize(compliance)
  try {
    return inv(compliance)
  } catch (error) {
    if (!(error instanceof SingularMatrixError)) throw error
    return pinvHermitian(compliance, SINGULAR_RCOND)
  }
}

/** Per joint, the largest s <= 1 with s demand <= limit (1 where nothing is demanded). */
function largestScale(demand: Vec, limit: Vec): Vec {
  return demand.map((value, i) => (value > 0 ? Math.min(1, limit[i] / value) : 1))
}

/** Per joint, the largest s <= 1 with sqrt(s) damping_demand <= limit. */
function largestDampingScale(dampingDemand: Vec, limit: Vec): Vec {
  return largestScale(dampingDemand, limit).map((value) => value * value)
}

function checkLength(name: string, values: Vec, count: number) {
  if (values.length !== count) throw new Error(`${name} must have ${count} values, got ${values.length}`)
}

function checkJacobian(name: string, jacobian: Mat, m: number, count: number) {
  if (jacobian.length !== m || jacobian.some((row) => row.length !== count)) throw new Error(`${name}.jacobian must be ${m}x${count}`)
}

/** One tick of the impedance stage (see the module comment for each mode's exact law). */
export function impedanceCommand(
  config: ImpedanceConfig,
  reference: JointReference,
  measured: MeasuredState,
  atReference: KinematicsSample,
  atMeasured?: KinematicsSample | null,
): ActuatorCommand {
  const joints = config.joints.map(resolveJoint)
  const count = joints.length
  if (!count) throw new Error('joints cannot be empty')
  const m = atReference.jacobian.length
  const qReference = reference.positions.slice()
  const qdReference = reference.velocities.slice()
  const effort = reference.effort == null ? new Array<number>(count).fill(0) : reference.effort.slice()
  checkLength('reference.positions', qReference, count)
  checkLength('reference.velocities', qdReference, count)
  checkLength('reference.effort', effort, count)
  checkLength('measured.positions', measured.positions, count)
  checkLength('measured.velocities', measured.velocities, count)
  checkJacobian('at_reference', atReference.jacobian, m, count)
  const jacobianReference = atReference.jacobian
  const design = config.dampingDesign ?? DampingDesign.INERTIA
  const hostKpMax = config.hostKpMax ?? null
  if (hostKpMax) {
    checkLength('host_kp_max', hostKpMax, count)
    if (hostKpMax.some((value) => !(value > 0) || !Number.isFinite(value))) throw new Error('host_kp_max must be positive')
  }

  const impedance = resolveImpedance(config.impedance, m)
  const stiffness = stiffnessMatrix(impedance, m)
  const wrench = impedance.wrenchFf
  const kpBase = joints.map((joint) => joint.kpBase)
  const kdBase = joints.map((joint) => joint.kdBase)
  const kpLimit = joints.map((joint) => Math.min(joint.kpMax, joint.scaleMax * joint.kpBase))
  const kdLimit = joints.map((joint) => Math.min(joint.kdMax ?? Infinity, joint.scaleMax * joint.kdBase))
  const cap = joints.map((joint) => joint.torqueCapNm)
  const clamped = new Array<boolean>(count).fill(false)
  let scale = 1
  let feedforward: Vec
  let kpScale: Vec
  let kdScale: Vec
  let renderedStiffness: Mat
  let renderedDamping: Mat

  if (config.mode === ImpedanceMode.HOST_SPRING) {
    if (!atMeasured) throw new Error('HOST_SPRING mode needs the kinematics at the measured configuration (atMeasured)')
    checkJacobian('at_measured', atMeasured.jacobian, m, count)
    const jacobianMeasured = atMeasured.jacobian
    const stiffnessJoint = jointStiffness(stiffness, jacobianMeasured)
    // WHY the damping at the reference: the board damps toward the reference velocity, like the joint modes
    const fullDamping = jointStiffness(cartesianDamping(impedance, atReference, design, m), jacobianReference)
    let perJoint = largestDampingScale(diagOf(fullDamping), kdLimit)
    if (hostKpMax) {
      const hostScale = largestScale(diagOf(stiffnessJoint), hostKpMax)
      perJoint = perJoint.map((value, i) => Math.min(value, hostScale[i]))
    }
    scale = Math.min(...perJoint)
    perJoint.forEach((value, i) => (clamped[i] ||= value < 1))
    const rootScale = Math.sqrt(scale)
    const dampingJoint = matScale(fullDamping, rootScale)
    const kd = diagOf(dampingJoint).map((value, i) => Math.min(value, kdLimit[i]))
    const error = taskError(atReference, atMeasured, m)
    const force = matVec(stiffness, error).map((value, i) => scale * value + wrench[i])
    const coupling = matVec(offDiagonal(dampingJoint), vecSub(measured.velocities, qdReference))
    feedforward = matTVec(jacobianMeasured, force).map((value, i) => value + effort[i] - coupling[i])
    kpScale = new Array<number>(count).fill(0)
    kdScale = kd.map((value, i) => value / kdBase[i])
    renderedStiffness = matScale(stiffnessJoint, scale)
    renderedDamping = matAdd(offDiagonal(dampingJoint), diag(kd))
  } else if (config.mode === ImpedanceMode.TORQUE) {
    if (!atMeasured) throw new Error('TORQUE mode needs the kinematics at the measured configuration (atMeasured)')
    checkJacobian('at_measured', atMeasured.jacobian, m, count)
    const jacobianMeasured = atMeasured.jacobian
    const stiffnessJoint = jointStiffness(stiffness, jacobianMeasured)
    if (hostKpMax) {
      const perJoint = largestScale(diagOf(stiffnessJoint), hostKpMax)
      scale = Math.min(...perJoint)
      perJoint.forEach((value, i) => (clamped[i] ||= value < 1))
    }
    const damping = cartesianDamping(impedance, atMeasured, design, m)
    const error = taskError(atReference, atMeasured, m)
    const twistError = vecSub(matVec(jacobianReference, qdReference), matVec(jacobianMeasured, measured.velocities))
    const rootScale = Math.sqrt(scale)
    const springForce = matVec(stiffness, error)
    const damperForce = matVec(damping, twistError)
    const force = springForce.map((value, i) => scale * value + rootScale * damperForce[i] + wrench[i])
    feedforward = matTVec(jacobianMeasured, force).map((value, i) => value + effort[i])
    kpScale = new Array<number>(count).fill(0)
    kdScale = new Array<number>(count).fill(0)
    renderedStiffness = matScale(stiffnessJoint, scale)
    renderedDamping = matScale(jointStiffness(damping, jacobianMeasured), rootScale)
  } else {
    const stiffnessJoint = jointStiffness(stiffness, jacobianReference)
    const dampingJoint = jointStiffness(cartesianDamping(impedance, atReference, design, m), jacobianReference)
    const stiffnessDiagonal = diagOf(stiffnessJoint)
    const dampingDiagonal = diagOf(dampingJoint)
    const wrenchTorque = matTVec(jacobianReference, wrench)
    feedforward = effort.map((value, i) => value + wrenchTorque[i])
    let kp: Vec
    let kd: Vec
    if (config.mode === ImpedanceMode.JOINT) {
      kp = stiffnessDiagonal.map((value, i) => Math.min(value, kpLimit[i]))
      kp.forEach((value, i) => (clamped[i] ||= value < stiffnessDiagonal[i]))
      // WHY sqrt(kp / Kq): a clamped joint keeps its damping ratio (kd ~ sqrt(M kp)) instead of keeping the asked-for kd
      const ratio = stiffnessDiagonal.map((value, i) => (value > 0 ? kp[i] / value : 1))
      const kdWanted = dampingDiagonal.map((value, i) => value * Math.sqrt(ratio[i]))
      kd = kdWanted.map((value, i) => Math.min(value, kdLimit[i]))
      kd.forEach((value, i) => (clamped[i] ||= value < kdWanted[i]))
      renderedStiffness = diag(kp)
      renderedDamping = diag(kd)
    } else if (config.mode === ImpedanceMode.JOINT_COUPLED) {
      const stiffnessScale = largestScale(stiffnessDiagonal, kpLimit)
      const dampingScale = largestDampingScale(dampingDiagonal, kdLimit)
      let perJoint = stiffnessScale.map((value, i) => Math.min(value, dampingScale[i]))
      if (hostKpMax) {
        const rowSums = offDiagonal(stiffnessJoint).map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0))
        const hostScale = largestScale(rowSums, hostKpMax)
        perJoint = perJoint.map((value, i) => Math.min(value, hostScale[i]))
      }
      scale = Math.min(...perJoint)
      perJoint.forEach((value, i) => (clamped[i] ||= value < 1))
      const rootScale = Math.sqrt(scale)
      kp = stiffnessDiagonal.map((value) => scale * value)
      kd = dampingDiagonal.map((value, i) => Math.min(rootScale * value, kdLimit[i]))
      const springCoupling = matVec(offDiagonal(stiffnessJoint), vecSub(measured.positions, qReference))
      const damperCoupling = matVec(offDiagonal(dampingJoint), vecSub(measured.velocities, qdReference))
      feedforward = feedforward.map((value, i) => value - scale * springCoupling[i] - rootScale * damperCoupling[i])
      renderedStiffness = matScale(stiffnessJoint, scale)
      renderedDamping = matAdd(matScale(offDiagonal(dampingJoint), rootScale), diag(kd))
    } else {
      throw new Error(`unknown mode ${String(config.mode)}`)
    }
    kpScale = kp.map((value, i) => value / kpBase[i])
    kdScale = kd.map((value, i) => value / kdBase[i])
  }

  feedforward = feedforward.map((value, i) => {
    if (Math.abs(value) > cap[i]) clamped[i] = true
    return Math.min(cap[i], Math.max(-cap[i], value))
  })
  return {
    position: qReference,
    velocity: qdReference,
    kpScale,
    kdScale,
    feedforwardTorque: feedforward,
    renderedJointStiffness: renderedStiffness,
    renderedJointDamping: renderedDamping,
    stiffnessScale: scale,
    clamped,
    mode: config.mode,
  }
}
