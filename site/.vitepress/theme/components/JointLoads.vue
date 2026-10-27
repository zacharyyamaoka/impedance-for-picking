<script setup lang="ts">
// Joint loads and gear durability (Zach, 2026-10-27): "what we really care about for durability are the peak impact forces on the
// joints ... shocks through the gears ... specify the motion speed so we never surpass the gear's safety limit ... an estimated
// gearbox lifetime." Reads data/factorial.json (docs/data-contract.md): per-joint gear torque over the repeated-peak rating, the safe
// approach speed and the life estimate, for each arm build side by side, so the UR-style vs QDD gear shock is one glance.
import { computed, onMounted, ref, shallowRef } from 'vue'
import GearBars from './GearBars.vue'
import { contactObject } from '../lib/contact'
import {
  FACTOR_NAMES, HOURS_PER_DAY, PICKS_PER_HOUR, WORST, armLife, compact, findRun, gearAmplification, label, lifeYears, loadFactorial, worstJoint,
  years, type Factorial, type Run,
} from '../lib/factorial'

const data = shallowRef<Factorial | null>(null)
const loaded = ref(false)
onMounted(async () => {
  data.value = await loadFactorial()
  loaded.value = true
})

// the worst case first; the object follows the page-wide switch
const pick = ref<{ controller: string; approach: string; spring: string }>({ controller: WORST.controller, approach: WORST.approach, spring: WORST.spring })
const CONTROLS = ['controller', 'approach', 'spring'] as const

const builds = computed(() => data.value?.factors.build ?? [])
const cols = computed(() =>
  builds.value.map((build) => {
    const run = findRun(data.value, { build, ...pick.value, object: contactObject.value }) as Run | null
    const box = data.value?.gearboxes[build]
    if (!run) return { build, run: null, box }
    const worst = worstJoint(run)
    const life = armLife(run)
    return {
      build, run, box, worst, life,
      years: lifeYears(life.picks),
      amp: gearAmplification(run),
      ratio: box?.per_joint?.[worst.index]?.ratio ?? null,
      over: run.gear_load_ratio.filter((r) => r > 1).length,
    }
  }),
)
const scaleMax = computed(() => Math.max(1.25, ...cols.value.flatMap((c) => c.run?.gear_load_ratio ?? [])))
const ur = computed(() => cols.value.find((c) => c.build === 'ur5e' && c.run))
const qdd = computed(() => cols.value.find((c) => c.build === 'qdd' && c.run))
const ratioOf = (build: string) => data.value?.gearboxes[build]?.per_joint?.[0]?.ratio ?? null
const sq = (v: number | null) => (v === null ? '—' : (v * v).toLocaleString('en-US'))
</script>

