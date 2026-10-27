<script setup lang="ts">
/**
 * <ArmLab />: Zach's impedance controller live on a planar 2-link arm. Drag the target anywhere (into the belt too), switch
 * where the spring and the damper live, tune K, zeta, the host rate and delay, and watch every motor's torque split between
 * the board's PD and the host's feed-forward. The law is lib/impedance (the Python package, ported and golden-tested), the
 * arm lib/arm2d (checked against MuJoCo).
 *
 * WHY a draggable, remembered panel boundary (Zach's rule for every split view) and a stacked layout under 760 px.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { DEFAULT_SETTINGS, Lab, type LabMode, type LabSettings, type LabSnapshot, MODES, PRESETS, type Preset } from '../lib/arm2d/lab'
import { type Palette, type View, drawForcePlot, drawStage, makeView, toWorld } from '../lib/arm2d/draw'
import { cssVar, onLookChange } from '../lib/variants'

const PANEL_KEY = 'armlab-panel-width'
const PANEL_DEFAULT = 340
const PANEL_MIN = 260
const PANEL_MAX = 520
const STAGE_MIN = 360
const STACK_BELOW = 760
const K_MIN = 50
const K_MAX = 10000

const root = ref<HTMLElement | null>(null)
const stageWrap = ref<HTMLElement | null>(null)
const stageCanvas = ref<HTMLCanvasElement | null>(null)
const plotCanvas = ref<HTMLCanvasElement | null>(null)
const splitter = ref<HTMLElement | null>(null)

const settings = reactive<LabSettings>({ ...DEFAULT_SETTINGS })
const snapshot = shallowRef<LabSnapshot | null>(null)
const panelWidth = ref(PANEL_DEFAULT)
const stacked = ref(false)
const paused = ref(false)
const visible = ref(true)
const dragging = ref(false)
const activePreset = ref<string | null>(null)

let lab: Lab | null = null
let palette: Palette | null = null
let view: View | null = null
let frame = 0
let lastTime = 0
let frameCount = 0
let resizing = false
let frameCost = 0
const cleanups: (() => void)[] = []

const modeInfo = computed(() => MODES.find((mode) => mode.id === settings.mode)!)

/** a log slider: position 0..1000 <-> 50..10000 N/m */
const toSlider = (k: number) => Math.round((1000 * Math.log(k / K_MIN)) / Math.log(K_MAX / K_MIN))
const fromSlider = (u: number) => {
  const k = K_MIN * (K_MAX / K_MIN) ** (u / 1000)
  const step = k < 200 ? 10 : k < 1000 ? 25 : k < 4000 ? 50 : 100
  return Math.round(k / step) * step
}
const kxSlider = computed({ get: () => toSlider(settings.kx), set: (u: number) => (settings.kx = fromSlider(Number(u))) })
const kzSlider = computed({ get: () => toSlider(settings.kz), set: (u: number) => (settings.kz = fromSlider(Number(u))) })

const formatK = (k: number) => `${k.toLocaleString('en-US')} N/m`
const fixed = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '∞')

const ceilingText = computed(() => {
  const c = snapshot.value?.ceiling
  if (!c) return ''
  if (c.status === 'board') return 'The spring and damper run on the board at its own rate: no host ceiling applies.'
  const where = `${settings.hostRateHz} Hz · ${settings.delayMs} ms`
  const what = settings.mode === 'joint_coupled' ? 'the host coupling' : c.boardDamping ? 'the host spring (board damper)' : 'the host spring and damper'
  return `${what}: joint wn ${fixed(c.jointWn[0], 0)} / ${fixed(c.jointWn[1], 0)} rad/s against a ${fixed(c.wnCeiling ?? 0, 0)} rad/s ceiling at ${where}`
})

const warning = computed(() => {
  const c = snapshot.value?.ceiling
  if (!c || c.status === 'ok' || c.status === 'board') return null
  const where = `${settings.hostRateHz} Hz / ${settings.delayMs} ms`
  if (c.status === 'unstable')
    return {
      status: 'unstable',
      text: `Above the host ceiling: wn ${fixed(Math.max(...c.jointWn), 0)} rad/s > ${fixed(c.wnCeiling ?? 0, 0)} rad/s at ${where}. Any nudge grows: the delayed loop feeds energy in.`,
    }
  return { status: 'margin', text: `Inside the 2× gain margin: wn ${fixed(Math.max(...c.jointWn), 0)} of a ${fixed(c.wnCeiling ?? 0, 0)} rad/s ceiling at ${where}.` }
})

