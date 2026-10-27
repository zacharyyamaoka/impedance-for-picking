<script setup lang="ts">
// Equation 3, the damper: D = 2ζ√(ΛK) on the arm's apparent mass Λ, per axis (the package's DampingDesign.INERTIA; for full matrices,
// Albu-Schäffer's factorization). The widget compares it with the unit-mass rule D = 2√K, which is critical only for a 1 kg tool.
import { computed, ref } from 'vue'

const props = defineProps<{ lambdaPick?: number }>()
const lambda = ref(props.lambdaPick ? Math.round(props.lambdaPick * 10) / 10 : 10)
const k = ref(500)
const zeta = ref(1)

const dInertia = computed(() => 2 * zeta.value * Math.sqrt(lambda.value * k.value))
const dUnit = computed(() => 2 * Math.sqrt(k.value))
const zetaUnit = computed(() => dUnit.value / (2 * Math.sqrt(lambda.value * k.value)))

const W = 300
const H = 120
const T = computed(() => Math.min(3, Math.max(0.4, (6 * 2 * Math.PI) / Math.sqrt(k.value / lambda.value) / 2)))
function response(d: number) {
  // released from 10 mm off the spring's rest point
  const dt = T.value / 3000
  let x = 0.01
  let v = 0
  let out = ''
  for (let i = 0; i <= 3000; i++) {
    if (i % 20 === 0) out += `${out ? 'L' : 'M'}${(i / 3000) * W},${H / 2 - (x / 0.01) * (H / 2 - 8)}`
    const a = (-k.value * x - d * v) / lambda.value
    v += a * dt
    x += v * dt
  }
  return out
}
const pathInertia = computed(() => response(dInertia.value))
const pathUnit = computed(() => response(dUnit.value))
</script>

<template>
  <div class="eq-widget">
    <div class="eq-math"><b class="hl">D</b> = 2 ζ √(Λ K)</div>
    <p class="eq-note">The damper is sized on how heavy the tool feels along each axis, Λ = (J M⁻¹ Jᵀ)⁻¹, so the damping ratio ζ is
      what you asked for at every pose. The default here is ζ 1 (no force overshoot while pressing).</p>
    <div class="eq-play">
      <svg :viewBox="`0 0 ${W} ${H}`" class="plot" role="img" aria-label="release response, inertia design against unit-mass design">
        <line :x1="0" :x2="W" :y1="H / 2" :y2="H / 2" class="axis" />
        <path :d="pathUnit" class="resp alt" />
        <path :d="pathInertia" class="resp" />
        <text x="4" y="12" class="lbl">released 10 mm off the spring · {{ T.toFixed(2) }} s</text>
      </svg>
      <div class="sliders">
        <label>Λ <input v-model.number="lambda" type="range" min="0.5" max="12" step="0.1" /> <span class="v">{{ lambda.toFixed(1) }} kg</span></label>
        <label>K <input v-model.number="k" type="range" min="100" max="5000" step="50" /> <span class="v">{{ k }} N/m</span></label>
        <label>ζ <input v-model.number="zeta" type="range" min="0.3" max="1.5" step="0.05" /> <span class="v">{{ zeta.toFixed(2) }}</span></label>
        <p class="out">
          <span class="key solid" /> inertia design: D <b>{{ dInertia.toFixed(0) }} N·s/m</b>, ζ {{ zeta.toFixed(2) }}.
          <span class="key dash" /> D = 2√K: {{ dUnit.toFixed(0) }} N·s/m, which is ζ <b>{{ zetaUnit.toFixed(2) }}</b> on this Λ.
          <template v-if="lambdaPick"> The UR5e stand-in's Λ<sub>zz</sub> at the pick is {{ lambdaPick.toFixed(1) }} kg.</template>
        </p>
      </div>
    </div>
  </div>
</template>
