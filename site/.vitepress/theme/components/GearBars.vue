<script setup lang="ts">
// One load-ratio bar per joint: the peak torque the GEAR carried over its repeated-peak rating. The line is the rating (1.0); a bar
// past it turns red. With `compare`, a second, thinner bar per joint (run B) sits under the first, on the same scale.
import { computed } from 'vue'

const props = defineProps<{
  joints: string[]
  ratios: number[]
  peaks?: number[]
  ratings?: number[]
  compare?: number[] | null
  scaleMax?: number
  labels?: [string, string]
}>()

const scale = computed(() => Math.max(1.25, props.scaleMax ?? 0, ...props.ratios.filter(Number.isFinite), ...(props.compare ?? []).filter(Number.isFinite)) * 1.04)
const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale.value) * 100))}%`
const short = (name: string) => name.replace('shoulder_', 'sh. ').replace('_', ' ')
</script>

<template>
  <div class="gear-bars" role="list" :aria-label="`gear load per joint${compare ? ', two runs' : ''}`">
    <div v-if="compare && labels" class="gb-key"><span class="a">{{ labels[0] }}</span><span class="b">{{ labels[1] }}</span></div>
    <div v-for="(joint, i) in joints" :key="joint" class="gb-row" role="listitem" :data-joint="joint" :data-over="ratios[i] > 1 ? 'true' : 'false'">
      <span class="gb-name" :title="joint">{{ short(joint) }}</span>
      <span class="gb-track">
        <span class="gb-bar" :class="{ over: ratios[i] > 1 }" :style="{ width: pct(ratios[i]) }" />
        <span v-if="compare" class="gb-bar b" :class="{ over: compare[i] > 1 }" :style="{ width: pct(compare[i]) }" />
        <span class="gb-limit" :style="{ left: pct(1) }" aria-hidden="true" />
      </span>
      <span class="gb-val" :class="{ over: ratios[i] > 1 }">
        ×{{ Number.isFinite(ratios[i]) ? ratios[i].toFixed(2) : '—' }}<template v-if="compare"> / ×{{ compare[i].toFixed(2) }}</template>
        <small v-if="peaks && ratings && !compare">{{ peaks[i].toFixed(1) }} of {{ ratings[i] }} N·m</small>
      </span>
    </div>
    <p class="gb-legend">Bar: peak gear torque ÷ the gearbox's repeated-peak rating; the line is the rating; red is over it.</p>
  </div>
</template>

<style scoped>
.gear-bars {
  display: grid;
  gap: 5px;
}
.gb-key {
  display: flex;
  gap: 14px;
  font-size: 11.5px;
  color: var(--pt-text-3);
}
.gb-key .a::before,
.gb-key .b::before {
  content: '';
  display: inline-block;
  width: 12px;
  height: 6px;
  margin-right: 5px;
  border-radius: 2px;
  background: var(--pt-brand);
}
.gb-key .b::before {
  background: var(--pt-accent);
  height: 3px;
  vertical-align: 2px;
}
.gb-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}
.gb-name {
  font-family: var(--pt-font-mono);
  font-size: 11.5px;
  color: var(--pt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gb-track {
  position: relative;
  display: grid;
  gap: 2px;
  min-height: 10px;
  padding: 2px 0;
  background: var(--pt-bg-soft);
  border-radius: 3px;
}
.gb-bar {
  display: block;
  height: 8px;
  border-radius: 2px;
  background: var(--pt-brand);
  transition: width 0.3s;
}
.gb-bar.b {
  height: 4px;
  background: var(--pt-accent);
}
.gb-bar.over {
  background: var(--pt-warn);
}
.gb-limit {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 0;
  border-left: 1.5px dashed var(--pt-text);
}
.gb-val {
  font-family: var(--pt-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 64px;
}
.gb-val.over {
  color: var(--pt-warn);
  font-weight: 600;
}
.gb-val small {
  display: block;
  color: var(--pt-text-3);
  font-weight: 400;
  font-size: 10.5px;
}
.gb-legend {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--pt-text-3);
}
</style>