const torqueRows = computed(() => {
  const s = snapshot.value
  if (!s) return []
  return s.torque.map((joint, index) => ({
    name: index === 0 ? 'Shoulder' : 'Elbow',
    cap: joint.cap,
    saturated: joint.saturated > 0.2,
    clamped: s.clamped[index],
    rows: [
      { key: 'pd', label: 'Board PD', value: joint.boardPd },
      { key: 'host', label: 'Host law', value: joint.hostFf },
      { key: 'friction', label: 'Friction ff', value: joint.frictionFf },
      { key: 'gravity', label: 'Gravity ff', value: joint.gravityFf },
      { key: 'total', label: 'Motor', value: joint.total },
    ],
  }))
})

function barStyle(value: number, cap: number) {
  const fraction = Math.min(1, Math.abs(value) / cap) * 50
  return value >= 0 ? { left: '50%', width: `${fraction}%` } : { left: `${50 - fraction}%`, width: `${fraction}%` }
}

function readPalette(): Palette {
  return {
    bg: cssVar('--pt-viewport-bg', '#eef3f8'),
    floor: cssVar('--pt-viewport-floor', '#dde6ef'),
    text: cssVar('--pt-text', '#0b1b2b'),
    text2: cssVar('--pt-text-2', '#3d5166'),
    text3: cssVar('--pt-text-3', '#6b7d90'),
    line: cssVar('--pt-line', '#d9e2ec'),
    brand: cssVar('--pt-brand', '#0f4c81'),
    brandSoft: cssVar('--pt-brand-soft', 'rgba(15,76,129,.1)'),
    accent: cssVar('--pt-accent', '#c98a00'),
    ghost: cssVar('--pt-ghost', 'rgba(15,76,129,.22)'),
    warn: cssVar('--pt-warn', '#d6402b'),
    friction: cssVar('--pt-rung-oracle', '#7c3aed'),
    gravity: cssVar('--pt-rung-factory', '#8c98a6'),
    surface: cssVar('--pt-bg-soft', '#f2f6fa'),
    mono: cssVar('--pt-font-mono', 'monospace'),
    sans: cssVar('--pt-font-base', 'sans-serif'),
  }
}

function sizeCanvases() {
  const wrap = stageWrap.value
  const canvas = stageCanvas.value
  const plot = plotCanvas.value
  if (!wrap || !canvas || !plot) return
  const ratio = window.devicePixelRatio || 1
  const width = wrap.clientWidth
  // WHY taller when stacked: on a phone the stage fits by width, so a squarer canvas keeps the arm large
  const height = Math.round(stacked.value ? Math.min(560, Math.max(320, width * 0.92)) : Math.min(600, Math.max(300, width * 0.74)))
  canvas.style.height = `${height}px`
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  view = makeView(width, height)
  const plotWidth = plot.clientWidth
  plot.width = Math.round(plotWidth * ratio)
  plot.height = Math.round(plot.clientHeight * ratio)
}

function draw() {
  if (!lab || !palette || !view || !snapshot.value) return
  const ratio = window.devicePixelRatio || 1
  const ctx = stageCanvas.value?.getContext('2d')
  if (ctx) {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawStage(ctx, view, snapshot.value, lab.params, palette, dragging.value)
  }
  const plot = plotCanvas.value
  const plotCtx = plot?.getContext('2d')
  if (plot && plotCtx) {
    plotCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawForcePlot(plotCtx, plot.clientWidth, plot.clientHeight, lab, palette)
  }
}

