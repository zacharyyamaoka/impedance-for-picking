<script setup lang="ts">
// The torque each joint's GEAR carries through the touch and the hold, one small chart per joint, with that gearbox's repeated-peak
// rating as a dashed line. Plotted as |τ| so a shock either way reads against the one rating. `compare` overlays a second run.
import { computed } from 'vue'

const props = defineProps<{
  joints: string[]
  t: number[]
  series: number[][]
  ratings: number[]
  compare?: { t: number[]; series: number[][] } | null
  height?: number
}>()

const W = 300
const H = computed(() => props.height ?? 46)
const span = computed(() => {
  const all = [...props.t, ...(props.compare?.t ?? [])]
  return all.length ? [Math.min(...all), Math.max(...all)] : [0, 1]
})
function path(t: number[], y: number[], top: number) {
  const [t0, t1] = span.value
  let d = ''
  for (let i = 0; i < t.length; i++) {
    const v = Math.abs(y[i])
    if (!Number.isFinite(v)) continue
    const x = ((t[i] - t0) / (t1 - t0 || 1)) * W
    const yy = H.value - 2 - (Math.min(v, top) / top) * (H.value - 6)
    d += `${d ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`
  }
  return d
}
const rows = computed(() =>
  props.joints.map((joint, i) => {
    const y = props.series[i] ?? []
    const yb = props.compare?.series[i] ?? []
    const peak = Math.max(0, ...y.map(Math.abs).filter(Number.isFinite))
    const peakB = Math.max(0, ...yb.map(Math.abs).filter(Number.isFinite))
    const rating = props.ratings[i] ?? NaN
    const top = Math.max(peak, peakB, Number.isFinite(rating) ? rating * 1.15 : 0, 1e-6) * 1.05
    const ratingY = Number.isFinite(rating) ? H.value - 2 - (rating / top) * (H.value - 6) : null
    return { joint, peak, rating, over: peak > rating, d: path(props.t, y, top), db: props.compare ? path(props.compare.t, yb, top) : '', ratingY }
  }),
)
</script>

<template>
  <div class="joint-traces">
    <div v-for="r in rows" :key="r.joint" class="jt-row" :data-joint="r.joint" :data-over="r.over ? 'true' : 'false'">
      <span class="jt-name">{{ r.joint }}<b :class="{ over: r.over }">{{ r.peak.toFixed(1) }}</b><small>/ {{ Number.isFinite(r.rating) ? r.rating : '—' }} N·m</small></span>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" :style="{ height: `${H}px` }" role="img" :aria-label="`${r.joint} gear torque`">
        <line v-if="r.ratingY !== null" x1="0" :x2="W" :y1="r.ratingY" :y2="r.ratingY" class="limit" vector-effect="non-scaling-stroke" />
        <path v-if="r.db" :d="r.db" class="tb" fill="none" vector-effect="non-scaling-stroke" />
        <path :d="r.d" class="ta" :class="{ over: r.over }" fill="none" vector-effect="non-scaling-stroke" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.joint-traces {
  display: grid;
  gap: 4px;
}
.jt-row {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.jt-name {
  display: flex;
  flex-direction: column;
  font-family: var(--pt-font-mono);
  font-size: 11px;
  color: var(--pt-text-3);
  line-height: 1.25;
}
.jt-name b {
  color: var(--pt-text);
  font-size: 12.5px;
}
.jt-name b.over {
  color: var(--pt-warn);
}
svg {
  display: block;
  width: 100%;
  border-bottom: 1px solid var(--pt-line);
}
.limit {
  stroke: var(--pt-text-2);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}
.ta {
  stroke: var(--pt-brand);
  stroke-width: 1.5;
}
.ta.over {
  stroke: var(--pt-warn);
}
.tb {
  stroke: var(--pt-accent);
  stroke-width: 1.2;
  stroke-dasharray: 3 2;
}
@media (max-width: 480px) {
  .jt-row {
    grid-template-columns: 104px minmax(0, 1fr);
  }
}
</style>
