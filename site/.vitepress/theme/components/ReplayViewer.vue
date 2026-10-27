<script setup lang="ts">
// In-browser replay of the tuner's evidence: the same held-out motion under factory, analytic, tuned and oracle
// controllers, side by side in MuJoCo, with the error plot and the scores under it. Data contract: lib/replay.ts.
// Everything that touches window, WebGL or WASM runs in onMounted, so VitePress can server-render the page.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { withBase } from 'vitepress'
import { cssVar, onLookChange } from '../lib/variants'
import type { JointController, RobotData, RobotIndex, RungId, Tape } from '../lib/replay'
import {
  RUNG_IDS,
  RUNG_NAMES,
  displayPosition,
  errorAt,
  errorTrace,
  fmt3,
  fmtRatio,
  positionUnit,
  sampleAt,
  tapeDuration,
  tapeT0,
  timeGrid,
  rerunUrl,
} from '../lib/replay'
import type { PaneRect, ReplayScene } from '../lib/scene'
import type { ErrorPlot, PlotData, PlotScale } from '../lib/errorplot'

const props = withDefaults(
  defineProps<{
    robot?: string
    rungs?: RungId[]
    picker?: boolean
    compact?: boolean
    autoplay?: boolean
    height?: number | string
  }>(),
  { robot: 'ur5e', rungs: () => [...RUNG_IDS], picker: false, compact: false, autoplay: false, height: 360 },
)

const SPEEDS = [0.25, 0.5, 1]
const PANE_GAP = 8
const NARROW = 760

// ---------------------------------------------------------------- state
const index = shallowRef<RobotIndex | null>(null)
const robotId = ref(props.robot)
const data = shallowRef<RobotData | null>(null)
const tapeName = ref('')
const jointSel = ref('all')
const status3d = ref<'loading' | 'ready' | 'error'>('loading')
const error3d = ref('')
const dataError = ref('')
const time = ref(0)
const playing = ref(false)
const speed = ref(1)
const loop = ref(true)
const scale = ref<PlotScale>('log')
const hoverT = ref<number | null>(null)
const hoverX = ref(0)
const rects = ref<PaneRect[]>([])
const stageHeight = ref(0)

const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const plotBox = ref<HTMLElement | null>(null)
const plotCanvas = ref<HTMLCanvasElement | null>(null)

const activeRungs = computed(() => RUNG_IDS.filter((r) => props.rungs.includes(r)))
const tape = computed<Tape | null>(() => data.value?.tapes.find((t) => t.name === tapeName.value) ?? data.value?.tapes[0] ?? null)
const unit = computed(() => data.value?.unit ?? 'mrad')
const start = computed(() => (tape.value ? tapeT0(tape.value) : 0))
const end = computed(() => (tape.value ? tapeDuration(tape.value) : 1))
const multiJoint = computed(() => (data.value?.joints.length ?? 0) > 1)
const selectedJoints = computed(() => {
  const joints = data.value?.joints.map((j) => j.name) ?? []
  return jointSel.value === 'all' || !joints.includes(jointSel.value) ? joints : [jointSel.value]
})

// ---------------------------------------------------------------- scores
function controller(rung: RungId, joint: string): JointController | undefined {
  return data.value?.rungs[rung]?.[joint]
}

/** Tracking RMS for a pane label: the selected joint's, or the robot's headline (mean over its joints). */
function trackingRms(rung: RungId): number | undefined {
  const d = data.value
  if (!d) return undefined
  if (selectedJoints.value.length === 1) return controller(rung, selectedJoints.value[0])?.score.tracking_rms_mrad
  const headline = index.value?.[d.robot]?.headline[rung]?.tracking_rms
  if (headline !== undefined) return headline
  const values = d.joints.map((j) => controller(rung, j.name)?.score.tracking_rms_mrad ?? NaN)
  return values.reduce((a, b) => a + b, 0) / values.length
}

interface Row {
  rung: RungId
  kp: string
  kd: string
  feedforward: string
  stop: string
  tracking: string
  max: string
  saturation: string
}

