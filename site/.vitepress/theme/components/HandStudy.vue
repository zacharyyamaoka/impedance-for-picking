<script setup lang="ts">
// Fingers on the arm (Zach, 2026-10-27): "show an example with 2 x 2 dof fingers on the end of the robot arm and the contact from that
// ... how you would control the contact: a mix of both the fingers and the arm." Data: site/public/data/hand.json (schema
// impedance-hand/1, docs/data-contract.md) and its replay tapes, written by the sim lane. Until they land, the planned cases show
// without numbers. The object comes from the page-wide soft / rigid switch.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { withBase } from 'vitepress'
import FzSpark from './FzSpark.vue'
import { contactObject, fetchOptional, type ContactObject } from '../lib/contact'
import { cssVar, onLookChange } from '../lib/variants'
import type { MjReplay } from '../lib/mjreplay'

interface Case {
  id: string
  title: string
  what: string
}
interface Result {
  case: string
  touch_peak_n: number
  fingertip_peak_n: number[]
  arm_flange_peak_n: number
  press_mean_n: number
  converged: boolean
  rate_hz: number
  trace: { t_ms: number[]; fz_total_n: number[]; fz_fingertips_n: number[][] }
}
interface Hand {
  schema: string
  generated_at: string
  source: { lane_commit: string; script: string; hand: string }
  objects: Partial<Record<ContactObject, { label?: string; contact_stiffness_n_m?: number; contact_damping_n_s_m?: number }>>
  cases: Case[]
  results: Record<ContactObject, Result[]>
  replay?: { model: string; runs: Record<string, string> }
}
interface Tape {
  t: number[]
  qpos: number[][]
}

// the planned cases, as the frozen contract names them (docs/data-contract.md) - shown until the data lands
const PLANNED: Case[] = [
  { id: 'H0', title: 'Arm stiff, fingers stiff', what: '' },
  { id: 'H1', title: 'Arm stiff, fingers soft', what: '' },
  { id: 'H2', title: 'Arm soft z, fingers soft', what: '' },
]

const emit = defineEmits<{ loaded: [Hand | null] }>()
const data = shallowRef<Hand | null>(null)
const loaded = ref(false)
const selected = ref('H0')
const tape = shallowRef<Tape | null>(null)
const tapeState = ref<'none' | 'loading' | 'ready' | 'missing' | 'error'>('none')
const time = ref(0)
const playing = ref(false)
const canvas = ref<HTMLCanvasElement | null>(null)
const view = ref<HTMLElement | null>(null)
let replay: MjReplay | null = null
let modelXml: string | null = null
let frame = 0
let last = 0
let stopLook: (() => void) | null = null
let resize: ResizeObserver | null = null

onMounted(async () => {
  data.value = await fetchOptional<Hand>(withBase('/data/hand.json'))
  loaded.value = true
  emit('loaded', data.value)
  if (data.value) {
    selected.value = data.value.cases[0]?.id ?? 'H0'
    await loadTape()
  }
})
onBeforeUnmount(() => {
  pause()
  stopLook?.()
  resize?.disconnect()
  replay?.dispose()
})

const cases = computed(() => data.value?.cases ?? PLANNED)
const results = computed(() => data.value?.results?.[contactObject.value] ?? [])
const byCase = computed(() => new Map(results.value.map((r) => [r.case, r])))
const traceMax = computed(() => Math.max(1, ...results.value.flatMap((r) => r.trace?.fz_total_n ?? [])))
const tSpan = computed(() => {
  const all = results.value.flatMap((r) => r.trace?.t_ms ?? [])
  return all.length ? [Math.min(...all), Math.max(...all)] : [-50, 600]
})
const fmt = (v: number | undefined | null, d = 0) => (v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(d))
const FINGER_COLORS = ['var(--pt-c-joint)', 'var(--pt-c-host-spring)']

// The conclusion is read off the numbers, never written ahead of them
const conclusion = computed(() => {
  const held = results.value.filter((r) => r.converged)
  if (held.length < 2) return null
  const best = held.reduce((a, b) => (b.touch_peak_n < a.touch_peak_n ? b : a))
  const worst = held.reduce((a, b) => (b.touch_peak_n > a.touch_peak_n ? b : a))
  const quiet = held.reduce((a, b) => (b.press_mean_n < a.press_mean_n ? b : a))
  const title = (id: string) => cases.value.find((c) => c.id === id)?.title ?? id
  const fingers = best.fingertip_peak_n.reduce((s, v) => s + v, 0)
  return { best, worst, quiet, title, fingers }
})

function tapeUrl(caseId: string, object: ContactObject) {
  const runs = data.value?.replay?.runs ?? {}
  const path = runs[`${caseId}-${object}`] ?? runs[`${caseId}/${object}`] ?? (object === 'rigid' ? runs[caseId] : undefined) ?? `data/hand-${caseId}-${object}.json`
  return withBase(`/${path.replace(/^\//, '')}`)
}

