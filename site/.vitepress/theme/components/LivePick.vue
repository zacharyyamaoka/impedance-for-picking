<script setup lang="ts">
// <LivePick />: bam_impedance_controller's conveyor pick, LIVE - MuJoCo stepping the arm, the belt and the suction tool in a Web
// Worker at 4 kHz, the board PD per joint every step, the host loop at the chosen rate and delay calling the same impedance law as
// the Python (lib/impedance). Zach (2026-10-27): "run mujoco in the thing so you can see it running live ... tune the parameters,
// switching in and out controllers, and see how it all works."
// The controller, K, zeta, the host loop and the friction keying act at the next host tick, mid-pick included; the arm build, the
// compensator, the object and the approach speed rebuild the scene, so they apply to the next pick.
// Props: controller, build, object (initial choices) and autorun (run one pick when it first scrolls into view).
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from 'vue'
import { useData, withBase } from 'vitepress'
import { BUILDS, CONTROLLERS, type BuildName, type ControllerName, DEFAULT_LIVE, DEFAULT_SCENE, type LiveParams, type ObjectName, type ReferenceFile,
  type ReferenceRun, type SceneParams, referenceParams } from '../lib/livepick/config'
import type { Frame, Loaded, RunState, ToPage, ToWorker } from '../lib/livepick/protocol'
import type { LiveView } from '../lib/livepick/view'
import { type Trace, drawForcePlot } from '../lib/livepick/plot'
import { cssVar, onLookChange } from '../lib/variants'
// the main thread's wasm asset (the same file lib/mujoco.ts loads): the worker fetches this URL, so a page that also replays MuJoCo
// on the main thread downloads the 10 MB once
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url'

const props = withDefaults(defineProps<{ controller?: ControllerName; build?: BuildName; object?: ObjectName; autorun?: boolean }>(), {
  controller: 'host_spring',
  build: 'ur5e',
  object: 'rigid',
  autorun: false,
})

const ZETAS = [0.3, 0.5, 0.7, 1, 1.4, 2]
const RATES = [100, 250, 500, 1000]
const SPEEDS = [
  { value: 1, label: 'Real time' },
  { value: 0.25, label: '¼' },
  { value: 0.05, label: '1/20' },
]
const JOINT_LABELS = ['Base', 'Shoulder', 'Elbow', 'Wrist 1', 'Wrist 2', 'Wrist 3']
const STORE = { panel: 'livepick.panelWidth', stage: 'livepick.stageHeight', folded: 'livepick.folded' }
const PANEL_MIN = 260
const PANEL_MAX = 560
const STAGE_MIN = 240
const STAGE_MAX = 760
const NARROW_PX = 760

const scene = reactive<SceneParams>({ ...DEFAULT_SCENE, build: props.build, object: props.object })
const live = reactive<LiveParams>({ ...DEFAULT_LIVE, controller: props.controller })
const speed = ref(1)

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const plotCanvas = ref<HTMLCanvasElement | null>(null)
const plotWrap = ref<HTMLElement | null>(null)
const status = ref('Starting')
const errorText = ref('')
const loaded = shallowRef<Loaded | null>(null)
const frame = shallowRef<Frame | null>(null)
const runState = ref<RunState>('ready')
const narrow = ref(false)
const panelWidth = ref(340)
const stageHeight = ref(430)
const folded = ref(false)
const reference = shallowRef<ReferenceFile | null>(null)

// the run being shown, and the one before it (faded on the plot)
interface RunRecord {
  trace: Float32Array
  count: number
  t0: number
  key: string
  mixed: boolean
  metrics: Frame['metrics'] | null
}
const current = shallowRef<RunRecord | null>(null)
const previous = shallowRef<RunRecord | null>(null)

const { isDark } = useData()

// ------------------------------------------------------------------------------------------------------------ helpers (read-only)
const controllerHint = computed(() => CONTROLLERS.find((c) => c.id === live.controller)?.hint ?? '')
const impedanceActive = computed(() => live.controller !== 'stiff')
const guardApplies = computed(() => live.controller === 'torque' || live.controller === 'host_spring')
const zetaIndex = computed({
  get: () => Math.max(0, ZETAS.indexOf(live.zeta)),
  set: (index: number) => (live.zeta = ZETAS[index]),
})
// log sliders for K: 0..1000 -> [min, max]
const logSlider = (min: number, max: number) => ({
  to: (value: number) => Math.round((1000 * Math.log(value / min)) / Math.log(max / min)),
  from: (position: number) => {
    const raw = min * (max / min) ** (position / 1000)
    const step = raw < 1000 ? 10 : raw < 10000 ? 50 : 500
    return Math.round(raw / step) * step
  },
})
const kxyScale = logSlider(300, 30000)
const kzScale = logSlider(50, 10000)
const kxyPosition = computed({ get: () => kxyScale.to(live.kxy), set: (p: number) => (live.kxy = kxyScale.from(p)) })
const kzPosition = computed({ get: () => kzScale.to(live.kz), set: (p: number) => (live.kz = kzScale.from(p)) })
const delayMs = computed({ get: () => Math.round(live.hostDelayS * 2000) / 2, set: (ms: number) => (live.hostDelayS = Math.round(ms * 2) / 2000) })
const approachLabel = computed(() => (scene.approachMS >= 0.2 - 1e-9 ? '0.20 m/s (one speed)' : `${scene.approachMS.toFixed(2)} m/s over the last 30 mm`))
const sceneKey = (s: SceneParams) => JSON.stringify([s.build, s.compensator, s.object, Math.round(s.approachMS * 1000), s.surfaceOffsetM])
const scenePending = computed(() => !!loaded.value && sceneKey(scene) !== sceneKey(loaded.value.scene))
const fmt = (value: number | null | undefined, digits = 1) => (value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits))

