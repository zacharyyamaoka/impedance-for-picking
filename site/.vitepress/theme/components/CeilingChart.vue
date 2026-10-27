<script setup lang="ts">
// The host-loop ceilings, interactive: the largest stable natural frequency of a delayed host PD against a host spring over a
// board-rate damper, over host delay, at a chosen host rate. Every point is stability.host_wn_ceiling (an exact discrete model with
// a fractional delay), computed by scripts/export_site_data.py - the page draws the table, it does not compute it.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface Ceilings {
  delays_ms: number[]
  rates_hz: number[]
  table: Record<string, { host_pd: (number | null)[]; host_spring: (number | null)[] }>
  rack: { rate_hz: number; delay_ms: number; host_pd: number; host_spring: number; wn_ratio: number; k_ratio: number }
}
interface JointCeiling {
  joint: string
  inertia_kg_m2: number
}

const props = defineProps<{
  ceilings: Ceilings
  joints: Record<string, JointCeiling[]>
  measured?: { torque: number; host_spring: number }
}>()

const rate = ref(String(props.ceilings.rack.rate_hz))
const delayIndex = ref(props.ceilings.delays_ms.indexOf(props.ceilings.rack.delay_ms))
const inertiaKey = ref('qdd/wrist_3_joint')

const options = computed(() => {
  const out: { key: string; label: string; J: number }[] = [{ key: 'fixture', label: 'boundary fixture, J 0.1 kg·m²', J: 0.1 }]
  for (const [build, rows] of Object.entries(props.joints ?? {})) {
    for (const row of rows) out.push({ key: `${build}/${row.joint}`, label: `${build} · ${row.joint.replace('_joint', '')}, ${row.inertia_kg_m2.toPrecision(3)} kg·m²`, J: row.inertia_kg_m2 })
  }
  return out
})
const inertia = computed(() => options.value.find((o) => o.key === inertiaKey.value)?.J ?? 0.1)

const series = computed(() => props.ceilings.table[rate.value])
const delay = computed(() => props.ceilings.delays_ms[delayIndex.value])
const at = computed(() => ({ pd: series.value.host_pd[delayIndex.value] ?? NaN, spring: series.value.host_spring[delayIndex.value] ?? NaN }))
const ratio = computed(() => at.value.spring / at.value.pd)

// WHY a px-true viewBox (the wrapper's width, measured): a scaled-up viewBox made the tick labels 20+ px on a desktop and 7 px on a phone
const box = ref<HTMLElement | null>(null)
const W = ref(520)
const H = computed(() => (W.value < 520 ? 220 : 280))
const PAD = { l: 40, r: 10, t: 8, b: 34 }
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (box.value) W.value = Math.max(240, Math.round(box.value.clientWidth))
  })
  if (box.value) observer.observe(box.value)
})
onBeforeUnmount(() => observer?.disconnect())
const yMax = computed(() => {
  let top = 0
  for (const v of [...series.value.host_pd, ...series.value.host_spring]) if (v && Number.isFinite(v)) top = Math.max(top, v)
  const step = top > 1500 ? 500 : top > 600 ? 200 : 100
  return Math.ceil((top * 1.05) / step) * step
})
const xMax = computed(() => props.ceilings.delays_ms[props.ceilings.delays_ms.length - 1])
const x = (d: number) => PAD.l + (d / xMax.value) * (W.value - PAD.l - PAD.r)
const y = (v: number) => H.value - PAD.b - (Math.min(v, yMax.value) / yMax.value) * (H.value - PAD.t - PAD.b)
function line(values: (number | null)[]) {
  let d = ''
  props.ceilings.delays_ms.forEach((delayMs, i) => {
    const v = values[i]
    if (v === null || !Number.isFinite(v)) return
    d += `${d ? 'L' : 'M'}${x(delayMs).toFixed(1)},${y(v).toFixed(1)}`
  })
  return d
}
const yTicks = computed(() => {
  const n = 5
  return Array.from({ length: n + 1 }, (_, i) => Math.round((yMax.value / n) * i))
})
const xTicks = computed(() => props.ceilings.delays_ms.filter((d) => Number.isInteger(d) && d % 3 === 0))

