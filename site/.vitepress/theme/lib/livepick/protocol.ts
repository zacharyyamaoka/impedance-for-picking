// Messages between <LivePick /> and its worker (lib/livepick/worker.ts).

import type { LiveParams, SceneParams } from './config'
import type { PickMetrics } from './sim'

export type RunState = 'ready' | 'running' | 'paused' | 'done' | 'diverged'

export type ToWorker =
  | { type: 'init'; base: string; wasmUrl: string; scene: SceneParams; live: LiveParams; speed: number }
  | { type: 'scene'; scene: SceneParams }
  | { type: 'live'; live: LiveParams }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'speed'; speed: number }
  | { type: 'visible'; visible: boolean }

/** One drawable geom of the TRUE model (planes are left to the page's own floor). */
export interface GeomInfo {
  index: number
  type: number
  size: [number, number, number]
  rgba: [number, number, number, number]
  group: number
  role: 'arm' | 'tool' | 'tip' | 'belt' | 'cleat' | 'other'
}

export interface Loaded {
  type: 'loaded'
  geoms: GeomInfo[]
  loopHz: number
  leadS: number
  endS: number
  phases: Record<string, number>
  scene: SceneParams
  /** how long the scene took to compile + solve the path (ms) */
  buildMs: number
}

export interface Frame {
  type: 'frame'
  state: RunState
  t: number
  tick: number
  totalTicks: number
  /** geom_xpos (3 per geom) and geom_xmat (9 per geom) of the GeomInfo indices, in the loaded order */
  xpos: Float32Array
  xmat: Float32Array
  tcp: [number, number, number]
  referenceTcp: [number, number, number]
  /** the tool-belt normal force, one value per 1 ms bin (the bin's max), bins [fzStart, fzStart + fz.length) of this run */
  fzStart: number
  fz: Float32Array
  fzNow: number
  /** per joint: the board's PD part, the host's feed-forward, the torque applied, each joint's cap */
  pd: number[]
  ff: number[]
  applied: number[]
  caps: number[]
  stiffnessScale: number
  clamped: boolean[]
  /** fraction of the last 0.25 s of physics ticks with a joint at its torque cap */
  saturationRecent: number
  /** RMS of the tool's error above ~20 Hz while free of the belt (mm): a limit cycle shows here */
  jitterMm: number
  /** achieved physics speed / real time over the last second (the requested speed included) */
  realtime: number
  speed: number
  /** the 4 kHz physics could not keep up: the run is slower than asked */
  behind: boolean
  metrics: PickMetrics
  compression: number
}

export type ToPage =
  | { type: 'status'; detail: string }
  | Loaded
  | Frame
  | { type: 'error'; message: string }