async function loadTape() {
  if (!data.value?.replay) {
    tapeState.value = 'none'
    return
  }
  pause()
  tapeState.value = 'loading'
  const [next, xml] = await Promise.all([
    fetchOptional<Tape>(tapeUrl(selected.value, contactObject.value)),
    modelXml ? Promise.resolve(modelXml) : fetch(withBase(`/${data.value.replay.model.replace(/^\//, '')}`)).then((r) => (r.ok ? r.text() : null)).catch(() => null),
  ])
  if (!next || !xml) {
    tapeState.value = 'missing'
    return
  }
  try {
    if (!replay) {
      modelXml = xml
      const [{ loadMujoco }, { MjReplay }] = await Promise.all([import('../lib/mujoco'), import('../lib/mjreplay')])
      const mujoco = await loadMujoco()
      await nextTick()
      if (!canvas.value) return
      replay = new MjReplay(canvas.value)
      replay.load(mujoco, xml, 1, { followBody: 'deepest', lookat: [0, 0, 0.1], azimuth: 90, elevation: -15, distance: 0.45, fovy: 40 })
      stopLook = onLookChange(readLook)
      resize = new ResizeObserver(layout)
      if (view.value) resize.observe(view.value)
    }
    tape.value = next
    time.value = next.t[0] ?? 0
    tapeState.value = 'ready'
    readLook()
    layout()
  } catch {
    tapeState.value = 'error'
  }
}

function readLook() {
  replay?.setLook({
    bg: cssVar('--pt-viewport-bg', '#eee'), arm: cssVar('--pt-arm', '#bbb'), tool: cssVar('--pt-text-2', '#444'), belt: cssVar('--pt-belt', '#222'),
    stripe: cssVar('--pt-text-3', '#888'), tip: cssVar('--pt-brand', '#088'), hot: cssVar('--pt-warn', '#c00'), ghost: cssVar('--pt-accent', '#c80'),
    arrow: cssVar('--pt-warn', '#c00'),
  })
  draw()
}
function layout() {
  if (!replay || !view.value) return
  const box = view.value.getBoundingClientRect()
  replay.layout(Math.round(box.width), Math.round(box.height), [{ x: 0, y: 0, w: Math.round(box.width), h: Math.round(box.height) }])
  draw()
}
function draw() {
  const t = tape.value
  if (!replay || !t || !t.t.length) return
  const dt = t.t.length > 1 ? t.t[1] - t.t[0] : 1
  const i = Math.max(0, Math.min(t.t.length - 1, Math.round((time.value - t.t[0]) / dt)))
  replay.setQpos(0, t.qpos[i])
  replay.render()
}
function tick(stamp: number) {
  const t = tape.value
  if (!playing.value || !t) return
  const dt = last ? Math.min(0.05, (stamp - last) / 1000) : 0
  last = stamp
  let next = time.value + dt * 0.25
  if (next > t.t[t.t.length - 1]) next = t.t[0]
  time.value = next
  draw()
  frame = requestAnimationFrame(tick)
}
function toggle() {
  if (playing.value) pause()
  else if (tapeState.value === 'ready') {
    playing.value = true
    last = 0
    frame = requestAnimationFrame(tick)
  }
}
function pause() {
  playing.value = false
  if (frame) cancelAnimationFrame(frame)
  frame = 0
}
watch([selected, contactObject], () => {
  if (data.value) loadTape()
})
</script>

