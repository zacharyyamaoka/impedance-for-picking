<script setup lang="ts">
// Equation 2, mapping a Cartesian spring to the joints: K_q = Jᵀ K J. The widget: a planar two-link arm with the UR5e's upper-arm and
// forearm lengths (0.425, 0.392 m), the asked spring at the tip (dashed) and what JOINT mode renders when only diag(K_q) reaches the
// boards (solid). An illustration in 2-D; the measured 6-D numbers are in the Results section.
import { computed, ref } from 'vue'

const L1 = 0.425
const L2 = 0.392
const shoulder = ref(35) // deg, from horizontal
const elbow = ref(-95) // deg, relative
const kx = ref(3000)
const kz = ref(500)

type M2 = [number, number, number, number] // row-major 2x2

const rad = (deg: number) => (deg * Math.PI) / 180
const geometry = computed(() => {
  const a = rad(shoulder.value)
  const b = rad(shoulder.value + elbow.value)
  const elbowPt = [L1 * Math.cos(a), L1 * Math.sin(a)]
  const tip = [elbowPt[0] + L2 * Math.cos(b), elbowPt[1] + L2 * Math.sin(b)]
  const J: M2 = [-L1 * Math.sin(a) - L2 * Math.sin(b), -L2 * Math.sin(b), L1 * Math.cos(a) + L2 * Math.cos(b), L2 * Math.cos(b)]
  return { elbowPt, tip, J }
})

function mul(a: M2, b: M2): M2 {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]]
}
const T = (a: M2): M2 => [a[0], a[2], a[1], a[3]]
function inv(a: M2): M2 {
  const det = a[0] * a[3] - a[1] * a[2]
  return [a[3] / det, -a[1] / det, -a[2] / det, a[0] / det]
}
/** eigen-decomposition of a symmetric 2x2: [(value, angle of its vector)] */
function eig(m: M2): { l1: number; l2: number; angle: number } {
  const [a, b, , d] = m
  const mean = (a + d) / 2
  const r = Math.hypot((a - d) / 2, b)
  const angle = 0.5 * Math.atan2(2 * b, a - d) // of the larger eigenvalue's vector
  return { l1: mean + r, l2: mean - r, angle }
}

const result = computed(() => {
  const { J } = geometry.value
  const K: M2 = [kx.value, 0, 0, kz.value]
  const Kq = mul(mul(T(J), K), J)
  const diag: M2 = [Kq[0], 0, 0, Kq[3]]
  const Jinv = inv(J)
  const rendered = mul(mul(T(Jinv), diag), Jinv)
  const asked = eig(K)
  const got = eig(rendered)
  // the soft axis tilts by as much as the stiff one: the angle between the two ellipses' main axes, folded into [0, 90]
  const diff = ((got.angle - asked.angle) * 180) / Math.PI
  const tilt = Math.abs((((diff % 180) + 270) % 180) - 90)
  const err = Math.hypot(rendered[0] - K[0], rendered[1] - K[1], rendered[2] - K[2], rendered[3] - K[3]) / Math.hypot(K[0], K[3])
  return { Kq, rendered, asked, got, tilt, zRatio: rendered[3] / K[3], err, singular: Math.abs(J[0] * J[3] - J[1] * J[2]) < 0.01 }
})

// drawing: world metres -> svg px
const W = 300
const H = 220
const S = 260 // px per metre
const O = [40, 170]
const px = (p: number[]) => [O[0] + p[0] * S, O[1] - p[1] * S]
const ELLIPSE_PX_PER_NM = 30 / 3000 // 3000 N/m -> a 30 px half-axis
function ellipse(e: { l1: number; l2: number; angle: number }, centre: number[]) {
  const [cx, cy] = px(centre)
  return { cx, cy, rx: Math.max(1, e.l1 * ELLIPSE_PX_PER_NM), ry: Math.max(1, Math.max(e.l2, 0) * ELLIPSE_PX_PER_NM), deg: (-e.angle * 180) / Math.PI }
}
const shapes = computed(() => {
  const { elbowPt, tip } = geometry.value
  return { base: px([0, 0]), elbow: px(elbowPt), tip: px(tip), asked: ellipse(result.value.asked, tip), got: ellipse(result.value.got, tip) }
})
</script>

<template>
  <div class="eq-widget">
    <div class="eq-math">K<sub>q</sub> = J<sup>T</sup> <b class="hl">K</b> J</div>
    <p class="eq-note">The Cartesian spring K (stiff in x, soft in z) becomes a joint-space matrix. Its diagonal can go to the boards
      as kp; its off-diagonal terms couple the joints and have to come from somewhere else. Drop them (JOINT mode) and the spring
      the tip feels tilts and stiffens.</p>
    <div class="eq-play">
      <svg :viewBox="`0 0 ${W} ${H}`" class="plot" role="img" aria-label="two-link arm with stiffness ellipses">
        <line :x1="0" :x2="W" :y1="O[1] + 6" :y2="O[1] + 6" class="axis" />
        <polyline :points="`${shapes.base.join(',')} ${shapes.elbow.join(',')} ${shapes.tip.join(',')}`" class="arm" />
        <circle :cx="shapes.base[0]" :cy="shapes.base[1]" r="5" class="joint" />
        <circle :cx="shapes.elbow[0]" :cy="shapes.elbow[1]" r="4" class="joint" />
        <ellipse :cx="shapes.asked.cx" :cy="shapes.asked.cy" :rx="shapes.asked.rx" :ry="shapes.asked.ry"
                 :transform="`rotate(${shapes.asked.deg} ${shapes.asked.cx} ${shapes.asked.cy})`" class="asked" />
        <ellipse v-if="!result.singular" :cx="shapes.got.cx" :cy="shapes.got.cy" :rx="shapes.got.rx" :ry="shapes.got.ry"
                 :transform="`rotate(${shapes.got.deg} ${shapes.got.cx} ${shapes.got.cy})`" class="got" />
        <text x="4" y="14" class="lbl">dashed: asked K · solid: JOINT mode (diagonal only)</text>
      </svg>
      <div class="sliders">
        <label>shoulder <input v-model.number="shoulder" type="range" min="0" max="80" step="1" /> <span class="v">{{ shoulder }}°</span></label>
        <label>elbow <input v-model.number="elbow" type="range" min="-150" max="-20" step="1" /> <span class="v">{{ elbow }}°</span></label>
        <label>K<sub>x</sub> <input v-model.number="kx" type="range" min="200" max="6000" step="100" /> <span class="v">{{ kx }} N/m</span></label>
        <label>K<sub>z</sub> <input v-model.number="kz" type="range" min="100" max="3000" step="50" /> <span class="v">{{ kz }} N/m</span></label>
        <p class="out" v-if="!result.singular">
          JOINT mode renders z <b>{{ result.zRatio.toFixed(2) }}×</b> the asked stiffness, soft axis tilted <b>{{ result.tilt.toFixed(0) }}°</b>.
          JOINT_COUPLED and HOST_SPRING put the off-diagonal terms back (on the host) and land on the dashed ellipse.
        </p>
        <p class="out" v-else>Near a singularity: J is not invertible here.</p>
      </div>
    </div>
  </div>
</template>
