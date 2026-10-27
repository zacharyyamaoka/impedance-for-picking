<script setup lang="ts">
// The ablation ladder (Zach, 2026-10-27): "change only one thing at a time ... Start with the worst case, then move it slower, then
// make the motors backdrivable, then lower the mass of the arm (grounding the motors), then add a spring on the end." The data is
// site/public/data/ablation.json (schema impedance-ablation/1, docs/data-contract.md), written by the sim lane; until it lands the
// planned rungs show without numbers. The object comes from the page-wide soft / rigid switch.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { withBase } from 'vitepress'
import FzSpark from './FzSpark.vue'
import RunCard from './RunCard.vue'
import { contactObject, fetchOptional, type ContactObject } from '../lib/contact'
import { FACTOR_NAMES, RUNG_COMBOS, findRun, label, loadFactorial, type Factorial } from '../lib/factorial'

interface Rung {
  id: string
  title: string
  change: string | null
  what?: string
}
interface Result {
  rung: string
  touch_peak_n: number
  peak_time_ms: number
  touch_speed_m_s: number
  reflected_mass_kg: number
  press_mean_n: number
  press_max_n: number
  converged: boolean
  rate_hz: number
  trace: { t_ms: number[]; fz_n: number[] }
}
interface Ablation {
  schema: string
  generated_at: string
  source: { lane_commit: string; script: string }
  objects: Record<ContactObject, { label: string; contact_stiffness_n_m: number; contact_damping_n_s_m: number }>
  rungs: Rung[]
  results: Record<ContactObject, Result[]>
}

// the planned rungs, as the frozen contract names them (docs/data-contract.md) - shown until the data lands
const PLANNED: Rung[] = [
  { id: 'R0', title: 'Worst case', change: null, what: 'UR-style joints (harmonic-drive rotor inertia), heavy links, fast approach, stiff position control' },
  { id: 'R1', title: 'Move slower', change: 'approach 0.2 -> 0.05 m/s over the last 30 mm' },
  { id: 'R2', title: 'Backdrivable motors', change: 'rotor inertia: harmonic-drive -> 10:1 QDD' },
  { id: 'R3', title: 'Lighter arm', change: 'link mass x0.3 (motors grounded)' },
  { id: 'R4', title: 'Spring on the end', change: 'passive level compensator 200 N/m, 4 N preload, 30 mm' },
  { id: 'R5', title: 'Impedance controller', change: 'stiff position control -> host_spring, soft z' },
]

const emit = defineEmits<{ loaded: [Ablation | null] }>()
const data = shallowRef<Ablation | null>(null)
const loaded = shallowRef(false)

onMounted(async () => {
  data.value = await fetchOptional<Ablation>(withBase('/data/ablation.json'))
  loaded.value = true
  emit('loaded', data.value)
  factorial.value = await loadFactorial()
})

// "Swap one rung's factor" (Zach, 2026-10-27): every rung is a combination of the full factorial (lib/factorial.ts RUNG_COMBOS), so
// any one factor of a rung can be swapped and the result read from data/factorial.json, shown as a pair (the rung vs the swap).
const factorial = shallowRef<Factorial | null>(null)
const SWAP_FACTORS = ['build', 'controller', 'approach', 'spring'] as const
type SwapFactor = (typeof SWAP_FACTORS)[number]
const swap = ref<{ rung: string; factor: SwapFactor; value: string } | null>(null)
function swapTo(rung: string, factor: SwapFactor, value: string) {
  swap.value = value === RUNG_COMBOS[rung]?.[factor] ? null : { rung, factor, value }
}
const pair = computed(() => {
  const s = swap.value
  if (!s || !factorial.value) return null
  const base = RUNG_COMBOS[s.rung]
  const a = findRun(factorial.value, { ...base, object: contactObject.value })
  const b = findRun(factorial.value, { ...base, [s.factor]: s.value, object: contactObject.value })
  return a && b ? { a, b, s } : null
})

const rungs = computed(() => data.value?.rungs ?? PLANNED)
const results = computed(() => data.value?.results?.[contactObject.value] ?? [])
const byRung = computed(() => new Map(results.value.map((r) => [r.rung, r])))
const peakMax = computed(() => Math.max(1, ...results.value.map((r) => r.touch_peak_n), ...results.value.map((r) => r.press_max_n)))
const traceMax = computed(() => Math.max(1, ...results.value.flatMap((r) => r.trace?.fz_n ?? [])))
const tSpan = computed(() => {
  const all = results.value.flatMap((r) => r.trace?.t_ms ?? [])
  return all.length ? [Math.min(...all), Math.max(...all)] : [-50, 600]
})

