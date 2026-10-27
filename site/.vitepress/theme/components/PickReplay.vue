<script setup lang="ts">
// The conveyor pick, replayed from real sim runs: the comparison's own cases (results.json) re-run with frames by
// scripts/export_site_data.py at their held physics rates, then posed here by MuJoCo (WASM) and drawn by three.js. Nothing is
// simulated in the browser: what moves is what the sim logged.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { withBase } from 'vitepress'
import FzSpark from './FzSpark.vue'
import { cssVar, onLookChange } from '../lib/variants'
import type { MjReplay } from '../lib/mjreplay'

interface Tape {
  row: string
  delta_mm: number
  loop_hz: number
  t0: number
  dt: number
  n: number
  qpos: Record<string, number[]>
  fz: number[]
  tip_mm: number[]
  ref_mm: number[]
  peak_n: number
  dwell_mean_n: number
  dwell_std_n: number
  bounces: number
}
interface Picks {
  frame_hz: number
  window_s: [number, number]
  phases: Record<string, number>
  rows: string[]
  deltas_mm: number[]
  model: string
  tapes: Tape[]
}

const ROW_INFO: Record<string, { label: string; color: string; what: string }> = {
  stiff: { label: 'stiff', color: '--pt-c-stiff', what: "today's board gains, no impedance" },
  host_spring: { label: 'host_spring', color: '--pt-c-host-spring', what: 'spring on the host, damper on the board' },
  'spring + host_spring': { label: 'spring + host_spring', color: '--pt-c-series', what: 'the level compensator, host_spring above it' },
}
const SPEEDS = [0.1, 0.25, 1]
const BELT_SURFACE_Z = 0.1 // sim/scene.py SceneConfig.belt_surface_z: the BELIEVED surface; the true one is delta above it

const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const views = ref<HTMLElement[]>([])
const picks = shallowRef<Picks | null>(null)
const delta = ref(10)
const playing = ref(false)
const speed = ref(0.25)
const time = ref(0.5)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
const colors = ref<Record<string, string>>({})

let replay: MjReplay | null = null
let frame = 0
let last = 0
let stopLook: (() => void) | null = null
let resize: ResizeObserver | null = null
let visibility: IntersectionObserver | null = null
let userPaused = false

const tapes = computed(() => (picks.value ? picks.value.rows.map((row) => picks.value!.tapes.find((t) => t.row === row && t.delta_mm === delta.value)!) : []))
const span = computed<[number, number]>(() => picks.value?.window_s ?? [0.5, 2])
const phases = computed(() => picks.value?.phases ?? {})

function index(tape: Tape, t: number) {
  return Math.max(0, Math.min(tape.n - 1, Math.round((t - tape.t0) / tape.dt)))
}
function times(tape: Tape) {
  return Array.from({ length: tape.n }, (_, i) => tape.t0 + i * tape.dt)
}
const traces = computed(() => tapes.value.map((tape) => ({ t: times(tape), y: tape.fz })))
const now = computed(() =>
  tapes.value.map((tape) => {
    const i = index(tape, time.value)
    return { fz: tape.fz[i], tip: tape.tip_mm[i], ref: tape.ref_mm[i] }
  }),
)
const bands = computed(() => [
  { from: phases.value.dwell ?? 0, to: phases.value.lift ?? 0, color: 'var(--pt-brand-soft)' },
  { from: phases.value.disturbance_on ?? 0, to: phases.value.disturbance_off ?? 0, color: 'var(--pt-accent-soft)' },
])
const phaseLabel = computed(() => {
  const t = time.value
  const p = phases.value
  if (t < p.dwell - 0.1) return 'descending'
  if (t < p.dwell) return 'touch'
  if (t >= p.disturbance_on && t < p.disturbance_off) return '20 N push in y'
  if (t < p.lift) return 'holding on the belt'
  return 'lifting'
})

function readLook() {
  if (!replay) return
  replay.setLook({
    bg: cssVar('--pt-viewport-bg', '#eee'),
    arm: cssVar('--pt-arm', '#bbb'),
    tool: cssVar('--pt-text-2', '#444'),
    belt: cssVar('--pt-belt', '#222'),
    stripe: cssVar('--pt-text-3', '#888'),
    tip: cssVar('--pt-brand', '#088'),
    hot: cssVar('--pt-warn', '#c00'),
    ghost: cssVar('--pt-accent', '#c80'),
    arrow: cssVar('--pt-warn', '#c00'),
  })
  colors.value = Object.fromEntries(Object.entries(ROW_INFO).map(([row, info]) => [row, cssVar(info.color, '#888')]))
  draw()
}

