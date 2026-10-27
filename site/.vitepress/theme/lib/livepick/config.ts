// The shape of site/public/data/livepick-config.json (written by scripts/export_livepick.py from bam_impedance_controller's
// sim) and the knobs the page turns. No DOM, no MuJoCo: imported by the worker, the page and the Node faithfulness test.

import type { JointServoLimits } from '../impedance'

export type ControllerName = 'stiff' | 'torque' | 'joint' | 'joint_coupled' | 'host_spring'
export type BuildName = 'ur5e' | 'qdd' | 'qdd_light'
export type ObjectName = 'rigid' | 'soft'
export type FrictionName = 'reference' | 'contact_aware'

export const CONTROLLERS: { id: ControllerName; label: string; hint: string }[] = [
  { id: 'stiff', label: 'Stiff', hint: 'today: every board at its base gains, no impedance' },
  { id: 'torque', label: 'Torque', hint: 'board PD off; the host sends the whole Cartesian law as torque' },
  { id: 'joint', label: 'Joint', hint: "the board's PD renders diag(JᵀKJ); coupling dropped" },
  { id: 'joint_coupled', label: 'Coupled', hint: 'that diagonal on the board, the off-diagonal terms as host feed-forward' },
  { id: 'host_spring', label: 'Host spring', hint: 'the host renders the exact spring, the board the damping' },
]

export const BUILDS: { id: BuildName; label: string }[] = [
  { id: 'ur5e', label: 'UR-style' },
  { id: 'qdd', label: 'QDD' },
  { id: 'qdd_light', label: 'Light QDD' },
]

/** What needs a new model or a new path: applied when a pick starts (or at once while nothing runs). */
export interface SceneParams {
  build: BuildName
  compensator: boolean
  object: ObjectName
  /** m/s over the last 30 mm above the believed surface; >= the descent speed (0.2) means one speed all the way */
  approachMS: number
  /** the TRUE surface minus the believed one (+ = the object is taller than believed) */
  surfaceOffsetM: number
}

/** What the host loop reads every tick: switching any of these takes effect at the next host tick, mid-pick included. */
export interface LiveParams {
  controller: ControllerName
  kxy: number
  kz: number
  /** one of the config's zeta_grid (the board ceilings were exported per zeta) */
  zeta: number
  hostRateHz: number
  hostDelayS: number
  friction: FrictionName
  /** the host ceiling (stability.host_kp_limits, / 2): off lets TORQUE run a spring its delayed loop cannot hold */
  guard: boolean
}

export const DEFAULT_SCENE: SceneParams = { build: 'ur5e', compensator: false, object: 'rigid', approachMS: 0.2, surfaceOffsetM: 0.01 }
export const DEFAULT_LIVE: LiveParams = {
  controller: 'host_spring',
  kxy: 3000,
  kz: 500,
  zeta: 1,
  hostRateHz: 100,
  hostDelayS: 0.007,
  friction: 'reference',
  guard: true,
}

export interface JointTruth {
  name: string
  armature_kg_m2: number
  coulomb_nm: number
  viscous_nm_s_rad: number
  torque_bandwidth_hz: number
  velocity_filter_hz: number
  encoder_counts_per_rev: number
  measurement_delay_s: number
  rotor_inertia_kg_m2: number
}

export interface Calibration {
  efc_R: number
  impedance: number
  dmax: number
  virtual_mass_kg: number
  solref: Record<ObjectName, [number, number]>
}

export interface BuildConfig {
  label: string
  link_scale: number
  models: { true: string; true_comp: string; nominal: string }
  armature_true: number[]
  armature_nominal: number[]
  coulomb_nm: number[]
  viscous_nm_s_rad: number[]
  /** per zeta (key `${zeta}`): tuning.tuner_limits' JointServoLimits */
  limits: Record<string, JointServoLimits[]>
  calibration: { bare: Calibration; comp: Calibration }
  q_pick: number[]
  host_kp_max_100hz_7ms: { torque: number[]; host_spring: number[] }
}