const phaseName = computed(() => {
  const f = frame.value
  const p = loaded.value?.phases
  if (!f || !p) return ''
  const t = f.t
  if (runState.value === 'ready') return 'holding the start pose'
  if (t < 0) return 'lead hold'
  if (t < p.descend) return 'matching the belt'
  if (t < p.dwell) return f.metrics.firstTouchS != null ? 'touched - still descending' : 'descending'
  if (t < p.lift) return t >= p.disturbance_on && t < p.disturbance_off ? 'dwell - 20 N side push' : 'dwell'
  if (t < p.lifted) return 'lifting'
  return 'slowing with the belt'
})
const realtimeText = computed(() => {
  const f = frame.value
  if (!f || runState.value !== 'running') return ''
  const ratio = f.realtime
  const label = `×${ratio.toFixed(ratio < 0.1 ? 3 : 2)} real time`
  return f.behind ? `${label} - this device cannot step 4 kHz faster` : label
})
const stability = computed(() => {
  const f = frame.value
  if (!f || runState.value === 'ready') return { label: '—', warn: false, detail: 'run a pick' }
  if (runState.value === 'diverged') return { label: 'Diverged', warn: true, detail: f.metrics.reason }
  const saturated = f.saturationRecent
  const shaking = f.jitterMm
  // WHY three states: a release or a lift rings for a few hundred ms and decays (seen at ~1.7 mm on host spring at 10 kN/m) - that
  // is settling; a delayed loop past its ceiling pins torques at their caps and shakes 5-14 mm (torque mode, guard off) - that is
  // a limit cycle
  if (saturated > 0.01 || shaking > 3)
    return { label: 'Limit cycle', warn: true, detail: `torques at their caps ${(100 * saturated).toFixed(0)} % of the last 0.25 s, tool shaking ${shaking.toFixed(2)} mm RMS` }
  if (shaking > 0.5) return { label: 'Settling', warn: false, detail: `tool ringing ${shaking.toFixed(2)} mm RMS, no torque at its cap` }
  return { label: 'Stable', warn: false, detail: `no torque at its cap, tool jitter ${shaking.toFixed(3)} mm RMS` }
})
const torqueRows = computed(() => {
  const f = frame.value
  if (!f) return []
  return JOINT_LABELS.map((label, i) => ({
    label,
    pd: f.pd[i] / f.caps[i],
    ff: f.ff[i] / f.caps[i],
    applied: f.applied[i],
    cap: f.caps[i],
    clamped: !!f.clamped[i],
  }))
})
const barStyle = (fraction: number) => {
  const clamped = Math.max(-1, Math.min(1, fraction))
  return clamped >= 0 ? { left: '50%', width: `${50 * clamped}%` } : { left: `${50 + 50 * clamped}%`, width: `${-50 * clamped}%` }
}
const shownMetrics = computed(() => current.value?.metrics ?? null)

/** The Python reference run with exactly the current run's settings (the plot overlays it). */
const matchedReference = computed<ReferenceRun | null>(() => {
  const run = current.value
  const file = reference.value
  if (!run || run.mixed || !file) return null
  return file.runs.find((entry) => settingsKey(referenceParams(entry).scene, referenceParams(entry).live) === run.key) ?? null
})
function settingsKey(s: SceneParams, l: LiveParams) {
  return JSON.stringify([sceneKey(s), l.controller, l.kxy, l.kz, l.zeta, l.hostRateHz, Math.round(l.hostDelayS * 1e5), l.friction, l.guard])
}

// ------------------------------------------------------------------------------------------------------------ the worker
let worker: Worker | null = null
let view: LiveView | null = null
let rafId = 0
let visible = false
let framePending = false
let plotPending = true
let observers: { disconnect(): void }[] = []
let stopLook: (() => void) | null = null
let autorunDone = false
let pendingRun = false

function send(message: ToWorker) {
  worker?.postMessage(message)
}

function onWorker(message: ToPage) {
  if (message.type === 'status') status.value = message.detail
  else if (message.type === 'error') errorText.value = message.message
  else if (message.type === 'loaded') {
    loaded.value = message
    view?.setGeoms(message.geoms)
    status.value = ''
    plotPending = true
    if (props.autorun && !autorunDone && visible) startRun()
  } else if (message.type === 'frame') {
    const before = runState.value
    runState.value = message.state
    frame.value = message
    framePending = true
    // the first frame of a run we started: a fresh record (after 'loaded', so a new plan's length is known)
    if (pendingRun && message.state === 'running') {
      current.value = newRecord()
      pendingRun = false
    }
    const run = current.value
    if (run && message.state !== 'ready' && message.fz.length && message.fzStart < run.trace.length) {
      run.trace.set(message.fz.subarray(0, Math.min(message.fz.length, run.trace.length - message.fzStart)), message.fzStart)
      run.count = Math.min(run.trace.length, message.fzStart + message.fz.length)
    }
    if (run && message.state !== 'ready') {
      run.metrics = message.metrics
      triggerRef(current) // the record is mutated in place (its trace is large): tell the readouts
    }
    if (before !== message.state || message.fz.length) plotPending = true
  }
}