const rows = computed<Row[]>(() => {
  const d = data.value
  if (!d) return []
  const joints = selectedJoints.value
  return activeRungs.value.map((rung) => {
    if (joints.length === 1) {
      const c = controller(rung, joints[0])
      return {
        rung,
        kp: fmt3(c?.kp),
        kd: fmt3(c?.kd),
        feedforward: c?.feedforward ?? '—',
        stop: fmt3(c?.score.stop_p90_mrad),
        tracking: fmt3(c?.score.tracking_rms_mrad),
        max: fmt3(c?.score.max_error_mrad),
        saturation: c ? `${fmt3(100 * c.score.saturation)} %` : '—',
      }
    }
    const scores = joints.map((j) => controller(rung, j)?.score).filter((s) => !!s)
    const headline = index.value?.[d.robot]?.headline[rung]
    return {
      rung,
      kp: 'per joint',
      kd: 'per joint',
      feedforward: 'per joint',
      stop: fmt3(headline?.stop_p90),
      tracking: fmt3(headline?.tracking_rms ?? trackingRms(rung)),
      max: fmt3(Math.max(...scores.map((s) => s!.max_error_mrad))),
      saturation: `${fmt3(100 * Math.max(...scores.map((s) => s!.saturation)))} %`,
    }
  })
})

/** The lever case: the analytic start tracks better than tuned, but the tuner refused it for saturating the drive. */
const saturationNote = computed(() => {
  const d = data.value
  if (!d || selectedJoints.value.length !== 1 || !activeRungs.value.includes('analytic') || !activeRungs.value.includes('tuned')) return ''
  const joint = selectedJoints.value[0]
  const analytic = controller('analytic', joint)?.score
  const tuned = controller('tuned', joint)?.score
  if (!analytic || !tuned) return ''
  if (!(analytic.tracking_rms_mrad < tuned.tracking_rms_mrad && analytic.saturation > tuned.saturation)) return ''
  return (
    `Why does the analytic start track better than tuned here? It held the drive at its torque limit for ` +
    `${fmt3(100 * analytic.saturation)} % of the held-out motion (tuned: ${fmt3(100 * tuned.saturation)} %). ` +
    `The tuner refuses a controller that leans on the torque limit, so it did not keep these gains.`
  )
})

interface Card {
  id: string
  title: string
  joints: number
  line: string
}

const cards = computed<Card[]>(() =>
  Object.entries(index.value ?? {}).map(([id, s]) => {
    const factory = s.headline.factory?.tracking_rms
    const tuned = s.headline.tuned?.tracking_rms
    const line =
      factory !== undefined && tuned !== undefined
        ? `factory → tuned: ${fmt3(factory)} → ${fmt3(tuned)} ${s.unit} (${fmtRatio(factory / tuned)} lower)`
        : ''
    return { id, title: s.title, joints: s.joints, line }
  }),
)

// ---------------------------------------------------------------- plot data
const plotData = computed<PlotData | null>(() => {
  const d = data.value
  const tp = tape.value
  if (!d || !tp) return null
  const times = timeGrid(tp)
  const joints = selectedJoints.value
  // The strip shows one joint: the selected one, or the one that moves the most when "all joints" is picked
  let shown = d.joints.find((j) => j.name === joints[0]) ?? d.joints[0]
  if (joints.length > 1) {
    let widest = -1
    for (const j of d.joints) {
      const s = tp.target[j.name]
      if (!s) continue
      const range = displayPosition(j, Math.max(...s.q)) - displayPosition(j, Math.min(...s.q))
      if (range > widest) {
        widest = range
        shown = j
      }
    }
  }
  const positions = (series: { t0: number; q: number[] } | undefined) =>
    Float64Array.from(times, (t) => (series ? displayPosition(shown, sampleAt(series.q, series.t0, tp.dt, t)) : NaN))
  return {
    times,
    unit: d.unit,
    errors: activeRungs.value.map((rung) => ({ rung, values: errorTrace(tp, rung, joints, times) })),
    position: {
      label: joints.length > 1 ? `${shown.name}, the joint that moves most` : shown.name,
      joint: shown.name,
      unit: positionUnit(shown),
      target: positions(tp.target[shown.name]),
      actual: activeRungs.value.map((rung) => ({ rung, values: positions(tp.rungs[rung]?.[shown.name]) })),
    },
  }
})

