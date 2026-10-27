// Replay data: the frozen export contract (scripts/export_examples.py writes site/public/data/) and time-indexed sampling.
// Every series is uniform at the tape's dt from its own t0; lengths can differ slightly between rungs and joints, so
// everything is indexed by time, never by sample number.

export type RungId = 'factory' | 'analytic' | 'tuned' | 'oracle'
export const RUNG_IDS: RungId[] = ['factory', 'analytic', 'tuned', 'oracle']
export const RUNG_NAMES: Record<RungId, string> = {
  factory: 'Factory gains',
  analytic: 'Analytic start',
  tuned: 'Tuned',
  oracle: 'Oracle (best possible)',
}

export type Unit = 'mrad' | 'mm'

export interface Series {
  t0: number
  q: number[]
}

export interface Score {
  stop_p90_mrad: number
  tracking_rms_mrad: number
  max_error_mrad: number
  ringing_mrad: number
  saturation: number
  complete: boolean
}

export interface JointController {
  kp: number
  kd: number
  feedforward: string
  score: Score
}

export interface JointInfo {
  name: string
  model_joint: string
  linear: boolean
  home: number
}

export interface Tape {
  name: string
  class: string
  dt: number
  target: Record<string, Series>
  rungs: Partial<Record<RungId, Record<string, Series>>>
  passive?: Partial<Record<RungId, Record<string, number[]>>>
  target_passive?: Record<string, number[]>
}

export interface RobotData {
  robot: string
  title: string
  blurb: string
  model: string
  rungs_order: RungId[]
  unit: Unit
  joints: JointInfo[]
  passive: string[]
  tapes: Tape[]
  rungs: Partial<Record<RungId, Record<string, JointController>>>
  payload_kg?: number
  /** This dataset as a Rerun recording: the .rrd's URL and the SDK version that wrote it, or null until a converter writes one. */
  rerun?: { rrd: string; sdk: string } | null
}

// WHY the pin travels with the data (tracking-run contract, 2026-10-26: comparison.json projections.rerun.sdk): an .rrd opens
// only in a viewer at least as new as the SDK that wrote it, so the button builds its URL from the file's own version.
// The viewer is Rerun's hosted one (no account): its wasm is ~52 MiB, over Cloudflare's 25 MiB per-file cap, so we cannot
// self-host it. The .rrd needs Access-Control-Allow-Origin: https://app.rerun.io (site/public/_headers).
export const RERUN_SDK_DEFAULT = '0.40.0'

/** "Open in Rerun": Rerun's hosted web viewer loading the dataset's .rrd, or null when there is none yet.
 *  The pages render the button only when this returns a URL, never a dead one. */
export function rerunUrl(data: { rerun?: { rrd: string; sdk: string } | null } | null | undefined): string | null {
  const rerun = data?.rerun
  if (!rerun?.rrd || typeof window === 'undefined') return null
  const rrd = new URL(rerun.rrd, window.location.href).href
  return `https://app.rerun.io/version/${rerun.sdk || RERUN_SDK_DEFAULT}/index.html?url=${encodeURIComponent(rrd)}`
}

export interface RobotSummary {
  title: string
  blurb: string
  unit: Unit
  joints: number
  headline: Partial<Record<RungId, { tracking_rms: number; stop_p90: number }>>
}

export type RobotIndex = Record<string, RobotSummary>

/** Value of a uniform series at time t: linear between samples, held at the ends. */
export function sampleAt(q: ArrayLike<number>, t0: number, dt: number, t: number): number {
  const n = q.length
  if (n === 0) return 0
  const x = (t - t0) / dt
  if (x <= 0) return q[0]
  if (x >= n - 1) return q[n - 1]
  const i = Math.floor(x)
  const f = x - i
  return q[i] * (1 - f) + q[i + 1] * f
}

export function seriesEnd(s: Series, dt: number): number {
  return s.t0 + Math.max(0, s.q.length - 1) * dt
}

/** Length of a tape: the longest target or rung series. */
export function tapeDuration(tape: Tape): number {
  let end = 0
  for (const s of Object.values(tape.target)) end = Math.max(end, seriesEnd(s, tape.dt))
  for (const rung of Object.values(tape.rungs)) for (const s of Object.values(rung ?? {})) end = Math.max(end, seriesEnd(s, tape.dt))
  return end
}

/** The t0 the driven joints share; passive paths use the same sample index. */
export function tapeT0(tape: Tape): number {
  const first = Object.values(tape.target)[0]
  return first ? first.t0 : 0
}

/** Error of one rung's joint against the command, in the display unit (mrad for hinges, mm for slides: both x1000). */
export function errorAt(tape: Tape, rung: RungId, joint: string, t: number): number {
  const target = tape.target[joint]
  const actual = tape.rungs[rung]?.[joint]
  if (!target || !actual) return NaN
  return 1000 * Math.abs(sampleAt(actual.q, actual.t0, tape.dt, t) - sampleAt(target.q, target.t0, tape.dt, t))
}

/** |error| on a uniform time grid for one joint, or the worst joint when joint is null. */
export function errorTrace(tape: Tape, rung: RungId, joints: string[], times: Float64Array): Float64Array {
  const out = new Float64Array(times.length)
  for (let i = 0; i < times.length; i++) {
    let worst = NaN
    for (const joint of joints) {
      const e = errorAt(tape, rung, joint, times[i])
      if (!Number.isNaN(e) && !(e <= worst)) worst = e
    }
    out[i] = worst
  }
  return out
}

/** Uniform time grid over the tape at its own dt. */
export function timeGrid(tape: Tape): Float64Array {
  const t0 = tapeT0(tape)
  const n = Math.max(1, Math.round((tapeDuration(tape) - t0) / tape.dt) + 1)
  const times = new Float64Array(n)
  for (let i = 0; i < n; i++) times[i] = t0 + i * tape.dt
  return times
}

/** Three significant digits; thousands get separators instead of an exponent. */
export function fmt3(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  if (x === 0) return '0'
  if (Math.abs(x) >= 1000) return Number(x.toPrecision(3)).toLocaleString('en-US')
  if (Math.abs(x) < 1e-6) return x.toExponential(2)
  return x.toPrecision(3)
}

/** "19x lower": two significant digits under 10, whole numbers above. */
export function fmtRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—'
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`
}

/** Display position of a joint: degrees for hinges, mm for slides. */
export function displayPosition(joint: JointInfo, q: number): number {
  return joint.linear ? 1000 * q : (180 / Math.PI) * q
}

export function positionUnit(joint: JointInfo): string {
  return joint.linear ? 'mm' : '°'
}