function newRecord(): RunRecord {
  const l = loaded.value!
  return {
    trace: new Float32Array(Math.ceil((l.leadS + l.endS) * 1000) + 2),
    count: 0,
    t0: -l.leadS,
    key: settingsKey(scene, live),
    mixed: false,
    metrics: null,
  }
}

function startRun() {
  if (!loaded.value) return
  autorunDone = true
  if (runState.value === 'paused') {
    send({ type: 'run' })
    return
  }
  if (runState.value === 'running') {
    send({ type: 'pause' })
    return
  }
  if (current.value && current.value.count > 50) previous.value = current.value
  // the scene applies on this run: the record's length and t0 follow the (possibly new) plan once 'loaded' arrives
  send({ type: 'scene', scene: { ...scene } })
  current.value = null
  pendingRun = true
  send({ type: 'run' })
}

function resetRun() {
  if (current.value && current.value.count > 50) previous.value = current.value
  current.value = null
  pendingRun = false
  send({ type: 'reset' })
  plotPending = true
}

watch(() => ({ ...live }), (value) => {
  if (current.value && (runState.value === 'running' || runState.value === 'paused')) current.value.mixed = true
  send({ type: 'live', live: value })
}, { deep: true })
watch(() => ({ ...scene }), (value) => send({ type: 'scene', scene: value }), { deep: true })
watch(speed, (value) => send({ type: 'speed', speed: value }))
// the host page may drive the initial choices (the landing page's soft / rigid switch): follow them, and with autorun run a new pick
watch(() => props.object, (value) => {
  scene.object = value
  if (props.autorun && autorunDone && loaded.value && visible) {
    if (runState.value === 'running' || runState.value === 'paused') send({ type: 'reset' })
    runState.value = 'ready'
    startRun()
  }
})
watch(() => props.controller, (value) => (live.controller = value))
watch(() => props.build, (value) => (scene.build = value))

// ------------------------------------------------------------------------------------------------------------ layout: draggable splits
function readStored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode: just not remembered */
  }
}
function clampPanel(width: number) {
  const container = root.value?.clientWidth ?? 1200
  return Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, container - 380, width)))
}
function startPanelDrag(event: PointerEvent) {
  if (narrow.value || folded.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startWidth = panelWidth.value
  const move = (e: PointerEvent) => (panelWidth.value = clampPanel(startWidth - (e.clientX - startX)))
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    store(STORE.panel, String(panelWidth.value))
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}
function onPanelKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 10
  if (event.key === 'ArrowLeft') panelWidth.value = clampPanel(panelWidth.value + step)
  else if (event.key === 'ArrowRight') panelWidth.value = clampPanel(panelWidth.value - step)
  else return
  event.preventDefault()
  store(STORE.panel, String(panelWidth.value))
}
function toggleFold() {
  folded.value = !folded.value
  store(STORE.folded, folded.value ? '1' : '0')
}
function startStageDrag(event: PointerEvent) {
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const startY = event.clientY
  const startHeight = stageHeight.value
  const move = (e: PointerEvent) => (stageHeight.value = Math.round(Math.max(STAGE_MIN, Math.min(STAGE_MAX, startHeight + e.clientY - startY))))
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    store(STORE.stage, String(stageHeight.value))
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}
function onStageKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 10
  if (event.key === 'ArrowUp') stageHeight.value = Math.max(STAGE_MIN, stageHeight.value - step)
  else if (event.key === 'ArrowDown') stageHeight.value = Math.min(STAGE_MAX, stageHeight.value + step)
  else return
  event.preventDefault()
  store(STORE.stage, String(stageHeight.value))
}

// ------------------------------------------------------------------------------------------------------------ drawing
function viewLook() {
  return {
    background: cssVar('--pt-viewport-bg', isDark.value ? '#141c1a' : '#ece7da'),
    floor: cssVar('--pt-viewport-floor', isDark.value ? '#1c2724' : '#ddd6c4'),
    grid: cssVar('--pt-line', '#cfc7b4'),
    arm: cssVar('--pt-arm', '#b7bec2'),
    belt: cssVar('--pt-belt', '#2c3433'),
    ghost: cssVar('--pt-brand', '#0f766e'),
    force: cssVar('--pt-accent', '#c2410c'),
    forceHigh: cssVar('--pt-warn', '#b42318'),
  }
}
function plotLook() {
  return {
    text: cssVar('--pt-text', '#17201f'),
    muted: cssVar('--pt-text-3', '#74827e'),
    grid: cssVar('--pt-line', '#ddd5c3'),
    band: cssVar('--pt-brand-soft', 'rgba(15,118,110,0.1)'),
    trace: cssVar('--pt-accent', '#c2410c'),
    previous: cssVar('--pt-text-3', '#9aa5a1'),
    reference: cssVar('--pt-text', '#17201f'),
    peak: cssVar('--pt-warn', '#b42318'),
    font: cssVar('--pt-font-mono', 'ui-monospace, monospace'),
  }
}
let lookCache = { view: viewLook(), plot: plotLook() }
function refreshLook() {
  lookCache = { view: viewLook(), plot: plotLook() }
  view?.setLook(lookCache.view)
  plotPending = true
  framePending = true
}

function toTrace(run: RunRecord | null): Trace | null {
  return run ? { fz: run.trace, count: run.count, t0: run.t0, dt: 0.001 } : null
}

