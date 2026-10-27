<script setup lang="ts">
// The landing page: the whole approach on one page, answer first. Every number comes from site/public/data/site.json, which
// scripts/export_site_data.py writes from the controller's evidence (re-run it when the evidence changes); the ablation ladder and the
// hand study read their own files at run time (docs/data-contract.md). The three design directions differ in tokens (style.css) and in
// the layout rules at the bottom of this file, keyed on html[data-variant].
import { computed, ref, shallowRef } from 'vue'
import { withBase } from 'vitepress'
import site from '../../../public/data/site.json'
import StepBar from './StepBar.vue'
import EqJointPD from './EqJointPD.vue'
import EqStiffness from './EqStiffness.vue'
import EqDamping from './EqDamping.vue'
import PickReplay from './PickReplay.vue'
import CeilingChart from './CeilingChart.vue'
import BuildsChart from './BuildsChart.vue'
import ObjectToggle from './ObjectToggle.vue'
import AblationLadder from './AblationLadder.vue'
import HandStudy from './HandStudy.vue'
import { contactObject } from '../lib/contact'

// The live MuJoCo pick (LivePick.vue, another lane): rendered through <component :is> so the page builds with or without it
const LivePick = (Object.values(import.meta.glob('./LivePick.vue', { eager: true }))[0] as { default?: object } | undefined)?.default ?? null

const S = site as any
const C = S.comparison
const I = S.impact
const O = S.oracle
const J = S.judge
const H = C.headline

const STEPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'problem', label: 'The problem' },
  { id: 'how', label: 'How it works' },
  { id: 'demo', label: 'Demos' },
  { id: 'board', label: 'Damper on the board' },
  { id: 'impact', label: 'Impact physics' },
  { id: 'fingers', label: 'Fingers on the arm' },
  { id: 'results', label: 'Results' },
  { id: 'tuning', label: 'Setting K and D' },
  { id: 'crisp', label: 'vs CRISP' },
  { id: 'verification', label: 'Verification' },
  { id: 'reproduce', label: 'Reproduce' },
]
const n = (id: string) => String(STEPS.findIndex((s) => s.id === id) + 1).padStart(2, '0')