const hoverValues = computed(() => {
  const t = hoverT.value
  const tp = tape.value
  if (t === null || !tp) return []
  return activeRungs.value.map((rung) => ({
    rung,
    value: Math.max(...selectedJoints.value.map((j) => errorAt(tp, rung, j, t)).filter((v) => !Number.isNaN(v))),
  }))
})

// ---------------------------------------------------------------- engine (client only)
let scene: ReplayScene | null = null
let plot: ErrorPlot | null = null
let mujocoPromise: Promise<import('@mujoco/mujoco').MainModule> | null = null
let raf = 0
let last = 0
let dirty = true
let onScreen = true
let pageVisible = true
let loadToken = 0
let lastCols = 0
let disposers: (() => void)[] = []

function invalidate() {
  dirty = true
  schedule()
}

function schedule() {
  if (!raf && onScreen && pageVisible && typeof window !== 'undefined') raf = requestAnimationFrame(frame)
}

function frame(now: number) {
  raf = 0
  const step = last ? Math.min(0.1, (now - last) / 1000) : 0
  last = now
  if (playing.value) {
    let t = time.value + step * speed.value
    if (t > end.value) {
      if (loop.value) t = start.value
      else {
        t = end.value
        playing.value = false
      }
    }
    time.value = t
  }
  if (playing.value || dirty) {
    dirty = false
    if (scene && status3d.value === 'ready') {
      scene.setTime(time.value)
      scene.render()
    }
    plot?.draw(time.value, hoverT.value)
  }
  if (playing.value) schedule()
  else last = 0
}

function readLook() {
  if (scene) {
    scene.setLook({
      viewportBg: cssVar('--pt-viewport-bg', '#eef3f8'),
      floor: cssVar('--pt-viewport-floor', '#dde6ef'),
      ghost: cssVar('--pt-ghost', 'rgba(15, 76, 129, 0.22)'),
      link: cssVar('--pt-text-2', '#3d5166'),
      ink: cssVar('--pt-text-3', '#6b7d90'),
      // WHY a fallback: the design tokens have no warning colour yet; --pt-warn is read first so a variant can set one
      warn: cssVar('--pt-warn', '#e5484d'),
    })
  }
  plot?.setLook({
    text: cssVar('--pt-text', '#0b1b2b'),
    text2: cssVar('--pt-text-2', '#3d5166'),
    text3: cssVar('--pt-text-3', '#6b7d90'),
    line: cssVar('--pt-line', '#d9e2ec'),
    font: cssVar('--pt-font-mono', 'monospace'),
    rungs: Object.fromEntries(RUNG_IDS.map((r) => [r, cssVar(`--pt-rung-${r}`, '#888')])) as Record<RungId, string>,
  })
  updateMask()
  invalidate()
}

function px(value: string, fallback: number): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

/** Round the panes' corners with a CSS mask on the one canvas, so the page behind shows through whatever it is. */
function updateMask() {
  const el = canvas.value
  if (!el || rects.value.length === 0) return
  const width = el.clientWidth || 1
  const radius = px(cssVar('--pt-radius-sm', '8px'), 8)
  const shapes = rects.value.map((r) => `<rect x='${r.x}' y='${r.y}' width='${r.w}' height='${r.h}' rx='${radius}'/>`).join('')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${stageHeight.value}'>${shapes}</svg>`
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  el.style.setProperty('mask-image', url)
  el.style.setProperty('-webkit-mask-image', url)
  el.style.setProperty('mask-size', '100% 100%')
  el.style.setProperty('-webkit-mask-size', '100% 100%')
}

function layout() {
  const el = stage.value
  if (!el) return
  const width = Math.max(1, Math.floor(el.clientWidth))
  const n = activeRungs.value.length
  const wide = width >= NARROW || (props.compact && n <= 2)
  const cols = wide ? n : Math.min(2, n)
  const rowsCount = Math.ceil(n / cols)
  const paneW = Math.floor((width - PANE_GAP * (cols - 1)) / cols)
  let paneH: number
  if (props.compact) {
    const total = typeof props.height === 'number' ? props.height : px(String(props.height), 360)
    paneH = Math.floor((total - PANE_GAP * (rowsCount - 1)) / rowsCount)
  } else {
    paneH = Math.round(Math.min(440, Math.max(170, paneW * (cols >= 4 ? 1.1 : 1.0))))
  }
  const next: PaneRect[] = []
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    next.push({ x: c * (paneW + PANE_GAP), y: r * (paneH + PANE_GAP), w: paneW, h: paneH })
  }
  rects.value = next
  stageHeight.value = rowsCount * paneH + PANE_GAP * (rowsCount - 1)
  if (scene) {
    scene.layout(width, stageHeight.value, next)
    if (cols !== lastCols && status3d.value === 'ready') scene.fit()
  }
  lastCols = cols
  if (plot && plotBox.value) plot.resize(plotBox.value.clientWidth)
  updateMask()
  invalidate()
}