function drawPlot() {
  const canvasEl = plotCanvas.value
  const wrap = plotWrap.value
  const l = loaded.value
  if (!canvasEl || !wrap || !l) return
  const run = current.value
  const ref0 = matchedReference.value
  const f = frame.value
  const running = runState.value === 'running' || runState.value === 'paused'
  const now = running && f ? f.t : l.endS
  const metrics = run?.metrics
  drawForcePlot(canvasEl, wrap.clientWidth, canvasEl.clientHeight || 170, {
    look: lookCache.plot,
    current: toTrace(run),
    previous: toTrace(previous.value),
    reference: ref0 ? { fz: ref0.trace.fz, count: ref0.trace.fz.length, t0: ref0.trace.t0, dt: ref0.trace.dt } : null,
    now,
    windowS: running ? 1.5 : null,
    startS: -l.leadS,
    endS: l.endS,
    dwell: [l.phases.dwell, l.phases.lift],
    peak: metrics && metrics.impactPeakS != null ? { t: metrics.impactPeakS, value: metrics.impactPeakN } : null,
    dwellMean: metrics && (runState.value === 'done' || (f && f.t >= l.phases.lift)) ? metrics.dwellMeanN : null,
  })
}

function animate() {
  rafId = 0
  if (!visible) return
  if (framePending && frame.value && view) {
    view.update(frame.value)
    framePending = false
  }
  view?.render()
  if (plotPending) {
    plotPending = false
    drawPlot()
  }
  rafId = requestAnimationFrame(animate)
}

function setVisible(next: boolean) {
  if (next === visible) return
  visible = next
  send({ type: 'visible', visible: next })
  if (next && !rafId) {
    plotPending = true
    rafId = requestAnimationFrame(animate)
  }
  if (next && props.autorun && !autorunDone && loaded.value) startRun()
}

onMounted(async () => {
  panelWidth.value = readStored(STORE.panel, 340)
  stageHeight.value = readStored(STORE.stage, 430)
  try {
    folded.value = localStorage.getItem(STORE.folded) === '1'
  } catch {
    /* default unfolded */
  }
  const element = root.value!
  const resize = new ResizeObserver(() => {
    narrow.value = element.clientWidth < NARROW_PX
    if (!narrow.value) panelWidth.value = clampPanel(panelWidth.value)
    const c = canvas.value
    if (c && view) view.resize(c.clientWidth, c.clientHeight)
    plotPending = true
  })
  resize.observe(element)
  observers.push(resize)
  const intersection = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting) && !document.hidden), { threshold: 0 })
  intersection.observe(element)
  observers.push(intersection)
  const onHidden = () => setVisible(!document.hidden && isOnScreen())
  document.addEventListener('visibilitychange', onHidden)
  observers.push({ disconnect: () => document.removeEventListener('visibilitychange', onHidden) })
  stopLook = onLookChange(refreshLook)

  const { LiveView } = await import('../lib/livepick/view')
  if (!canvas.value) return
  view = new LiveView(canvas.value)
  refreshLook()
  view.resize(canvas.value.clientWidth, canvas.value.clientHeight)
  worker = new Worker(new URL('../lib/livepick/worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<ToPage>) => onWorker(event.data)
  worker.onerror = (event) => (errorText.value = event.message || 'the simulation worker failed to start')
  send({ type: 'init', base: withBase('/'), wasmUrl: new URL(wasmUrl, window.location.href).href, scene: { ...scene }, live: { ...live }, speed: speed.value })
  send({ type: 'visible', visible })
  fetch(withBase('/data/livepick-reference.json'))
    .then((response) => (response.ok ? response.json() : null))
    .then((file) => (reference.value = file))
    .catch(() => undefined)
})

function isOnScreen() {
  const rect = root.value?.getBoundingClientRect()
  return !!rect && rect.bottom > 0 && rect.top < window.innerHeight
}

onBeforeUnmount(() => {
  observers.forEach((observer) => observer.disconnect())
  observers = []
  stopLook?.()
  if (rafId) cancelAnimationFrame(rafId)
  worker?.terminate()
  worker = null
  view?.dispose()
  view = null
})

watch([current, previous, matchedReference], () => (plotPending = true))
watch(stageHeight, () => {
  requestAnimationFrame(() => {
    const c = canvas.value
    if (c && view) view.resize(c.clientWidth, c.clientHeight)
  })
})

const runLabel = computed(() => (runState.value === 'running' ? 'Pause' : runState.value === 'paused' ? 'Resume' : 'Run pick'))
const progress = computed(() => {
  const f = frame.value
  return f && f.totalTicks ? Math.min(1, f.tick / f.totalTicks) : 0
})
</script>

