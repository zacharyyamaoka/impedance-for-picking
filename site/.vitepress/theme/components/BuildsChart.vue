<script setup lang="ts">
// The arm-build axis of the impact study: the same pick on three arms - the UR5e stand-in (harmonic-drive-like rotors), "qdd" (10:1
// QDD rotors, 1.83e-3 kg·m² on every joint) and "qdd_light" (qdd with the six links at 0.3x mass) - under today's tuning (stiff),
// JOINT, HOST_SPRING and max-gain position control. The contact object comes from the page-wide soft / rigid switch.
import { computed, ref } from 'vue'
import { contactObject } from '../lib/contact'

interface Row {
  build: string
  controller: string
  contact_n_m: number
  speed: number
  friction: string
  peak_30ms_n: number | null
  peak_100ms_n: number | null
  after_touch_ms: number | null
  held: boolean
}

const props = defineProps<{ rows: Row[] }>()
const friction = ref<'ur5e' | 'jmc'>('ur5e')
const speed = ref(0.2)

const BUILDS = [
  { id: 'ur5e', label: 'UR-style joints', sub: 'UR5e stand-in: harmonic-drive-like rotors' },
  { id: 'qdd', label: 'Backdrivable QDD', sub: '10:1 QDD rotors, same links' },
  { id: 'qdd_light', label: 'QDD, light links', sub: 'links at 0.3× mass (motors grounded)' },
]
const CONTROLLERS = [
  { id: 'stiff', label: "stiff (today's tuning)", color: 'var(--pt-c-stiff)' },
  { id: 'joint', label: 'JOINT', color: 'var(--pt-c-joint)' },
  { id: 'host_spring', label: 'HOST_SPRING', color: 'var(--pt-c-host-spring)' },
  { id: 'stiff_max', label: 'max-gain position control', color: 'var(--pt-c-max)' },
]
const contact = computed(() => (contactObject.value === 'rigid' ? 100000 : 20000))

const groups = computed(() =>
  BUILDS.map((build) => ({
    ...build,
    bars: CONTROLLERS.map((controller) => {
      const row = props.rows.find((r) => r.build === build.id && r.controller === controller.id && r.contact_n_m === contact.value
        && Math.abs(r.speed - speed.value) < 1e-9 && r.friction === friction.value)
      return { ...controller, row }
    }),
  })),
)
const top = computed(() => {
  let max = 0
  for (const g of groups.value) for (const b of g.bars) max = Math.max(max, b.row?.peak_100ms_n ?? 0)
  return max || 1
})
const pct = (v: number | null | undefined) => `${Math.max(0.5, ((v ?? 0) / top.value) * 100)}%`
const stiffDrop = computed(() => {
  const value = (build: string) => groups.value.find((g) => g.id === build)?.bars.find((b) => b.id === 'stiff')?.row?.peak_100ms_n ?? null
  return { ur5e: value('ur5e'), qdd: value('qdd'), light: value('qdd_light') }
})
</script>

<template>
  <div class="builds" data-testid="builds-chart">
    <div class="controls">
      <div class="seg" role="radiogroup" aria-label="joint friction">
        <span class="seg-label">friction</span>
        <button role="radio" :aria-checked="friction === 'ur5e'" :class="{ on: friction === 'ur5e' }" @click="friction = 'ur5e'">UR5e</button>
        <button role="radio" :aria-checked="friction === 'jmc'" :class="{ on: friction === 'jmc' }" @click="friction = 'jmc'">JMC-like (Gen-1)</button>
      </div>
      <div class="seg" role="radiogroup" aria-label="approach speed">
        <span class="seg-label">speed</span>
        <button v-for="s in [0.1, 0.2]" :key="s" role="radio" :aria-checked="speed === s" :class="{ on: speed === s }" @click="speed = s">{{ s }} m/s</button>
      </div>
    </div>
    <div class="groups">
      <div v-for="group in groups" :key="group.id" class="group">
        <div class="glabel"><b>{{ group.label }}</b><span>{{ group.sub }}</span></div>
        <div v-for="bar in group.bars" :key="bar.id" class="bar-row" :class="{ flagged: bar.row && !bar.row.held }">
          <span class="blabel">{{ bar.label }}</span>
          <span class="track"><span class="bar" :style="{ width: pct(bar.row?.peak_100ms_n), background: bar.color }" /></span>
          <span class="val">
            {{ bar.row?.peak_100ms_n?.toFixed(0) ?? '—' }}{{ bar.row && !bar.row.held ? '*' : '' }} N
            <em v-if="bar.row?.after_touch_ms && bar.row.after_touch_ms > 30">press</em>
          </span>
        </div>
      </div>
    </div>
    <p class="legend">
      Peak contact force in the 100 ms after touch, {{ contactObject === 'rigid' ? 'rigid 100 kN/m' : 'soft 20 kN/m' }} object (B 200 N·s/m assumed),
      δ +10 mm. "press": the maximum lands later than 30 ms after touch, the controller pushing the arm in rather than the touch itself.
      "*": did not hold the rate or perturbation check. <template v-if="stiffDrop.ur5e && stiffDrop.qdd && stiffDrop.light">Today's tuning reads
        {{ stiffDrop.ur5e.toFixed(0) }} → {{ stiffDrop.qdd.toFixed(0) }} → {{ stiffDrop.light.toFixed(0) }} N across the three arms.</template>
    </p>
  </div>
</template>

<style scoped>
.builds {
  display: grid;
  gap: 10px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.groups {
  display: grid;
  gap: 14px;
}
.glabel {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  margin-bottom: 4px;
  font-size: 13.5px;
}
.glabel span {
  color: var(--pt-text-3);
  font-size: 12px;
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(96px, 170px) minmax(0, 1fr) 82px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin: 2px 0;
}
.blabel {
  color: var(--pt-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track {
  height: 12px;
  background: var(--pt-bg-soft);
  border-radius: 3px;
  overflow: hidden;
}
.bar {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.35s;
}
.val {
  font-family: var(--pt-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.val em {
  display: block;
  color: var(--pt-warn);
  font-style: normal;
  font-size: 10.5px;
}
.flagged .bar {
  opacity: 0.4;
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
.seg button.on {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
@media (max-width: 480px) {
  .bar-row {
    grid-template-columns: minmax(80px, 110px) minmax(0, 1fr) 64px;
  }
}
</style>
