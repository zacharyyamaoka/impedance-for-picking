<script setup lang="ts">
// A small force trace: one or more Fz series against time, an optional playhead and shaded windows (the hold, the push).
// SVG with a fixed viewBox that stretches to its box, so it never forces a width on a phone.
import { computed } from 'vue'

interface Series {
  t: number[]
  y: number[]
  color: string
  label?: string
  dashed?: boolean
}

const props = withDefaults(
  defineProps<{
    series: Series[]
    yMax?: number
    tMin?: number
    tMax?: number
    cursor?: number | null
    bands?: { from: number; to: number; color: string }[]
    height?: number
    unit?: string
    tUnit?: string
    showAxis?: boolean
  }>(),
  { height: 64, unit: 'N', tUnit: 's', showAxis: true, cursor: null, bands: () => [] },
)

const W = 300
const H = computed(() => props.height)
const PAD = { l: 2, r: 2, t: 6, b: 4 }

const range = computed(() => {
  let t0 = props.tMin ?? Infinity
  let t1 = props.tMax ?? -Infinity
  let y1 = props.yMax ?? 0
  for (const s of props.series) {
    if (props.tMin === undefined && s.t.length) t0 = Math.min(t0, s.t[0])
    if (props.tMax === undefined && s.t.length) t1 = Math.max(t1, s.t[s.t.length - 1])
    if (props.yMax === undefined) for (const v of s.y) if (Number.isFinite(v)) y1 = Math.max(y1, v)
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
    t0 = 0
    t1 = 1
  }
  return { t0, t1, y1: y1 > 0 ? y1 * (props.yMax === undefined ? 1.08 : 1) : 1 }
})

function x(t: number) {
  const { t0, t1 } = range.value
  return PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r)
}
function y(v: number) {
  return H.value - PAD.b - (Math.min(v, range.value.y1) / range.value.y1) * (H.value - PAD.t - PAD.b)
}

const paths = computed(() =>
  props.series.map((s) => {
    let d = ''
    for (let i = 0; i < s.t.length; i++) {
      const v = s.y[i]
      if (!Number.isFinite(v)) continue
      d += `${d ? 'L' : 'M'}${x(s.t[i]).toFixed(1)},${y(v).toFixed(1)}`
    }
    return { d, color: s.color, dashed: s.dashed }
  }),
)
</script>

<template>
  <svg class="fz-spark" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" :style="{ height: `${H}px` }" role="img"
       :aria-label="series.map((s) => s.label).filter(Boolean).join(', ') || 'force trace'">
    <rect v-for="(band, i) in bands" :key="i" :x="x(band.from)" :y="0" :width="Math.max(0, x(band.to) - x(band.from))" :height="H" :fill="band.color" />
    <line v-if="showAxis" :x1="PAD.l" :x2="W - PAD.r" :y1="H - PAD.b" :y2="H - PAD.b" class="axis" />
    <path v-for="(p, i) in paths" :key="i" :d="p.d" :stroke="p.color" :stroke-dasharray="p.dashed ? '4 3' : undefined" fill="none"
          vector-effect="non-scaling-stroke" class="trace" />
    <line v-if="cursor !== null && cursor !== undefined" :x1="x(cursor)" :x2="x(cursor)" y1="0" :y2="H" class="cursor" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<style scoped>
.fz-spark {
  display: block;
  width: 100%;
  overflow: visible;
}
.axis {
  stroke: var(--pt-line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.trace {
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.cursor {
  stroke: var(--pt-text);
  stroke-width: 1;
  opacity: 0.6;
}
</style>
