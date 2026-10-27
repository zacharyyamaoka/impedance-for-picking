/// <reference lib="webworker" />
// <LivePick />'s physics, off the main thread: @mujoco/mujoco stepping lib/livepick/sim.ts at the config's 4 kHz.
// WHY the wasm URL comes from the page instead of lib/mujoco.ts's own `?url` import: a worker bundle emits its OWN copy of the
// 10 MB wasm under another name, so the landing page (whose replays load MuJoCo on the main thread) downloaded it twice; the page's
// URL is the main thread's asset, one download, one HTTP cache entry. Paced to the wall clock x the requested speed; when the CPU cannot keep up, the backlog is DROPPED - the sim runs
// slower than real time (never with a coarser step) and every frame says by how much. ~60 frames a second go to the page: the geoms'
// poses, the contact force in 1 ms bins (each bin's max, as pick.trace_arrays), the per-joint torque split and the scale s.
// Stops stepping while the page says it is off-screen.

import type { MainModule } from '@mujoco/mujoco'
import loadMujocoFactory from '@mujoco/mujoco'
import type { LiveConfig, LiveParams, SceneParams } from './config'
import { cartesianReference } from './path'
import type { Frame, GeomInfo, Loaded, RunState, ToPage, ToWorker } from './protocol'
import { type ModelTexts, PickSim } from './sim'

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (message: ToPage, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

const FRAME_MS = 16
const SLICE_MS = 12 // compute per slice before yielding to messages
const MAX_BACKLOG_S = 0.02 // sim time owed beyond this is dropped (the run falls behind real time instead of stalling)
const JITTER_TAU_S = 0.025 // the moving-average stand-in: a first-order filter at ~6 Hz; what is above it is jitter
const JITTER_WINDOW_S = 0.2

let sim: PickSim | null = null
let geoms: GeomInfo[] = []
let state: RunState = 'ready'
let speed = 1
let visible = true
let pendingScene: SceneParams | null = null
let scheduled = false
let lastWall = 0
let debtTicks = 0
let lastFrame = 0
let behind = false
let sentBins = 0
const progress: { wall: number; simT: number }[] = []
// the free-space jitter estimate (pick.tool_jitter_mm's idea, causal): error minus its low-pass, RMS over ~0.2 s
let errorLow: number[] | null = null
let jitterSq = 0

const channel = new MessageChannel()
channel.port1.onmessage = () => {
  try {
    slice()
  } catch (error) {
    state = 'paused'
    post({ type: 'error', message: `the simulation stopped: ${error instanceof Error ? error.stack ?? error.message : String(error)}` })
  }
}
function schedule() {
  if (scheduled || state !== 'running' || !visible) return
  scheduled = true
  channel.port2.postMessage(0)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

async function init(base: string, wasmUrl: string, scene: SceneParams, live: LiveParams) {
  post({ type: 'status', detail: 'Loading MuJoCo' })
  const loading = loadMujocoFactory({ locateFile: () => wasmUrl }) as Promise<MainModule>
  const [mujoco, config] = await Promise.all([loading, fetchText(`${base}data/livepick-config.json`).then((text) => JSON.parse(text) as LiveConfig)])
  post({ type: 'status', detail: 'Loading the pick scene' })
  const paths = new Set<string>()
  for (const build of Object.values(config.builds)) for (const path of Object.values(build.models)) paths.add(path)
  const texts: ModelTexts = {}
  await Promise.all([...paths].map(async (path) => (texts[path] = await fetchText(`${base}${path}`))))
  post({ type: 'status', detail: 'Solving the pick path' })
  const started = performance.now()
  sim = new PickSim(mujoco, config, texts, scene, live)
  postLoaded(performance.now() - started)
  postFrame(true)
}

function describeGeoms(): GeomInfo[] {
  const s = sim!
  const { mujoco } = s
  const model = s.model
  const types = model.geom_type as Int32Array
  const sizes = model.geom_size as Float64Array
  const rgbas = model.geom_rgba as Float32Array
  const groups = model.geom_group as Int32Array
  const bodies = model.geom_bodyid as Int32Array
  const GEOM = mujoco.mjtObj.mjOBJ_GEOM.value
  const BODY = mujoco.mjtObj.mjOBJ_BODY.value
  const out: GeomInfo[] = []
  for (let g = 0; g < model.ngeom; g++) {
    if (types[g] === mujoco.mjtGeom.mjGEOM_PLANE.value) continue
    const name = mujoco.mj_id2name(model, GEOM, g) || ''
    const body = mujoco.mj_id2name(model, BODY, bodies[g]) || ''
    const role: GeomInfo['role'] =
      name === 'tip_contact' ? 'tip' : name === 'tool_housing' ? 'tool' : name === 'belt_surface' ? 'belt' : body === 'belt' ? 'cleat' : groups[g] === 3 ? 'arm' : 'other'
    out.push({
      index: g,
      type: types[g],
      size: [sizes[3 * g], sizes[3 * g + 1], sizes[3 * g + 2]],
      rgba: [rgbas[4 * g], rgbas[4 * g + 1], rgbas[4 * g + 2], rgbas[4 * g + 3]],
      group: groups[g],
      role,
    })
  }
  return out
}

function postLoaded(buildMs: number) {
  const s = sim!
  geoms = describeGeoms()
  const message: Loaded = {
    type: 'loaded',
    geoms,
    loopHz: s.config.loop_hz,
    leadS: s.plan.lead_s,
    endS: s.phases.end,
    phases: { ...s.phases },
    scene: { ...s.scene },
    buildMs,
  }
  post(message)
}

function resetRun(scene: SceneParams | null) {
  const s = sim!
  const started = performance.now()
  const rebuild = scene && JSON.stringify(scene) !== JSON.stringify(s.scene)
  s.reset(scene ?? undefined)
  pendingScene = null
  if (rebuild) postLoaded(performance.now() - started)
  sentBins = 0
  debtTicks = 0
  progress.length = 0
  behind = false
  errorLow = null
  jitterSq = 0
}

function slice() {
  scheduled = false
  const s = sim
  if (!s || state !== 'running' || !visible) return
  const now = performance.now()
  const wallDt = Math.min((now - lastWall) / 1000, 0.1) // after a stall (a background tab), do not try to catch up
  lastWall = now
  debtTicks += wallDt * speed * s.config.loop_hz
  const deadline = now + SLICE_MS
  const ticksPerBin = Math.round(s.config.loop_hz / 1000)
  const lowAlpha = 1 - Math.exp(-ticksPerBin * s.dt / JITTER_TAU_S)
  const windowAlpha = 1 - Math.exp(-ticksPerBin * s.dt / JITTER_WINDOW_S)
  let stepped = 0
  while (debtTicks >= 1) {
    if (!s.step()) {
      state = s.diverged ? 'diverged' : 'done'
      break
    }
    debtTicks -= 1
    stepped++
    if (s.fz[s.tick - 1] > 0) errorLow = null // pressed on the belt: jitter is a free-space measure; restart its filter on release
    else if (s.tick % ticksPerBin === 0) {
      // the free-space jitter, at 1 kHz: the tool's error minus its low-pass, mean-squared over ~0.2 s
      const tcp = s.tcp()
      const reference = cartesianReference(s.plan, s.config.belt.surface_z, Math.max(s.time, 0)).position
      const error = [0, 1, 2].map((k) => tcp[k] - reference[k])
      // WHY seeded with the first sample (and again after each contact): a static offset - the arm's sag, the error a release leaves - is not jitter
      if (!errorLow) errorLow = error
      let sq = 0
      for (let k = 0; k < 3; k++) {
        errorLow[k] += lowAlpha * (error[k] - errorLow[k])
        sq += (error[k] - errorLow[k]) ** 2
      }
      jitterSq += windowAlpha * (sq - jitterSq)
    }
    if ((stepped & 63) === 0 && performance.now() > deadline) break
  }
  const backlog = MAX_BACKLOG_S * s.config.loop_hz
  behind = debtTicks > backlog
  if (behind) debtTicks = backlog
  // WHY sampled, not per slice: a slice with nothing owed is microseconds long, and one entry per slice grew this list (and its
  // shift()) without bound - the run crawled at the first contact (measured 2026-10-27: 10 ms per physics step in Chrome)
  if (!progress.length || now - progress[progress.length - 1].wall >= 50) progress.push({ wall: now, simT: s.time })
  while (progress.length > 2 && now - progress[0].wall > 1000) progress.shift()
  if (state !== 'running' || now - lastFrame >= FRAME_MS) postFrame()
  // nothing was owed (the sim is ahead of the clock): wait a moment instead of spinning the thread
  if (stepped === 0 && state === 'running') idle()
  else schedule()
}

function idle() {
  if (scheduled) return
  scheduled = true
  setTimeout(() => channel.port1.onmessage?.(new MessageEvent('message')), 2)
}

function postFrame(force = false) {
  const s = sim
  if (!s || !s.data) return
  const now = performance.now()
  if (!force && !visible) return
  lastFrame = now
  const data = s.data
  const geomXpos = data.geom_xpos as Float64Array
  const geomXmat = data.geom_xmat as Float64Array
  const xpos = new Float32Array(geoms.length * 3)
  const xmat = new Float32Array(geoms.length * 9)
  geoms.forEach((geom, k) => {
    for (let i = 0; i < 3; i++) xpos[3 * k + i] = geomXpos[3 * geom.index + i]
    for (let i = 0; i < 9; i++) xmat[9 * k + i] = geomXmat[9 * geom.index + i]
  })
  // the contact force in completed 1 ms bins since the last frame (each bin's max)
  const ticksPerBin = Math.round(s.config.loop_hz / 1000)
  const bins = Math.floor(s.tick / ticksPerBin)
  const fz = new Float32Array(Math.max(0, bins - sentBins))
  for (let b = sentBins; b < bins; b++) {
    let peak = 0
    for (let k = b * ticksPerBin; k < (b + 1) * ticksPerBin; k++) if (s.fz[k] > peak) peak = s.fz[k]
    fz[b - sentBins] = peak
  }
  const fzStart = sentBins
  sentBins = bins
  let realtime = speed
  if (progress.length >= 2) {
    const first = progress[0]
    const last = progress[progress.length - 1]
    if (last.wall - first.wall > 200) realtime = (last.simT - first.simT) / ((last.wall - first.wall) / 1000)
  }
  const ff = s.latched.ff
  const message: Frame = {
    type: 'frame',
    state,
    t: s.time,
    tick: s.tick,
    totalTicks: s.totalTicks,
    xpos,
    xmat,
    tcp: s.tcp() as [number, number, number],
    referenceTcp: s.referenceTcp.slice() as [number, number, number],
    fzStart,
    fz,
    fzNow: s.tick > 0 ? s.fz[s.tick - 1] : 0,
    pd: s.boardPd.slice(),
    ff: ff.slice(),
    applied: s.tauApplied.slice(),
    caps: s.config.torque_cap_nm.slice(),
    stiffnessScale: s.stiffnessScale,
    clamped: s.clamped.slice(),
    saturationRecent: s.recentSaturationFraction,
    jitterMm: 1000 * Math.sqrt(Math.max(jitterSq, 0)),
    realtime,
    speed,
    behind: state === 'running' && realtime < 0.95 * speed,
    metrics: s.metrics(),
    compression: s.indices.compQpos >= 0 ? (data.qpos as Float64Array)[s.indices.compQpos] : 0,
  }
  post(message, [xpos.buffer, xmat.buffer, fz.buffer])
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      speed = message.speed
      await init(message.base, message.wasmUrl, message.scene, message.live)
      return
    }
    const s = sim
    if (!s) return
    switch (message.type) {
      case 'scene':
        if (state === 'running' || state === 'paused') pendingScene = message.scene
        else {
          resetRun(message.scene)
          state = 'ready'
          postFrame(true)
        }
        break
      case 'live':
        s.setLive(message.live)
        if (state !== 'running' && state !== 'paused') {
          // nothing is moving: start again from the hold under the new controller
          resetRun(pendingScene)
          state = 'ready'
        }
        postFrame(true)
        break
      case 'run':
        if (state === 'paused') {
          state = 'running'
        } else {
          resetRun(pendingScene)
          state = 'running'
        }
        lastWall = performance.now()
        postFrame(true)
        schedule()
        break
      case 'pause':
        if (state === 'running') state = 'paused'
        postFrame(true)
        break
      case 'reset':
        resetRun(pendingScene)
        state = 'ready'
        postFrame(true)
        break
      case 'speed':
        speed = message.speed
        progress.length = 0
        break
      case 'visible':
        visible = message.visible
        if (visible) {
          lastWall = performance.now()
          progress.length = 0
          postFrame(true)
          schedule()
        }
        break
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