const f0 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'))
const f1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1))
const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`)

// --- equations, one at a time
const EQUATIONS = [
  { id: 'pd', label: "1 · The board's PD" },
  { id: 'jkj', label: '2 · Jᵀ K J' },
  { id: 'damping', label: '3 · D = 2ζ√(ΛK)' },
]
const eq = ref(0)

// --- the comparison table, in the review page's order
const ROW_ORDER = ['spring + host_spring', 'host_spring', 'joint_coupled', 'joint', 'torque', 'spring', 'stiff', 'torque @ ceiling', 'joint_coupled + row-sum cap']
const DIAGNOSTIC = new Set(['torque @ ceiling', 'joint_coupled + row-sum cap'])
const table = computed(() => ROW_ORDER.map((name) => (C.summary_table as any[]).find((r) => r.controller === name)).filter(Boolean))
const row = (name: string) => (C.summary_table as any[]).find((r) => r.controller === name)
const speed = (controller: string, v: number) => (C.speed as any[]).find((r) => r.controller === controller && Math.abs(r.speed - v) < 1e-9)
const latency = (label: string) => (C.latency as any[]).find((r) => r.label === label)
const latencyHost = computed(() => (C.latency as any[]).map((r) => r.host_response_ms).filter((v) => v !== null))
const sens = I.contact_b_sensitivity
const dropRows = I.drop
const dropSoft = dropRows['soft, B 10, ideal, impedance 0.05']?.peak_n
const dropSoftLow = dropRows['soft, B 10, ideal, impedance 0.005']?.peak_n
const dropStiff = dropRows["stiff (the judge's), B 10, ideal, impedance 0.05"]?.peak_n
const qddCeil = computed(() => (O.ceilings?.qdd ?? []).find((r: any) => r.joint === 'wrist_3_joint'))
const ur5eCeil = computed(() => (O.ceilings?.ur5e ?? []).find((r: any) => r.joint === 'wrist_3_joint'))
const buildPeak = (build: string, controller: string, friction = 'ur5e', contact = 100000, v = 0.2) =>
  (I.builds as any[]).find((r) => r.build === build && r.controller === controller && r.friction === friction && r.contact_n_m === contact && Math.abs(r.speed - v) < 1e-9)

// --- the oracle study
const KPI_TEXT: Record<string, { name: string; rule: string }> = {
  I1: { name: 'renders what it asks', rule: 'HOST_SPRING / JOINT_COUPLED at 5 poses: static error ≤ 0.10, dynamic ≤ 0.20' },
  I2: { name: 'beats today', rule: 'every cell: tuned admissible and cheaper than stiff' },
  I3: { name: 'the seed is a good start', rule: 'every cell: description seed admissible, seed loss ≤ 0.30' },
  I4: { name: 'tuning reaches the oracle', rule: 'cells with an admissible oracle: tuned admissible, regret ≤ 0.15' },
  I5: { name: 'robust to a wrong model', rule: 'imperfect-model sweep: tuned admissible on the true plant at ≥ 90 % of points' },
  I6: { name: 'implementation loss', rule: 'S1 / S2 host_spring: c_oracle / c_ideal − 1 ≤ 0.25' },
  I7: { name: 'nothing diverges', rule: 'every study run' },
}
const kpis = computed(() => Object.entries(O.kpis).map(([id, k]: [string, any]) => ({ id, ...KPI_TEXT[id], ...k })))
const blocking = computed(() => Object.entries(O.readiness.parts).filter(([, ok]) => !ok).map(([id]) => id))
const cellCols = ['stiff', 'seed (description)', 'seed (perfect)', 'tuned']
const whatifs = computed(() => {
  const order = ['S1q', 'S1q-contact_aware', 'S2q', 'S2q-contact_aware']
  return order.filter((k) => O.whatifs[k]).map((k) => ({ key: k, ...O.whatifs[k], rows: (O.whatifs[k].rows as any[]).filter((r: any) => r.pick === 'tuned' || k.startsWith('S2q')) }))
})
const gateNames = ['peak force', 'lost contact', 'seal force', 'force ripple', 'x/y error']

// --- the ablation ladder's numbers, for the claims that ride on it (the object switch changes them too)
const ablation = shallowRef<any>(null)
const rung = (id: string) => (ablation.value?.results?.[contactObject.value] as any[] | undefined)?.find((r) => r.rung === id)
const drop = (a: any, b: any, key = 'touch_peak_n') => (a && b && a[key] ? (b[key] - a[key]) / a[key] : null)
const biggestStep = computed(() => {
  const ids = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']
  let best = { id: '', drop: 0 }
  for (let i = 1; i < ids.length; i++) {
    const d = drop(rung(ids[i - 1]), rung(ids[i]))
    if (d !== null && -d > best.drop) best = { id: ids[i], drop: -d }
  }
  return best.id
})
const signed = (v: number | null) => (v === null ? '—' : `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(0)} %`)

const sources = S.sources as Record<string, { path: string; sha256_12: string; what: string }>
const src = (...keys: string[]) => keys.map((k) => sources[k]).filter(Boolean)
const shortPath = (p: string) => p.replace('/home/bam/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller/', 'bam_impedance_controller/').replace('/home/bam/bam_ws/reports/media/', 'reports/media/')
const LANE = S.lane
const LANE_DIR = '~/bam_ws/.claude/worktrees/bam-impedance-controller/src/core/mdp/agent/controllers/bam_impedance_controller'
</script>

<template>
  <div class="lp-root">
    <StepBar :steps="STEPS" />
    <main class="lp">
      <!-- ============================================================ 01 overview -->
      <section id="overview" class="sec hero">
        <div class="hero-copy">
          <p class="eyebrow">bam_impedance_controller · BAM Robotics · a simulation study</p>
          <h1>Stiff in x and y.<br /><span class="soft">Soft in z.</span></h1>
          <p class="lead">
            A cascade stage after the joint trajectory controller that decides how stiffly each Cartesian direction tracks: stiff in x/y,
            soft in z for a conveyor pick. It is the software version of a suction cup's spring, rendered on backdrivable 10:1 QDD joints by
            splitting the spring and the damper between the host and the moteus boards.
          </p>
          <div class="tiles">
            <div class="tile">
              <b>{{ f0(H.series_peak_n) }} N <small>vs {{ f0(H.arm_peak_min_n) }}–{{ f0(H.arm_peak_max_n) }} N</small></b>
              <span>touch peak with the level compensator + host_spring, against every arm-only mode (0.2 m/s, δ +10 mm, assumed contact)</span>
            </div>
            <div class="tile">
              <b>{{ f1(H.series_dwell_mean_n) }} ± {{ f1(H.series_dwell_std_n) }} N</b>
              <span>holding force through the dwell, spring + host_spring (stiff presses {{ f1(row('stiff')?.['dwell Fz N'] ? parseFloat(row('stiff')['dwell Fz N']) : null) }} N)</span>
            </div>
            <div class="tile">
              <b>×{{ S.ceilings.rack.wn_ratio.toFixed(1) }} ω<sub>n</sub> · ×{{ S.ceilings.rack.k_ratio.toFixed(1) }} K</b>
              <span>higher host ceiling when the damper moves to the board, at {{ S.ceilings.rack.rate_hz }} Hz / {{ S.ceilings.rack.delay_ms }} ms</span>
            </div>
            <div class="tile">
              <b>{{ pct(C.probe.host_spring.error_mean) }}</b>
              <span>host_spring's stiffness error at five poses (worst {{ pct(C.probe.host_spring.error_max, 1) }}); JOINT mode {{ pct(C.probe.joint.error_mean) }}</span>
            </div>
          </div>
          <p class="honest">
            <span class="pill warn">Simulation only</span> the PID tuner's UR5e stand-in, not a fit of BAM's arm; nothing ran on hardware.
            <span class="pill warn">Hardware readiness: not met</span> ({{ blocking.join(', ') }} fail).
            <span class="pill ok">Codex judge: PASS</span> after {{ J.rounds.length }} fresh rounds.
          </p>
        </div>
        <figure class="hero-media">
          <video data-testid="hero-video" :src="withBase('/media/hero-impedance-modes.mp4')" :poster="withBase('/media/hero-poster.png')" muted loop
                 playsinline autoplay controls preload="metadata" />
          <figcaption>
            The real sim at {{ C.video.speed }}× speed, the true surface {{ f0(C.video.delta_mm) }} mm above where the arm believes it is. Touch peaks:
            stiff {{ f0(C.video.peaks_n.stiff) }} N, spring {{ f0(C.video.peaks_n.spring) }} N, torque {{ f0(C.video.peaks_n.torque) }} N,
            host_spring {{ f0(C.video.peaks_n.host_spring) }} N. The strip under each panel is that run's contact force.
          </figcaption>
        </figure>
      </section>

      <!-- ============================================================ 02 problem -->
      <section id="problem" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('problem') }}</span>
          <h2>The problem: press onto a surface you only roughly know</h2>
          <p class="answer">
            A conveyor pick presses a suction cup onto an item whose top is known to ±{{ f0(O.budget.height_uncertainty_m * 1000) }} mm, then holds a
            seal while the belt carries it. Stiff in z, every millimetre of surprise becomes force. Soft in z, the cup lands gently and seals; stiff
            in x/y, it stays on the item.
          </p>
        </header>
        <div class="grid3">
          <div class="card">
            <h3>The budget</h3>
            <ul class="facts">
              <li>surface height ±{{ f0(O.budget.height_uncertainty_m * 1000) }} mm; press {{ f0(O.budget.press_in_m * 1000) }} mm below the believed top</li>
              <li>seal force {{ f0(O.budget.seal_force_n) }} N, inside {{ O.budget.seal_force_range_n[0] }}–{{ O.budget.seal_force_range_n[1] }} N, ripple ≤ {{ O.budget.force_ripple_n }} N</li>
              <li>touch peak ≤ {{ f0(O.budget.peak_force_n) }} N with a level compensator</li>
              <li>x/y error ≤ {{ f0(O.budget.lateral_error_m * 1000) }} mm under a {{ f0(O.budget.lateral_disturbance_n) }} N push</li>
            </ul>
            <p class="small">From the oracle study's pick budget (<code>task.PickBudget</code>).</p>
          </div>
          <div class="card">
            <h3>Why soft z</h3>
            <p>
              The spring sets the hold force: K<sub>z</sub> × how far below the surface the reference goes. In the comparison (surface +10 mm), today's
              stiff gains press <b>{{ row('stiff')['dwell Fz N'] }} N</b> through the hold; the compensator with host_spring holds
              <b>{{ row('spring + host_spring')['dwell Fz N'] }} N</b>.
            </p>
            <p>And x/y must stay stiff: K<sub>xy</sub> ≥ push ÷ allowed error = {{ f0(O.budget.lateral_disturbance_n) }} N ÷ {{ f0(O.budget.lateral_error_m * 1000) }} mm
              = {{ f0(O.budget.lateral_disturbance_n / O.budget.lateral_error_m) }} N/m.</p>
          </div>
          <div class="card">
            <h3>The benchmark: a spring</h3>
            <p>
              Suction grippers already solve this with a level compensator: a spring plunger behind the cup, 0.12–0.27 N/mm with 2–6 N preload
              (Piab LC, from the research note). The sim's is {{ C.base.compensator.stiffness_n_m }} N/m, {{ C.base.compensator.preload_n }} N preload,
              {{ f0(C.base.compensator.stroke_m * 1000) }} mm stroke. It puts 50 g in front of the contact: <b>{{ f0(H.spring_peak_n) }} N</b> at touch, against
              <b>{{ f0(speed('stiff', 0.2)?.peak_n) }} N</b> for the stiff arm.
            </p>
          </div>
        </div>
      </section>

      <!-- ============================================================ 03 how -->
      <section id="how" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('how') }}</span>
          <h2>How it works</h2>
          <p class="answer">
            One pure function per host tick, <code>impedance_command</code>, takes the trajectory controller's point as the reference and writes five
            fields per joint to the moteus board. Four modes behind one switch decide where the Cartesian spring K and damper D are computed: on the
            host (CAN rate, ~7 ms behind) or on the board (30 kHz).
          </p>
        </header>

        <div class="cascade" role="img" aria-label="the cascade: trajectory generator, joint trajectory controller, impedance stage, moteus board">
          <div class="stage-box host">
            <span class="where">host</span>
            <b>bam_traj_gen</b>
            <span>waypoint + its <code>CartesianImpedance</code></span>
          </div>
          <span class="arrow" aria-hidden="true" />
          <div class="stage-box host">
            <span class="where">host · fixed-rate grid</span>
            <b>bam_controllers.tick_controller</b>
            <span>unchanged → <code>JointTrajectoryPoint</code> (q, q̇, effort)</span>
          </div>
          <span class="arrow" aria-hidden="true" />
          <div class="stage-box new">
            <span class="where">host · this package</span>
            <b>impedance_command(config, …)</b>
            <span>mode = TORQUE | JOINT | JOINT_COUPLED | HOST_SPRING</span>
          </div>
          <span class="arrow" aria-hidden="true" />
          <div class="stage-box board">
            <span class="where">per joint, over CAN</span>
            <b>position · velocity · kp_scale · kd_scale · feed-forward</b>
            <span>the moteus position-mode fields</span>
          </div>
          <span class="arrow" aria-hidden="true" />
          <div class="stage-box board">
            <span class="where">board · 30 kHz</span>
            <b>moteus PD → joint</b>
            <span>10:1 QDD, backdrivable</span>
          </div>
        </div>

        <h3 class="sub">Four modes: where K and D live</h3>
        <div class="table-wrap">
          <table class="modes">
            <thead>
              <tr><th>mode</th><th>spring K</th><th>damper D</th><th>the board (30 kHz)</th><th>the host (CAN rate)</th><th>use it when</th></tr>
            </thead>
            <tbody>
              <tr class="pick">
                <td><code>HOST_SPRING</code></td><td><span class="chip host">host</span> exact</td><td><span class="chip board">board</span> + host coupling</td>
                <td>kd only (kp_scale 0)</td><td>the exact spring + off-diagonal damping</td>
                <td>The default for picks: the exact spring, stable at every rate and delay swept.</td>
              </tr>
              <tr>
                <td><code>JOINT_COUPLED</code></td><td><span class="chip board">board</span> diagonal + host coupling</td><td><span class="chip board">board</span> + host coupling</td>
                <td>kp, kd = diag(JᵀKJ), diag(JᵀDJ)</td><td>the off-diagonal terms as torque</td>
                <td>The fallback when a board won't take kd with kp_scale 0.</td>
              </tr>
              <tr>
                <td><code>JOINT</code></td><td><span class="chip board">board</span> diagonal only</td><td><span class="chip board">board</span> diagonal only</td>
                <td>the diagonal</td><td>effort only</td>
                <td>Stiff joints, not a Cartesian spring: it renders z {{ '1.9×' }} too stiff and tilts it {{ f0(C.probe.joint.tilt_deg) }}°.</td>
              </tr>
              <tr>
                <td><code>TORQUE</code></td><td><span class="chip host">host</span></td><td><span class="chip host">host</span></td>
                <td>PD off</td><td>the whole Cartesian law as torque</td>
                <td>Only with a short host delay: at 100 Hz / 7 ms it has no good setting.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="small">Switch with <code>dataclasses.replace(config, mode=…)</code>; the law keeps no state, so a switch takes effect on the next tick.
          The JOINT figures (1.9× in z, {{ f0(C.probe.joint.tilt_deg) }}° tilt) are the README's five-pose probe.</p>

        <h3 class="sub">One equation at a time</h3>
        <div class="eq-deck card">
          <div class="eq-tabs" role="tablist">
            <button v-for="(e, i) in EQUATIONS" :key="e.id" role="tab" :aria-selected="eq === i" :class="{ on: eq === i }" @click="eq = i">{{ e.label }}</button>
          </div>
          <div class="eq-body">
            <EqJointPD v-if="eq === 0" />
            <EqStiffness v-else-if="eq === 1" />
            <EqDamping v-else :lambda-pick="C.reflected_mass_kg" />
          </div>
          <div class="eq-nav">
            <button :disabled="eq === 0" @click="eq--">← previous</button>
            <span class="dim">{{ eq + 1 }} / {{ EQUATIONS.length }}</span>
            <button :disabled="eq === EQUATIONS.length - 1" @click="eq++">next →</button>
          </div>
        </div>
      </section>

      <!-- ============================================================ 04 demos -->
      <section id="demo" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('demo') }}</span>
          <h2>Demos</h2>
          <p class="answer">The recorded sim runs, replayed in your browser with MuJoCo, then a live two-link lab where you set the spring yourself.</p>
        </header>
        <div class="card flush">
          <h3 class="card-title">Three controllers on the same pick</h3>
          <PickReplay />
        </div>
        <div class="card flush">
          <h3 class="card-title">Live: the two-link lab</h3>
          <ArmLab />
        </div>
        <div class="card flush live-pick" data-testid="live-pick-slot">
          <div class="live-head">
            <h3 class="card-title">Live: the full arm in MuJoCo</h3>
            <a v-if="LivePick" class="open-full" :href="withBase('/live')">open the live lab full-screen →</a>
          </div>
          <component :is="LivePick" v-if="LivePick" :object="contactObject" controller="host_spring" build="ur5e" :autorun="true" />
          <p v-else class="small">The live MuJoCo pick (the full arm, the law running in your browser) lands here from its own lane.</p>
        </div>
      </section>

      <!-- ============================================================ 05 board -->
      <section id="board" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('board') }}</span>
          <h2>Why the damper belongs on the board</h2>
          <p class="answer">
            A host loop is limited by its delayed damper, not its delayed spring. Move the damper to the board's 30 kHz PD and the host can render
            ω<sub>n</sub> {{ S.ceilings.rack.host_spring }} rad/s instead of {{ S.ceilings.rack.host_pd }} rad/s at {{ S.ceilings.rack.rate_hz }} Hz /
            {{ S.ceilings.rack.delay_ms }} ms: ×{{ S.ceilings.rack.wn_ratio.toFixed(1) }} in natural frequency, ×{{ S.ceilings.rack.k_ratio.toFixed(1) }} in stiffness.
          </p>
        </header>
        <div class="card">
          <CeilingChart :ceilings="S.ceilings" :joints="O.ceilings" :measured="{ torque: I.boundary.torque.measured_wn, host_spring: I.boundary.host_spring.measured_wn }" />
        </div>
        <div class="grid3">
          <div class="card">
            <h3>k = J·ω<sub>n</sub>²</h3>
            <p>The ceiling is a frequency, so the stiffness a joint can hold scales with its inertia. Light QDD joints hold little: the qdd build's
              wrist 3 ({{ qddCeil?.inertia_kg_m2.toPrecision(3) }} kg·m²) gets {{ qddCeil?.host_spring_kp_max.toPrecision(3) }} N·m/rad under HOST_SPRING and
              {{ qddCeil?.torque_kp_max.toPrecision(3) }} under TORQUE; the UR5e stand-in's ({{ ur5eCeil?.inertia_kg_m2.toPrecision(3) }} kg·m²) gets
              {{ f0(ur5eCeil?.host_spring_kp_max) }} and {{ f0(ur5eCeil?.torque_kp_max) }}.</p>
          </div>
          <div class="card">
            <h3>Who answers the touch, and when</h3>
            <p>The board's PD responds one physics tick after touch ({{ latency('host_spring')?.board_response_ms }} ms). The host's first
              contact-responsive command lands {{ Math.min(...latencyHost).toFixed(1) }}–{{ Math.max(...latencyHost).toFixed(1) }} ms after touch, depending
              on where the touch falls in the 10 ms host period; the peak itself comes {{ f1(latency('host_spring')?.peak_after_touch_ms) }} ms after touch.
              Measured counterfactually: the same run without the contact.</p>
          </div>
          <div class="card">
            <h3>The real loop sits a little lower</h3>
            <p>The implemented loop (sensing delay, velocity filter, torque lag) stops decaying at {{ I.boundary.torque.measured_wn }} (TORQUE) and
              {{ I.boundary.host_spring.measured_wn }} rad/s (HOST_SPRING): {{ I.boundary.torque.ratio.toFixed(2) }}× and {{ I.boundary.host_spring.ratio.toFixed(2) }}× the
              ideal model. The judge found host PD stable at {{ J.r9.host_pd_stable_unstable?.[0] }} and unstable at {{ J.r9.host_pd_stable_unstable?.[1] }} rad/s.
              Deployed caps sit at half the ceiling (the PID tuner's 2× kp margin).</p>
          </div>
        </div>
        <details class="more">
          <summary>Firmware check, and passivity</summary>
          <p>moteus v1.0.0 (the rack's) and current main apply kd_scale independently of kp_scale; moteus's own zero-velocity mode already runs kp 0
            with kd &gt; 0. Send the scales as float registers. Passivity (stable against any contact, not just free space) is stricter still; no
            contact-stiffness limit for the host PD is claimed here (the review page's wording).</p>
        </details>
      </section>

      <!-- ============================================================ 06 impact -->
      <section id="impact" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('impact') }}</span>
          <h2>Impact physics: the crumple zone and the brakes</h2>
          <p class="answer">
            The touch peak is mass × speed: whatever mass sits in front of the first soft thing, arriving at whatever speed. The spring is the crumple
            zone; slowing down is the brakes. Impedance can't remove the brief touch peak, but it stops the arm pushing on the belt afterwards.
          </p>
        </header>
        <div class="object-bar">
          <ObjectToggle :objects="ablation?.objects" />
          <span class="dim">switches every number and trace below, and in the next section</span>
        </div>
        <div class="claims" data-testid="impact-claims">
          <div class="claim">
            <b>The spring is the crumple zone.</b>
            <span v-if="rung('R4')">Adding the spring on the end (R3 → R4): touch {{ f1(rung('R3').touch_peak_n) }} → {{ f1(rung('R4').touch_peak_n) }} N.</span>
            <span>On the full stand-in arm the compensator leaves 50 g in front: {{ f0(sens['200'].spring) }} N at touch against {{ f0(sens['200'].stiff) }} N
              stiff on the rigid contact (×{{ sens['200'].ratio.toFixed(1) }} at B 200; ×{{ sens['40'].ratio.toFixed(1) }} at B 40, ×{{ sens['600'].ratio.toFixed(1) }} at B 600).</span>
          </div>
          <div class="claim">
            <b>Slowing down is the brakes.</b>
            <span v-if="rung('R1')">Worst case → move slower (R0 → R1): touch {{ f0(rung('R0').touch_peak_n) }} → {{ f0(rung('R1').touch_peak_n) }} N
              ({{ signed(drop(rung('R0'), rung('R1'))) }}){{ biggestStep === 'R1' ? ', the biggest step on the ladder' : '' }}. It does not stop the press: {{ f1(rung('R0').press_mean_n) }} →
              {{ f1(rung('R1').press_mean_n) }} N through the hold.</span>
            <span v-else>Stiff arm over the last 30 mm: {{ f0(speed('stiff', 0.2)?.peak_n) }} → {{ f0(speed('stiff', 0.1)?.peak_n) }} →
              {{ f0(speed('stiff', 0.05)?.peak_n) }} N at 0.2 / 0.1 / 0.05 m/s.</span>
            <span>With a heavy wrist in front of the tool<template v-if="rung('R0')"> ({{ f1(rung('R0').reflected_mass_kg) }} kg of it in the worst case)</template>,
              slowing before impact is the main lever.</span>
          </div>
          <div class="claim">
            <b>Impedance stops the pushing, not the touch.</b>
            <span v-if="rung('R5')">Spring → impedance controller (R4 → R5): touch {{ f1(rung('R4').touch_peak_n) }} → {{ f1(rung('R5').touch_peak_n) }} N,
              press {{ f1(rung('R4').press_mean_n) }} → {{ f1(rung('R5').press_mean_n) }} N.</span>
            <span>On the full arm: host_spring touches at {{ f0(speed('host_spring', 0.2)?.peak_n) }} N, about stiff's {{ f0(speed('stiff', 0.2)?.peak_n) }} N,
              then holds {{ row('host_spring')['dwell Fz N'] }} N where stiff presses {{ row('stiff')['dwell Fz N'] }} N.</span>
          </div>
        </div>

        <h3 class="sub">The ablation ladder: one change at a time, worst case first</h3>
        <AblationLadder @loaded="ablation = $event" />

        <h3 class="sub">UR-style joints against backdrivable QDD joints</h3>
        <div class="answer-line">
          The R1 → R2 rung is this comparison inside the ladder: the same links, the rotors swapped from harmonic-drive-like to 10:1 QDD.
          <template v-if="rung('R2')">The mass in front of the tool falls {{ f1(rung('R1').reflected_mass_kg) }} → {{ f1(rung('R2').reflected_mass_kg) }} kg;
            the touch {{ f1(rung('R1').touch_peak_n) }} → {{ f1(rung('R2').touch_peak_n) }} N ({{ signed(drop(rung('R1'), rung('R2'))) }}); the press
            {{ f1(rung('R1').press_mean_n) }} → {{ f1(rung('R2').press_mean_n) }} N. Grounding the motors (R3) takes it to {{ f1(rung('R3').reflected_mass_kg) }} kg
            and {{ f1(rung('R3').touch_peak_n) }} N.</template>
          Below, the impact study's own arm-build axis, and a legged robot's foot as the limit case.
        </div>
        <div class="grid2">
          <div class="card">
            <BuildsChart :rows="I.builds" />
          </div>
          <div class="card drop">
            <h3>A legged robot's foot</h3>
            <p>The judge's drop fixture: a {{ I.drop_fixture.trunk_kg }} kg trunk on a {{ I.drop_fixture.link_m }} m leg with a 10:1 QDD hip, a
              {{ f0(I.drop_fixture.foot_kg * 1000) }} g foot. Backdrivable, the hip leaves only <b>{{ I.drop_fixture.free_contact_mass_kg }} kg</b> in front
              of the ground (foot + rotor / L²). Dropped at {{ I.drop_fixture.speed_m_s }} m/s onto {{ f0(I.drop_fixture.ground_n_m / 1000) }} kN/m:</p>
            <div class="vs">
              <div><b>{{ f1(dropSoft) }} N</b><span>soft hip</span></div>
              <div><b>{{ f1(dropStiff) }} N</b><span>stiff hip</span></div>
            </div>
            <p class="small">Ideal actuator, converged. The continuous equations give {{ J.r9.drop_equations_soft_n?.toFixed(1) }} / {{ J.r9.drop_equations_stiff_n?.toFixed(1) }} N
              (the judge's, round 9); at a 10× lower solver impedance the soft case reads {{ f1(dropSoftLow) }} N. With a backdrivable joint, the joint
              itself can be the crumple zone. Whether that carries to BAM's arm is not measured.</p>
          </div>
        </div>

        <details class="more">
          <summary>Anticipation against just slowing down</summary>
          <p>Softening the whole law over the last 30 mm (K × 0.1, D × √0.1), compared with the plain controller slowed until it touches at the same
            measured speed (within 2 %), on the 35 of 48 pairs where both runs hold: today's ordinary controllers range −22 … +94 % (12 better, 11
            worse). Anticipation consistently lowers max-gain position control's first-100-ms peak (12 of 12, −57 … −23 %), but the press continues
            afterwards. <b>Slowing the approach is the reliable lever.</b> (The README's numbers, re-checked by the judge in round 9.)</p>
          <img :src="withBase('/media/impact-anticipation.png')" alt="anticipation against the plain controller slowed to the same touch speed" loading="lazy" />
        </details>
        <details class="more">
          <summary>The friction feed-forward finding, and the contact-aware law</summary>
          <p>On JMC-like friction (Coulomb 23 % of each joint's cap, BAM's Gen-1 joints) the reference-keyed Coulomb feed-forward keeps driving after
            the contact has stopped the joints. Cut at the first contact tick (the judge's diagnostic) the rigid-contact peaks fall from 176 / 218 / 193*
            to 81 / 82 / 76 N on qdd (stiff / joint / host_spring). With the feed-forward off: stiff {{ f0(buildPeak('ur5e', 'stiff', 'jmc')?.peak_100ms_n) }} → 152 N.</p>
          <p><b>The contact-aware law</b> (<code>friction.contact_aware_friction</code>, an option, default off) keys the feed-forward on the velocity the
            contact allows: τ<sub>f</sub> = c·tanh(k / 0.01), k = q̇<sub>r</sub> − λ·J<sub>r</sub>⁻¹[a (aᵀJ<sub>v</sub>q̇<sub>r</sub>); 0], with a latch λ that sets once
            the reference moves steadily inward and the tool lags it. On S2q's tapes it holds the dwell within ±1.1 N of the spring (today's keying: up to
            +20.1 N), but it does not rescue the touch peak (144 → 125 N): the touch is over before a 100 Hz detector fires.</p>
        </details>
        <details class="more">
          <summary>Which mass sets the peak</summary>
          <p>On a heavy arm the peak follows the sticking-contact mass ((J<sub>v</sub>M⁻¹J<sub>v</sub>ᵀ)⁻¹)<sub>zz</sub> ≈ 7.2–8.4 kg, through
            m/(m + m<sub>v</sub>)·f(ζ)·v·√(k(m + m<sub>v</sub>)): measured over predicted reads 1.00–1.31 over the impact study's 42 held touch transients;
            the normal-only mass under-predicts 1.0–1.7×. The stand-in's harmonic-drive-like armature is 3.5 kg of its 10.1 kg Λ<sub>zz</sub>.</p>
          <img :src="withBase('/media/impact-masses.png')" alt="measured peak over predicted for three apparent masses" loading="lazy" />
        </details>
      </section>

      <!-- ============================================================ 07 fingers -->
      <section id="fingers" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('fingers') }}</span>
          <h2>Fingers on the arm: who takes the contact</h2>
          <p class="answer">
            The same question with Zach's 2 × 2-DoF hand on the arm: a slap-and-grab, where the fingers or the arm (or both) can be the soft part.
            The cases split the stiffness between the two and read the force at each fingertip and at the arm's flange.
          </p>
        </header>
        <div class="object-bar">
          <ObjectToggle :objects="ablation?.objects" />
        </div>
        <HandStudy />
      </section>

      <!-- ============================================================ 08 results -->
      <section id="results" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('results') }}</span>
          <h2>Results</h2>
          <p class="answer">
            In this sim, keep the compensator and run host_spring above it at K<sub>z</sub> ≈ 1.5 kN/m. It is a trade-off, not a sweep: near-best touch
            ({{ f1(H.series_peak_n) }} N against {{ f1(H.spring_peak_n) }} N for the spring alone), the steadiest hold ({{ row('spring + host_spring')['dwell Fz N'] }} N,
            no bounce at the tested rates), and softer to an x/y push ({{ row('spring + host_spring')['y defl mm'] }} mm). <b class="warn-text">Hardware
            readiness is not met.</b>
          </p>
        </header>
        <div class="table-wrap card flush">
          <table class="results" data-testid="results-table">
            <thead>
              <tr>
                <th>controller</th><th>touch N<br /><small>UR5e / JMC friction</small></th><th>hold Fz N</th><th>bounces<br /><small>(B 40)</small></th>
                <th>x/y RMS mm<br /><small>UR5e / JMC</small></th><th>y push mm</th><th>s</th><th>K error</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in table" :key="r.controller" :class="{ pick: r.controller === 'spring + host_spring', diag: DIAGNOSTIC.has(r.controller) }">
                <td><code>{{ r.controller }}</code></td><td>{{ r['impact N'] }}</td><td>{{ r['dwell Fz N'] }}</td><td>{{ r.bounces }}</td>
                <td>{{ r['x/y RMS'] }}</td><td>{{ r['y defl mm'] }}</td><td>{{ r.s }}</td><td>{{ r['K error'] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="small">UR5e stand-in, 100 Hz / 7 ms host, K = ({{ C.base.stiffness.slice(0, 3).join(', ') }} N/m; {{ C.base.stiffness[3] }} N·m/rad), ζ 1, δ +10 mm,
          one assumed contact ({{ f0(C.base.contact_n_m / 1000) }} kN/m, B {{ C.base.contact_b }} N·s/m). {{ C.runs_total }} runs, {{ C.runs_diverged }} diverged;
          350 of 384 held the three-rate and perturbation checks, the rest carry "*" and enter no conclusion. Greyed: diagnostics of rules that were
          replaced. "s": the share of the spring kept under the ceilings. The series row's K error is against its own 1,500 N/m (its z is 176 N/m by design).</p>
        <details class="more">
          <summary>The force traces, the stiffness each mode renders, and the rate × delay sweep</summary>
          <figure><img :src="withBase('/media/fz-delta+10mm.png')" alt="contact force through the pick for every controller" loading="lazy" />
            <figcaption>Contact force through the pick (grey: the hold; yellow: the 20 N push).</figcaption></figure>
          <figure><img :src="withBase('/media/stiffness-ellipses.png')" alt="rendered stiffness at five poses" loading="lazy" />
            <figcaption>The stiffness each mode renders at five poses (dashed: asked for).</figcaption></figure>
          <figure><img :src="withBase('/media/rate-delay-heatmap.png')" alt="host rate by delay sweep" loading="lazy" />
            <figcaption>Host rate × delay: how much of the spring each mode keeps. host_spring keeps all of it everywhere swept.</figcaption></figure>
          <figure><img :src="withBase('/media/approach-speed.png')" alt="impact peak against approach speed" loading="lazy" />
            <figcaption>Impact peak against approach speed over the last 30 mm.</figcaption></figure>
        </details>

        <h3 class="sub">The oracle study: how close the seed and the tuner get to the best pick</h3>
        <div class="readiness" :class="{ met: O.readiness.met }" data-testid="readiness">
          <b>Hardware readiness ({{ O.readiness.cells.join(', ') }}: host_spring on the QDD build, JMC-like friction): {{ O.readiness.met ? 'met' : 'NOT met' }}.</b>
          <span>Blocked by {{ blocking.join(', ') }}; also not met on the corrected I1 / I7. Hardware stays blocked. {{ f0(O.compute.pick_runs) }} pick runs,
            {{ O.compute.diverged }} diverged, {{ O.compute.wall_h }} h on {{ O.compute.workers }} workers, code {{ O.compute.code_commit }}.</span>
        </div>
        <div class="table-wrap card flush">
          <table class="kpis" data-testid="kpi-table">
            <thead><tr><th>KPI</th><th>rule</th><th>measured</th><th></th></tr></thead>
            <tbody>
              <tr v-for="k in kpis" :key="k.id">
                <td><b>{{ k.id }}</b> {{ k.name }}</td>
                <td class="rule">{{ k.rule }}</td>
                <td class="mono">
                  <template v-if="k.id === 'I1'">friction reads as stiffness ({{ k.worst_static.toExponential(2) }}); frictionless: static {{ k.corrected_static }}, dynamic {{ k.corrected_dynamic }}, {{ k.corrected_held }} of {{ k.corrected_rows }} held</template>
                  <template v-else-if="k.id === 'I2'">misses {{ k.misses.join(', ') }}</template>
                  <template v-else-if="k.id === 'I3'">S1q seed loss {{ pct(k.s1q_seed_loss) }}; S2q no admissible seed</template>
                  <template v-else-if="k.id === 'I4'">worst regret {{ pct(k.worst_regret) }}; no admissible oracle on the arm-only cells</template>
                  <template v-else-if="k.id === 'I5'">{{ pct(k.share) }} of {{ k.points }} points admissible</template>
                  <template v-else-if="k.id === 'I6'">S1u {{ pct(k.per_cell.S1u) }}, S1j {{ pct(k.per_cell.S1j) }}, others not measurable</template>
                  <template v-else>{{ k.diverged }} of {{ f0(k.pick_runs) }} runs diverged</template>
                </td>
                <td><span class="pill" :class="k.met ? 'ok' : 'warn'">{{ k.met ? 'met' : 'not met' }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="grid2">
          <div class="card">
            <h3>What blocks readiness</h3>
            <ul class="facts">
              <li><b>I1:</b> at UR5e friction the probe's 0.5 / 1.5 N levels sit inside the joints' Coulomb dead band, so the "stiffness" it reads is
                friction; frictionless, the law still misses on the qdd build (static up to {{ O.kpis.I1.corrected_static }} against 0.10).</li>
              <li><b>I3:</b> the description seed lands {{ pct(O.kpis.I3.s1q_seed_loss) }} above S1q's oracle (target ≤ 30 %); S2q has no admissible seed.</li>
              <li><b>I5:</b> {{ pct(O.kpis.I5.share) }} of the {{ O.kpis.I5.points }} imperfect-model points are admissible (target ≥ 90 %): on S1q a 1 kg
                payload breaks the 30 N peak cap; on S2q every point fails the peak cap and the ripple gate.</li>
            </ul>
          </div>
          <div class="card">
            <h3>What is met</h3>
            <ul class="facts">
              <li><b>I4:</b> the tuner reaches the oracle where one exists: S1q {{ pct(O.kpis.I4.regrets.S1q) }}, S1u {{ pct(O.kpis.I4.regrets.S1u) }},
                S1j {{ pct(O.kpis.I4.regrets.S1j, 1) }} regret. It says nothing on S2q, which has no admissible oracle.</li>
              <li><b>I7:</b> {{ O.kpis.I7.diverged }} of {{ f0(O.kpis.I7.pick_runs) }} runs diverged.</li>
              <li>The arm-only cells are infeasible under this budget: the 120 N peak cap and the 3 N ripple cap bind on every candidate; the
                compensator cells pass both. The budget is Zach's to change, not the study's.</li>
            </ul>
          </div>
        </div>
        <details class="more">
          <summary>Per cell: stiff, seeds, tuned, oracle, ideal</summary>
          <div class="table-wrap">
            <table class="cells">
              <thead><tr><th>cell</th><th>system</th><th v-for="c in cellCols" :key="c">{{ c }}</th><th>oracle</th><th>ideal</th><th>regret</th><th>seed loss</th><th>impl. loss</th></tr></thead>
              <tbody>
                <tr v-for="c in O.cells" :key="c.cell">
                  <td><b>{{ c.cell }}</b></td>
                  <td>{{ c.compensator ? 'comp + ' : '' }}{{ c.controller }}, {{ c.friction }}, {{ c.build }}</td>
                  <td v-for="col in cellCols" :key="col" :class="{ bad: c.columns[col] && !c.columns[col].admissible }">
                    {{ c.columns[col]?.cost ?? '—' }}{{ c.columns[col] && !c.columns[col].converged ? '*' : '' }}{{ c.columns[col] && !c.columns[col].admissible ? ' ✗' : '' }}
                  </td>
                  <td :class="{ bad: c.oracle === null }">{{ c.oracle ?? 'none admissible' }}</td>
                  <td>{{ c.ideal ?? '—' }}</td><td>{{ pct(c.regret) }}</td><td>{{ pct(c.seed_loss) }}</td><td>{{ pct(c.impl_loss) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="small">p90 pick cost on the 12 evaluation tapes; lower is better; ✗ fails a gate; * a tape did not hold the rate check. S2q's and
            S2ql's ideal searches inherit a host-ceiling shrink, so their "—" is not a proof that no controller could pass.</p>
        </details>
        <details class="more" open>
          <summary>What-ifs: the compensator cell (S1q) against the arm-only cell (S2q)</summary>
          <div v-for="w in whatifs" :key="w.key" class="whatif">
            <h4>{{ w.cell }} · {{ w.law === 'contact_aware' ? 'contact-aware friction FF' : "today's friction FF" }}
              <span class="dim">({{ w.key.startsWith('S1q') ? 'compensator + host_spring' : 'host_spring, arm only' }}; qdd build, JMC-like friction)</span></h4>
            <p v-if="w.status !== 'ok'" class="small">{{ w.status }}.</p>
            <div v-else class="table-wrap">
              <table class="whatif-table">
                <thead><tr><th>pick</th><th>what-if</th><th>p90 cost</th><th>verdict</th><th v-for="g in gateNames" :key="g">{{ g }}</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in w.rows" :key="i" :class="{ ok: r.admissible }">
                    <td>{{ r.pick }}</td><td>{{ r.whatif }}</td><td class="mono">{{ r.cost }}{{ r.converged ? '' : '*' }}</td>
                    <td>{{ r.admissible ? 'admissible' : r.rejections.join(', ') }}</td>
                    <td v-for="g in gateNames" :key="g" class="mono">{{ r.gate_tapes[g] ?? 0 }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p class="small">Diagnostics outside the study's definitions: each scores the cell's pick on the same 12 evaluation tapes and gates; the gate
            columns count failing tapes of 12. "slow": the last 30 mm and the press at 0.05 m/s.</p>
        </details>
      </section>

      <!-- ============================================================ 09 tuning -->
      <section id="tuning" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('tuning') }}</span>
          <h2>How K and D are set and tuned</h2>
          <p class="answer">
            Practitioners pick K from the task and D from a damping ratio; nobody auto-tunes K. This package does the same analytically, then runs a
            PID-tuner-style ladder on a pick cost with gates, and checks the result against an oracle.
          </p>
        </header>
        <div class="grid3">
          <div class="card">
            <h3>What vendors set</h3>
            <ul class="facts">
              <li>KUKA iiwa 2,000 N/m (0–5,000), ζ 0.7 default</li>
              <li>Franka 150–200 N/m, D = 2√K (critical only for 1 kg)</li>
              <li>Doosan 3,000 N/m; Flexiv caps ζ at 0.3–0.8</li>
              <li>FANUC soft float and ABB SoftMove lower servo gains: joint mode's twins</li>
            </ul>
            <p class="small">From the vault note "Impedance Stiffness and Damping — How They're Set and Tuned" (2026-10-26), primary sources cited there.</p>
          </div>
          <div class="card">
            <h3>The analytic seed (rung 0)</h3>
            <ul class="facts">
              <li>K<sub>z</sub> from the seal band and the height uncertainty; with a compensator, a stiffer second stage (series ratio)</li>
              <li>K<sub>xy</sub> = push ÷ allowed error; K<sub>rot</sub> likewise</li>
              <li>D = 2ζ√(ΛK) on Λ(q); ζ 0.7, ζ<sub>z</sub> 1.0</li>
              <li>shrunk until the mode's ceilings hold (host: <code>stability.host_kp_limits</code>; board: the tuner's kp cap)</li>
            </ul>
          </div>
          <div class="card">
            <h3>The cost and the gates</h3>
            <p class="formula">(peak / cap)² + ((hold − seal) / seal)² + (ripple / cap)² + (x/y / allowed)² + 0.5·settle / 0.2 s + 10·bounces +
              10·(1 − in-contact)</p>
            <p class="small">The p90 over 12 held-out tapes. Hard gates on any tape: diverged, non-finite, saturation &gt; 2 %, peak over the cap. Soft gates on
              &gt; 10 % of tapes: lost contact, seal force out of band, ripple, x/y error. (<code>objective.py</code>)</p>
          </div>
        </div>
        <div class="table-wrap card flush">
          <table class="ladder-table">
            <thead><tr><th>PID tuner rung</th><th>impedance equivalent</th><th>here</th></tr></thead>
            <tbody>
              <tr><td>0 · analytic</td><td>K from the budget, D from ζ and Λ(q), clamped by the mode's ceilings</td><td><code>analytic.seed_impedance</code></td></tr>
              <tr><td>1 · identify</td><td>the plant's realized K and ζ<sub>z</sub> at the pick pose, its z friction dead band; re-seed</td><td>sim (<code>SimPickPlant</code>); not on hardware</td></tr>
              <tr><td>2 · sweep</td><td>K<sub>z</sub> ×1.25 per rung, up and down, while the gates pass on the search tapes</td><td><code>sim.tuner</code></td></tr>
              <tr><td>3 · refine</td><td>ζ<sub>z</sub> ±0.2, press ±5 mm, K<sub>xy</sub> ×{0.7, 1, 1.4} around the sweep's best</td><td><code>sim.tuner</code></td></tr>
              <tr><td>4 · verify</td><td>the best that is admissible on the held-out evaluation tapes, each at a physics rate that holds on doubling</td><td><code>sim.tuner</code></td></tr>
              <tr><td>proposal</td><td>CartesianImpedance + press-in + the evidence; nothing written to a board</td><td>—</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============================================================ 10 crisp -->
      <section id="crisp" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('crisp') }}</span>
          <h2>Compared with CRISP</h2>
          <p class="answer">
            CRISP (LearnSysLab) is a mature, open-source Cartesian impedance stack running on real torque-controlled arms. This package solves a
            narrower problem on different hardware: joints with their own fast PD, a slow host, and tuning that has to be earned rather than set.
          </p>
        </header>
        <div class="table-wrap card flush">
          <table class="crisp">
            <thead><tr><th></th><th>CRISP controllers</th><th>bam_impedance_controller</th></tr></thead>
            <tbody>
              <tr><td>hardware</td><td>any arm with an effort interface (FR3, iiwa 14, Kinova Gen3, UR5 listed)</td><td>moteus boards on 10:1 QDD joints, each with its own 30 kHz PD</td></tr>
              <tr><td>loop</td><td>a ros2_control controller at the controller_manager's rate (1,000 Hz in the example config)</td><td>a host tick at CAN rate (100 Hz, ~7 ms behind) above the boards</td></tr>
              <tr><td>law</td><td>Cartesian impedance + nullspace + safety clamps (error clip, torque-rate limit, joint-limit repulsion)</td><td>four modes that split K and D between host and board</td></tr>
              <tr><td>gains</td><td>hand-set defaults: k_pos 500 N/m, k_rot 30, a variable-stiffness cap of 900 / 60</td><td>K from the task budget, D from ζ on Λ(q), ceilings computed (<code>stability</code>), tuned and checked against an oracle</td></tr>
              <tr><td>friction</td><td>an optional Franka friction model (the header credits FrankaEmikaPandaDynModel, Gaz et al. 2019): sigmoids on the filtered measured velocity, fixed coefficients, <code>use_friction</code> off by default; no identification</td><td>Coulomb identified per joint by the PID tuner; a contact-aware feed-forward as an option</td></tr>
              <tr><td>calibration</td><td>the gripper's range</td><td>the identify rung (friction dead band, realized K and ζ), so far in sim</td></tr>
              <tr><td>status</td><td>deployed on real robots, with a teleoperation and learning stack around it</td><td>simulation only; hardware readiness not met</td></tr>
            </tbody>
          </table>
        </div>
        <p class="small">CRISP facts checked on <code>learnsyslab/crisp_controllers</code> (formerly utiasDSL), main at 0279dc8: <code>README.md</code>,
          <code>src/cartesian_controller.yaml</code> (k_pos_* 500, k_rot_* 30, variable_max_stiffness 900 / 60, use_friction false),
          <code>include/crisp_controllers/utils/friction_model.hpp</code>, <code>docs/getting_started_controllers.md</code> (update_rate 1000).
          The page's structure borrows from CRISP's site and slides; no text or assets are copied.</p>
      </section>

      <!-- ============================================================ 11 verification -->
      <section id="verification" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('verification') }}</span>
          <h2>Verification: an independent judge, {{ J.rounds.length }} fresh rounds</h2>
          <p class="answer">
            Every impact claim went through a Codex judge (a different model provider, read-only, a fresh process each round) until it passed:
            {{ J.rounds.filter((r: any) => r.verdict === 'FIX').length }} rounds of FIX, then PASS at round {{ J.rounds.length }} after {{ J.r9.checks }} fresh-process checks. The judge changed the claims, not just the wording.
          </p>
        </header>
        <ol class="timeline">
          <li v-for="r in J.rounds" :key="r.round" :class="r.verdict === 'PASS' ? 'pass' : 'fix'">
            <span class="rn">R{{ r.round }}</span>
            <span class="pill" :class="r.verdict === 'PASS' ? 'ok' : 'warn'">{{ r.verdict }}</span>
            <span class="raised">{{ r.raised === 'none' ? 'no new findings' : `raised ${r.raised}` }}</span>
            <q>{{ r.headline }}</q>
          </li>
        </ol>
        <div class="grid2">
          <div class="card">
            <h3>What it changed</h3>
            <ul class="facts">
              <li>one contact material for every row (B 200 N·s/m), not one per row</li>
              <li>three apparent masses instead of one; the transmitted-force predictor</li>
              <li>every reported number through a three-rate physics check and a perturbation check; flagged rows starred and kept out of conclusions</li>
              <li>"stiff" re-defined as today's tuning on every arm build; max-gain position control its own row</li>
              <li>anticipation compared with just slowing down, at matched touch speed</li>
              <li>the host's contact response measured counterfactually; contact-event counts certified only at the tested rates</li>
              <li>round 8: the solver's regularization takes ~10–11 % off light-tip peaks ({{ J.r9.f31_b200?.[0] }} → {{ J.r9.f31_b200?.[1] }}–{{ J.r9.f31_b200?.[2] }} N)</li>
            </ul>
          </div>
          <div class="card">
            <h3>Open risks</h3>
            <ul class="facts">
              <li><b>Unfitted plant.</b> The PID tuner's UR5e stand-in, not BAM's arm: its harmonic-drive-like armature is 3.5 kg of the 10.1 kg Λ<sub>zz</sub>.</li>
              <li><b>Contact material assumed.</b> 100 kN/m, B 200 N·s/m is an example; the compensator's advantage is ×{{ sens['40'].ratio.toFixed(1) }} /
                ×{{ sens['200'].ratio.toFixed(1) }} / ×{{ sens['600'].ratio.toFixed(1) }} at B 40 / 200 / 600.</li>
              <li><b>Solver bias on light tips.</b> The default regularization lowers compensator peaks ~10–11 %; heavy-arm peaks move ~0.2 %.</li>
              <li><b>Contact-event counts.</b> Bounces and in-contact fractions are certified only at the tested rates; near a threshold they can flip.</li>
              <li><b>Ideal ceilings.</b> The implemented loop sits 7–12 % below the model's ceilings, inside the 2× kp margin.</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ============================================================ 12 reproduce -->
      <section id="reproduce" class="sec">
        <header class="sec-head">
          <span class="sec-n">{{ n('reproduce') }}</span>
          <h2>Reproduce</h2>
          <p class="answer">The code sits on lane <code>{{ LANE.branch }}</code> ({{ LANE.commit }}), not merged. Every command below is the package's own.</p>
        </header>
        <div class="grid2">
          <div class="card">
            <h3>Tests, the comparison, the studies</h3>
            <pre><code>cd {{ LANE_DIR }}
env -u VIRTUAL_ENV uv run --extra test --extra sim pytest -q
env -u VIRTUAL_ENV uv run --extra sim --extra report --extra waypoint \
  bam-impedance compare --out ~/bam_ws/reports/media/impedance-modes-2026-10-26
env -u VIRTUAL_ENV uv run --extra sim --extra report python docs/impact_study.py \
  --out ~/bam_ws/reports/media/impedance-modes-2026-10-26/impact
env -u VIRTUAL_ENV uv run --extra sim --extra report python docs/oracle_study.py \
  --out ~/bam_ws/reports/media/impedance-modes-2026-10-26/oracle
env -u VIRTUAL_ENV uv run python docs/kpis.py \
  --out ~/bam_ws/reports/media/impedance-modes-2026-10-26/oracle</code></pre>
          </div>
          <div class="card">
            <h3>This page</h3>
            <pre><code>python3 /home/bam/impedance-controller-website/scripts/export_site_data.py
pnpm --dir /home/bam/impedance-controller-website run dev</code></pre>
            <p class="small">The exporter re-reads every input below, recomputes the ceiling table with <code>stability.host_wn_ceiling</code> and re-runs the
              replay picks when their cases change (at most 4 sim processes).</p>
            <h3>Code</h3>
            <ul class="facts mono-list">
              <li><code>types.py</code>, <code>law.py</code>: the contract and the four-mode law</li>
              <li><code>stability.py</code>: the host ceilings; <code>limits.py</code>: the tuner's hand-off</li>
              <li><code>analytic.py</code>, <code>objective.py</code>, <code>sim/tuner.py</code>: seed, cost, ladder</li>
              <li><code>friction.py</code>: the contact-aware feed-forward</li>
              <li><code>sim/</code>: the MuJoCo pick, scene and loop</li>
            </ul>
          </div>
        </div>
        <details class="more">
          <summary>Where every number on this page comes from</summary>
          <ul class="sources">
            <li v-for="(s, key) in sources" :key="key"><code>{{ shortPath(s.path) }}</code> <span class="dim">{{ s.sha256_12 }}</span> — {{ s.what }}</li>
            <li><code>site/public/data/ablation.json</code>, <code>hand.json</code> — the ablation ladder and the hand study (the sim lane; docs/data-contract.md)</li>
          </ul>
        </details>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ base layout (every direction) */
.lp-root {
  background: var(--pt-bg);
  background-image: linear-gradient(var(--pt-grid) 1px, transparent 1px), linear-gradient(90deg, var(--pt-grid) 1px, transparent 1px);
  background-size: 28px 28px;
  min-height: 100vh;
}
.lp {
  max-width: 1180px;
  margin: 0 auto;
  padding: 8px 16px 96px;
  color: var(--pt-text);
  font-family: var(--pt-font-base);
}
.sec {
  padding: 56px 0 8px;
  scroll-margin-top: calc(var(--vp-nav-height, 64px) + 48px);
}
.sec-head {
  display: grid;
  gap: 10px;
  margin-bottom: 22px;
  max-width: 860px;
}
.sec-n {
  justify-self: start;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--pt-brand-soft);
  color: var(--pt-brand);
  font-family: var(--pt-font-mono);
  font-size: 12px;
  font-weight: 600;
}
h1,
h2,
h3,
h4 {
  font-family: var(--pt-font-display);
  font-weight: var(--pt-display-weight);
  letter-spacing: var(--pt-display-tracking);
  color: var(--pt-text);
  margin: 0;
}
h2 {
  font-size: clamp(24px, 3.6vw, 34px);
  line-height: 1.15;
}
h3 {
  font-size: 16.5px;
  line-height: 1.3;
  margin-bottom: 6px;
}
h4 {
  font-size: 14.5px;
  margin: 14px 0 6px;
}
h3.sub {
  margin: 34px 0 12px;
  font-size: 19px;
}
.answer {
  margin: 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--pt-text-2);
}
.answer-line {
  margin: -4px 0 12px;
  color: var(--pt-text-2);
  font-size: 15px;
  max-width: 860px;
}
p {
  line-height: 1.6;
}
.card {
  padding: 18px 20px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius);
  background: var(--pt-card);
  box-shadow: var(--pt-shadow);
  min-width: 0;
}
.card p {
  margin: 0 0 8px;
  font-size: 14.5px;
  color: var(--pt-text-2);
}
.card p b {
  color: var(--pt-text);
}
.card.flush {
  padding: 14px;
}
.card + .card {
  margin-top: 14px;
}
.card-title {
  margin: 2px 2px 10px;
}
.grid2,
.grid3 {
  display: grid;
  gap: 14px;
  margin-top: 14px;
}
.grid2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.grid3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.grid2 > .card + .card,
.grid3 > .card + .card {
  margin-top: 0;
}
@media (max-width: 900px) {
  .grid3 {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .grid2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
.facts {
  margin: 0;
  padding-left: 18px;
  list-style: disc;
  display: grid;
  gap: 5px;
  font-size: 14px;
  color: var(--pt-text-2);
}
.facts b {
  color: var(--pt-text);
}
.small {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--pt-text-3);
  line-height: 1.5;
}
.dim {
  color: var(--pt-text-3);
}
.mono {
  font-family: var(--pt-font-mono);
  font-variant-numeric: tabular-nums;
}
code {
  font-family: var(--pt-font-mono);
  font-size: 0.88em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--pt-bg-soft);
  overflow-wrap: anywhere;
}
pre {
  margin: 0 0 12px;
  padding: 12px 14px;
  border-radius: var(--pt-radius-sm);
  background: var(--pt-bg-soft);
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
}
pre code {
  padding: 0;
  background: none;
  overflow-wrap: normal;
}
.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.pill.warn {
  background: var(--pt-warn-soft);
  color: var(--pt-warn);
}
.pill.ok {
  background: var(--pt-brand-soft);
  color: var(--pt-good);
}
.warn-text {
  color: var(--pt-warn);
}
details.more {
  margin-top: 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  padding: 0 16px;
}
details.more > summary {
  cursor: pointer;
  padding: 12px 0;
  font-weight: 600;
  font-size: 14.5px;
  color: var(--pt-text);
}
details.more[open] > summary {
  border-bottom: var(--pt-border-w) solid var(--pt-line);
  margin-bottom: 10px;
}
details.more p {
  font-size: 14px;
  color: var(--pt-text-2);
}
details.more img {
  display: block;
  width: 100%;
  height: auto;
  margin: 8px 0 14px;
  border-radius: var(--pt-radius-sm);
  background: #fff;
}
figure {
  margin: 0;
}
figcaption {
  font-size: 12.5px;
  color: var(--pt-text-3);
  margin: -6px 0 14px;
}
.table-wrap {
  overflow-x: auto;
  max-width: 100%;
}
table {
  width: 100%;
  min-width: 620px; /* WHY: on a phone a table scrolls inside .table-wrap instead of squeezing every cell to one word a line */
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 7px 9px;
  border-bottom: var(--pt-border-w) solid var(--pt-line);
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--pt-text-3);
  font-weight: 600;
  font-size: 12px;
}
th small {
  font-weight: 400;
}
td:first-child code {
  white-space: nowrap;
  overflow-wrap: normal;
}
tr.pick td {
  background: var(--pt-brand-soft);
}
tr.diag td {
  color: var(--pt-text-3);
}
td.bad {
  color: var(--pt-warn);
}
td.rule {
  color: var(--pt-text-2);
}
.dim {
  color: var(--pt-text-3);
}

/* hero */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 32px;
  align-items: center;
  padding-top: 40px;
}
@media (max-width: 960px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
  }
}
.eyebrow {
  margin: 0 0 10px;
  color: var(--pt-brand);
  font-family: var(--pt-font-mono);
  font-size: 12.5px;
}
h1 {
  font-size: clamp(38px, 6.4vw, 66px);
  line-height: 1.02;
  margin-bottom: 16px;
}
h1 .soft {
  color: var(--pt-brand);
}
.lead {
  margin: 0 0 20px;
  font-size: 17.5px;
  line-height: 1.6;
  color: var(--pt-text-2);
  max-width: 620px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 480px) {
  .tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
.tile {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
}
.tile b {
  font-family: var(--pt-font-display);
  font-size: 23px;
  line-height: 1.15;
  color: var(--pt-text);
}
.tile b small {
  font-size: 14px;
  color: var(--pt-text-3);
  font-weight: 500;
}
.tile span {
  font-size: 12.5px;
  color: var(--pt-text-2);
  line-height: 1.45;
}
.honest {
  margin: 16px 0 0;
  font-size: 13px;
  color: var(--pt-text-2);
  line-height: 1.9;
}
.hero-media {
  margin: 0;
}
.hero-media video {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1040 / 746;
  border-radius: var(--pt-radius);
  border: var(--pt-border-w) solid var(--pt-line);
  background: #fff;
  box-shadow: var(--pt-shadow);
}
.hero-media figcaption {
  margin: 8px 2px 0;
}

/* cascade */
.cascade {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 4px 0 8px;
}
.stage-box {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  font-size: 12px;
  color: var(--pt-text-2);
}
.stage-box b {
  font-family: var(--pt-font-mono);
  font-size: 12.5px;
  color: var(--pt-text);
  overflow-wrap: anywhere;
}
.stage-box .where {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pt-text-3);
}
.stage-box.new {
  border-color: var(--pt-brand);
  box-shadow: 0 0 0 1px var(--pt-brand);
}
.stage-box.board {
  background: var(--pt-accent-soft);
}
.arrow {
  flex: 0 0 22px;
  align-self: center;
  height: 2px;
  background: var(--pt-text-3);
  position: relative;
}
.arrow::after {
  content: '';
  position: absolute;
  right: 0;
  top: -4px;
  border: 5px solid transparent;
  border-left: 7px solid var(--pt-text-3);
  border-right: 0;
}
@media (max-width: 860px) {
  .cascade {
    flex-direction: column;
  }
  .arrow {
    flex: 0 0 18px;
    width: 2px;
    height: 18px;
    align-self: center;
  }
  .arrow::after {
    right: -4px;
    top: auto;
    bottom: 0;
    border: 5px solid transparent;
    border-top: 7px solid var(--pt-text-3);
    border-bottom: 0;
  }
}
.chip {
  display: inline-block;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.chip.host {
  background: var(--pt-brand-soft);
  color: var(--pt-brand);
}
.chip.board {
  background: var(--pt-accent-soft);
  color: var(--pt-accent);
}
table.modes td:last-child {
  color: var(--pt-text-2);
  min-width: 220px;
}

.live-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}
.open-full {
  font-size: 13px;
  color: var(--pt-brand);
}

/* the equation deck */
.eq-deck {
  display: grid;
  gap: 14px;
}
.eq-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.eq-tabs button,
.eq-nav button {
  padding: 5px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: 999px;
  font-size: 13px;
  color: var(--pt-text-2);
  background: var(--pt-card);
}
.eq-tabs button.on {
  background: var(--pt-brand);
  border-color: var(--pt-brand);
  color: var(--pt-bg);
}
.eq-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
}
.eq-nav button:disabled {
  opacity: 0.35;
}

/* impact */
.claims {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 22px;
}
@media (max-width: 900px) {
  .claims {
    grid-template-columns: minmax(0, 1fr);
  }
}
.claim {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-left: 3px solid var(--pt-brand);
  background: var(--pt-card);
  border-radius: 0 var(--pt-radius-sm) var(--pt-radius-sm) 0;
  font-size: 13.5px;
  color: var(--pt-text-2);
}
.claim b {
  color: var(--pt-text);
  font-size: 15px;
}
@media (max-width: 760px) {
  .object-bar {
    position: static !important;
  }
}
.object-bar {
  position: sticky;
  top: calc(var(--vp-nav-height, 64px) + 42px);
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin: 0 0 14px;
  font-size: 12.5px;
}
.drop .vs {
  display: flex;
  gap: 24px;
  margin: 6px 0 10px;
}
.drop .vs div {
  display: flex;
  flex-direction: column;
}
.drop .vs b {
  font-family: var(--pt-font-display);
  font-size: 30px;
}
.drop .vs span {
  color: var(--pt-text-3);
  font-size: 12px;
}

/* results */
.readiness {
  display: grid;
  gap: 4px;
  margin: 0 0 14px;
  padding: 12px 16px;
  border: var(--pt-border-w) solid var(--pt-warn);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-warn-soft);
  font-size: 14px;
  color: var(--pt-text-2);
}
.readiness b {
  color: var(--pt-warn);
}
.readiness.met {
  border-color: var(--pt-good);
  background: var(--pt-brand-soft);
}
.readiness.met b {
  color: var(--pt-good);
}
table.kpis td.mono {
  font-size: 12px;
}
.whatif-table tr.ok td {
  background: var(--pt-brand-soft);
}
.formula {
  font-family: var(--pt-font-mono);
  font-size: 12.5px !important;
  color: var(--pt-text) !important;
  line-height: 1.6;
}

/* verification */
.timeline {
  display: grid;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}
.timeline li {
  display: grid;
  grid-template-columns: 34px 52px 170px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-card);
  font-size: 13px;
}
.timeline li.pass {
  border-color: var(--pt-good);
}
.timeline .rn {
  font-family: var(--pt-font-mono);
  font-weight: 700;
}
.timeline .raised {
  font-family: var(--pt-font-mono);
  font-size: 12px;
  color: var(--pt-text-3);
}
.timeline q {
  color: var(--pt-text-2);
  font-style: italic;
}
@media (max-width: 760px) {
  .timeline li {
    grid-template-columns: 34px 52px minmax(0, 1fr);
  }
  .timeline q {
    grid-column: 1 / -1;
  }
}
.sources {
  margin: 0 0 12px;
  padding-left: 18px;
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--pt-text-2);
}
.mono-list {
  font-size: 13px;
}

</style>

<!-- WHY unscoped: the variant rules key on <html>, and scoped CSS's :global() drops the rest of the selector -->
<style>
/* ------------------------------------------------------------------ 2 · Scope: instrument panels */
:root[data-variant='scope'] .lp-root {
  background-size: 40px 40px;
}
:root[data-variant='scope'] .lp h1,
:root[data-variant='scope'] .lp h2 {
  text-transform: uppercase;
  letter-spacing: 0.01em;
}
:root[data-variant='scope'] .lp h1 {
  font-size: clamp(32px, 5.4vw, 54px);
}
:root[data-variant='scope'] .lp h1 .soft,
:root[data-variant='scope'] .lp .tile b {
  color: var(--pt-brand);
  text-shadow: 0 0 14px color-mix(in srgb, var(--pt-brand) 45%, transparent);
}
:root[data-variant='scope'] .lp .sec-n {
  border-radius: 2px;
  background: transparent;
  border: 1px solid var(--pt-brand);
}
:root[data-variant='scope'] .lp .sec-n::before {
  content: 'CH ';
}
:root[data-variant='scope'] .lp .card,
:root[data-variant='scope'] .lp .tile,
:root[data-variant='scope'] .lp details.more {
  position: relative;
  border-radius: 2px;
}
:root[data-variant='scope'] .lp .card::before {
  content: '';
  position: absolute;
  inset: -1px;
  pointer-events: none;
  background:
    linear-gradient(var(--pt-brand), var(--pt-brand)) top left / 10px 1px no-repeat,
    linear-gradient(var(--pt-brand), var(--pt-brand)) top left / 1px 10px no-repeat,
    linear-gradient(var(--pt-brand), var(--pt-brand)) bottom right / 10px 1px no-repeat,
    linear-gradient(var(--pt-brand), var(--pt-brand)) bottom right / 1px 10px no-repeat;
}
:root[data-variant='scope'] .lp .tile b,
:root[data-variant='scope'] .lp .drop .vs b {
  font-family: var(--pt-font-mono);
}
:root[data-variant='scope'] .lp .eyebrow::before {
  content: '▸ ';
}
:root[data-variant='scope'] .lp .claim {
  border-radius: 0;
  border-left-color: var(--pt-accent);
}
:root[data-variant='scope'] .lp .answer {
  font-size: 15.5px;
}

/* ------------------------------------------------------------------ 3 · Editorial: one column, hairlines, serif */
:root[data-variant='editorial'] .lp-root {
  background-image: none;
}
:root[data-variant='editorial'] .lp {
  max-width: 1060px;
}
:root[data-variant='editorial'] .lp .sec {
  border-top: 1px solid var(--pt-line);
  margin-top: 40px;
  padding-top: 40px;
}
:root[data-variant='editorial'] .lp .sec.hero {
  border-top: 0;
  margin-top: 0;
}
:root[data-variant='editorial'] .lp .sec-head {
  max-width: 720px;
}
:root[data-variant='editorial'] .lp .sec-n {
  background: none;
  padding: 0;
  color: var(--pt-accent);
  font-family: var(--pt-font-display);
  font-size: 15px;
  font-style: italic;
}
:root[data-variant='editorial'] .lp h2 {
  font-size: clamp(28px, 4.2vw, 42px);
}
:root[data-variant='editorial'] .lp h1 {
  font-weight: 500;
  font-size: clamp(42px, 7vw, 76px);
}
:root[data-variant='editorial'] .lp h1 .soft {
  color: var(--pt-accent);
  font-style: italic;
}
:root[data-variant='editorial'] .lp .answer,
:root[data-variant='editorial'] .lp .lead {
  font-family: var(--pt-font-display);
  font-size: 20px;
  line-height: 1.55;
  color: var(--pt-text);
}
:root[data-variant='editorial'] .lp .card,
:root[data-variant='editorial'] .lp .tile,
:root[data-variant='editorial'] .lp details.more {
  background: transparent;
  box-shadow: none;
  border: 0;
  border-top: 1px solid var(--pt-text);
  border-radius: 0;
  padding-left: 0;
  padding-right: 0;
}
:root[data-variant='editorial'] .lp .card.flush {
  border-top: 0;
}
:root[data-variant='editorial'] .lp .tile b {
  font-family: var(--pt-font-display);
  font-weight: 400;
  font-size: 30px;
}
:root[data-variant='editorial'] .lp .claim {
  background: transparent;
  border-left: 0;
  border-top: 2px solid var(--pt-accent);
  border-radius: 0;
  padding-left: 0;
}
:root[data-variant='editorial'] .lp .claim b {
  font-family: var(--pt-font-display);
  font-size: 18px;
}
:root[data-variant='editorial'] .lp .timeline li {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--pt-line);
  border-radius: 0;
}
:root[data-variant='editorial'] .lp .stage-box {
  border-radius: 0;
  background: transparent;
}
:root[data-variant='editorial'] .lp .stage-box.board {
  background: var(--pt-accent-soft);
}
:root[data-variant='editorial'] .lp .hero-media video {
  border-radius: 0;
  box-shadow: none;
}
</style>
