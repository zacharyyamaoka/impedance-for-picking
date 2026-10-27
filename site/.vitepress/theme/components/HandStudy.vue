<script setup lang="ts">
// Fingers on the arm (Zach, 2026-10-27): "show an example with 2 x 2 dof fingers on the end of the robot arm and the contact from that
// ... how you would control the contact: a mix of both the fingers and the arm." Data: site/public/data/hand.json (schema
// impedance-hand/1, docs/data-contract.md) and its replay tapes, written by the sim lane. Until they land, the planned cases show
// without numbers. The object comes from the page-wide soft / rigid switch.
// v2 (schema impedance-hand/2, frozen 2026-10-27): "not soft fingers, rigid fingers with compliant joints, like the human hand". The
// J-cases (rigid joints / virtual torsion springs / physical series-elastic springs, each at several joint stiffnesses, arm stiff or
// soft) lead; the first study's H-cases move under `legacy` and show folded below; `contact_models` says which contact model the runs
// use and why. A v1 file (H-cases only) still renders as before.
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
  group?: string
  arm?: string
  finger_joint_k_equiv_n_m?: number | null
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
  finger_gear_torque_peak_nm?: number[]
  arm_gear_torque_peak_nm?: number[]
  finger_travel_used?: number[]
  grasp_success?: boolean
}
interface ContactModel {
  id: string
  label: string
  what: string
  results: Record<string, { fingertip_peak_n?: number; arm_flange_peak_n?: number; finger_gear_torque_peak_nm?: number[]; arm_gear_torque_peak_nm?: number[]; converged?: boolean }>
}
interface Hand {
  schema: string
  generated_at: string
  source: { lane_commit: string; script: string; hand: string }
  objects: Partial<Record<ContactObject, { label?: string; contact_stiffness_n_m?: number; contact_damping_n_s_m?: number }>>
  cases: Case[]
  results: Record<ContactObject, Result[]>
  replay?: { model: string; runs: Record<string, string>; runs_by_object?: Partial<Record<ContactObject, Record<string, string>>> }
  contact_models?: { finding: string; chosen: string; models: ContactModel[] }
  legacy?: { cases: Case[]; results: Partial<Record<ContactObject, Result[]>> }
  answer?: string
  metrics?: string | Record<string, string>
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
    if (isV2.value && !arms.value.includes(arm.value)) arm.value = (arms.value[0] as 'stiff' | 'soft') ?? 'soft'
    selected.value = (isV2.value ? shown.value[0]?.id : undefined) ?? data.value.cases[0]?.id ?? 'H0'
    await loadTape()
  }
})
onBeforeUnmount(() => {
  pause()
  stopLook?.()
  resize?.disconnect()
  replay?.dispose()
})

// v2 puts the J-cases on top and the old H-cases under `legacy`; the H block below renders whichever holds them
const isV2 = computed(() => !!data.value && (data.value.schema?.endsWith('/2') || data.value.cases.some((c) => c.id.startsWith('J'))))
const cases = computed(() => (isV2.value ? data.value?.legacy?.cases ?? [] : data.value?.cases ?? PLANNED))
const results = computed(() => (isV2.value ? data.value?.legacy?.results?.[contactObject.value] : data.value?.results?.[contactObject.value]) ?? [])

