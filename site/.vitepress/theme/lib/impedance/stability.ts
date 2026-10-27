/**
 * How stiff a spring the HOST loop can render - a port of `bam_impedance_controller/stability.py`.
 *
 * TORQUE mode moves the spring from the board's 30 kHz PD to the host's rate behind the measured state/torque delay (rack:
 * 100 Hz, ~7 ms), so its ceiling is a property of (period, delay), not of the joint's board gains.
 *
 * Model: a lone inertia J; the state (q, qd) is sampled at t_k = k T, the torque -kp q - kd qd computed from it is applied
 * from t_k + delay and held for one period (zero-order hold); kp = J wn^2, kd = 2 zeta J wn. The ceiling is the largest wn
 * whose exact discrete closed loop (fractional delay included) has every eigenvalue strictly inside the unit circle. Because
 * kp and kd both scale with J, the ceiling is a natural frequency. Physical damping only helps, so leaving it out is
 * conservative.
 *
 * `boardDamping = true` is the HOST_SPRING split: only the spring -kp q is sampled, delayed and held; the damper -kd qd acts
 * continuously on the board. WHY it matters: at 100 Hz / 7 ms the ceiling rises from wn ~56 to ~234 rad/s - the delayed
 * damper, not the delayed spring, is what limits a host loop.
 */

import { type Mat, spectralRadius, zeros } from './linalg'

export const RELATIVE_TOLERANCE = 1e-3 // the bisection stops at 0.1 % of wn
export const SCAN_FACTOR = 1.25 // the coarse scan's step up in wn before the bisection
export const SCAN_START_PER_PERIOD = 1e-3 // first wn of the scan: 1e-3 / period, deep inside the stable range
export const SCAN_STOP_PER_PERIOD = 1e3
export const GAIN_MARGIN = 2

/** (Phi, Gamma) of q'' = -c q' + u over `durationS` with u held, per unit inertia. c = 0 is the double integrator. */
function flow(durationS: number, decayPerS: number): { phi: Mat; gamma: [number, number] } {
  const t = durationS
  const c = decayPerS
  let settle: number
  let lag: number
  if (c * t < 1e-6) {
    // series: exact to O((c t)^2) relative
    settle = t - 0.5 * c * t * t
    lag = 0.5 * t * t - (c * t * t * t) / 6
  } else {
    settle = -Math.expm1(-c * t) / c // (1 - e^-ct) / c
    lag = (t - settle) / c
  }
  return {
    phi: [
      [1, settle],
      [0, 1 - c * settle],
    ],
    gamma: [lag, settle],
  }
}

/**
 * The exact discrete closed loop of a unit inertia under the delayed host PD, state (q, qd, u_{k-1} ... u_{k-n-1}).
 * Astrom & Wittenmark's fractional delay: delay = n T + tau', 0 <= tau' < T. Over [t_k, t_k+1) the control computed n + 1
 * periods ago acts for the first tau' and the one computed n periods ago for the remaining T - tau'.
 */
export function closedLoopMatrix(wn: number, dampingRatio: number, periodS: number, delayS: number, boardDamping = false): Mat {
  const whole = Math.floor(delayS / periodS + 1e-12)
  const fraction = Math.max(delayS - whole * periodS, 0)
  const late = periodS - fraction // how long the newer control acts
  const decay = boardDamping ? 2 * dampingRatio * wn : 0 // the board's continuous damper, per unit inertia
  const { phi } = flow(periodS, decay)
  const { phi: phiLate, gamma: gamma0 } = flow(late, decay)
  const { gamma: gammaFraction } = flow(fraction, decay)
  // integrated over tau', then carried for T - tau'
  const gamma1 = [
    phiLate[0][0] * gammaFraction[0] + phiLate[0][1] * gammaFraction[1],
    phiLate[1][0] * gammaFraction[0] + phiLate[1][1] * gammaFraction[1],
  ]
  const gain = [wn * wn, boardDamping ? 0 : 2 * dampingRatio * wn]
  const size = 2 + whole + 1 // buffer slot j holds u_(k-1-j), j = 0 .. n
  const matrix = zeros(size, size)
  matrix[0][0] = phi[0][0]
  matrix[0][1] = phi[0][1]
  matrix[1][0] = phi[1][0]
  matrix[1][1] = phi[1][1]
  if (whole === 0) {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) matrix[i][j] -= gamma0[i] * gain[j] // u_(k-n) = u_k = -gain x_k
  } else {
    for (let i = 0; i < 2; i++) matrix[i][2 + whole - 1] += gamma0[i]
  }
  for (let i = 0; i < 2; i++) matrix[i][2 + whole] += gamma1[i]
  matrix[2][0] = -gain[0] // the new u_(k-1) is this tick's control
  matrix[2][1] = -gain[1]
  for (let slot = 1; slot <= whole; slot++) matrix[2 + slot][2 + slot - 1] = 1 // the buffer shifts by one period
  return matrix
}