function draw() {
  if (!replay || !tapes.value.length) return
  tapes.value.forEach((tape, pane) => {
    const i = index(tape, time.value)
    const values: Record<string, number> = { belt_z: tape.delta_mm / 1000 }
    for (const [joint, path] of Object.entries(tape.qpos)) values[joint] = path[i]
    if (!('compensator' in tape.qpos)) values.compensator = 0 // the arm-only rows: the tip rigid at full extension
    replay!.setQposByName(pane, values)
    replay!.setForce(pane, tape.fz[i])
    replay!.setReference(pane, BELT_SURFACE_Z + tape.delta_mm / 1000 + tape.ref_mm[i] / 1000)
  })
  replay.render()
}

function layout() {
  if (!replay || !stage.value) return
  const box = stage.value.getBoundingClientRect()
  const rects = views.value.map((view) => {
    const r = view.getBoundingClientRect()
    return { x: Math.round(r.left - box.left), y: Math.round(r.top - box.top), w: Math.round(r.width), h: Math.round(r.height) }
  })
  replay.layout(Math.round(box.width), Math.round(box.height), rects)
  draw()
}

function tick(stamp: number) {
  frame = 0
  if (!playing.value) return
  const dt = last ? Math.min(0.05, (stamp - last) / 1000) : 0
  last = stamp
  let t = time.value + dt * speed.value
  if (t > span.value[1]) t = span.value[0]
  time.value = t
  draw()
  frame = requestAnimationFrame(tick)
}

function play() {
  if (playing.value || status.value !== 'ready') return
  playing.value = true
  last = 0
  frame = requestAnimationFrame(tick)
}
function pause() {
  playing.value = false
  if (frame) cancelAnimationFrame(frame)
  frame = 0
}
function toggle() {
  if (playing.value) {
    userPaused = true
    pause()
  } else {
    userPaused = false
    play()
  }
}
function scrub(event: Event) {
  time.value = Number((event.target as HTMLInputElement).value)
  draw()
}

watch(delta, () => draw())

onMounted(async () => {
  try {
    const [data, xml, { loadMujoco }, { MjReplay }] = await Promise.all([
      fetch(withBase('/data/picks.json')).then((r) => r.json() as Promise<Picks>),
      fetch(withBase('/models/pick_scene.xml')).then((r) => r.text()),
      import('../lib/mujoco'),
      import('../lib/mjreplay'),
    ])
    picks.value = data
    time.value = data.phases.dwell - 0.05
    const mujoco = await loadMujoco()
    if (!canvas.value) return
    replay = new MjReplay(canvas.value)
    // WHY this camera: the hero video's - side on across the belt, the look-at point riding with the tip along x
    replay.load(mujoco, xml, data.rows.length, { follow: 'tcp', followAxes: [true, false, false], lookat: [0, -0.45, 0.13], azimuth: 90, elevation: -12, distance: 0.5, fovy: 40 })
    status.value = 'ready'
    readLook()
    stopLook = onLookChange(readLook)
    resize = new ResizeObserver(layout)
    if (stage.value) resize.observe(stage.value)
    layout()
    const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    visibility = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting)
      if (visible && !userPaused && !reduced) play()
      if (!visible) pause()
    }, { threshold: 0.25 })
    if (root.value) visibility.observe(root.value)
  } catch (err) {
    status.value = 'error'
    error.value = err instanceof Error ? err.message : String(err)
  }
})

onBeforeUnmount(() => {
  pause()
  stopLook?.()
  resize?.disconnect()
  visibility?.disconnect()
  replay?.dispose()
  replay = null
})
</script>