// --- v2: rigid fingers with compliant joints
const jCases = computed(() => (isV2.value ? data.value!.cases.filter((c) => c.id.startsWith('J')) : []))
const jResults = computed(() => new Map((isV2.value ? data.value!.results?.[contactObject.value] ?? [] : []).map((r) => [r.case, r])))
const GROUPS = ['rigid joints', 'virtual torsion springs', 'physical series-elastic springs']
const groups = computed(() => {
  const seen = [...new Set(jCases.value.map((c) => c.group ?? 'other'))]
  return seen.sort((a, b) => (GROUPS.indexOf(a) + 99) % 99 - (GROUPS.indexOf(b) + 99) % 99)
})
const armOf = (c: Case) => (c.arm === 'stiff' || /arm_stiff$/.test(c.id) ? 'stiff' : 'soft')
const arm = ref<'stiff' | 'soft'>('soft')
const arms = computed(() => [...new Set(jCases.value.map(armOf))].sort())
const shown = computed(() =>
  jCases.value.filter((c) => armOf(c) === arm.value).sort((a, b) => groups.value.indexOf(a.group ?? 'other') - groups.value.indexOf(b.group ?? 'other') || (a.finger_joint_k_equiv_n_m ?? 0) - (b.finger_joint_k_equiv_n_m ?? 0)),
)
const maxOf = (v?: number[]) => (v && v.length ? Math.max(...v.map(Math.abs)) : NaN)
const armShock = (id: string) => maxOf(jResults.value.get(id)?.arm_gear_torque_peak_nm)
const metricsText = computed(() => {
  const m = data.value?.metrics
  if (!m) return 'Gear torque peak = max |τ_gear − its pre-touch value| over the 60 ms after first touch: the slap\'s shock, not the gravity load.'
  return typeof m === 'string' ? m : Object.values(m).join(' ')
})
// arm-gear shock against finger joint stiffness: one line per compliant group, rigid joints as the reference
const chart = computed(() => {
  const rigid = shown.value.filter((c) => c.group === 'rigid joints').map((c) => armShock(c.id)).filter(Number.isFinite)
  const lines = groups.value.filter((g) => g !== 'rigid joints').map((g) => ({
    group: g,
    points: shown.value.filter((c) => c.group === g && c.finger_joint_k_equiv_n_m).map((c) => ({ k: c.finger_joint_k_equiv_n_m as number, y: armShock(c.id), id: c.id })).filter((p) => Number.isFinite(p.y)),
  })).filter((l) => l.points.length)
  const ks = lines.flatMap((l) => l.points.map((p) => p.k))
  if (!ks.length) return null
  const ys = [...rigid, ...lines.flatMap((l) => l.points.map((p) => p.y))]
  const k0 = Math.min(...ks), k1 = Math.max(...ks)
  const yMax = Math.max(...ys, 1e-6) * 1.12
  const W = 320, H = 150, L = 34, R = 18, T = 8, B = 22
  const x = (k: number) => (k1 === k0 ? (L + W - R) / 2 : L + ((Math.log(k) - Math.log(k0)) / (Math.log(k1) - Math.log(k0))) * (W - L - R))
  const y = (v: number) => H - B - (v / yMax) * (H - T - B)
  return {
    W, H, L, R, T, B, yMax, x, y, ks: [...new Set(ks)].sort((a, b) => a - b),
    rigid: rigid.length ? y(Math.max(...rigid)) : null, rigidValue: rigid.length ? Math.max(...rigid) : null,
    lines: lines.map((l, i) => ({ ...l, color: ['var(--pt-brand)', 'var(--pt-accent)', 'var(--pt-c-host-spring)'][i % 3], d: l.points.map((p, j) => `${j ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p.y).toFixed(1)}`).join('') })),
  }
})
const chosenModel = computed(() => data.value?.contact_models?.models.find((m) => m.id === data.value?.contact_models?.chosen))
const modelCases = computed(() => {
  const ids = new Set<string>()
  for (const m of data.value?.contact_models?.models ?? []) for (const id of Object.keys(m.results ?? {})) ids.add(id)
  return [...ids]
})
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
  if (isV2.value) return null
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
  const named = data.value?.replay?.runs_by_object?.[object]?.[caseId] ?? runs[`${caseId}-${object}`] ?? runs[`${caseId}/${object}`] ?? (object === 'rigid' ? runs[caseId] : undefined)
  // WHY no guess in v2: its J-cases ship without tapes (only the H-cases have them), and a guessed URL is a 404 in the console
  if (!named && isV2.value) return null
  const path = named ?? `data/hand-${caseId}-${object}.json`
  return withBase(`/${path.replace(/^\//, '')}`)
}