function stable(wn: number, dampingRatio: number, periodS: number, delayS: number, boardDamping: boolean): boolean {
  return spectralRadius(closedLoopMatrix(wn, dampingRatio, periodS, delayS, boardDamping)) < 1
}

/**
 * Largest stable wn (rad/s) of the delayed host PD (or, with `boardDamping`, of the host spring over a board-rate damper),
 * by bisection to 0.1 %. Infinity when stable up to 1e3 / period; 0 when unstable from the start.
 */
export function hostWnCeiling(periodS: number, delayS: number, dampingRatio = 1, boardDamping = false): number {
  if (!(Number.isFinite(periodS) && periodS > 0 && Number.isFinite(delayS) && delayS >= 0))
    throw new Error('period_s must be positive and delay_s non-negative, both finite')
  if (!(Number.isFinite(dampingRatio) && dampingRatio >= 0)) throw new Error('damping_ratio must be finite and non-negative')
  // WHY a scan up from deep inside the stable range before bisecting: the first instability is the ceiling, and a bisection
  // alone could land on a stable island above it
  let stableWn = SCAN_START_PER_PERIOD / periodS
  if (!stable(stableWn, dampingRatio, periodS, delayS, boardDamping)) return 0
  let unstableWn = stableWn * SCAN_FACTOR
  while (stable(unstableWn, dampingRatio, periodS, delayS, boardDamping)) {
    stableWn = unstableWn
    unstableWn = unstableWn * SCAN_FACTOR
    if (unstableWn > SCAN_STOP_PER_PERIOD / periodS) return Infinity
  }
  while (unstableWn - stableWn > RELATIVE_TOLERANCE * stableWn) {
    const middle = 0.5 * (stableWn + unstableWn)
    if (stable(middle, dampingRatio, periodS, delayS, boardDamping)) stableWn = middle
    else unstableWn = middle
  }
  return stableWn
}

/** inertia x hostWnCeiling^2 (N.m/rad, or N/m for a mass in kg). */
export function hostStiffnessCeiling(inertiaKgM2: number, periodS: number, delayS: number, dampingRatio = 1, boardDamping = false): number {
  if (!(Number.isFinite(inertiaKgM2) && inertiaKgM2 > 0)) throw new Error('inertia_kg_m2 must be positive and finite')
  return inertiaKgM2 * hostWnCeiling(periodS, delayS, dampingRatio, boardDamping) ** 2
}

/**
 * Per joint `hostKpMax`: each joint's host ceiling (on its own inertia, e.g. M_ii at the pose) divided by `gainMargin`.
 * WHY a 2x margin on kp by default: at the ceiling itself the comparison's wrists limit-cycled; the PID tuner deploys the
 * same way - a new kp never above half the last quiet one.
 */
export function hostKpLimits(
  inertiasKgM2: number[],
  periodS: number,
  delayS: number,
  dampingRatio = 1,
  boardDamping = false,
  gainMargin = GAIN_MARGIN,
): number[] {
  if (!(Number.isFinite(gainMargin) && gainMargin >= 1)) throw new Error('gain_margin must be finite and at least 1')
  const wnSquared = hostWnCeiling(periodS, delayS, dampingRatio, boardDamping) ** 2
  return inertiasKgM2.map((inertia) => {
    if (!(Number.isFinite(inertia) && inertia > 0)) throw new Error('inertia_kg_m2 must be positive and finite')
    return (inertia * wnSquared) / gainMargin
  })
}
