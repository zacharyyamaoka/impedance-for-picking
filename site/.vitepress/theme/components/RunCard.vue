<script setup lang="ts">
// One factorial run in full (its numbers, its Fz trace, its gears), or - with `other` - two runs side by side ("compare to"), the
// factors that differ marked. Used by the Explorer's detail panel and the ablation ladder's factor swap.
import { computed } from 'vue'
import FzSpark from './FzSpark.vue'
import GearBars from './GearBars.vue'
import JointTraces from './JointTraces.vue'
import { FACTORS, FACTOR_NAMES, HOURS_PER_DAY, PICKS_PER_HOUR, armLife, compact, label, lifeYears, worstJoint, years, type Factorial, type Run } from '../lib/factorial'

const props = withDefaults(defineProps<{ data: Factorial; run: Run; other?: Run | null; names?: [string, string]; traces?: boolean }>(), {
  other: null,
  names: () => ['A', 'B'],
  traces: true,
})

const ratings = computed(() => (props.data.gearboxes[props.run.build]?.per_joint ?? []).map((g) => g.repeated_peak_nm))
const differs = (f: (typeof FACTORS)[number]) => !!props.other && props.other[f] !== props.run[f]

function facts(run: Run) {
  const worst = worstJoint(run)
  const life = armLife(run)
  return {
    touch: run.touch_peak_n,
    press: run.press_mean_n,
    load: worst.ratio,
    joint: props.data.joints[worst.index],
    life: life.picks,
    years: lifeYears(life.picks),
    safe: run.safe_approach_speed_m_s,
  }
}
const A = computed(() => facts(props.run))
const B = computed(() => (props.other ? facts(props.other) : null))
const change = (a: number, b: number) => (a ? `${b < a ? '−' : '+'}${Math.abs(((b - a) / a) * 100).toFixed(0)} %` : '—')
const ROWS = [
  { key: 'touch', name: 'Touch peak', fmt: (v: number) => `${v.toFixed(1)} N`, lower: true },
  { key: 'press', name: 'Press (hold)', fmt: (v: number) => `${v.toFixed(1)} N`, lower: true },
  { key: 'load', name: 'Max gear load', fmt: (v: number) => `×${v.toFixed(2)}`, lower: true },
  { key: 'life', name: 'Gearbox life', fmt: (v: number) => `${compact(v)} picks`, lower: false },
  { key: 'years', name: `… at ${PICKS_PER_HOUR}/h, ${HOURS_PER_DAY} h/day`, fmt: (v: number) => years(v), lower: false },
  { key: 'safe', name: 'Safe approach', fmt: (v: number) => `${v.toFixed(3)} m/s`, lower: false },
] as const
const tSpan = computed(() => {
  const all = [...props.run.trace.t_ms, ...(props.other?.trace.t_ms ?? [])]
  return [Math.min(...all), Math.max(...all)]
})
</script>

<template>
  <div class="run-card" :data-pair="other ? 'true' : 'false'" data-testid="run-card">
    <div class="combo" :class="{ pair: other }">
      <div v-for="(r, k) in (other ? [run, other] : [run])" :key="k" class="combo-col" :data-side="k === 0 ? 'a' : 'b'">
        <span v-if="other" class="side">{{ names[k] }}</span>
        <span v-for="f in FACTORS" :key="f" class="fchip" :class="{ diff: differs(f) }" :title="FACTOR_NAMES[f]">{{ label(data, r[f]) }}</span>
        <span v-if="!r.converged" class="flag" :title="r.flag ?? ''">★ {{ r.flag ?? 'did not hold the checks' }}</span>
      </div>
    </div>

    <table class="facts">
      <thead v-if="other"><tr><th /><th>{{ names[0] }}</th><th>{{ names[1] }}</th><th>change</th></tr></thead>
      <tbody>
        <tr v-for="row in ROWS" :key="row.key" :data-fact="row.key">
          <th scope="row">{{ row.name }}</th>
          <td :class="{ over: row.key === 'load' && A.load > 1 }">{{ row.fmt(A[row.key]) }}</td>
          <template v-if="B">
            <td :class="{ over: row.key === 'load' && B.load > 1 }">{{ row.fmt(B[row.key]) }}</td>
            <td class="chg" :class="{ good: row.lower ? B[row.key] < A[row.key] : B[row.key] > A[row.key] }">{{ change(A[row.key], B[row.key]) }}</td>
          </template>
        </tr>
      </tbody>
    </table>
    <p v-if="!other" class="small">Hardest-hit gear: <code>{{ A.joint }}</code>. Life is an estimate from the gearbox's fatigue model, not a test.</p>

    <h4>Contact force Fz</h4>
    <FzSpark :series="[{ t: run.trace.t_ms, y: run.trace.fz_n, color: 'var(--pt-brand)', label: `${names[0]} Fz` },
                       ...(other ? [{ t: other.trace.t_ms, y: other.trace.fz_n, color: 'var(--pt-accent)', label: `${names[1]} Fz`, dashed: true }] : [])]"
             :t-min="tSpan[0]" :t-max="tSpan[1]" :height="70" :cursor="0" />
    <p class="small">ms from first touch (the line); {{ other ? `${names[0]} solid, ${names[1]} dashed` : 'one run' }}.</p>

    <h4>Gear load per joint</h4>
    <GearBars :joints="data.joints" :ratios="run.gear_load_ratio" :peaks="run.gear_torque_peak_nm" :ratings="ratings"
              :compare="other ? other.gear_load_ratio : null" :labels="[names[0], names[1]]" />

    <template v-if="traces">
      <h4>Gear torque through the touch</h4>
      <JointTraces :joints="data.joints" :t="run.trace.t_ms" :series="run.trace.gear_torque_nm" :ratings="ratings"
                   :compare="other ? { t: other.trace.t_ms, series: other.trace.gear_torque_nm } : null" />
      <p class="small">|τ| at each gear; dashed: {{ label(data, run.build) }}'s repeated-peak rating{{ other && other.build !== run.build ? ` (${names[1]}'s gearbox differs: see its bars)` : '' }}.</p>
    </template>
  </div>
</template>

<style scoped>
.run-card {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.combo {
  display: grid;
  gap: 8px;
}
.combo.pair {
  grid-template-columns: 1fr 1fr;
}
.combo-col {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-content: flex-start;
}
.side {
  font-family: var(--pt-font-mono);
  font-weight: 700;
  font-size: 12px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--pt-brand);
  color: var(--pt-bg);
}
.combo-col[data-side='b'] .side {
  background: var(--pt-accent);
}
.fchip {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--pt-line);
  color: var(--pt-text-2);
}
.fchip.diff {
  border-color: var(--pt-accent);
  color: var(--pt-text);
  font-weight: 600;
}
.flag {
  font-size: 11.5px;
  color: var(--pt-warn);
}
table.facts {
  width: 100%;
  min-width: 0;
  border-collapse: collapse;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.facts th,
.facts td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--pt-line);
  text-align: right;
}
.facts th[scope='row'] {
  text-align: left;
  color: var(--pt-text-3);
  font-weight: 500;
}
.facts td {
  font-family: var(--pt-font-mono);
  white-space: nowrap;
}
.facts td.over {
  color: var(--pt-warn);
  font-weight: 600;
}
.facts .chg {
  color: var(--pt-warn);
}
.facts .chg.good {
  color: var(--pt-good);
}
h4 {
  margin: 6px 0 0;
  font-size: 13px;
}
.small {
  margin: 0;
  font-size: 11.5px;
  color: var(--pt-text-3);
}
code {
  font-family: var(--pt-font-mono);
  font-size: 0.92em;
}
</style>
