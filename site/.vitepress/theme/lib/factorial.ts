// The full factorial (docs/data-contract.md, schema impedance-factorial/1): build × controller × approach × spring × object, 120 runs
// with per-joint contact and GEAR torques, a gearbox life estimate and a safe approach speed. The sim lane writes
// site/public/data/factorial.json; the Explorer, the joint-loads section and the ablation ladder's factor swaps all read it through
// loadFactorial(), so the page fetches it once. Pure helpers below are unit-tested (tests/unit/factorial.test.ts).
import { fetchOptional } from './contact'

export const FACTORS = ['build', 'controller', 'approach', 'spring', 'object'] as const
export type Factor = (typeof FACTORS)[number]
export type Combo = Record<Factor, string>

export interface GearJoint {
  rated_nm: number
  repeated_peak_nm: number
  momentary_peak_nm: number
  ratio: number
  life_model: string
}
export interface Run extends Combo {
  touch_peak_n: number
  press_mean_n: number
  touch_speed_m_s: number
  joint_contact_torque_peak_nm: number[]
  gear_torque_peak_nm: number[]
  gear_load_ratio: number[]
  gear_life_picks: number[]
  safe_approach_speed_m_s: number
  converged: boolean
  flag: string | null
  trace: { t_ms: number[]; fz_n: number[]; gear_torque_nm: number[][] }
}
export interface Factorial {
  schema: string
  generated_at: string
  fixture?: boolean
  source: { lane_commit: string; script: string }
  factors: Record<Factor, string[]>
  factor_labels: Record<string, string>
  joints: string[]
  gearboxes: Record<string, { model: string; source?: string; per_joint: GearJoint[] } & Record<string, unknown>>
  runs: Run[]
}

let cached: Promise<Factorial | null> | null = null
/** factorial.json once per page view; null while the sim lane has not written it. */
export function loadFactorial(): Promise<Factorial | null> {
  // WHY import.meta.env.BASE_URL, not withBase: this file is also imported by vitest, outside VitePress' client
  if (!cached) cached = fetchOptional<Factorial>(`${import.meta.env.BASE_URL}data/factorial.json`)
  return cached
}

// The duty cycle the life-in-years figure assumes (stated beside every such number on the page)
export const PICKS_PER_HOUR = 1800
export const HOURS_PER_DAY = 16

export const FACTOR_NAMES: Record<Factor, string> = { build: 'Arm build', controller: 'Controller', approach: 'Approach', spring: 'Spring', object: 'Object' }

/** The ablation ladder's rungs as factorial combinations (docs/data-contract.md: one change per rung). */
export const RUNG_COMBOS: Record<string, Omit<Combo, 'object'>> = {
  R0: { build: 'ur5e', controller: 'stiff', approach: 'fast', spring: 'off' },
  R1: { build: 'ur5e', controller: 'stiff', approach: 'slow', spring: 'off' },
  R2: { build: 'qdd', controller: 'stiff', approach: 'slow', spring: 'off' },
  R3: { build: 'qdd_light', controller: 'stiff', approach: 'slow', spring: 'off' },
  R4: { build: 'qdd_light', controller: 'stiff', approach: 'slow', spring: 'on' },
  R5: { build: 'qdd_light', controller: 'host_spring', approach: 'slow', spring: 'on' },
}
export const WORST: Omit<Combo, 'object'> = RUNG_COMBOS.R0

export function label(data: Factorial | null, value: string): string {
  return data?.factor_labels?.[value] ?? value
}
export function runId(run: Combo): string {
  return FACTORS.map((f) => run[f]).join('/')
}
export function findRun(data: Factorial | null, combo: Partial<Combo>): Run | null {
  if (!data) return null
  return data.runs.find((run) => FACTORS.every((f) => combo[f] === undefined || run[f] === combo[f])) ?? null
}
/** The joint whose gear is loaded hardest (index) and its load ratio. */
export function worstJoint(run: Run): { index: number; ratio: number } {
  let index = 0
  run.gear_load_ratio.forEach((value, i) => {
    if (value > run.gear_load_ratio[index]) index = i
  })
  return { index, ratio: run.gear_load_ratio[index] ?? NaN }
}
/** The gearbox life of the whole arm: the shortest joint's. */
export function armLife(run: Run): { index: number; picks: number } {
  let index = 0
  run.gear_life_picks.forEach((value, i) => {
    if (value < run.gear_life_picks[index]) index = i
  })
  return { index, picks: run.gear_life_picks[index] ?? NaN }
}
export function lifeYears(picks: number, perHour = PICKS_PER_HOUR, hoursPerDay = HOURS_PER_DAY): number {
  return picks / (perHour * hoursPerDay * 365)
}
/** The gear torque over the contact torque at the hardest-hit joint: how much the gear adds to what the contact asks. */
export function gearAmplification(run: Run): number {
  const { index } = worstJoint(run)
  const contact = run.joint_contact_torque_peak_nm[index]
  return contact > 0 ? run.gear_torque_peak_nm[index] / contact : NaN
}