function tick(time: number) {
  frame = requestAnimationFrame(tick)
  if (!lab) return
  // WHY up to 0.1 s per frame: a slow frame still advances real time (the physics costs ~8 % of a core at a 1 kHz host)
  const elapsed = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 1 / 60
  lastTime = time
  if (paused.value || !visible.value) return
  const start = performance.now()
  lab.advance(elapsed)
  const next = lab.snapshot()
  frameCount += 1
  snapshot.value = next
  syncFromLab()
  draw()
  frameCost += 0.1 * (performance.now() - start - frameCost)
  if (root.value && frameCount % 6 === 0) {
    const el = root.value
    el.dataset.mode = next.settings.mode
    el.dataset.ceiling = next.ceiling.status
    el.dataset.ripple = next.ripple.toFixed(4)
    el.dataset.contact = next.contactForce.toFixed(2)
  }
}

/** a preset or script step can change settings inside the lab: mirror them into the controls */
function syncFromLab() {
  if (!lab) return
  for (const key of Object.keys(settings) as (keyof LabSettings)[]) {
    if (settings[key] !== lab.settings[key]) (settings as any)[key] = lab.settings[key]
  }
}

watch(settings, (value) => lab?.update({ ...value }), { deep: true })

function setMode(mode: LabMode) {
  settings.mode = mode
}

function runPreset(preset: Preset) {
  if (!lab) return
  activePreset.value = preset.id
  lab.runPreset(preset)
  syncFromLab()
  paused.value = false
}

function resetArm() {
  lab?.cancelScript()
  lab?.reset()
  activePreset.value = null
}

function push(direction: 1 | -1) {
  lab?.pushTool([15 * direction, 0], 0.6)
}

function pointerWorld(event: PointerEvent) {
  const canvas = stageCanvas.value!
  const rect = canvas.getBoundingClientRect()
  return toWorld(view!, event.clientX - rect.left, event.clientY - rect.top)
}

function onStageDown(event: PointerEvent) {
  if (!lab || !view) return
  dragging.value = true
  stageCanvas.value!.setPointerCapture(event.pointerId)
  lab.cancelScript()
  activePreset.value = null
  lab.setTarget(...pointerWorld(event))
  event.preventDefault()
}

function onStageMove(event: PointerEvent) {
  if (!dragging.value || !lab || !view) return
  lab.setTarget(...pointerWorld(event))
}

function onStageUp(event: PointerEvent) {
  dragging.value = false
  stageCanvas.value?.releasePointerCapture?.(event.pointerId)
}

function clampPanel(width: number) {
  const total = root.value?.getBoundingClientRect().width ?? 1200
  return Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, total - STAGE_MIN, width)))
}

function savePanel() {
  try {
    localStorage.setItem(PANEL_KEY, String(panelWidth.value))
  } catch {
    /* private mode: the width just isn't remembered */
  }
}

function onSplitterDown(event: PointerEvent) {
  resizing = true
  splitter.value!.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onSplitterMove(event: PointerEvent) {
  if (!resizing || !root.value) return
  const rect = root.value.getBoundingClientRect()
  panelWidth.value = clampPanel(rect.right - event.clientX - 5)
}

function onSplitterUp(event: PointerEvent) {
  if (!resizing) return
  resizing = false
  splitter.value?.releasePointerCapture?.(event.pointerId)
  savePanel()
}

function onSplitterKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowLeft') panelWidth.value = clampPanel(panelWidth.value + step)
  else if (event.key === 'ArrowRight') panelWidth.value = clampPanel(panelWidth.value - step)
  else return
  event.preventDefault()
  savePanel()
}

onMounted(() => {
  try {
    const saved = Number(localStorage.getItem(PANEL_KEY))
    if (saved) panelWidth.value = saved
  } catch {
    /* no storage */
  }
  lab = new Lab({ ...settings })
  palette = readPalette()
  snapshot.value = lab.snapshot()
  const observer = new ResizeObserver(() => {
    if (!root.value) return
    stacked.value = root.value.getBoundingClientRect().width < STACK_BELOW
    if (!stacked.value) panelWidth.value = clampPanel(panelWidth.value)
    requestAnimationFrame(() => {
      sizeCanvases()
      draw()
    })
  })
  if (root.value) observer.observe(root.value)
  cleanups.push(() => observer.disconnect())
  const intersection = new IntersectionObserver((entries) => {
    visible.value = entries.some((entry) => entry.isIntersecting)
    lastTime = 0
  })
  if (root.value) intersection.observe(root.value)
  cleanups.push(() => intersection.disconnect())
  const onVisibility = () => {
    lastTime = 0
  }
  document.addEventListener('visibilitychange', onVisibility)
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
  cleanups.push(onLookChange(() => {
    palette = readPalette()
    draw()
  }))
  // a handle for headless checks (tests/armlab.spec.mjs): the live lab and its last snapshot, read-only use
  ;(window as any).__armLab = { lab, snapshot: () => snapshot.value, frameCostMs: () => frameCost }
  sizeCanvases()
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  cleanups.forEach((cleanup) => cleanup())
  if ((window as any).__armLab?.lab === lab) delete (window as any).__armLab
})
</script>