<template>
  <div class="hand" :data-state="data ? 'data' : loaded ? 'pending' : 'loading'" data-testid="hand-study">
    <p v-if="!data && loaded" class="pending-note">
      <b>Being computed.</b> The sim lane is running the slap-and-grab now: Zach's 2 × 2-DoF hand on the arm, the arm and the fingers each stiff
      or soft. The cards and the replay fill in when <code>data/hand.json</code> lands.
    </p>
    <p v-if="conclusion" class="summary">
      With the {{ contactObject }} object, the lowest touch peak is <b>{{ conclusion.best.case }}</b> ({{ conclusion.title(conclusion.best.case) }}):
      <b>{{ fmt(conclusion.best.touch_peak_n) }} N</b> against {{ fmt(conclusion.worst.touch_peak_n) }} N for {{ conclusion.worst.case }}; its
      fingertips peak at {{ conclusion.best.fingertip_peak_n.map((v) => fmt(v)).join(' / ') }} N and the arm flange at
      {{ fmt(conclusion.best.arm_flange_peak_n) }} N. The quietest hold is {{ conclusion.quiet.case }} ({{ fmt(conclusion.quiet.press_mean_n, 1) }} N).
    </p>
    <div class="cases">
      <button v-for="c in cases" :key="c.id" class="case" :class="{ on: selected === c.id, starred: byCase.get(c.id) && !byCase.get(c.id)!.converged }"
              :data-case="c.id" @click="selected = c.id">
        <span class="cid">{{ c.id }}</span>
        <b class="ctitle">{{ c.title }}</b>
        <span v-if="c.what" class="cwhat">{{ c.what }}</span>
        <template v-if="byCase.get(c.id)">
          <span class="nums">
            <span><em>touch</em> {{ fmt(byCase.get(c.id)!.touch_peak_n) }}{{ byCase.get(c.id)!.converged ? '' : '*' }} N</span>
            <span><em>fingertips</em> {{ byCase.get(c.id)!.fingertip_peak_n.map((v) => fmt(v)).join(' / ') }} N</span>
            <span><em>arm flange</em> {{ fmt(byCase.get(c.id)!.arm_flange_peak_n) }} N</span>
            <span><em>press</em> {{ fmt(byCase.get(c.id)!.press_mean_n, 1) }} N</span>
          </span>
          <FzSpark :series="[
                     { t: byCase.get(c.id)!.trace.t_ms, y: byCase.get(c.id)!.trace.fz_total_n, color: 'var(--pt-text)', label: 'total' },
                     ...(byCase.get(c.id)!.trace.fz_fingertips_n ?? []).map((y, k) => ({ t: byCase.get(c.id)!.trace.t_ms, y, color: FINGER_COLORS[k % 2], label: `finger ${k + 1}` })),
                   ]" :y-max="traceMax * 1.05" :t-min="tSpan[0]" :t-max="tSpan[1]" :height="44" :cursor="0" />
        </template>
        <span v-else class="placeholder" aria-hidden="true"><span /><span /></span>
      </button>
    </div>
    <div v-if="data?.replay" class="replay">
      <div class="rbar">
        <button class="play" :disabled="tapeState !== 'ready'" @click="toggle">{{ playing ? 'Pause' : 'Play' }}</button>
        <span class="dim mono">{{ selected }} · {{ contactObject }} · t = {{ time.toFixed(2) }} s</span>
      </div>
      <div ref="view" class="rview">
        <canvas ref="canvas" />
        <div v-if="tapeState !== 'ready'" class="overlay">{{ tapeState === 'loading' ? 'Loading the replay…' : 'This run has no replay tape yet.' }}</div>
      </div>
    </div>
    <p class="legend">
      Lines: <span class="k-total">total Fz</span>, <span class="k-f1">finger 1</span>, <span class="k-f2">finger 2</span>, from 50 ms before touch
      (the line at touch). "*": did not hold the rate or perturbation check.
    </p>
  </div>
</template>

<style scoped>
.hand {
  display: grid;
  gap: 12px;
}
.pending-note,
.summary {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--pt-radius-sm);
  font-size: 14px;
}
.pending-note {
  border: var(--pt-border-w) dashed var(--pt-line);
  color: var(--pt-text-2);
}
.summary {
  background: var(--pt-brand-soft);
}
.cases {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}
.case {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  color: var(--pt-text);
  text-align: left;
}
.case.on {
  border-color: var(--pt-brand);
  box-shadow: 0 0 0 1px var(--pt-brand);
}
.case.starred {
  border-style: dashed;
}
.cid {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--pt-brand);
  color: var(--pt-bg);
  font-family: var(--pt-font-mono);
  font-size: 12px;
  font-weight: 700;
}
.ctitle {
  font-size: 15px;
}
.cwhat {
  color: var(--pt-text-2);
  font-size: 12.5px;
}
.nums {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
  font-family: var(--pt-font-mono);
  font-size: 12px;
}
.nums em {
  display: block;
  color: var(--pt-text-3);
  font-style: normal;
  font-family: var(--pt-font-base);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.placeholder {
  display: grid;
  gap: 6px;
}
.placeholder span {
  display: block;
  height: 10px;
  border-radius: 4px;
  background: var(--pt-bg-soft);
}
.placeholder span:last-child {
  width: 60%;
}
.replay {
  display: grid;
  gap: 6px;
}
.rbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.play {
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--pt-text);
  color: var(--pt-bg);
  font-weight: 600;
}
.play:disabled {
  opacity: 0.4;
}
.rview {
  position: relative;
  aspect-ratio: 16 / 9;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  overflow: hidden;
}
.rview canvas {
  position: absolute;
  inset: 0;
}
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--pt-text-2);
  font-size: 13px;
}
.dim {
  color: var(--pt-text-3);
}
.mono {
  font-family: var(--pt-font-mono);
  font-size: 12px;
}
.legend {
  margin: 0;
  color: var(--pt-text-3);
  font-size: 12.5px;
}
.k-total {
  color: var(--pt-text);
  font-weight: 600;
}
.k-f1 {
  color: var(--pt-c-joint);
  font-weight: 600;
}
.k-f2 {
  color: var(--pt-c-host-spring);
  font-weight: 600;
}
</style>
