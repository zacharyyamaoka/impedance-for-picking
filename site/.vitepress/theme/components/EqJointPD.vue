<script setup lang="ts">
// Equation 1, the board's law: moteus' position mode is a PD with per-command scales on its configured gains.
// The widget: one joint (an illustration, J 0.1 kg·m² like the impact study's boundary fixture), its tuned gains, and the two
// scales the impedance stage sends. kp_scale 0 with kd_scale > 0 is HOST_SPRING's board: a pure damper.
import { computed, ref } from 'vue'

const J = 0.1 // kg m^2
const WN_BASE = 60 // rad/s: the illustration's tuned bandwidth
const KP = J * WN_BASE * WN_BASE
const KD = 2 * J * WN_BASE
const kpScale = ref(1)
const kdScale = ref(1)

const wn = computed(() => Math.sqrt((KP * kpScale.value) / J))
const zeta = computed(() => (kpScale.value > 0 ? (KD * kdScale.value) / (2 * Math.sqrt(KP * kpScale.value * J)) : Infinity))

// a 0.1 rad step in q_r, 0.25 s, semi-implicit Euler at 0.1 ms
const W = 300
const H = 120
const T = 0.25
const STEP = 0.1
const path = computed(() => {
  const dt = 1e-4
  let q = 0
  let qd = 0
  let d = ''
  const kp = KP * kpScale.value
  const kd = KD * kdScale.value
  const every = Math.round(T / dt / 150)
  for (let i = 0; i <= T / dt; i++) {
    if (i % every === 0) d += `${d ? 'L' : 'M'}${((i * dt) / T) * W},${H - 12 - (q / (1.6 * STEP)) * (H - 24)}`
    const tau = kp * (STEP - q) + kd * (0 - qd)
    qd += (tau / J) * dt
    q += qd * dt
  }
  return d
})
const yStep = H - 12 - (1 / 1.6) * (H - 24)
</script>

<template>
  <div class="eq-widget">
    <div class="eq-math">
      <span class="lhs">τ</span> = k<sub>p</sub>·<b class="hl">kp_scale</b>·(q<sub>r</sub> − q) + k<sub>d</sub>·<b class="hl">kd_scale</b>·(q̇<sub>r</sub> − q̇) + τ<sub>ff</sub>
    </div>
    <p class="eq-note">The moteus board runs this at 30 kHz. The impedance stage only chooses the five fields per joint: position, velocity,
      kp_scale, kd_scale and the feed-forward torque. The gains k<sub>p</sub>, k<sub>d</sub> are the PID tuner's.</p>
    <div class="eq-play">
      <svg :viewBox="`0 0 ${W} ${H}`" class="plot" role="img" aria-label="joint step response">
        <line :x1="0" :x2="W" :y1="yStep" :y2="yStep" class="ref" />
        <line :x1="0" :x2="W" :y1="H - 12" :y2="H - 12" class="axis" />
        <path :d="path" class="resp" />
        <text :x="W - 4" :y="yStep - 4" text-anchor="end" class="lbl">q_r</text>
        <text :x="W - 4" :y="H - 2" text-anchor="end" class="lbl">250 ms</text>
      </svg>
      <div class="sliders">
        <label>kp_scale <input v-model.number="kpScale" type="range" min="0" max="1" step="0.01" /> <span class="v">{{ kpScale.toFixed(2) }}</span></label>
        <label>kd_scale <input v-model.number="kdScale" type="range" min="0" max="1.5" step="0.01" /> <span class="v">{{ kdScale.toFixed(2) }}</span></label>
        <p class="out">
          <template v-if="kpScale > 0">ω<sub>n</sub> {{ wn.toFixed(0) }} rad/s · ζ {{ zeta.toFixed(2) }}</template>
          <template v-else><b>kp_scale 0:</b> the board is a pure damper and the joint stays put. That is HOST_SPRING's board: the host
            adds the spring as torque.</template>
        </p>
      </div>
    </div>
  </div>
</template>