export interface PlanConfig {
  center_xy: [number, number]
  approach_m: number
  press_in_m: number
  descent_speed_m_s: number
  ramp_s: number
  dwell_s: number
  belt_speed_m_s: number
  belt_ramp_s: number
  hold_before_s: number
  hold_after_s: number
  tail_s: number
  lead_s: number
  disturbance_n: number
  disturbance_s: number
  disturbance_angle_rad: number
  contact_speed_m_s: number | null
  slow_zone_m: number
}

export interface LiveConfig {
  schema: string
  source: { commit: string; sources_sha256: string; lane: string }
  loop_hz: number
  joints: string[]
  home_rad: number[]
  home_seed: number[]
  torque_cap_nm: number[]
  sites: { tcp: string; tip_body: string; tip_geom: string; belt_body: string; belt_geom: string; belt_joint: string; compensator_joint: string }
  truths: JointTruth[]
  friction_solref: [number, number]
  belt: { surface_z: number; y: number; half_size: [number, number, number]; speed_m_s: number }
  objects: Record<ObjectName, { label: string; contact_stiffness_n_m: number; contact_damping_n_s_m: number }>
  surface_offset_m: number
  default_stiffness: number[]
  zeta_grid: number[]
  host_rates_hz: number[]
  host_margin: number
  metrics: { impact_window_s: number; lost_contact_s: number }
  diverged: { speed_rad_s: number; tool_error_m: number }
  plan: PlanConfig
  path: { fine_dt: number; ik_tolerance: number; ik_damping: number; ik_iterations: number; ik_stride: number; coulomb_band_rad_s: number; rotation: number[][] }
  builds: Record<BuildName, BuildConfig>
}

/** One Python reference run (site/public/data/livepick-reference.json). */
export interface ReferenceRun {
  id: string
  controller: ControllerName
  object: ObjectName
  build?: BuildName
  compensator?: boolean
  host_rate_hz?: number
  host_delay_s?: number
  approach_m_s: number | null
  friction?: FrictionName
  stiffness: number[]
  damping_ratio?: number
  guard?: boolean
  loop_hz: number
  metrics: Record<string, number | boolean | string | null>
  trace: { t0: number; dt: number; fz: number[] }
}

export interface ReferenceFile {
  schema: string
  source: LiveConfig['source']
  loop_hz: number
  surface_offset_m: number
  paths: { build: BuildName; approach_m_s: number | null; host_rate_hz: number; coulomb_feedforward: boolean; rows: number; stride: number; q: number[][]; qd: number[][]; tau_ff: number[][] }[]
  runs: ReferenceRun[]
}

/** The scene and live params a reference run was made with (for the faithfulness test and the page's overlay). */
export function referenceParams(run: ReferenceRun): { scene: SceneParams; live: LiveParams } {
  return {
    scene: {
      build: run.build ?? 'ur5e',
      compensator: !!run.compensator,
      object: run.object,
      approachMS: run.approach_m_s ?? 0.2,
      surfaceOffsetM: 0.01,
    },
    live: {
      controller: run.controller,
      kxy: run.stiffness[0],
      kz: run.stiffness[2],
      zeta: run.damping_ratio ?? 1,
      hostRateHz: run.host_rate_hz ?? 100,
      hostDelayS: run.host_delay_s ?? 0.007,
      friction: run.friction ?? 'reference',
      guard: run.guard !== false,
    },
  }
}

/** The plan with the page's approach speed: below the descent speed it is the slow-zone speed (reference.py's contact_speed_m_s). */
export function planFor(base: PlanConfig, approachMS: number): PlanConfig {
  const slow = approachMS < base.descent_speed_m_s - 1e-9 ? approachMS : null
  return { ...base, contact_speed_m_s: slow }
}