/** 1,234 / 12.3 K / 4.5 M / 6.7 B: a big count readable at a glance (the exact value goes in a title). */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toPrecision(3)} B`
  if (abs >= 1e6) return `${(value / 1e6).toPrecision(3)} M`
  if (abs >= 1e4) return `${(value / 1e3).toPrecision(3)} K`
  return Math.round(value).toLocaleString('en-US')
}
export function years(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 100) return `${Math.round(value).toLocaleString('en-US')} y`
  if (value >= 1) return `${value.toFixed(1)} y`
  const days = value * 365
  return days >= 1 ? `${days.toFixed(days >= 10 ? 0 : 1)} d` : `${(days * HOURS_PER_DAY).toFixed(1)} h`
}

// ------------------------------------------------------------------ the Explorer's data-ui dataset and views (CONTRACT §3, §5)

export interface PresetView {
  name: string
  /** the combination the detail panel opens on when the view is picked */
  focus?: Partial<Combo>
}

/** One row per run, in data-ui's runtime shape. Factor columns hold the readable label; ids stay the raw combination. */
export function toDataset(data: Factorial) {
  const rows = data.runs.map((run) => {
    const worst = worstJoint(run)
    const life = armLife(run)
    return {
      id: runId(run),
      // WHY the raw factor ids as the title: the readable labels are the next five columns; this stays short and unique
      name: `${run.converged ? '' : '★ '}${run.build} · ${run.controller} · ${run.approach} · spring ${run.spring} · ${run.object}`,
      build: label(data, run.build),
      controller: label(data, run.controller),
      approach: label(data, run.approach),
      spring: label(data, run.spring),
      object: label(data, run.object),
      build_order: data.factors.build.indexOf(run.build),
      controller_order: data.factors.controller.indexOf(run.controller),
      touch_peak_n: run.touch_peak_n,
      press_mean_n: run.press_mean_n,
      max_gear_load: worst.ratio,
      worst_joint: data.joints[worst.index] ?? String(worst.index),
      over_limit: run.gear_load_ratio.filter((r) => r > 1).length,
      life_picks: life.picks,
      life_years: Number(lifeYears(life.picks).toPrecision(4)),
      safe_speed_m_s: run.safe_approach_speed_m_s,
      held: run.converged,
      flag: run.flag ?? null,
    }
  })
  return {
    id: 'impedance-factorial',
    title: 'Every combination: build × controller × approach × spring × object',
    titleProperty: 'name',
    properties: {
      name: { type: 'text', width: 290 },
      build: { type: 'text', width: 190, display: 'badge', colors: Object.fromEntries(data.factors.build.map((b, i) => [label(data, b), i + 1])) },
      controller: { type: 'text', width: 200 },
      approach: { type: 'text', width: 130 },
      spring: { type: 'text', width: 140 },
      object: { type: 'text', width: 110 },
      build_order: { type: 'number', hidden: true },
      controller_order: { type: 'number', hidden: true },
      touch_peak_n: { type: 'number', unitText: 'N', decimals: 1, better: 'lower', width: 110, note: 'peak contact force within 30 ms of first touch' },
      press_mean_n: { type: 'number', unitText: 'N', decimals: 1, better: 'lower', width: 100, note: 'mean contact force through the hold' },
      max_gear_load: { type: 'number', decimals: 2, better: 'lower', width: 120, note: 'the hardest-hit joint: peak gear torque / its repeated-peak rating (> 1 = over the limit)' },
      worst_joint: { type: 'text', width: 120 },
      over_limit: { type: 'number', decimals: 0, better: 'lower', width: 90, note: 'joints whose gear torque passed the repeated-peak rating' },
      life_picks: { type: 'number', decimals: 0, better: 'higher', width: 120, note: "estimated picks until the shortest-lived joint's gearbox fails (an estimate)" },
      life_years: { type: 'number', unitText: 'y', decimals: 2, better: 'higher', width: 100, note: `at ${PICKS_PER_HOUR} picks/h, ${HOURS_PER_DAY} h/day` },
      safe_speed_m_s: { type: 'number', unitText: 'm/s', decimals: 3, better: 'higher', width: 110, note: "the fastest approach that keeps every joint's gear under its repeated-peak rating" },
      held: { type: 'boolean', width: 70, note: 'passed the three-rate and perturbation checks; ★ rows did not' },
      flag: { type: 'text', width: 220 },
    },
    rows,
  }
}

/** The .base document: the factor facets and the named preset views (Zach's: worst case, + impedance only, + QDD + impedance ...). */
export function toBase(data: Factorial): { base: Record<string, unknown>; presets: PresetView[] } {
  const L = (v: string) => JSON.stringify(label(data, v))
  const order = ['name', 'build', 'controller', 'approach', 'spring', 'object', 'touch_peak_n', 'press_mean_n', 'max_gear_load', 'worst_joint', 'over_limit', 'life_picks', 'life_years', 'safe_speed_m_s', 'held', 'flag']
  const bySeverity = [{ property: 'max_gear_load', direction: 'DESC' }]
  const presets: (PresetView & { view: Record<string, unknown> })[] = [
    { name: 'All runs', view: { sort: [{ property: 'build_order', direction: 'ASC' }, { property: 'controller_order', direction: 'ASC' }] } },
    {
      name: 'Worst case', focus: { ...WORST, object: 'rigid' },
      view: { filters: `build == ${L(WORST.build)} && controller == ${L(WORST.controller)} && approach == ${L(WORST.approach)} && spring == ${L(WORST.spring)}`, sort: bySeverity },
    },
    {
      name: 'Worst case + impedance only', focus: { ...WORST, controller: 'host_spring', object: 'rigid' },
      view: { filters: `build == ${L(WORST.build)} && controller == ${L('host_spring')} && approach == ${L(WORST.approach)} && spring == ${L(WORST.spring)}`, sort: bySeverity },
    },
    {
      name: 'Worst case + QDD + impedance', focus: { ...WORST, build: 'qdd', controller: 'host_spring', object: 'rigid' },
      view: { filters: `build == ${L('qdd')} && controller == ${L('host_spring')} && approach == ${L(WORST.approach)} && spring == ${L(WORST.spring)}`, sort: bySeverity },
    },
    {
      name: 'Best combination',
      view: { filters: 'held == true', sort: [{ property: 'max_gear_load', direction: 'ASC' }, { property: 'touch_peak_n', direction: 'ASC' }], limit: 10 },
    },
    {
      name: 'Every controller on the worst arm', focus: { ...WORST, object: 'rigid' },
      view: {
        filters: `build == ${L(WORST.build)} && approach == ${L(WORST.approach)} && spring == ${L(WORST.spring)}`,
        groupBy: { property: 'object', direction: 'ASC' },
        sort: [{ property: 'controller_order', direction: 'ASC' }],
      },
    },
  ]
  const base = {
    facets: FACTORS.map((f) => ({ property: f, as: 'values', label: FACTOR_NAMES[f] })).concat([{ property: 'held', as: 'toggle', label: 'Held the checks' } as never]),
    properties: {
      name: { displayName: 'Run' },
      build_order: { displayName: 'Arm build (study order)' },
      controller_order: { displayName: 'Controller (study order)' },
      build: { displayName: 'Arm build' },
      controller: { displayName: 'Controller' },
      approach: { displayName: 'Approach' },
      spring: { displayName: 'Spring' },
      object: { displayName: 'Object' },
      touch_peak_n: { displayName: 'Touch peak' },
      press_mean_n: { displayName: 'Press (hold)' },
      max_gear_load: { displayName: 'Max gear load' },
      worst_joint: { displayName: 'Hardest-hit joint' },
      over_limit: { displayName: 'Joints over' },
      life_picks: { displayName: 'Life (picks)' },
      life_years: { displayName: 'Life (years)' },
      safe_speed_m_s: { displayName: 'Safe approach' },
      held: { displayName: 'Held' },
      flag: { displayName: 'Flag' },
    },
    views: presets.map((p) => ({ type: 'table', units: 'inline', name: p.name, order, display: { max_gear_load: 'bar' }, ...p.view })),
  }
  return { base, presets: presets.map(({ name, focus }) => ({ name, focus })) }
}