function fromPointer(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const px = ((event.clientX - rect.left) / rect.width) * W.value
  const d = ((px - PAD.l) / (W.value - PAD.l - PAD.r)) * xMax.value
  let best = 0
  props.ceilings.delays_ms.forEach((value, i) => {
    if (Math.abs(value - d) < Math.abs(props.ceilings.delays_ms[best] - d)) best = i
  })
  delayIndex.value = best
}
function onPointer(event: PointerEvent) {
  if (event.type === 'pointermove' && event.buttons === 0 && event.pointerType !== 'mouse') return
  fromPointer(event)
}

const fmtK = (v: number) => (v >= 1000 ? `${(v / 1000).toPrecision(3)} k` : v.toPrecision(3))
</script>

<template>
  <div class="ceiling-chart" data-testid="ceiling-chart">
    <div class="controls">
      <div class="seg" role="radiogroup" aria-label="host loop rate">
        <span class="seg-label">host rate</span>
        <button v-for="r in ceilings.rates_hz" :key="r" role="radio" :aria-checked="rate === String(r)" :class="{ on: rate === String(r) }" @click="rate = String(r)">
          {{ r }} Hz
        </button>
      </div>
    </div>
    <p class="axis-title">ω<sub>n</sub> max, rad/s (ζ 1)</p>
    <div ref="box" class="chart-box">
    <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H" class="chart" role="img" aria-label="host ceiling against delay" @pointerdown="onPointer" @pointermove="onPointer">
      <g class="grid">
        <line v-for="t in yTicks" :key="`y${t}`" :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" />
      </g>
      <g class="ticks">
        <text v-for="t in yTicks" :key="`yl${t}`" :x="PAD.l - 6" :y="y(t) + 4" text-anchor="end">{{ t }}</text>
        <text v-for="t in xTicks" :key="`xl${t}`" :x="x(t)" :y="H - PAD.b + 16" text-anchor="middle">{{ t }}</text>
        <text :x="(PAD.l + W - PAD.r) / 2" :y="H - 4" text-anchor="middle">host delay, ms</text>
      </g>
      <path :d="line(series.host_spring)" class="spring" />
      <path :d="line(series.host_pd)" class="pd" />
      <line :x1="x(delay)" :x2="x(delay)" :y1="PAD.t" :y2="H - PAD.b" class="cursor" />
      <circle :cx="x(delay)" :cy="y(at.spring)" r="4.5" class="dot spring-dot" />
      <circle :cx="x(delay)" :cy="y(at.pd)" r="4.5" class="dot pd-dot" />
      <template v-if="measured && rate === String(ceilings.rack.rate_hz)">
        <rect :x="x(ceilings.rack.delay_ms) - 3.5" :y="y(measured.torque) - 3.5" width="7" height="7" class="measured" />
        <rect :x="x(ceilings.rack.delay_ms) - 3.5" :y="y(measured.host_spring) - 3.5" width="7" height="7" class="measured" />
      </template>
    </svg>
    </div>
    <input v-model.number="delayIndex" class="scrub" type="range" min="0" :max="ceilings.delays_ms.length - 1" step="1" aria-label="host delay" />
    <div class="readout">
      <div class="cell"><span class="key pd" /> host PD (TORQUE mode)<b>{{ at.pd.toFixed(1) }} rad/s</b></div>
      <div class="cell"><span class="key spring" /> host spring + board damper (HOST_SPRING)<b>{{ at.spring.toFixed(1) }} rad/s</b></div>
      <div class="cell">at {{ rate }} Hz, {{ delay }} ms<b>×{{ ratio.toFixed(1) }} ω<sub>n</sub> · ×{{ (ratio * ratio).toFixed(1) }} K</b></div>
    </div>
    <div class="k-row">
      <label>
        k = J·ω<sub>n</sub>² for
        <select v-model="inertiaKey" aria-label="joint inertia">
          <option v-for="o in options" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
      </label>
      <span>host PD <b>{{ fmtK(inertia * at.pd * at.pd) }} N·m/rad</b></span>
      <span>HOST_SPRING <b>{{ fmtK(inertia * at.spring * at.spring) }} N·m/rad</b></span>
      <span class="dim">deployed at half of each (the 2× kp margin)</span>
    </div>
    <p class="legend">
      Drag across the chart or use the slider. <template v-if="measured">The squares at {{ ceilings.rack.rate_hz }} Hz / {{ ceilings.rack.delay_ms }} ms are
        the implemented loop's measured boundary in the sim ({{ measured.torque }} and {{ measured.host_spring }} rad/s): 7–12 % under the ideal model,
        inside the 2× kp margin.</template>
    </p>
  </div>