// R0's description is long: its first sentence on the card, the rest one click away
function firstSentence(text?: string) {
  if (!text) return ''
  const i = text.indexOf('. ')
  return (i > 0 ? text.slice(0, i + 1) : text).replaceAll('->', '→')
}
function rest(text?: string) {
  if (!text) return ''
  const i = text.indexOf('. ')
  return i > 0 ? text.slice(i + 2) : ''
}
const fmt = (v: number | undefined | null, d = 0) => (v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(d))
function change(i: number) {
  if (i === 0) return null
  const now = byRung.value.get(rungs.value[i].id)
  const before = byRung.value.get(rungs.value[i - 1].id)
  if (!now || !before || !before.touch_peak_n) return null
  return (now.touch_peak_n - before.touch_peak_n) / before.touch_peak_n
}
const summary = computed(() => {
  const list = rungs.value.map((rung) => byRung.value.get(rung.id)).filter((r): r is Result => !!r)
  if (list.length < 2) return null
  const first = list[0]
  const last = list[list.length - 1]
  let biggest = { id: '', title: '', drop: 0 }
  rungs.value.forEach((rung, i) => {
    const c = change(i)
    if (c !== null && byRung.value.get(rung.id)?.converged && byRung.value.get(rungs.value[i - 1].id)?.converged && -c > biggest.drop) {
      biggest = { id: rung.id, title: rung.title, drop: -c }
    }
  })
  return { first, last, biggest, ratio: first.touch_peak_n / Math.max(last.touch_peak_n, 1e-9) }
})
</script>

<template>
  <div class="ladder" :data-state="data ? 'data' : loaded ? 'pending' : 'loading'" data-testid="ablation-ladder">
    <p v-if="!data && loaded" class="pending-note">
      <b>Being computed.</b> The sim lane is running this ladder now; the cards fill in when <code>data/ablation.json</code> lands. The rungs
      below are the plan, one change each.
    </p>
    <p v-if="summary" class="summary">
      From {{ summary.first.rung }} to {{ summary.last.rung }} the touch peak falls from <b>{{ fmt(summary.first.touch_peak_n) }} N</b> to
      <b>{{ fmt(summary.last.touch_peak_n) }} N</b> (×{{ summary.ratio.toFixed(1) }} lower).
      <template v-if="summary.biggest.id">The biggest single step is {{ summary.biggest.id }}, {{ summary.biggest.title.toLowerCase() }}:
        −{{ (summary.biggest.drop * 100).toFixed(0) }} %.</template>
    </p>
    <ol class="rungs">
      <li v-for="(rung, i) in rungs" :key="rung.id" class="rung" :class="{ starred: byRung.get(rung.id) && !byRung.get(rung.id)!.converged }"
          :data-rung="rung.id">
        <div class="rhead">
          <span class="rid">{{ rung.id }}</span>
          <div class="rtitle">
            <b>{{ rung.title }}</b>
            <span class="rchange">{{ rung.change ? `Changes one thing: ${rung.change.replaceAll('->', '→')}` : firstSentence(rung.what) }}</span>
            <details v-if="rung.change ? rung.what : rest(rung.what)" class="rwhat">
              <summary>{{ rung.change ? 'what this rung does' : 'more' }}</summary>{{ (rung.change ? rung.what : rest(rung.what))?.replaceAll('->', '→') }}
            </details>
          </div>
        </div>
        <template v-if="byRung.get(rung.id)">
          <div class="nums">
            <div class="num">
              <span class="k">touch peak</span>
              <b>{{ fmt(byRung.get(rung.id)!.touch_peak_n) }}<small>{{ byRung.get(rung.id)!.converged ? '' : '*' }} N</small></b>
              <span v-if="change(i) !== null" class="delta" :class="{ down: change(i)! < 0 }">{{ change(i)! < 0 ? '−' : '+' }}{{ Math.abs(change(i)! * 100).toFixed(0) }} %</span>
            </div>
            <div class="num">
              <span class="k">press (hold)</span>
              <b>{{ fmt(byRung.get(rung.id)!.press_mean_n, 1) }}<small> N</small></b>
              <span class="dim">max {{ fmt(byRung.get(rung.id)!.press_max_n, 1) }} N</span>
            </div>
          </div>
          <div class="bars" aria-hidden="true">
            <span class="bar peak" :style="{ width: `${(byRung.get(rung.id)!.touch_peak_n / peakMax) * 100}%` }" />
            <span class="bar press" :style="{ width: `${(byRung.get(rung.id)!.press_mean_n / peakMax) * 100}%` }" />
          </div>
          <FzSpark :series="[{ t: byRung.get(rung.id)!.trace.t_ms, y: byRung.get(rung.id)!.trace.fz_n, color: 'var(--pt-brand)', label: `${rung.id} Fz` }]"
                   :y-max="traceMax * 1.05" :t-min="tSpan[0]" :t-max="tSpan[1]" :height="46" :cursor="0" />
          <p class="meta">
            touch at {{ fmt(byRung.get(rung.id)!.touch_speed_m_s, 3) }} m/s · {{ fmt(byRung.get(rung.id)!.reflected_mass_kg, 2) }} kg in front · peak
            {{ fmt(byRung.get(rung.id)!.peak_time_ms, 1) }} ms after touch · {{ (byRung.get(rung.id)!.rate_hz / 1000).toFixed(0) }} kHz
          </p>
        </template>
        <div v-else class="placeholder" aria-hidden="true"><span /><span /></div>
        <div v-if="factorial && RUNG_COMBOS[rung.id]" class="swaps" data-testid="rung-swaps">
          <span class="sk">swap one factor</span>
          <label v-for="f in SWAP_FACTORS" :key="f" class="swap">
            <span class="sr">{{ FACTOR_NAMES[f] }}</span>
            <select :data-factor="f" :value="swap?.rung === rung.id && swap.factor === f ? swap.value : RUNG_COMBOS[rung.id][f]"
                    :class="{ on: swap?.rung === rung.id && swap.factor === f }" @change="swapTo(rung.id, f, ($event.target as HTMLSelectElement).value)">
              <option v-for="v in factorial.factors[f]" :key="v" :value="v">{{ label(factorial, v) }}</option>
            </select>
          </label>
        </div>
      </li>
    </ol>
    <div v-if="pair" class="pair card-pair" data-testid="ladder-pair">
      <div class="pair-head">
        <b>{{ pair.s.rung }} as it is (A) vs {{ pair.s.rung }} with {{ FACTOR_NAMES[pair.s.factor].toLowerCase() }} →
          {{ label(factorial, pair.s.value) }} (B)</b>
        <button class="close" @click="swap = null">Close</button>
      </div>
      <RunCard :data="factorial!" :run="pair.a" :other="pair.b" :names="[pair.s.rung, 'swap']" :traces="false" />
      <p class="legend">From <code>data/factorial.json</code> (every combination, {{ contactObject }} object); the ladder's cards above are
        <code>data/ablation.json</code>, the same combinations run by the ladder's own script.</p>
    </div>
    <p v-if="data" class="legend">
      Each card changes one thing from the card above; the trace is Fz from 50 ms before touch to the end of the hold (line at touch), on one scale.
      Bars: <span class="kp">touch peak</span> and <span class="kh">press during the hold</span>, scaled to the largest. "*": did not hold the rate or
      perturbation check; never in a headline. Source: <code>data/ablation.json</code> ({{ data.source.script }} on {{ data.source.lane_commit?.slice(0, 8) }}).
    </p>
  </div>