<template>
  <section
    ref="root"
    class="arm-lab"
    :class="{ 'arm-lab--stacked': stacked }"
    :style="{ '--arm-lab-panel': `${panelWidth}px` }"
    data-testid="arm-lab"
  >
    <div class="arm-lab__stage">
      <div ref="stageWrap" class="arm-lab__canvas-wrap">
        <canvas
          ref="stageCanvas"
          class="arm-lab__canvas"
          data-testid="arm-lab-canvas"
          aria-label="Two-link arm: drag to move the target"
          @pointerdown="onStageDown"
          @pointermove="onStageMove"
          @pointerup="onStageUp"
          @pointercancel="onStageUp"
        />
        <div class="arm-lab__caption">
          <span class="arm-lab__caption-mode">{{ modeInfo.label }}</span>
          <span>board: {{ modeInfo.board }}</span>
          <span>host: {{ modeInfo.host }}</span>
        </div>
        <div class="arm-lab__hint">Drag anywhere to move the target, even into the belt</div>
        <div v-if="warning" class="arm-lab__warning" :data-status="warning.status" data-testid="arm-lab-warning" role="status">
          {{ warning.text }}
        </div>
        <div class="arm-lab__legend">
          <span><i class="swatch swatch--dash" />requested K</span>
          <span><i class="swatch swatch--solid" />realized K (radius ∝ √k)</span>
          <span><i class="swatch swatch--spring" />spring to the reference</span>
        </div>
      </div>
      <div class="arm-lab__strip">
        <dl v-if="snapshot" class="readouts" data-testid="arm-lab-readouts">
          <div><dt>Contact force</dt><dd data-testid="readout-contact">{{ snapshot.contactForce.toFixed(1) }} N</dd></div>
          <div><dt>Stiffness scale s</dt><dd>{{ snapshot.stiffnessScale.toFixed(2) }}</dd></div>
          <div><dt>Oscillation</dt><dd data-testid="readout-ripple">{{ (snapshot.ripple * 1000).toFixed(0) }} mm/s</dd></div>
          <div v-if="settings.frictionFeedforward === 'contact_aware'"><dt>Contact latch</dt><dd>{{ snapshot.frictionLatched ? 'set' : 'clear' }}</dd></div>
        </dl>
        <div class="actions">
          <button type="button" data-testid="push-left" @click="push(-1)">← Push 15 N</button>
          <button type="button" data-testid="push-right" @click="push(1)">Push 15 N →</button>
          <button type="button" data-testid="reset" @click="resetArm">Reset arm</button>
          <button type="button" data-testid="pause" :aria-pressed="paused" @click="paused = !paused">{{ paused ? 'Play' : 'Pause' }}</button>
        </div>
      </div>
      <div class="arm-lab__forces">
        <div class="arm-lab__motors" data-testid="arm-lab-torques">
          <div v-for="motor in torqueRows" :key="motor.name" class="motor" :data-joint="motor.name.toLowerCase()">
            <div class="motor__head">
              <span class="motor__name">{{ motor.name }}</span>
              <span v-if="motor.clamped" class="motor__flag">clamped</span>
              <span v-if="motor.saturated" class="motor__flag motor__flag--warn">at cap</span>
              <span class="motor__cap">± {{ motor.cap }} N·m</span>
            </div>
            <div v-for="row in motor.rows" :key="row.key" class="bar" :class="`bar--${row.key}`" :data-term="row.key" :data-value="row.value.toFixed(3)">
              <span class="bar__label">{{ row.label }}</span>
              <span class="bar__track"><span class="bar__fill" :style="barStyle(row.value, motor.cap)" /></span>
              <span class="bar__value">{{ row.value >= 0 ? '+' : '−' }}{{ Math.abs(row.value).toFixed(2) }}</span>
            </div>
          </div>
        </div>
        <div class="arm-lab__plot">
          <canvas ref="plotCanvas" class="arm-lab__plot-canvas" data-testid="arm-lab-plot" aria-label="Contact force over the last 8 seconds" />
        </div>
        <p class="footnote">
          The law is <code>bam_impedance_controller</code>, ported and held to the Python by golden vectors; the arm (0.35 + 0.30 m,
          10:1 QDD rotors) runs at 8 kHz and is checked against MuJoCo. Each board's PD runs every physics step, the host at
          {{ settings.hostRateHz }} Hz behind {{ settings.delayMs }} ms. The belt is a 100 kN/m spring-damper, frictionless along x.
        </p>
      </div>
    </div>

    <div
      v-show="!stacked"
      ref="splitter"
      class="arm-lab__splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the controls panel"
      :aria-valuenow="panelWidth"
      :aria-valuemin="PANEL_MIN"
      :aria-valuemax="PANEL_MAX"
      tabindex="0"
      data-testid="arm-lab-splitter"
      @pointerdown="onSplitterDown"
      @pointermove="onSplitterMove"
      @pointerup="onSplitterUp"
      @pointercancel="onSplitterUp"
      @keydown="onSplitterKey"
    />

    <aside class="arm-lab__panel" data-testid="arm-lab-panel">
      <fieldset class="group">
        <legend>Where the spring lives</legend>
        <div class="segmented segmented--wrap">
          <button
            v-for="mode in MODES"
            :key="mode.id"
            type="button"
            :aria-pressed="settings.mode === mode.id"
            :data-testid="`mode-${mode.id}`"
            @click="setMode(mode.id)"
          >
            {{ mode.label }}
          </button>
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>Try</legend>
        <div class="presets">
          <button
            v-for="preset in PRESETS"
            :key="preset.id"
            type="button"
            class="preset"
            :aria-pressed="activePreset === preset.id"
            :data-testid="`preset-${preset.id}`"
            :title="preset.blurb"
            @click="runPreset(preset)"
          >
            {{ preset.label }}
          </button>
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>Cartesian spring</legend>
        <label class="slider">
          <span><span>K<sub>x</sub> along the belt</span><output>{{ formatK(settings.kx) }}</output></span>
          <input v-model.number="kxSlider" type="range" min="0" max="1000" step="1" data-testid="slider-kx" />
        </label>
        <label class="slider">
          <span><span>K<sub>z</sub> into the belt</span><output>{{ formatK(settings.kz) }}</output></span>
          <input v-model.number="kzSlider" type="range" min="0" max="1000" step="1" data-testid="slider-kz" />
        </label>
        <label class="slider">
          <span><span>Damping ratio ζ</span><output>{{ settings.zeta.toFixed(2) }}</output></span>
          <input v-model.number="settings.zeta" type="range" min="0.1" max="2" step="0.05" data-testid="slider-zeta" />
        </label>
      </fieldset>

      <fieldset class="group">
        <legend>Host loop</legend>
        <div class="segmented" role="group" aria-label="Host rate">
          <button
            v-for="rate in [100, 250, 500, 1000]"
            :key="rate"
            type="button"
            :aria-pressed="settings.hostRateHz === rate"
            :data-testid="`rate-${rate}`"
            @click="settings.hostRateHz = rate"
          >
            {{ rate }} Hz
          </button>
        </div>
        <label class="slider">
          <span><span>State → torque delay</span><output>{{ settings.delayMs.toFixed(1) }} ms</output></span>
          <input v-model.number="settings.delayMs" type="range" min="0" max="10" step="0.5" data-testid="slider-delay" />
        </label>
        <label class="check">
          <input v-model="settings.hostGuard" type="checkbox" data-testid="host-guard" />
          <span>Cap the host spring at half its ceiling (<code>host_kp_max</code>): the law softens it, s &lt; 1</span>
        </label>
        <p v-if="snapshot" class="ceiling-note" :data-status="snapshot.ceiling.status" data-testid="arm-lab-ceiling">{{ ceilingText }}</p>
      </fieldset>

      <fieldset class="group">
        <legend>Friction</legend>
        <div class="field-label">Coulomb feed-forward</div>
        <div class="segmented" role="group" aria-label="Friction feed-forward">
          <button type="button" :aria-pressed="settings.frictionFeedforward === 'off'" data-testid="friction-off" @click="settings.frictionFeedforward = 'off'">Off</button>
          <button type="button" :aria-pressed="settings.frictionFeedforward === 'reference'" data-testid="friction-reference" @click="settings.frictionFeedforward = 'reference'">Reference-keyed</button>
          <button type="button" :aria-pressed="settings.frictionFeedforward === 'contact_aware'" data-testid="friction-contact" @click="settings.frictionFeedforward = 'contact_aware'">Contact-aware</button>
        </div>
        <div class="field-label">The joints' dry friction</div>
        <div class="segmented" role="group" aria-label="Joint friction">
          <button type="button" :aria-pressed="settings.jointFriction === 'none'" @click="settings.jointFriction = 'none'">None</button>
          <button type="button" :aria-pressed="settings.jointFriction === 'light'" @click="settings.jointFriction = 'light'">Light 3 %</button>
          <button type="button" :aria-pressed="settings.jointFriction === 'jmc'" @click="settings.jointFriction = 'jmc'">JMC-like 23 %</button>
        </div>
      </fieldset>

    </aside>
  </section>
