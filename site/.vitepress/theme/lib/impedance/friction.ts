/**
 * Contact-aware Coulomb friction feed-forward - a port of `bam_impedance_controller/friction.py`, an OPTION
 * (`ImpedanceConfig.frictionCompensation`), default off.
 *
 * Today ("reference"): the trajectory's effort carries c tanh(qd_r / 0.05) per joint, keyed on the REFERENCE velocity. After
 * the tool meets the belt the reference keeps descending for 0.1-0.3 s while the contact holds the joints, and that
 * feed-forward keeps pushing the tool into the belt.
 *
 * "contact_aware": key the feed-forward on the velocity the contact ALLOWS,
 *
 *     tau_f = c * tanh(k / b),   k = qd_r - lambda * J_r^-1 [a (a^T J_v qd_r); 0],
 *
 * a the approach axis (into the belt), c the identified kinetic Coulomb per joint (`JointServoLimits.coulombNm`), lambda a
 * latch that SETS once the reference has moved inward steadily for ARM_TICKS host ticks and the tool lags it, and CLEARS on
 * the way out. The latch is explicit state, passed in and returned: the law stays stateless.
 *
 * Generic over the task: `approachAxis` lives in the Jacobian's linear rows (world -z for m = 6, (0, -1) for the planar
 * (x, z) arm). J_r must be square (m = n), as in the Python.
 */

import { type Vec, matVec, solve } from './linalg'
import type { ImpedanceConfig, JointReference, KinematicsSample, MeasuredState } from './types'

/** WHY world -z: the approach axis is the belt's normal - the descent the reference makes and the motion the contact stops */
export const APPROACH_AXIS_6D: Vec = [0, 0, -1]
/** the planar (x, z) arm's approach axis */
export const APPROACH_AXIS_PLANAR: Vec = [0, -1]
/** WHY 0.01 rad/s (the reasoner's band sweep): narrow enough to drop the feed-forward on the joints the contact holds, wide enough to stay smooth */
export const BAND_RAD_S = 0.01
/** WHY armed only while the reference moves inward steadily: the detector must not fire during the cruise's ramps or a lift */
export const ARM_SPEED_M_S = 0.02
export const ARM_ACCEL_M_S2 = 0.3
export const ARM_TICKS = 4
/** WHY 0.8: the tool's inward speed falling below 0.8 of the reference's is the contact holding it back */
export const LAG_RATIO = 0.8
/** WHY release only on the way out: a tool that LED its reference at touch reads a negative compression for tens of ms */
export const RELEASE_SPEED_M_S = 0.01
export const RELEASE_COMPRESSION_M = 0.0005
/** today's reference-keyed band (the trajectory controller's c tanh(qd_r / 0.05)) */
export const REFERENCE_BAND_RAD_S = 0.05

/** lambda and the reference's inward tool speed at the last ARM_TICKS host ticks (newest last). */
export interface FrictionLatchState {
  latched: boolean
  inwardSpeeds: Vec
}

export const initialFrictionLatch = (): FrictionLatchState => ({ latched: false, inwardSpeeds: [] })

/** Today's keying: c tanh(qd_r / 0.05) per joint (what the trajectory controller's effort carries). */
export function referenceKeyedFriction(coulombNm: Vec, qdReference: Vec): Vec {
  return coulombNm.map((c, i) => c * Math.tanh(qdReference[i] / REFERENCE_BAND_RAD_S))
}

/**
 * One host tick: [the friction feed-forward per joint (N.m), the next state]. `atMeasured` gives the spring's compression
 * along the axis. `approachAxis` defaults to world -z for a 6-D task and (0, -1) for a planar one.
 */
export function contactAwareFriction(
  config: ImpedanceConfig,
  reference: JointReference,
  measured: MeasuredState,
  atReference: KinematicsSample,
  atMeasured: KinematicsSample,
  state: FrictionLatchState,
  approachAxis?: Vec,
): [Vec, FrictionLatchState] {
  const coulomb = config.joints.map((joint) => joint.coulombNm)
  if (coulomb.some((value) => value == null))
    throw new Error('contact_aware friction compensation needs every JointServoLimits.coulombNm (the identified Coulomb)')
  const c = coulomb as number[]
  const period = config.host?.periodS ?? 0.01
  const jacobian = atReference.jacobian
  const axis = approachAxis ?? (jacobian.length === 6 ? APPROACH_AXIS_6D : APPROACH_AXIS_PLANAR)
  const linear = axis.length
  const along = (twist: Vec) => {
    let sum = 0
    for (let i = 0; i < linear; i++) sum += axis[i] * twist[i]
    return sum
  }
  const referenceSpeed = along(matVec(jacobian, reference.velocities))
  const measuredSpeed = along(matVec(jacobian, measured.velocities))
  let compression = 0
  for (let i = 0; i < linear; i++) compression += axis[i] * (atReference.position[i] - atMeasured.position[i])
  const speeds = [...state.inwardSpeeds, referenceSpeed].slice(-ARM_TICKS)
  let steady = speeds.length === ARM_TICKS && speeds.every((value) => value > ARM_SPEED_M_S)
  for (let i = 1; steady && i < speeds.length; i++) if (!(Math.abs(speeds[i] - speeds[i - 1]) / period < ARM_ACCEL_M_S2)) steady = false
  let latched = state.latched
  if (!latched) latched = steady && measuredSpeed < LAG_RATIO * referenceSpeed
  else if (referenceSpeed < -RELEASE_SPEED_M_S && compression < RELEASE_COMPRESSION_M) latched = false
  let key = reference.velocities.slice()
  if (latched) {
    const normal = new Array<number>(jacobian.length).fill(0)
    for (let i = 0; i < linear; i++) normal[i] = axis[i] * referenceSpeed
    const correction = solve(jacobian, normal)
    key = key.map((value, i) => value - correction[i])
  }
  return [c.map((value, i) => value * Math.tanh(key[i] / BAND_RAD_S)), { latched, inwardSpeeds: speeds }]
}