</template>

<style scoped>
.ladder {
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
.rungs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rung {
  display: grid;
  gap: 8px;
  align-content: start;
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
}
.rhead {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.rid {
  flex: 0 0 auto;
  min-width: 30px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--pt-brand);
  color: var(--pt-bg);
  font-family: var(--pt-font-mono);
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}
.rtitle {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rtitle b {
  font-size: 15px;
}
.rwhat {
  color: var(--pt-text-3);
  font-size: 12px;
  line-height: 1.45;
}
.rwhat summary {
  cursor: pointer;
  color: var(--pt-text-3);
}
.rchange {
  color: var(--pt-text-2);
  font-size: 12.5px;
  line-height: 1.4;
}
.nums {
  display: flex;
  gap: 18px;
}
.num {
  display: flex;
  flex-direction: column;
}
.num .k {
  color: var(--pt-text-3);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.num b {
  font-family: var(--pt-font-mono);
  font-size: 24px;
  line-height: 1.2;
}
.num small {
  font-size: 13px;
  font-weight: 500;
}
.delta {
  font-family: var(--pt-font-mono);
  font-size: 12px;
  color: var(--pt-warn);
}
.delta.down {
  color: var(--pt-good);
}
.dim {
  color: var(--pt-text-3);
  font-size: 12px;
}
.bars {
  display: grid;
  gap: 3px;
}
.bar {
  display: block;
  height: 6px;
  border-radius: 3px;
  transition: width 0.35s;
}
.bar.peak {
  background: var(--pt-accent);
}
.bar.press {
  background: var(--pt-brand);
}
.meta {
  margin: 0;
  color: var(--pt-text-3);
  font-size: 11.5px;
  font-family: var(--pt-font-mono);
}
.starred {
  border-style: dashed;
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
.swaps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  padding-top: 6px;
  border-top: 1px dashed var(--pt-line);
}
.sk {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pt-text-3);
  margin-right: 2px;
}
.swap .sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.swap select {
  max-width: 132px;
  padding: 2px 4px;
  border: 1px solid var(--pt-line);
  border-radius: 6px;
  background: var(--pt-card);
  color: var(--pt-text-2);
  font-size: 11.5px;
}
.swap select.on {
  border-color: var(--pt-accent);
  color: var(--pt-text);
  font-weight: 600;
}
.pair {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-accent);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  max-width: 760px;
}
.pair-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  justify-content: space-between;
  font-size: 14px;
}
.close {
  padding: 2px 10px;
  border: 1px solid var(--pt-line);
  border-radius: 999px;
  font-size: 12px;
}
.legend {
  margin: 0;
  color: var(--pt-text-3);
  font-size: 12.5px;
}
.legend .kp {
  color: var(--pt-accent);
  font-weight: 600;
}
.legend .kh {
  color: var(--pt-brand);
  font-weight: 600;
}
</style>