async function loadTape() {
  if (!data.value?.replay) {
    tapeState.value = 'none'
    return
  }
  pause()
  const url = tapeUrl(selected.value, contactObject.value)
  if (!url) {
    tapeState.value = 'missing'
    return
  }
  tapeState.value = 'loading'
  const [next, xml] = await Promise.all([
    fetchOptional<Tape>(url),
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
    <template v-if="isV2">
      <p v-if="data!.answer" class="summary answer" data-testid="hand-answer">{{ data!.answer }}</p>
      <div class="jbar">
        <span class="dim">The arm under the hand:</span>
        <div class="seg" role="radiogroup" aria-label="the arm under the hand">
          <button v-for="a in arms" :key="a" role="radio" :aria-checked="arm === a" :class="{ on: arm === a }" :data-arm="a" @click="arm = a">
            {{ a === 'stiff' ? 'stiff arm' : 'soft arm (host_spring)' }}</button>
        </div>
      </div>
      <div class="jgrid">
        <div v-for="g in groups" :key="g" class="jgroup" :data-group="g">
          <h4>{{ g }}</h4>
          <button v-for="c in shown.filter((x) => (x.group ?? 'other') === g)" :key="c.id" class="case jcase" :class="{ on: selected === c.id, starred: jResults.get(c.id) && !jResults.get(c.id)!.converged }"
                  :data-case="c.id" @click="selected = c.id">
            <span class="cid">{{ c.id }}</span>
            <b class="ctitle">{{ c.title }}</b>
            <span class="cwhat">{{ c.finger_joint_k_equiv_n_m ? `${c.finger_joint_k_equiv_n_m} N/m at the fingertip` : 'joints held rigid' }}</span>
            <template v-if="jResults.get(c.id)">
              <span class="nums">
                <span><em>touch</em> {{ fmt(jResults.get(c.id)!.touch_peak_n) }}{{ jResults.get(c.id)!.converged ? '' : '*' }} N</span>
                <span><em>arm flange</em> {{ fmt(jResults.get(c.id)!.arm_flange_peak_n) }} N</span>
                <span><em>arm gear shock</em> {{ fmt(armShock(c.id), 1) }} N·m</span>
                <span><em>finger gear</em> {{ fmt(maxOf(jResults.get(c.id)!.finger_gear_torque_peak_nm), 2) }} N·m</span>
              </span>
              <span v-if="jResults.get(c.id)!.finger_travel_used" class="travel" aria-label="finger joint travel used">
                <span v-for="(u, k) in jResults.get(c.id)!.finger_travel_used" :key="k" class="tbar" :class="{ stop: u >= 1 }" :title="`joint ${k + 1}: ${(u * 100).toFixed(0)} % of its range`">
                  <span :style="{ width: `${Math.min(100, u * 100)}%` }" /></span>
                <small>travel used{{ jResults.get(c.id)!.finger_travel_used!.some((u) => u >= 1) ? ' · hit the stop' : '' }}</small>
              </span>
              <span class="grasp" :class="{ fail: jResults.get(c.id)!.grasp_success === false }">{{ jResults.get(c.id)!.grasp_success === false ? 'grasp failed' : 'grasped' }}</span>
            </template>
            <span v-else class="placeholder" aria-hidden="true"><span /><span /></span>
          </button>
        </div>
      </div>
      <figure v-if="chart" class="kchart" data-testid="hand-kchart">
        <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" role="img" aria-label="arm gear shock against finger joint stiffness">
          <line :x1="chart.L" :x2="chart.W - chart.R" :y1="chart.H - chart.B" :y2="chart.H - chart.B" class="ax" />
          <line :x1="chart.L" :x2="chart.L" :y1="chart.T" :y2="chart.H - chart.B" class="ax" />
          <text :x="chart.L - 4" :y="chart.T + 8" class="tl" text-anchor="end">{{ chart.yMax.toFixed(0) }}</text>
          <text :x="chart.L - 4" :y="chart.H - chart.B" class="tl" text-anchor="end">0</text>
          <text v-for="k in chart.ks" :key="k" :x="chart.x(k)" :y="chart.H - 6" class="tl" text-anchor="middle">{{ k }}</text>
          <template v-if="chart.rigid !== null">
            <line :x1="chart.L" :x2="chart.W - chart.R" :y1="chart.rigid" :y2="chart.rigid" class="ref" />
            <text :x="chart.W - chart.R" :y="chart.rigid - 3" class="tl" text-anchor="end">rigid joints {{ chart.rigidValue!.toFixed(1) }}</text>
          </template>
          <g v-for="l in chart.lines" :key="l.group">
            <path :d="l.d" :stroke="l.color" fill="none" stroke-width="1.8" />
            <circle v-for="p in l.points" :key="p.id" :cx="chart.x(p.k)" :cy="chart.y(p.y)" r="3" :fill="l.color" />
          </g>
        </svg>
        <figcaption>Arm gear shock (largest joint, N·m) against the finger joints' stiffness at the fingertip (N/m, log scale), {{ arm }} arm,
          {{ contactObject }} object. <span v-for="l in chart.lines" :key="l.group" class="lk" :style="{ color: l.color }">● {{ l.group }}</span></figcaption>
      </figure>
      <p class="legend metrics" data-testid="hand-metrics"><b>Gear torque peak:</b> {{ metricsText }} Travel used: the share of each finger joint's
        range the touch took (≥ 100 % = hit the stop, red).</p>

      <div v-if="data!.contact_models" class="models" data-testid="contact-models">
        <h4>Which contact model, and why</h4>
        <p>{{ data!.contact_models.finding }}</p>
        <p class="dim">Used for the runs above: <b>{{ chosenModel?.label ?? data!.contact_models.chosen }}</b>.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>model</th><th v-for="id in modelCases" :key="id">{{ id }}<br /><small>fingertip / flange N · arm gear N·m</small></th></tr></thead>
            <tbody>
              <tr v-for="m in data!.contact_models.models" :key="m.id" :class="{ chosen: m.id === data!.contact_models.chosen }">
                <td><b>{{ m.label }}</b><br /><span class="dim">{{ m.what }}</span></td>
                <td v-for="id in modelCases" :key="id" class="mono">
                  <template v-if="m.results?.[id]">{{ fmt(m.results[id].fingertip_peak_n) }} / {{ fmt(m.results[id].arm_flange_peak_n) }}
                    · {{ fmt(maxOf(m.results[id].arm_gear_torque_peak_nm), 1) }}{{ m.results[id].converged === false ? '*' : '' }}</template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <component :is="isV2 ? 'details' : 'div'" class="hblock" :class="{ legacy: isV2 }" :data-testid="isV2 ? 'hand-legacy' : undefined">
    <summary v-if="isV2">The first study: soft fingers vs a soft arm (H-cases)</summary>
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
    </component>
    <div v-if="data?.replay" class="replay">
      <div class="rbar">
        <button class="play" :disabled="tapeState !== 'ready'" @click="toggle">{{ playing ? 'Pause' : 'Play' }}</button>
        <span class="dim mono">{{ selected }} · {{ contactObject }} · t = {{ time.toFixed(2) }} s</span>
        <span v-if="data?.fixture" class="dim">fixture data, not results</span>
      </div>
      <p v-if="isV2 && selected.startsWith('J')" class="dim notape">No replay tape for the J-cases yet: open the first study below and pick an H-case to replay it.</p>
      <div v-show="!(isV2 && selected.startsWith('J'))" ref="view" class="rview">
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
.notape {
  margin: 0;
  font-size: 13px;
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
.answer {
  font-size: 15px;
}
.jbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.seg {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: 999px;
}
.seg button {
  padding: 3px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--pt-text-2);
}
.seg button.on {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
.jgrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 12px;
}
.jgroup {
  display: grid;
  gap: 8px;
  align-content: start;
}
.jgroup h4 {
  margin: 0;
  font-size: 13px;
  text-transform: capitalize;
  color: var(--pt-text-2);
}
.travel {
  display: flex;
  gap: 3px;
  align-items: center;
}
.tbar {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--pt-bg-soft);
  overflow: hidden;
}
.tbar span {
  display: block;
  height: 100%;
  background: var(--pt-brand);
}
.tbar.stop span {
  background: var(--pt-warn);
}
.travel small {
  flex: 0 0 auto;
  margin-left: 4px;
  font-size: 10.5px;
  color: var(--pt-text-3);
}
.grasp {
  font-size: 11.5px;
  color: var(--pt-good);
}
.grasp.fail {
  color: var(--pt-warn);
}
.kchart {
  margin: 0;
  max-width: 560px;
}
.kchart svg {
  display: block;
  width: 100%;
  height: auto;
}
.kchart .ax {
  stroke: var(--pt-line);
}
.kchart .ref {
  stroke: var(--pt-warn);
  stroke-dasharray: 5 3;
}
.kchart .tl {
  font-size: 9px;
  fill: var(--pt-text-3);
  font-family: var(--pt-font-mono);
}
.kchart figcaption {
  font-size: 12px;
  color: var(--pt-text-3);
}
.lk {
  margin-left: 8px;
  font-weight: 600;
}
.models {
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
}
.models h4 {
  margin: 0 0 4px;
}
.models p {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--pt-text-2);
}
.table-wrap {
  overflow-x: auto;
}
.models table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.models th,
.models td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--pt-line);
  text-align: left;
  vertical-align: top;
}
.models th {
  color: var(--pt-text-3);
  font-weight: 600;
}
.models tr.chosen td:first-child {
  box-shadow: inset 3px 0 0 var(--pt-brand);
}
.hblock {
  display: grid;
  gap: 12px;
}
details.hblock {
  display: block;
  padding: 0 14px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
}
details.hblock > summary {
  cursor: pointer;
  padding: 10px 0;
  font-weight: 600;
  font-size: 14px;
}
details.hblock > .cases,
details.hblock > .summary {
  margin-bottom: 10px;
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