</template>

<style scoped>
.ceiling-chart {
  display: grid;
  gap: 8px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.axis-title {
  margin: 0;
  color: var(--pt-text-2);
  font-size: 12px;
}
.chart-box {
  width: 100%;
  min-width: 0;
}
.chart {
  display: block;
  width: 100%;
  touch-action: pan-y;
  cursor: crosshair;
}
.grid line {
  stroke: var(--pt-line);
  stroke-width: 1;
}
.ticks text {
  fill: var(--pt-text-3);
  font-size: 11px;
  font-family: var(--pt-font-mono);
}
.ticks .unit {
  fill: var(--pt-text-2);
}
.pd {
  fill: none;
  stroke: var(--pt-c-torque);
  stroke-width: 2.4;
}
.spring {
  fill: none;
  stroke: var(--pt-c-host-spring);
  stroke-width: 2.4;
}
.cursor {
  stroke: var(--pt-text-3);
  stroke-dasharray: 3 3;
}
.dot {
  stroke: var(--pt-card);
  stroke-width: 2;
}
.pd-dot {
  fill: var(--pt-c-torque);
}
.spring-dot {
  fill: var(--pt-c-host-spring);
}
.measured {
  fill: none;
  stroke: var(--pt-text);
  stroke-width: 1.5;
}
.scrub {
  width: 100%;
  accent-color: var(--pt-brand);
}
.readout {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  color: var(--pt-text-2);
  font-size: 12px;
}
.cell b {
  color: var(--pt-text);
  font-family: var(--pt-font-mono);
  font-size: 17px;
}
.key {
  display: inline-block;
  width: 14px;
  height: 3px;
  margin-right: 4px;
  vertical-align: middle;
}
.key.pd {
  background: var(--pt-c-torque);
}
.key.spring {
  background: var(--pt-c-host-spring);
}
.k-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  font-size: 13px;
  color: var(--pt-text-2);
}
.k-row b {
  color: var(--pt-text);
  font-family: var(--pt-font-mono);
}
.k-row select {
  max-width: 100%;
  margin-left: 4px;
  padding: 3px 6px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  color: var(--pt-text);
  font-size: 12.5px;
}
.dim {
  color: var(--pt-text-3);
}
.legend {
  margin: 0;
  color: var(--pt-text-3);
  font-size: 12.5px;
}
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: 999px;
  overflow: hidden;
  background: var(--pt-card);
  font-size: 12.5px;
}
.seg-label {
  padding: 0 8px 0 10px;
  color: var(--pt-text-3);
  font-size: 12px;
}
.seg button {
  padding: 4px 10px;
  color: var(--pt-text-2);
}
@media (max-width: 480px) {
  .seg-label {
    display: none;
  }
  .seg button {
    padding: 4px 8px;
  }
}
.seg button.on {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
</style>