async function loadIndex() {
  try {
    const response = await fetch(withBase('/data/index.json'))
    if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`)
    index.value = await response.json()
  } catch (e) {
    // The robot picker needs the index; a single robot still replays without it
    if (props.picker) dataError.value = `Could not load the robot list (${(e as Error).message}).`
  }
}

/** Seek to the factory controller's worst moment, so a paused viewer opens on the difference, not on four still robots. */
function worstMoment(): number {
  const pd = plotData.value
  const trace = pd?.errors.find((e) => e.rung === 'factory') ?? pd?.errors[0]
  if (!pd || !trace) return start.value
  let best = 0
  for (let i = 1; i < trace.values.length; i++) if (trace.values[i] > trace.values[best]) best = i
  return pd.times[best] ?? start.value
}

async function loadRobot(id: string, preferredTape?: string) {
  const token = ++loadToken
  dataError.value = ''
  let robotData: RobotData
  let xml: string
  try {
    const dataResponse = await fetch(withBase(`/data/${id}.json`))
    if (!dataResponse.ok) throw new Error(`${id}.json: HTTP ${dataResponse.status}`)
    robotData = await dataResponse.json()
    const xmlResponse = await fetch(withBase(robotData.model))
    if (!xmlResponse.ok) throw new Error(`${robotData.model}: HTTP ${xmlResponse.status}`)
    xml = await xmlResponse.text()
  } catch (e) {
    if (token === loadToken) dataError.value = `Could not load ${id} (${(e as Error).message}).`
    return
  }
  if (token !== loadToken) return

  data.value = robotData
  tapeName.value = robotData.tapes.some((t) => t.name === preferredTape) ? preferredTape! : robotData.tapes[0]?.name ?? ''
  if (!robotData.joints.some((j) => j.name === jointSel.value)) jointSel.value = 'all'
  if (robotData.joints.length === 1) jointSel.value = robotData.joints[0].name
  playing.value = false
  syncUrl()
  time.value = props.autoplay || props.compact ? start.value : worstMoment()
  await nextTick()
  layout()

  if (!scene || !mujocoPromise) return
  try {
    const mujoco = await mujocoPromise
    if (token !== loadToken) return
    scene.load(mujoco, xml, robotData, activeRungs.value)
    if (tape.value) scene.setTape(tape.value)
    readLook()
    status3d.value = 'ready'
    layout()
    scene.fit()
    invalidate()
  } catch (e) {
    if (token !== loadToken) return
    status3d.value = 'error'
    error3d.value = (e as Error)?.message ?? String(e)
  }
  if (props.autoplay || props.compact) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduced) play()
  }
}

function syncUrl() {
  if (!props.picker || typeof window === 'undefined' || !data.value) return
  const url = new URL(window.location.href)
  url.searchParams.set('robot', data.value.robot)
  if (data.value.tapes.length > 1) url.searchParams.set('tape', tapeName.value)
  else url.searchParams.delete('tape')
  window.history.replaceState(window.history.state, '', url)
}

// ---------------------------------------------------------------- controls
function play() {
  if (time.value >= end.value - 1e-6) time.value = start.value
  playing.value = true
  last = 0
  schedule()
}

function togglePlay() {
  if (playing.value) playing.value = false
  else play()
}

function seek(t: number) {
  time.value = Math.min(end.value, Math.max(start.value, t))
  invalidate()
}

function selectRobot(id: string) {
  if (id === robotId.value && data.value?.robot === id) return
  robotId.value = id
  status3d.value = scene ? 'loading' : status3d.value
  loadRobot(id)
}

function selectTape(name: string) {
  tapeName.value = name
  playing.value = false
  syncUrl()
  time.value = worstMoment()
  if (scene && tape.value) {
    scene.setTape(tape.value)
    scene.fit()
  }
  invalidate()
}

let dragging = false
function plotPointer(event: PointerEvent) {
  if (!plot) return
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - box.left
  hoverX.value = x
  hoverT.value = plot.timeAt(x)
  if (event.type === 'pointerdown') {
    dragging = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  if (dragging) seek(hoverT.value)
  else invalidate()
}

function plotRelease(event: PointerEvent) {
  dragging = false
  if (event.type === 'pointerleave' || event.pointerType !== 'mouse') hoverT.value = null
  invalidate()
}

watch([plotData], () => {
  if (plot && plotData.value) plot.setData(plotData.value)
  invalidate()
})
watch([jointSel, scale], () => {
  plot?.setScale(scale.value)
  invalidate()
})
watch(
  () => props.robot,
  (id) => {
    if (!props.picker && id !== robotId.value) selectRobot(id)
  },
)

const timeLabel = computed(() => `${time.value.toFixed(2)} s / ${end.value.toFixed(2)} s`)

// ---------------------------------------------------------------- lifecycle
onMounted(async () => {
  let initialTape: string | undefined
  if (props.picker) {
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('robot')
    if (wanted) robotId.value = wanted
    initialTape = params.get('tape') ?? undefined
    // ?joint= (the Data explorer's "Open the 3D replay"): loadRobot keeps it when the robot has that joint
    const wantedJoint = params.get('joint')
    if (wantedJoint) jointSel.value = wantedJoint
  }

  const [{ ErrorPlot }, sceneModule] = await Promise.all([import('../lib/errorplot'), import('../lib/scene').catch((e) => e as Error)])
  if (!props.compact && plotCanvas.value) {
    plot = new ErrorPlot(plotCanvas.value)
    plot.setScale(scale.value)
  }
  if (sceneModule instanceof Error) {
    status3d.value = 'error'
    error3d.value = sceneModule.message
  } else if (canvas.value) {
    try {
      scene = new sceneModule.ReplayScene(canvas.value, invalidate)
      mujocoPromise = import('../lib/mujoco').then((m) => m.loadMujoco())
    } catch (e) {
      scene = null
      status3d.value = 'error'
      error3d.value = `WebGL is not available (${(e as Error)?.message ?? e}).`
    }
  }

  const resize = new ResizeObserver(() => layout())
  if (root.value) resize.observe(root.value)
  disposers.push(() => resize.disconnect())
  const visibility = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting)
    last = 0
    if (onScreen) invalidate()
  })
  if (root.value) visibility.observe(root.value)
  disposers.push(() => visibility.disconnect())
  const onVisibility = () => {
    pageVisible = document.visibilityState !== 'hidden'
    last = 0
    if (pageVisible) invalidate()
  }
  document.addEventListener('visibilitychange', onVisibility)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
  disposers.push(onLookChange(readLook))

  readLook()
  await Promise.all([loadIndex(), loadRobot(robotId.value, initialTape)])
  if (index.value && props.picker && !index.value[robotId.value]) selectRobot(Object.keys(index.value)[0])
})

onBeforeUnmount(() => {
  loadToken++
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  for (const dispose of disposers) dispose()
  disposers = []
  scene?.dispose()
  scene = null
  plot = null
})
</script>

<template>
  <div ref="root" class="pt-replay vp-raw" :class="{ compact, picker }">
    <div v-if="picker" class="robots" role="list" aria-label="Robots">
      <button
        v-for="card in cards"
        :key="card.id"
        type="button"
        role="listitem"
        class="robot-card"
        :class="{ active: card.id === robotId }"
        :aria-pressed="card.id === robotId"
        :data-robot="card.id"
        @click="selectRobot(card.id)"
      >
        <span class="robot-title">{{ card.title }}</span>
        <span class="robot-joints">{{ card.joints }} {{ card.joints === 1 ? 'joint' : 'joints' }}</span>
        <span class="robot-line">{{ card.line }}</span>
      </button>
    </div>

    <div v-if="picker && data" class="about">
      <p class="blurb">{{ data.blurb }}<template v-if="rerunUrl(data)"> <a class="rerun" :href="rerunUrl(data)!" target="_blank" rel="noopener">Open in Rerun ↗</a></template></p>
      <div v-if="data.tapes.length > 1" class="chips" role="group" aria-label="Motion">
        <span class="chips-label">Motion</span>
        <button
          v-for="t in data.tapes"
          :key="t.name"
          type="button"
          class="chip"
          :class="{ active: t.name === tape?.name }"
          :aria-pressed="t.name === tape?.name"
          @click="selectTape(t.name)"
        >
          {{ t.name }}
        </button>
      </div>
    </div>

    <div ref="stage" class="stage" :style="{ height: `${stageHeight}px` }">
      <canvas ref="canvas" class="viewport" aria-label="3D replay of the robot under each controller; drag to orbit, scroll or pinch to zoom" />
      <div
        v-for="(rect, i) in rects"
        :key="activeRungs[i]"
        class="pane"
        :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }"
      >
        <div class="pane-label">
          <span class="pane-name" :style="{ color: `var(--pt-rung-${activeRungs[i]})` }">{{ RUNG_NAMES[activeRungs[i]] }}</span>
          <span v-if="data" class="pane-score">tracking RMS {{ fmt3(trackingRms(activeRungs[i])) }} {{ unit }}</span>
        </div>
      </div>
      <div v-if="status3d !== 'ready'" class="overlay" :class="status3d">
        <p v-if="status3d === 'loading'">Loading MuJoCo (WebAssembly, about 2.5 MB)…</p>
        <template v-else>
          <p><strong>The 3D replay could not start in this browser.</strong> It needs WebGL and WebAssembly.</p>
          <p class="detail">{{ error3d }}</p>
          <p v-if="!compact">The error plot and the scores below come from the same data and still work.</p>
        </template>
      </div>
    </div>

    <div v-if="compact" class="legend">
      <span v-for="rung in activeRungs" :key="rung" class="legend-item">
        <i class="swatch" :style="{ background: `var(--pt-rung-${rung})` }" />{{ RUNG_NAMES[rung] }}
      </span>
      <span class="legend-item"><i class="swatch ghost" />commanded (ghost)</span>
    </div>

    <template v-else>
      <div class="timeline">
        <button type="button" class="play" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
          <svg v-if="playing" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" /><rect x="9.5" y="2" width="3.5" height="12" /></svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2 L14 8 L4 14 Z" /></svg>
        </button>
        <input
          class="scrubber"
          type="range"
          :min="start"
          :max="end"
          :step="tape?.dt ?? 0.01"
          :value="time"
          aria-label="Time"
          @input="seek(+($event.target as HTMLInputElement).value)"
        />
        <span class="clock" data-testid="clock">{{ timeLabel }}</span>
        <div class="group" role="group" aria-label="Speed">
          <button v-for="s in SPEEDS" :key="s" type="button" class="chip" :class="{ active: speed === s }" :aria-pressed="speed === s" @click="speed = s">
            {{ s }}×
          </button>
        </div>
        <label class="toggle"><input v-model="loop" type="checkbox" /> loop</label>
      </div>

      <div class="plot-head">
        <div class="legend">
          <span v-for="rung in activeRungs" :key="rung" class="legend-item">
            <i class="swatch" :style="{ background: `var(--pt-rung-${rung})` }" />{{ RUNG_NAMES[rung] }}
          </span>
        </div>
        <div class="plot-tools">
          <label v-if="picker && multiJoint" class="select">
            <span>Joint</span>
            <select v-model="jointSel" aria-label="Joint">
              <option value="all">All joints (worst now)</option>
              <option v-for="j in data?.joints ?? []" :key="j.name" :value="j.name">{{ j.name }}</option>
            </select>
          </label>
          <div class="group" role="group" aria-label="Error scale">
            <button type="button" class="chip" :class="{ active: scale === 'log' }" :aria-pressed="scale === 'log'" @click="scale = 'log'">log</button>
            <button type="button" class="chip" :class="{ active: scale === 'linear' }" :aria-pressed="scale === 'linear'" @click="scale = 'linear'">linear</button>
          </div>
        </div>
      </div>
      <div ref="plotBox" class="plot">
        <canvas
          ref="plotCanvas"
          aria-label="Tracking error over time for each controller"
          @pointermove="plotPointer"
          @pointerdown="plotPointer"
          @pointerup="plotRelease"
          @pointerleave="plotRelease"
        />
        <div v-if="hoverT !== null && hoverValues.length" class="tooltip" :class="{ flip: hoverX > (plotBox?.clientWidth ?? 0) / 2 }" :style="{ left: `${hoverX}px` }">
          <div class="tooltip-time">{{ hoverT.toFixed(2) }} s</div>
          <div v-for="v in hoverValues" :key="v.rung" class="tooltip-row">
            <i class="swatch" :style="{ background: `var(--pt-rung-${v.rung})` }" />
            <span>{{ RUNG_NAMES[v.rung] }}</span>
            <span class="num">{{ fmt3(v.value) }} {{ unit }}</span>
          </div>
        </div>
      </div>
      <p v-if="dataError" class="data-error">{{ dataError }}</p>

      <div v-if="picker && data" class="scores">
        <p class="caption">{{ selectedJoints.length === 1 ? selectedJoints[0] : `All ${data.joints.length} joints: tracking and stop are the mean, max error and torque limit the worst joint. Pick a joint for its gains.` }}</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Controller</th>
                <template v-if="selectedJoints.length === 1">
                  <th scope="col" class="num">kp</th>
                  <th scope="col" class="num">kd</th>
                  <th scope="col">Feed-forward</th>
                </template>
                <th scope="col" class="num">Stop p90 ({{ unit }})</th>
                <th scope="col" class="num">Tracking RMS ({{ unit }})</th>
                <th scope="col" class="num">Max error ({{ unit }})</th>
                <th scope="col" class="num">At torque limit</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.rung">
                <th scope="row"><i class="swatch" :style="{ background: `var(--pt-rung-${row.rung})` }" />{{ RUNG_NAMES[row.rung] }}</th>
                <template v-if="selectedJoints.length === 1">
                  <td class="num">{{ row.kp }}</td>
                  <td class="num">{{ row.kd }}</td>
                  <td class="ff">{{ row.feedforward }}</td>
                </template>
                <td class="num">{{ row.stop }}</td>
                <td class="num">{{ row.tracking }}</td>
                <td class="num">{{ row.max }}</td>
                <td class="num">{{ row.saturation }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="saturationNote" class="note">{{ saturationNote }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pt-replay {
  font-family: var(--pt-font-base);
  color: var(--pt-text);
  min-width: 0;
  max-width: 100%;
}

/* ---- robot picker */
.robots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.robot-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  padding: 10px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-bg-soft);
  color: var(--pt-text);
  cursor: pointer;
  font: inherit;
  transition: border-color 0.15s;
}
.robot-card:hover {
  border-color: var(--pt-text-3);
}
.robot-card.active {
  border-color: var(--pt-text);
  background: var(--pt-bg);
  box-shadow: inset 0 0 0 1px var(--pt-text);
}
.robot-title {
  font-weight: 600;
  font-size: 14px;
  line-height: 1.3;
}
.robot-joints {
  font-size: 12px;
  color: var(--pt-text-3);
}
.robot-line {
  font-family: var(--pt-font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--pt-text-2);
}

.about {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-bottom: 12px;
}
.blurb {
  margin: 0;
  flex: 1 1 320px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--pt-text-2);
}

/* ---- chips and buttons */
.chips,
.group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.chips-label {
  font-size: 12px;
  color: var(--pt-text-3);
  margin-right: 4px;
}
.chip,
.play,
select {
  font: inherit;
  font-size: 13px;
  color: var(--pt-text);
  background: var(--pt-bg-soft);
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  padding: 3px 10px;
  cursor: pointer;
  line-height: 1.5;
}
.chip:hover,
.play:hover {
  border-color: var(--pt-text-3);
}
.chip.active {
  background: var(--pt-text);
  border-color: var(--pt-text);
  color: var(--pt-bg);
}

/* ---- viewport */
.stage {
  position: relative;
  width: 100%;
  min-height: 120px;
}
.viewport {
  position: absolute;
  inset: 0 auto auto 0;
  display: block;
  cursor: grab;
}
.viewport:active {
  cursor: grabbing;
}
.pane {
  position: absolute;
  pointer-events: none;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
}
.pane-label {
  position: absolute;
  top: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.25;
  padding: 3px 6px;
  border-radius: var(--pt-radius-sm);
  /* WHY a backing: the label sits over the robot on small panes */
  background: color-mix(in srgb, var(--pt-viewport-bg) 82%, transparent);
}
.pane-name {
  font-weight: 700;
  font-size: 13px;
}
.pane-score {
  font-family: var(--pt-font-mono);
  font-size: 11px;
  color: var(--pt-text-2);
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 16px;
  text-align: center;
  font-size: 14px;
  color: var(--pt-text-2);
  background: var(--pt-viewport-bg);
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
}
.overlay p {
  margin: 0;
  max-width: 46ch;
}
.overlay .detail {
  font-family: var(--pt-font-mono);
  font-size: 12px;
  color: var(--pt-text-3);
}
.overlay.loading p::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 50%;
  border: 2px solid var(--pt-text-3);
  border-top-color: transparent;
  vertical-align: -1px;
  animation: pt-spin 0.8s linear infinite;
}
@keyframes pt-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- legend */
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: var(--pt-text-2);
}
.compact .legend {
  margin-top: 8px;
  /* WHY inherit: the landing hero may sit on a deep background where --pt-text-2 would vanish */
  color: inherit;
  opacity: 0.85;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
}
.swatch.ghost {
  background: var(--pt-ghost);
  outline: 1px solid var(--pt-text-3);
}

/* ---- timeline */
.timeline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 12px 0 6px;
}
.play {
  width: 36px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.play svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
.scrubber {
  flex: 1 1 200px;
  min-width: 140px;
  accent-color: var(--pt-text);
}
.clock {
  font-family: var(--pt-font-mono);
  font-size: 12px;
  color: var(--pt-text-2);
  font-variant-numeric: tabular-nums;
  min-width: 15ch;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--pt-text-2);
  cursor: pointer;
}

/* ---- plot */
.plot-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-top: 10px;
}
.plot-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--pt-text-3);
}
select {
  max-width: 220px;
}
.plot {
  position: relative;
  width: 100%;
  margin-top: 6px;
}
.plot canvas {
  display: block;
  cursor: crosshair;
  touch-action: pan-y;
}
.tooltip {
  position: absolute;
  top: 90px;
  transform: translateX(12px);
  pointer-events: none;
  background: var(--pt-bg);
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  padding: 6px 8px;
  font-size: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  white-space: nowrap;
  z-index: 2;
}
.tooltip.flip {
  transform: translateX(calc(-100% - 12px));
}
.tooltip-time {
  font-family: var(--pt-font-mono);
  color: var(--pt-text-3);
  margin-bottom: 2px;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tooltip-row .num {
  margin-left: auto;
  padding-left: 10px;
}
.num {
  font-family: var(--pt-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.data-error {
  color: var(--pt-text-2);
  font-size: 13px;
}

/* ---- scores */
.scores {
  margin-top: 18px;
}
.table-wrap {
  overflow-x: auto;
  max-width: 100%;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.caption {
  margin: 0;
  text-align: left;
  font-size: 12px;
  color: var(--pt-text-3);
  padding-bottom: 6px;
}
th,
td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--pt-line);
  text-align: left;
  white-space: nowrap;
}
thead th {
  font-weight: 600;
  font-size: 12px;
  color: var(--pt-text-2);
  white-space: normal;
  vertical-align: bottom;
}
tbody th {
  font-weight: 600;
}
tbody th .swatch {
  margin-right: 8px;
  vertical-align: -1px;
}
td.ff {
  white-space: normal;
  min-width: 22ch;
  color: var(--pt-text-2);
}
th.num,
td.num {
  text-align: right;
}
.note {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--pt-text-2);
  padding: 8px 12px;
  border-left: 3px solid var(--pt-rung-analytic);
  background: var(--pt-bg-soft);
  border-radius: 0 var(--pt-radius-sm) var(--pt-radius-sm) 0;
}

@media (max-width: 640px) {
  .robots {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding-bottom: 4px;
  }
  .robot-card {
    flex: 0 0 210px;
    scroll-snap-align: start;
  }
  .pane-name {
    font-size: 12px;
  }
  .pane-score {
    font-size: 10px;
  }
}
</style>