<template>
  <div
    ref="root"
    class="livepick"
    :class="{ 'is-narrow': narrow, 'is-folded': folded && !narrow }"
    :style="{ '--lp-panel': `${panelWidth}px`, '--lp-stage': `${narrow ? 330 : stageHeight}px` }"
    data-testid="livepick"
    :data-state="runState"
    :data-t="frame ? frame.t.toFixed(3) : ''"
  >
    <div class="lp-main">
      <div class="lp-stage">
        <canvas ref="canvas" class="lp-canvas" data-testid="livepick-canvas" aria-label="The live MuJoCo pick: arm, belt and suction tool" />
        <div class="lp-hud">
          <span class="lp-hud-time">t = {{ fmt(frame?.t, 3) }} s</span>
          <span class="lp-hud-phase">{{ phaseName }}</span>
          <span v-if="realtimeText" class="lp-hud-rate" :class="{ 'is-warn': frame?.behind }" data-testid="livepick-realtime">{{ realtimeText }}</span>
        </div>
        <div class="lp-key">
          <span><i class="lp-dot" /> reference tcp, tied to the tool by the spring</span>
          <span><i class="lp-arrow" /> contact force</span>
        </div>
        <div class="lp-progress" :style="{ width: `${100 * progress}%` }" />
        <div v-if="status || errorText" class="lp-loading" :class="{ 'is-error': errorText }">{{ errorText || status }}</div>
        <div v-if="runState === 'diverged'" class="lp-banner" role="status">
          Unstable: {{ frame?.metrics.reason }} at t = {{ fmt(frame?.t, 2) }} s. Reset to try again.
        </div>
      </div>
      <div
        v-if="!narrow"
        class="lp-hsplit"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the view"
        tabindex="0"
        data-testid="livepick-stage-split"
        @pointerdown="startStageDrag"
        @keydown="onStageKey"
      />
      <div class="lp-readouts">
        <section class="lp-force">
          <header class="lp-row-head">
            <h4>Contact force</h4>
            <span class="lp-figures" data-testid="livepick-metrics">
              impact <b data-testid="livepick-impact">{{ fmt(shownMetrics?.impactPeakN) }}</b> N · dwell mean <b>{{ fmt(shownMetrics?.dwellMeanN) }}</b> N · now
              <b data-testid="livepick-fz">{{ fmt(frame?.fzNow) }}</b> N
            </span>
          </header>
          <div ref="plotWrap" class="lp-plot">
            <canvas ref="plotCanvas" class="lp-plot-canvas" data-testid="livepick-plot" />
          </div>
          <p class="lp-plot-key">
            <span><i class="lp-swatch lp-swatch-now" /> this pick</span>
            <span v-if="previous"><i class="lp-swatch lp-swatch-prev" /> previous pick</span>
            <span v-if="matchedReference" data-testid="livepick-python-ref">
              <i class="lp-swatch lp-swatch-ref" /> Python (pick.run_case):
              {{ fmt(matchedReference.metrics.impact_peak_fz_n as number) }} N impact, {{ fmt(matchedReference.metrics.dwell_fz_mean_n as number) }} N dwell
            </span>
            <span><i class="lp-swatch lp-swatch-band" /> dwell</span>
          </p>
        </section>
        <section class="lp-torque">
          <header class="lp-row-head">
            <h4>Joint torque <span class="lp-sub">share of each joint's cap</span></h4>
            <span class="lp-legend"><i class="lp-swatch lp-swatch-pd" /> board PD <i class="lp-swatch lp-swatch-ff" /> host feed-forward</span>
          </header>
          <div class="lp-bars">
            <div v-for="row in torqueRows" :key="row.label" class="lp-bar-row" :class="{ 'is-clamped': row.clamped }">
              <span class="lp-bar-label">{{ row.label }}</span>
              <span class="lp-bar-track">
                <i class="lp-bar lp-bar-pd" :style="barStyle(row.pd)" />
                <i class="lp-bar lp-bar-ff" :style="barStyle(row.ff)" />
                <i class="lp-bar-mid" />
              </span>
              <span class="lp-bar-value">{{ fmt(row.applied) }} / {{ row.cap }} N·m</span>
            </div>
          </div>
          <div class="lp-scale-row">
            <span class="lp-scale">stiffness scale s <b data-testid="livepick-scale">{{ fmt(frame?.stiffnessScale, 2) }}</b>
              <span class="lp-meter"><i :style="{ width: `${100 * Math.min(1, frame?.stiffnessScale ?? 0)}%` }" /></span>
            </span>
            <span class="lp-stability" :class="{ 'is-warn': stability.warn }" :title="stability.detail" data-testid="livepick-stability">{{ stability.label }}</span>
          </div>
          <p class="lp-stability-detail">{{ stability.detail }}</p>
        </section>
      </div>
    </div>

    <div
      v-if="!narrow"
      class="lp-vsplit"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the controls (double-click folds them)"
      tabindex="0"
      data-testid="livepick-panel-split"
      @pointerdown="startPanelDrag"
      @dblclick="toggleFold"
      @keydown="onPanelKey"
    >
      <button class="lp-fold" type="button" :aria-label="folded ? 'Show the controls' : 'Hide the controls'" data-testid="livepick-fold" @pointerdown.stop @click="toggleFold">
        {{ folded ? '‹' : '›' }}
      </button>
    </div>

    <aside v-show="narrow || !folded" class="lp-panel" data-testid="livepick-panel">
      <div class="lp-actions">
        <button class="lp-btn lp-btn-primary" type="button" data-testid="livepick-run" :disabled="!loaded" @click="startRun">{{ runLabel }}</button>
        <button class="lp-btn" type="button" data-testid="livepick-reset" :disabled="!loaded" @click="resetRun">Reset</button>
        <div class="lp-seg lp-speed" role="radiogroup" aria-label="Playback speed">
          <button v-for="option in SPEEDS" :key="option.value" type="button" role="radio" :aria-checked="speed === option.value" :class="{ on: speed === option.value }" @click="speed = option.value">{{ option.label }}</button>
        </div>
      </div>

      <fieldset class="lp-group">
        <legend>Controller <span class="lp-live-tag">live</span></legend>
        <div class="lp-seg lp-seg-wrap" role="radiogroup" aria-label="Controller" data-testid="livepick-controller">
          <button v-for="option in CONTROLLERS" :key="option.id" type="button" role="radio" :data-value="option.id" :aria-checked="live.controller === option.id" :class="{ on: live.controller === option.id }" @click="live.controller = option.id">{{ option.label }}</button>
        </div>
        <p class="lp-hint">{{ controllerHint }}</p>
      </fieldset>

      <fieldset class="lp-group" :disabled="!impedanceActive">
        <legend>Impedance <span class="lp-live-tag">live</span></legend>
        <label class="lp-field">
          <span>K<sub>xy</sub> <b data-testid="livepick-kxy">{{ live.kxy.toLocaleString('en-US') }}</b> N/m</span>
          <input v-model.number="kxyPosition" type="range" min="0" max="1000" step="1" aria-label="Kxy" data-testid="livepick-kxy-slider" />
        </label>
        <label class="lp-field">
          <span>K<sub>z</sub> <b data-testid="livepick-kz">{{ live.kz.toLocaleString('en-US') }}</b> N/m</span>
          <input v-model.number="kzPosition" type="range" min="0" max="1000" step="1" aria-label="Kz" data-testid="livepick-kz-slider" />
        </label>
        <label class="lp-field">
          <span>ζ <b>{{ live.zeta }}</b></span>
          <input v-model.number="zetaIndex" type="range" min="0" :max="ZETAS.length - 1" step="1" aria-label="damping ratio" />
        </label>
        <p v-if="!impedanceActive" class="lp-hint">Stiff ignores these: every board runs its base gains.</p>
      </fieldset>

      <fieldset class="lp-group">
        <legend>Host loop <span class="lp-live-tag">live</span></legend>
        <div class="lp-seg" role="radiogroup" aria-label="Host rate" data-testid="livepick-rate">
          <button v-for="rate in RATES" :key="rate" type="button" role="radio" :data-value="rate" :aria-checked="live.hostRateHz === rate" :class="{ on: live.hostRateHz === rate }" @click="live.hostRateHz = rate">{{ rate }} Hz</button>
        </div>
        <label class="lp-field">
          <span>state → torque delay <b data-testid="livepick-delay">{{ delayMs }}</b> ms</span>
          <input v-model.number="delayMs" type="range" min="0" max="10" step="0.5" aria-label="host delay" data-testid="livepick-delay-slider" />
        </label>
        <label class="lp-check" :class="{ 'is-off': !guardApplies }">
          <input v-model="live.guard" type="checkbox" data-testid="livepick-guard" :disabled="!guardApplies" />
          <span>Host ceiling guard <small>(½ of the delayed loop's stability ceiling; torque and host-spring modes)</small></span>
        </label>
        <div class="lp-seg" role="radiogroup" aria-label="Friction feed-forward" data-testid="livepick-friction">
          <button type="button" role="radio" :aria-checked="live.friction === 'reference'" :class="{ on: live.friction === 'reference' }" @click="live.friction = 'reference'">Friction FF: reference</button>
          <button type="button" role="radio" :aria-checked="live.friction === 'contact_aware'" :class="{ on: live.friction === 'contact_aware' }" @click="live.friction = 'contact_aware'">contact-aware</button>
        </div>
      </fieldset>

      <fieldset class="lp-group">
        <legend>Plant <span class="lp-next-tag" :class="{ 'is-pending': scenePending }">{{ scenePending ? 'applies on the next pick' : 'per pick' }}</span></legend>
        <div class="lp-seg" role="radiogroup" aria-label="Arm build" data-testid="livepick-build">
          <button v-for="option in BUILDS" :key="option.id" type="button" role="radio" :data-value="option.id" :aria-checked="scene.build === option.id" :class="{ on: scene.build === option.id }" @click="scene.build = option.id">{{ option.label }}</button>
        </div>
        <div class="lp-seg" role="radiogroup" aria-label="Object" data-testid="livepick-object">
          <button type="button" role="radio" :aria-checked="scene.object === 'rigid'" :class="{ on: scene.object === 'rigid' }" @click="scene.object = 'rigid'">Rigid object</button>
          <button type="button" role="radio" :aria-checked="scene.object === 'soft'" :class="{ on: scene.object === 'soft' }" @click="scene.object = 'soft'">Soft object</button>
        </div>
        <label class="lp-check">
          <input v-model="scene.compensator" type="checkbox" data-testid="livepick-compensator" />
          <span>Passive compensator <small>(200 N/m spring, 4 N preload, 30 mm, under the tip)</small></span>
        </label>
        <label class="lp-field">
          <span>approach <b>{{ approachLabel }}</b></span>
          <input v-model.number="scene.approachMS" type="range" min="0.02" max="0.2" step="0.01" aria-label="approach speed" data-testid="livepick-approach" />
        </label>
      </fieldset>

      <details class="lp-info">
        <summary>What is running here</summary>
        <p>
          MuJoCo 3.15 (WebAssembly) in a Web Worker steps a UR5e-like arm (Menagerie's kinematics and inertias, drawn with capsules), a belt
          at 0.25 m/s and a suction tool at 4 kHz. The object is 10 mm taller than the robot believes, so the tool meets it while still
          descending; mid-dwell a 20 N side push lasts 0.2 s.
        </p>
        <p>
          The loop is bam_impedance_controller's <code>sim/loop.py</code>, tick for tick: every joint's board runs moteus' PD every physics step
          behind 0.5 ms of sensing delay, encoder quantization, a 200 Hz velocity filter and a 300 Hz torque lag; the host samples the
          trajectory controller at the chosen rate and its command latches on the boards after the chosen delay. The impedance law is the
          site's TypeScript port, held to the Python by golden vectors.
        </p>
        <p>
          Held to the Python (<code>tests/unit/livepick.faithful.test.ts</code>): on eight reference picks (<code>pick.run_case</code> at the same
          4 kHz) the browser's impact peak and dwell mean agree within 0.4 % (tolerance 2 %), and on the two unguarded high-K picks torque
          mode pins its torques at their caps in both while host spring never does; the joint path agrees within 5e-12 rad. Nothing in the loop is simplified. What differs: MuJoCo 3.15
          here, 3.11 in the Python; ζ snaps to the six values the board ceilings were exported for. With the compensator on, 4 kHz is not
          converged for its 50 g tip (41.0 N here, 37.2 N at 32 kHz in the Python study).
        </p>
      </details>
    </aside>
  </div>
</template>

<style scoped>
.livepick {
  --lp-gap: 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12px var(--lp-panel);
  gap: 0;
  width: 100%;
  min-width: 0;
  color: var(--pt-text, var(--vp-c-text-1));
  font-family: var(--pt-font-base, inherit);
  background: var(--pt-card, var(--vp-c-bg));
  border: var(--pt-border-w, 1px) solid var(--pt-line, var(--vp-c-divider));
  border-radius: var(--pt-radius, 14px);
  box-shadow: var(--pt-shadow, none);
  overflow: hidden;
}
.livepick.is-folded {
  grid-template-columns: minmax(0, 1fr) 12px 0;
}
.livepick.is-narrow {
  grid-template-columns: minmax(0, 1fr);
}
.lp-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.lp-stage {
  position: relative;
  height: var(--lp-stage);
  min-height: 200px;
  background: var(--pt-viewport-bg, #ece7da);
}
.lp-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
}
.lp-hud {
  position: absolute;
  top: 10px;
  left: 12px;
  right: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font: 12px/1.4 var(--pt-font-mono, ui-monospace, monospace);
  color: var(--pt-text-2, #44524f);
  pointer-events: none;
}
.lp-hud-time {
  color: var(--pt-text, #17201f);
  font-weight: 600;
}
.lp-hud-rate.is-warn {
  color: var(--pt-warn, #b42318);
  font-weight: 600;
}
.lp-key {
  position: absolute;
  left: 12px;
  bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: var(--pt-text-3, #74827e);
  pointer-events: none;
}
.lp-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--pt-brand, #0f766e);
  opacity: 0.6;
  vertical-align: -1px;
}
.lp-arrow {
  display: inline-block;
  width: 3px;
  height: 11px;
  background: var(--pt-accent, #c2410c);
  vertical-align: -1px;
}
.lp-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--pt-brand, #0f766e);
  opacity: 0.6;
}
.lp-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font: 13px var(--pt-font-mono, ui-monospace, monospace);
  color: var(--pt-text-2, #44524f);
  background: color-mix(in srgb, var(--pt-viewport-bg, #ece7da) 85%, transparent);
}
.lp-loading.is-error {
  color: var(--pt-warn, #b42318);
}
.lp-banner {
  position: absolute;
  left: 50%;
  top: 44px;
  transform: translateX(-50%);
  max-width: calc(100% - 24px);
  padding: 8px 12px;
  border-radius: var(--pt-radius-sm, 10px);
  background: var(--pt-warn-soft, rgba(180, 35, 24, 0.08));
  border: 1px solid var(--pt-warn, #b42318);
  color: var(--pt-warn, #b42318);
  font-size: 13px;
  font-weight: 600;
}
.lp-hsplit {
  height: 8px;
  cursor: row-resize;
  background: var(--pt-line, #ddd5c3);
  background-clip: content-box;
  padding: 3px 0;
  touch-action: none;
}
.lp-hsplit:hover,
.lp-hsplit:focus-visible,
.lp-vsplit:hover,
.lp-vsplit:focus-visible {
  background-color: var(--pt-brand, #0f766e);
  outline: none;
}
.lp-readouts {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: var(--lp-gap);
  padding: 12px;
}
.is-narrow .lp-key {
  display: none;
}
.is-narrow .lp-readouts {
  grid-template-columns: minmax(0, 1fr);
}
.lp-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
  margin-bottom: 6px;
}
.lp-row-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.lp-sub {
  font-weight: 400;
  color: var(--pt-text-3, #74827e);
}
.lp-figures,
.lp-legend {
  font: 12px var(--pt-font-mono, ui-monospace, monospace);
  color: var(--pt-text-2, #44524f);
}
.lp-plot {
  width: 100%;
}
.lp-plot-canvas {
  display: block;
  width: 100%;
  height: 170px;
}
.lp-plot-key {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--pt-text-3, #74827e);
}
.lp-swatch {
  display: inline-block;
  width: 14px;
  height: 3px;
  margin-right: 3px;
  vertical-align: 3px;
  border-radius: 2px;
}
.lp-swatch-now {
  background: var(--pt-accent, #c2410c);
}
.lp-swatch-prev {
  background: var(--pt-text-3, #9aa5a1);
}
.lp-swatch-ref {
  background: repeating-linear-gradient(90deg, var(--pt-text, #17201f) 0 4px, transparent 4px 7px);
}
.lp-swatch-band {
  height: 9px;
  vertical-align: -1px;
  background: var(--pt-brand-soft, rgba(15, 118, 110, 0.1));
}
.lp-swatch-pd {
  background: var(--pt-brand, #0f766e);
}
.lp-swatch-ff {
  background: var(--pt-accent, #c2410c);
}
.lp-bars {
  display: grid;
  gap: 5px;
}
.lp-bar-row {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) 104px;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.lp-bar-label {
  color: var(--pt-text-2, #44524f);
}
.lp-bar-value {
  font: 11px var(--pt-font-mono, ui-monospace, monospace);
  color: var(--pt-text-3, #74827e);
  text-align: right;
  white-space: nowrap;
}
.lp-bar-row.is-clamped .lp-bar-value {
  color: var(--pt-warn, #b42318);
}
.lp-bar-track {
  position: relative;
  height: 14px;
  border-radius: 3px;
  background: var(--pt-bg-soft, #eeeadd);
}
.lp-bar {
  position: absolute;
  height: 5px;
  border-radius: 2px;
}
.lp-bar-pd {
  top: 2px;
  background: var(--pt-brand, #0f766e);
}
.lp-bar-ff {
  bottom: 2px;
  background: var(--pt-accent, #c2410c);
}
.lp-bar-mid {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--pt-text-3, #74827e);
}
.lp-scale-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  margin-top: 10px;
  font-size: 12px;
}
.lp-scale b {
  font-family: var(--pt-font-mono, ui-monospace, monospace);
}
.lp-meter {
  display: inline-block;
  position: relative;
  width: 70px;
  height: 6px;
  margin-left: 6px;
  border-radius: 3px;
  background: var(--pt-bg-soft, #eeeadd);
  vertical-align: 1px;
}
.lp-meter i {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 3px;
  background: var(--pt-brand, #0f766e);
}
.lp-stability {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--pt-good, #15803d);
  background: color-mix(in srgb, var(--pt-good, #15803d) 12%, transparent);
}
.lp-stability.is-warn {
  color: var(--pt-warn, #b42318);
  background: var(--pt-warn-soft, rgba(180, 35, 24, 0.08));
}
.lp-stability-detail {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--pt-text-3, #74827e);
}
.lp-vsplit {
  position: relative;
  cursor: col-resize;
  background: var(--pt-line, #ddd5c3);
  background-clip: content-box;
  padding: 0 5px;
  touch-action: none;
}
.lp-fold {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  width: 18px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--pt-line, #ddd5c3);
  border-radius: 6px;
  background: var(--pt-card, #fff);
  color: var(--pt-text-2, #44524f);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.lp-panel {
  min-width: 0;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  max-height: calc(var(--lp-stage) + 360px);
}
.is-narrow .lp-panel {
  max-height: none;
  border-top: 1px solid var(--pt-line, #ddd5c3);
}
.lp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.lp-btn {
  padding: 7px 14px;
  border: 1px solid var(--pt-line, #ddd5c3);
  border-radius: 8px;
  background: var(--pt-card, #fff);
  color: var(--pt-text, #17201f);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.lp-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.lp-btn-primary {
  background: var(--pt-brand, #0f766e);
  border-color: var(--pt-brand, #0f766e);
  color: var(--pt-on-deep, #fff);
  min-width: 92px;
}
.lp-group {
  margin: 0;
  padding: 8px 0 2px;
  border: 0;
  border-top: 1px solid var(--pt-line, #ddd5c3);
  display: grid;
  gap: 8px;
  min-width: 0;
}
.lp-group:disabled .lp-field {
  opacity: 0.45;
}
.lp-group legend {
  padding: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--pt-text-2, #44524f);
}
.lp-live-tag,
.lp-next-tag {
  margin-left: 6px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--pt-text-3, #74827e);
}
.lp-next-tag.is-pending {
  color: var(--pt-accent, #c2410c);
}
.lp-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.lp-seg button {
  flex: 1 1 auto;
  padding: 5px 8px;
  border: 1px solid var(--pt-line, #ddd5c3);
  border-radius: 7px;
  background: transparent;
  color: var(--pt-text-2, #44524f);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.lp-seg button.on {
  border-color: var(--pt-brand, #0f766e);
  background: var(--pt-brand-soft, rgba(15, 118, 110, 0.1));
  color: var(--pt-text, #17201f);
  font-weight: 600;
}
.lp-speed button {
  flex: 0 0 auto;
}
.lp-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--pt-text-3, #74827e);
}
.lp-field {
  display: grid;
  gap: 2px;
  font-size: 12px;
  color: var(--pt-text-2, #44524f);
}
.lp-field b {
  font-family: var(--pt-font-mono, ui-monospace, monospace);
  color: var(--pt-text, #17201f);
}
.lp-field input[type='range'] {
  width: 100%;
  accent-color: var(--pt-brand, #0f766e);
}
.lp-check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12px;
  color: var(--pt-text-2, #44524f);
}
.lp-check input {
  margin-top: 2px;
  accent-color: var(--pt-brand, #0f766e);
}
.lp-check small {
  color: var(--pt-text-3, #74827e);
}
.lp-check.is-off {
  opacity: 0.5;
}
.lp-info {
  border-top: 1px solid var(--pt-line, #ddd5c3);
  padding-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--pt-text-2, #44524f);
}
.lp-info summary {
  cursor: pointer;
  font-weight: 600;
}
.lp-info p {
  margin: 6px 0 0;
}
</style>