<template>
  <div ref="root" class="pick-replay" :data-ready="status === 'ready' ? 'true' : 'false'" data-testid="pick-replay">
    <div class="controls">
      <div class="seg" role="radiogroup" aria-label="true surface above the believed one">
        <span class="seg-label">surface</span>
        <button v-for="d in picks?.deltas_mm ?? [10, 20]" :key="d" role="radio" :aria-checked="delta === d" :class="{ on: delta === d }" @click="delta = d">
          +{{ d }} mm
        </button>
      </div>
      <button class="play" :aria-label="playing ? 'Pause' : 'Play'" data-testid="replay-play" @click="toggle">{{ playing ? 'Pause' : 'Play' }}</button>
      <div class="seg" role="radiogroup" aria-label="playback speed">
        <button v-for="s in SPEEDS" :key="s" role="radio" :aria-checked="speed === s" :class="{ on: speed === s }" @click="speed = s">{{ s }}×</button>
      </div>
      <span class="clock" data-testid="replay-clock">t = {{ time.toFixed(2) }} s · {{ phaseLabel }}</span>
    </div>
    <input class="scrub" type="range" :min="span[0]" :max="span[1]" step="0.005" :value="time" aria-label="time" @input="scrub" />
    <div ref="stage" class="stage">
      <canvas ref="canvas" class="gl" />
      <div class="panes">
        <div v-for="(tape, i) in tapes" :key="tape.row" class="pane" :data-row="tape.row">
          <div :ref="(el) => { if (el) views[i] = el as HTMLElement }" class="view">
            <div class="tag">
              <span class="name" :style="{ color: colors[tape.row] }">{{ ROW_INFO[tape.row]?.label ?? tape.row }}</span>
              <span class="what">{{ ROW_INFO[tape.row]?.what }}</span>
            </div>
            <div class="live mono">
              <span><b>{{ now[i]?.fz.toFixed(1) }}</b> N</span>
              <span class="dim">asked {{ now[i]?.ref.toFixed(0) }} mm · tip {{ now[i]?.tip.toFixed(1) }} mm</span>
            </div>
          </div>
          <div class="strip">
            <FzSpark :series="[{ t: traces[i].t, y: traces[i].y, color: colors[tape.row] ?? '#888', label: `${tape.row} Fz` }]" :t-min="span[0]" :t-max="span[1]"
                     :y-max="Math.max(...tapes.map((tp) => Math.max(...tp.fz))) * 1.05" :cursor="time" :bands="bands" :height="54" />
            <div class="facts mono">
              <span>touch peak <b>{{ tape.peak_n.toFixed(0) }} N</b></span>
              <span>holds <b>{{ tape.dwell_mean_n.toFixed(1) }} ± {{ tape.dwell_std_n.toFixed(1) }} N</b></span>
              <span class="dim">{{ tape.loop_hz / 1000 }} kHz</span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="status !== 'ready'" class="overlay">{{ status === 'error' ? `The replay could not load: ${error}` : 'Loading MuJoCo and the recorded runs…' }}</div>
    </div>
    <p class="legend">
      Each pane is one recorded sim run (UR5e stand-in, UR5e friction, contact 100 kN/m with B 200 N·s/m). The <span class="hot">arrow</span> is the
      tool–belt force (100 N = 10 cm); the <span class="ghost">bar</span> under the tip is where the trajectory asks the tip to be, 15 mm below the
      believed surface. Shaded: the hold, and the 20 N push.
    </p>
  </div>
</template>

<style scoped>
.pick-replay {
  display: grid;
  gap: 10px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  font-size: 13px;
}
.seg {
  display: inline-flex;
  align-items: center;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: 999px;
  overflow: hidden;
  background: var(--pt-card);
}
.seg-label {
  padding: 0 8px 0 10px;
  color: var(--pt-text-3);
  font-size: 12px;
}
.seg button {
  padding: 4px 10px;
  color: var(--pt-text-2);
  font-variant-numeric: tabular-nums;
}
.seg button.on {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
.play {
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--pt-text);
  color: var(--pt-bg);
  font-weight: 600;
}
.clock {
  color: var(--pt-text-2);
  font-family: var(--pt-font-mono);
  font-size: 12px;
}
.scrub {
  width: 100%;
  accent-color: var(--pt-brand);
}
.stage {
  position: relative;
}
.gl {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.panes {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 860px) {
  .panes {
    grid-template-columns: minmax(0, 1fr);
  }
}
.pane {
  display: grid;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  overflow: hidden;
}
.view {
  position: relative;
  aspect-ratio: 16 / 10;
}
.tag {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--pt-card) 88%, transparent);
}
.tag .name {
  font-family: var(--pt-font-mono);
  font-weight: 700;
  font-size: 13px;
}
.tag .what {
  color: var(--pt-text-2);
  font-size: 11.5px;
}
.live {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 3px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--pt-card) 88%, transparent);
  font-size: 11px;
  text-align: right;
}
@media (max-width: 420px) {
  .live .dim {
    display: none;
  }
}
.live b {
  font-size: 18px;
}
.strip {
  padding: 6px 8px 8px;
  border-top: var(--pt-border-w) solid var(--pt-line);
  background: var(--pt-card);
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--pt-text-2);
}
.mono {
  font-family: var(--pt-font-mono);
  font-variant-numeric: tabular-nums;
}
.dim {
  color: var(--pt-text-3);
}
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--pt-bg) 80%, transparent);
  color: var(--pt-text-2);
  font-size: 13px;
  text-align: center;
}
.legend {
  margin: 0;
  color: var(--pt-text-3);
  font-size: 12.5px;
  line-height: 1.5;
}
.legend .hot {
  color: var(--pt-warn);
  font-weight: 600;
}
.legend .ghost {
  color: var(--pt-accent);
  font-weight: 600;
}
</style>