<template>
  <div class="joint-loads" :data-state="data ? 'data' : loaded ? 'pending' : 'loading'" data-testid="joint-loads">
    <p v-if="!data && loaded" class="pending-note">
      <b>Being computed.</b> The per-joint gear torques, the safe approach speed and the gearbox life come from the full factorial
      (<code>data/factorial.json</code>), which the sim lane is running now.
    </p>
    <template v-else-if="data">
      <div class="controls" role="group" aria-label="the run to compare across arm builds">
        <div v-for="f in CONTROLS" :key="f" class="cgroup" :data-factor="f">
          <span class="k">{{ FACTOR_NAMES[f] }}</span>
          <button v-for="v in data.factors[f]" :key="v" :aria-pressed="pick[f] === v" :class="{ on: pick[f] === v }" :data-value="v"
                  @click="pick = { ...pick, [f]: v }">{{ label(data, v) }}</button>
        </div>
        <span v-if="data.fixture" class="pill warn">fixture data, not results</span>
      </div>

      <p v-if="ur && qdd" class="answer-box" data-testid="joint-answer">
        Same pick, {{ label(data, pick.controller).toLowerCase() }}, {{ label(data, pick.approach).toLowerCase() }},
        {{ label(data, pick.spring).toLowerCase() }}, {{ contactObject }} object: the UR-style arm's hardest-hit gear (<code>{{ data.joints[ur.worst!.index] }}</code>)
        carries <b :class="{ bad: ur.worst!.ratio > 1 }">×{{ ur.worst!.ratio.toFixed(2) }}</b> its repeated-peak rating; the QDD arm's
        <b :class="{ bad: qdd.worst!.ratio > 1 }">×{{ qdd.worst!.ratio.toFixed(2) }}</b>. To stay under every rating, approach at
        <b>{{ ur.run!.safe_approach_speed_m_s.toFixed(3) }} m/s</b> (UR-style) or <b>{{ qdd.run!.safe_approach_speed_m_s.toFixed(3) }} m/s</b> (QDD).
      </p>

      <div class="builds">
        <div v-for="c in cols" :key="c.build" class="build card" :data-build="c.build" :data-over="c.over ? 'true' : 'false'">
          <h4>{{ label(data, c.build) }}</h4>
          <p class="model">{{ c.box?.model }}</p>
          <template v-if="c.run">
            <GearBars :joints="data.joints" :ratios="c.run.gear_load_ratio" :peaks="c.run.gear_torque_peak_nm"
                      :ratings="(c.box?.per_joint ?? []).map((g) => g.repeated_peak_nm)" :scale-max="scaleMax" />
            <dl class="kv">
              <div data-k="safe"><dt>Safe approach speed</dt><dd>{{ c.run.safe_approach_speed_m_s.toFixed(3) }} m/s</dd></div>
              <div data-k="life"><dt>Estimated gearbox life</dt><dd :title="`${Math.round(c.life!.picks).toLocaleString('en-US')} picks`">{{ compact(c.life!.picks) }} picks</dd></div>
              <div data-k="years"><dt>… at {{ PICKS_PER_HOUR.toLocaleString('en-US') }} picks/h, {{ HOURS_PER_DAY }} h/day</dt><dd>{{ years(c.years!) }}</dd></div>
              <div data-k="amp"><dt>Gear torque ÷ contact torque</dt><dd>×{{ Number.isFinite(c.amp) ? c.amp!.toFixed(2) : '—' }}</dd></div>
            </dl>
            <p class="small">Shortest-lived: <code>{{ data.joints[c.life!.index] }}</code>. {{ c.over ? `${c.over} joint${c.over > 1 ? 's' : ''} over the rating.` : 'Every joint under its rating.' }}
              <template v-if="!c.run.converged"> ★ {{ c.run.flag }}</template></p>
          </template>
          <p v-else class="small">No run for this combination.</p>
        </div>
      </div>

      <div class="grid2">
        <div class="card why" data-testid="why-backdrivable">
          <h4>Why backdrivable joints spare the gears</h4>
          <p>At touch the tool stops in a few milliseconds, and so must everything geared to it. A motor's rotor turns N times faster than its
            joint, so it looks N² times heavier from the joint side, and the only thing that can stop it is the gear's teeth:
            τ<sub>gear</sub> ≈ N²·J<sub>rotor</sub>·α<sub>joint</sub> on top of the contact's own torque.</p>
          <ul class="facts">
            <li>UR-style harmonic drive, N ≈ {{ ratioOf('ur5e') ?? '—' }}: N² ≈ {{ sq(ratioOf('ur5e')) }}<template v-if="ur">; here the hardest-hit gear
              carries ×{{ ur.amp!.toFixed(2) }} the contact's torque</template>.</li>
            <li>QDD, N = {{ ratioOf('qdd') ?? '—' }}: N² = {{ sq(ratioOf('qdd')) }}<template v-if="qdd">; ×{{ qdd.amp!.toFixed(2) }}</template>. The rotor
              backdrives instead of hammering the teeth, and the board's PD (30 kHz) yields with it.</li>
          </ul>
          <p class="small">The sign convention and the formula the sim uses are in <code>{{ data.source.script }}</code> (data contract:
            gear_torque_peak_nm).</p>
        </div>
        <div class="card caveat" data-testid="life-caveat">
          <h4>Read the life as an estimate</h4>
          <p>Life in picks comes from each gearbox's published ratings and a fatigue model (S-N / bearing L10) over one simulated pick's torque
            history, gear and bearing, whichever is shorter. It is not a test: real gears also wear from misalignment, lubrication, temperature
            and the other moves the arm makes. Use it to compare builds and speeds, not to promise a service interval.</p>
          <p class="small">Years assume {{ PICKS_PER_HOUR.toLocaleString('en-US') }} picks an hour, {{ HOURS_PER_DAY }} hours a day, every day
            ({{ (PICKS_PER_HOUR * HOURS_PER_DAY * 365 / 1e6).toFixed(1) }} M picks a year).</p>
        </div>
      </div>

      <details class="more" data-testid="gearbox-models">
        <summary>The gearbox models, their ratings and sources</summary>
        <div v-for="b in builds" :key="b" class="gbm">
          <h5>{{ label(data, b) }}</h5>
          <p class="small">{{ data.gearboxes[b]?.model }}<template v-if="data.gearboxes[b]?.source"> · {{ data.gearboxes[b].source }}</template></p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>joint</th><th>ratio</th><th>rated N·m</th><th>repeated peak N·m</th><th>momentary peak N·m</th><th>life model</th></tr></thead>
              <tbody>
                <tr v-for="(g, i) in data.gearboxes[b]?.per_joint ?? []" :key="i">
                  <td><code>{{ data.joints[i] }}</code></td><td>{{ g.ratio }}</td><td>{{ g.rated_nm }}</td><td>{{ g.repeated_peak_nm }}</td><td>{{ g.momentary_peak_nm }}</td>
                  <td class="lm">{{ g.life_model }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.joint-loads {
  display: grid;
  gap: 12px;
}
.pending-note {
  margin: 0;
  padding: 10px 14px;
  border: var(--pt-border-w) dashed var(--pt-line);
  border-radius: var(--pt-radius-sm);
  color: var(--pt-text-2);
  font-size: 14px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  align-items: center;
}
.cgroup {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.cgroup .k {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pt-text-3);
  margin-right: 2px;
}
.cgroup button {
  padding: 3px 10px;
  border: 1px solid var(--pt-line);
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--pt-text-2);
  background: var(--pt-card);
}
.cgroup button.on {
  background: var(--pt-brand);
  border-color: var(--pt-brand);
  color: var(--pt-bg);
}
.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
}
.pill.warn {
  background: var(--pt-warn-soft);
  color: var(--pt-warn);
}
.answer-box {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--pt-radius-sm);
  background: var(--pt-brand-soft);
  font-size: 14.5px;
  line-height: 1.55;
}
.answer-box b.bad {
  color: var(--pt-warn);
}
.builds {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 12px;
}
.card {
  padding: 14px 16px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius);
  background: var(--pt-card);
  min-width: 0;
}
.build[data-over='true'] {
  border-color: var(--pt-warn);
}
h4 {
  margin: 0 0 4px;
  font-size: 15.5px;
}
h5 {
  margin: 10px 0 2px;
  font-size: 13.5px;
}
.model {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--pt-text-3);
}
.kv {
  display: grid;
  gap: 2px;
  margin: 10px 0 6px;
}
.kv div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--pt-line);
  padding: 2px 0;
}
.kv dt {
  color: var(--pt-text-3);
}
.kv dd {
  margin: 0;
  font-family: var(--pt-font-mono);
  font-weight: 600;
}
.small {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--pt-text-3);
  line-height: 1.5;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 760px) {
  .grid2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
.why p,
.caveat p {
  font-size: 14px;
  color: var(--pt-text-2);
  margin: 0 0 8px;
  line-height: 1.55;
}
.facts {
  margin: 0;
  padding-left: 18px;
  font-size: 13.5px;
  color: var(--pt-text-2);
  display: grid;
  gap: 4px;
}
details.more {
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  padding: 0 16px 8px;
}
details.more > summary {
  cursor: pointer;
  padding: 12px 0;
  font-weight: 600;
  font-size: 14.5px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--pt-line);
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--pt-text-3);
  font-weight: 600;
}
td.lm {
  color: var(--pt-text-2);
  font-size: 12px;
}
code {
  font-family: var(--pt-font-mono);
  font-size: 0.9em;
}
</style>