</template>

<style scoped>
.arm-lab {
  --arm-lab-gap: 16px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 10px var(--arm-lab-panel, 340px);
  margin: 0;
  border: 1px solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-bg);
  color: var(--pt-text);
  font-family: var(--pt-font-base);
  overflow: hidden;
}
.arm-lab--stacked {
  grid-template-columns: minmax(0, 1fr);
}
.arm-lab__stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.arm-lab__canvas-wrap {
  position: relative;
}
.arm-lab__canvas {
  display: block;
  width: 100%;
  height: 420px;
  touch-action: none;
  cursor: crosshair;
  background: var(--pt-viewport-bg);
}
.arm-lab__caption {
  position: absolute;
  top: 10px;
  left: 12px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 12px;
  color: var(--pt-text-2);
  pointer-events: none;
}
.arm-lab__caption-mode {
  font-family: var(--pt-font-display);
  font-weight: var(--pt-display-weight);
  font-size: 15px;
  color: var(--pt-text);
}
.arm-lab__hint {
  position: absolute;
  top: 10px;
  right: 12px;
  font-size: 12px;
  color: var(--pt-text-3);
  pointer-events: none;
  text-align: right;
  max-width: 45%;
}
.arm-lab__warning {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 40px;
  padding: 8px 12px;
  border-radius: var(--pt-radius-sm);
  font-size: 13px;
  line-height: 1.35;
  pointer-events: none;
  border: 1px solid currentColor;
  background: var(--pt-bg);
}
.arm-lab__warning[data-status='unstable'] {
  color: var(--pt-warn);
}
.arm-lab__warning[data-status='margin'] {
  color: var(--pt-accent);
}
.arm-lab__legend {
  position: absolute;
  left: 12px;
  bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: var(--pt-text-3);
  pointer-events: none;
}
.swatch {
  display: inline-block;
  width: 16px;
  height: 0;
  margin-right: 5px;
  vertical-align: middle;
  border-top: 2px solid var(--pt-brand);
}
.swatch--dash {
  border-top: 2px dashed var(--pt-text-3);
}
.swatch--spring {
  border-top: 2px solid var(--pt-accent);
}
.arm-lab__forces {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 12px var(--arm-lab-gap);
  padding: 14px var(--arm-lab-gap) 16px;
  border-top: 1px solid var(--pt-line);
}
.arm-lab__motors {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.arm-lab__plot {
  min-width: 0;
}
.arm-lab__plot-canvas {
  display: block;
  width: 100%;
  height: 180px;
}
.motor__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 13px;
}
.motor__name {
  font-weight: 600;
}
.motor__cap {
  margin-left: auto;
  font-family: var(--pt-font-mono);
  font-size: 11px;
  color: var(--pt-text-3);
}
.motor__flag {
  font-size: 11px;
  color: var(--pt-text-2);
  border: 1px solid var(--pt-line);
  border-radius: 999px;
  padding: 0 6px;
}
.motor__flag--warn {
  color: var(--pt-warn);
  border-color: currentColor;
}
.bar {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 54px;
  align-items: center;
  gap: 8px;
  height: 17px;
  font-size: 11.5px;
  color: var(--pt-text-2);
}
.bar__track {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--pt-bg-soft);
}
.bar__track::after {
  content: '';
  position: absolute;
  left: 50%;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--pt-text-3);
}
.bar__fill {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 4px;
  background: var(--pt-brand);
}
.bar--host .bar__fill {
  background: var(--pt-accent);
}
.bar--friction .bar__fill {
  background: var(--pt-rung-oracle);
}
.bar--gravity .bar__fill {
  background: var(--pt-rung-factory);
}
.bar--total {
  color: var(--pt-text);
  font-weight: 600;
}
.bar--total .bar__fill {
  background: var(--pt-text);
}
.bar__value {
  font-family: var(--pt-font-mono);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.arm-lab__splitter {
  cursor: col-resize;
  background: var(--pt-bg-soft);
  border-left: 1px solid var(--pt-line);
  border-right: 1px solid var(--pt-line);
  touch-action: none;
  position: relative;
}
.arm-lab__splitter::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 3px;
  width: 2px;
  height: 36px;
  margin-top: -18px;
  border-radius: 1px;
  background: var(--pt-text-3);
  opacity: 0.5;
}
.arm-lab__splitter:hover,
.arm-lab__splitter:focus-visible {
  background: var(--pt-brand-soft);
  outline: none;
}
.arm-lab__panel {
  min-width: 0;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  background: var(--pt-bg);
}
.arm-lab--stacked .arm-lab__panel {
  border-top: 1px solid var(--pt-line);
}
.group {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.group legend {
  padding: 0;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pt-text-3);
}
.field-label {
  font-size: 12px;
  color: var(--pt-text-2);
}
.segmented {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.segmented button,
.presets button,
.actions button {
  flex: 1 1 auto;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid var(--pt-line);
  border-radius: var(--pt-radius-sm);
  background: var(--pt-bg);
  color: var(--pt-text);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.segmented button:hover,
.presets button:hover,
.actions button:hover {
  border-color: var(--pt-brand);
}
.segmented button[aria-pressed='true'],
.presets button[aria-pressed='true'] {
  background: var(--pt-brand);
  border-color: var(--pt-brand);
  color: var(--pt-bg);
}
.presets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.slider {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
  color: var(--pt-text-2);
}
.slider > span {
  display: flex;
  justify-content: space-between;
}
.slider output {
  font-family: var(--pt-font-mono);
  color: var(--pt-text);
}
.slider input {
  width: 100%;
  accent-color: var(--pt-brand);
}
.check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--pt-text-2);
}
.check input {
  margin-top: 2px;
  accent-color: var(--pt-brand);
}
.arm-lab__strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px var(--arm-lab-gap);
  border-top: 1px solid var(--pt-line);
}
.readouts {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 22px;
}
.readouts div {
  display: flex;
  flex-direction: column;
}
.readouts dt {
  font-size: 11px;
  color: var(--pt-text-3);
}
.readouts dd {
  margin: 0;
  font-family: var(--pt-font-mono);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.ceiling-note {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--pt-text-2);
}
.ceiling-note[data-status='unstable'] {
  color: var(--pt-warn);
}
.ceiling-note[data-status='margin'] {
  color: var(--pt-accent);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.actions button {
  flex: 0 0 auto;
}
.footnote {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--pt-text-3);
}
code {
  font-family: var(--pt-font-mono);
  font-size: 0.95em;
}
.arm-lab--stacked .arm-lab__legend {
  position: static;
  padding: 6px 12px 0;
}
.arm-lab--stacked .arm-lab__warning {
  bottom: 10px;
}
@media (max-width: 520px) {
  .arm-lab__hint {
    display: none;
  }
  .bar {
    grid-template-columns: 70px minmax(0, 1fr) 50px;
  }
}
</style>
