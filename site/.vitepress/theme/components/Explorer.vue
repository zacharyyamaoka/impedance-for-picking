<script setup lang="ts">
// The Explorer (Zach, 2026-10-27): "I want to see, e.g., the worst case with just the impedance controller ... add more runs so I can
// see all those combinations, then filter it or create different views that are more readable ... what does it look like in the
// worst case with QDD motors and the impedance controller."
//
// Every run of data/factorial.json (docs/data-contract.md) in data-ui's <data-views>: Zach's table kit, vendored in
// site/public/data-ui/ by scripts/vendor_data_ui.py and never edited here, as pidtuna.com's Data explorer uses it. Sorting, the factor
// facets (one value group per factor, with counts) and the named views (the tabs: "Worst case", "... + impedance only", ...) are
// data-ui's; the .base document and the dataset are built from the file in lib/factorial.ts. This component adds the detail panel:
// the picked run's Fz and per-joint gear torque, and "compare to" (pin a run as A, pick B).
// WHY our own panel and not data-ui's peek: the peek lists fields; the traces are the point here. The panel still uses the kit's drag
// handle (data-resizable, CONTRACT §11), so its width drags and is remembered like every data-ui panel.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { withBase } from 'vitepress'
import RunCard from './RunCard.vue'
import { findRun, loadFactorial, runId, toBase, toDataset, type Factorial, type PresetView, type Run } from '../lib/factorial'

const data = shallowRef<Factorial | null>(null)
const loaded = ref(false)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const selected = shallowRef<Run | null>(null)
const pinned = shallowRef<Run | null>(null)
const views = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
let presets: PresetView[] = []
let lastView = ''

const byId = computed(() => new Map((data.value?.runs ?? []).map((run) => [runId(run), run])))

function loadKit(): Promise<void> {
  if (customElements.get('data-views')) return Promise.resolve()
  if (!document.querySelector('link[data-ix-data-ui]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = withBase('/data-ui/data-ui.css')
    link.dataset.ixDataUi = ''
    document.head.appendChild(link)
  }
  if (!document.querySelector('script[data-ix-data-ui]')) {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = withBase('/data-ui/data-ui.js')
    script.dataset.ixDataUi = ''
    script.onerror = () => {
      status.value = 'error'
      errorText.value = 'the table component (data-ui) failed to load'
    }
    document.head.appendChild(script)
  }
  return customElements.whenDefined('data-views').then(() => undefined)
}

function select(run: Run | null) {
  if (run) selected.value = run
}
function focusView(name: string) {
  const preset = presets.find((p) => p.name === name)
  if (preset?.focus) return select(findRun(data.value, preset.focus))
  // a view without a named focus (Best combination, All runs): its first row
  const first = (views.value as unknown as { model?: { rows?: { id: string }[] } } | null)?.model?.rows?.[0]
  if (first) select(byId.value.get(String(first.id)) ?? null)
}

function onOpen(event: Event) {
  const row = (event as CustomEvent<{ row?: { id?: string } }>).detail?.row
  const run = row?.id ? byId.value.get(String(row.id)) : null
  // the kit's own peek would cover the table: the detail panel beside it is this page's peek
  ;(views.value as unknown as { closePeek?: () => void })?.closePeek?.()
  if (run) select(run)
}
function onChange(event: Event) {
  const name = (event as CustomEvent<{ name?: string }>).detail?.name ?? ''
  if (name && name !== lastView) {
    lastView = name
    nextTick(() => focusView(name))
  }
}
function onRender() {
  status.value = 'ready'
}

function pin() {
  pinned.value = selected.value
}
function unpin() {
  pinned.value = null
}
function swap() {
  if (!pinned.value || !selected.value) return
  const a = pinned.value
  pinned.value = selected.value
  selected.value = a
}

onMounted(async () => {
  data.value = await loadFactorial()
  loaded.value = true
  if (!data.value) return
  await nextTick()
  const el = views.value as unknown as (HTMLElement & { data: unknown; base: unknown }) | null
  if (!el) return
  el.addEventListener('data-views-open', onOpen)
  el.addEventListener('data-views-change', onChange)
  el.addEventListener('data-views-render', onRender)
  try {
    await loadKit()
    const built = toBase(data.value)
    presets = built.presets
    el.data = toDataset(data.value)
    el.base = built.base
    select(findRun(data.value, presets.find((p) => p.name === 'Worst case')?.focus ?? {}) ?? data.value.runs[0])
  } catch (error) {
    status.value = 'error'
    errorText.value = (error as Error).message
  }
})
onBeforeUnmount(() => {
  views.value?.removeEventListener('data-views-open', onOpen)
  views.value?.removeEventListener('data-views-change', onChange)
  views.value?.removeEventListener('data-views-render', onRender)
})
</script>

<template>
  <div class="explorer" :data-state="data ? 'data' : loaded ? 'pending' : 'loading'" :data-status="status" data-testid="explorer">
    <p v-if="!data && loaded" class="pending-note">
      <b>Being computed.</b> The sim lane is running every combination now (3 arm builds × 5 controllers × 2 approach speeds × spring on / off ×
      2 objects = 120 runs). The table, the named views and the detail panel fill in when <code>data/factorial.json</code> lands.
    </p>
    <template v-else-if="data">
      <p class="lead">
        {{ data.runs.length }} runs. Pick a named view in the tabs (<b>Worst case</b>, <b>Worst case + impedance only</b>, <b>Worst case + QDD +
        impedance</b>, <b>Best combination</b>, <b>Every controller on the worst arm</b>), narrow it with the factor filters, sort by any column,
        click a row for its traces. ★ = did not hold the rate or perturbation check.
        <span v-if="data.fixture" class="pill warn" data-testid="fixture-badge">fixture data, not results</span>
      </p>
      <p v-if="status === 'error'" class="err">The explorer failed to load: {{ errorText }}.</p>
      <div class="ex-split">
        <div class="ex-main">
          <data-facets for="ix-runs" aria-label="Filter by factor" />
          <data-views id="ix-runs" ref="views" no-url frame="flush" aria-label="Every run of the factorial" />
        </div>
        <aside id="ix-detail" ref="panel" class="ex-detail" data-resizable="left" data-resizable-key="impedance-explorer-detail"
               data-resizable-min="300" data-resizable-max="900" aria-label="the selected run" data-testid="explorer-detail">
          <div class="ex-bar">
            <template v-if="!pinned">
              <b>Selected run</b>
              <button class="btn" :disabled="!selected" data-testid="pin-run" @click="pin">Compare to… (pin as A)</button>
            </template>
            <template v-else>
              <b>Compare</b>
              <button class="btn" data-testid="swap-pair" @click="swap">Swap A ↔ B</button>
              <button class="btn" data-testid="unpin-run" @click="unpin">Done</button>
            </template>
          </div>
          <p v-if="pinned && selected && pinned === selected" class="hint">A is pinned. Click another row to set B.</p>
          <RunCard v-if="selected && pinned && pinned !== selected" :data="data" :run="pinned" :other="selected" />
          <RunCard v-else-if="selected" :data="data" :run="selected" />
        </aside>
      </div>
      <p class="src">Source: <code>data/factorial.json</code> ({{ data.source.script }} on {{ data.source.lane_commit?.slice(0, 8) }}). Table: data-ui
        (vendored, <code>site/public/data-ui/VENDOR.json</code>).</p>
    </template>
  </div>
</template>

<style>
/* data-ui reads --data-* (its CONTRACT §4); here they come from the site's --pt-* tokens, so a variant or dark switch follows */
.explorer {
  --data-bg: var(--pt-card);
  --data-fg: var(--pt-text);
  --data-muted: var(--pt-text-3);
  --data-subtle: var(--pt-bg-soft);
  --data-border: var(--pt-line);
  --data-rule: var(--pt-line);
  --data-hover: var(--pt-brand-soft);
  --data-accent: var(--pt-brand);
  --data-on-accent: var(--pt-bg);
  --data-warn: var(--pt-warn);
  --data-font: var(--pt-font-base);
  --data-mono: var(--pt-font-mono);
  --data-radius: var(--pt-radius-sm);
  --data-series-1: var(--pt-c-stiff);
  --data-series-2: var(--pt-c-torque);
  --data-series-3: var(--pt-c-series);
  --data-height: 560px;
}
</style>

<style scoped>
/* WHY wider than the page column: three panes (filters, table, detail) need the room; on a phone this is just the column */
.explorer {
  display: grid;
  gap: 10px;
  width: min(1560px, calc(100vw - 32px));
  /* centred on the column without a transform (a transform would re-anchor the kit's fixed-position overlays) */
  margin-left: calc(50% - min(780px, 50vw - 16px));
}
.pending-note {
  margin: 0;
  padding: 10px 14px;
  border: var(--pt-border-w) dashed var(--pt-line);
  border-radius: var(--pt-radius-sm);
  color: var(--pt-text-2);
  font-size: 14px;
}
.lead {
  margin: 0;
  font-size: 14px;
  color: var(--pt-text-2);
  max-width: 980px;
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
.ex-split {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: start;
}
.ex-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  min-width: 0;
  padding: 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius);
  background: var(--pt-card);
}
.ex-main data-facets {
  width: var(--data-panel-width, 210px);
}
.ex-main data-views {
  /* WHY not display: block: the kit lays <data-views> out as a column flexbox of --data-height; block lets the rows spill out */
  min-width: 0;
}
.ex-detail {
  width: var(--data-panel-width, 420px);
  max-height: calc(100vh - var(--vp-nav-height, 64px) - 80px);
  overflow: auto;
  position: sticky;
  top: calc(var(--vp-nav-height, 64px) + 56px);
  padding: 12px 14px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius);
  background: var(--pt-card);
  box-sizing: border-box;
}
.ex-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ex-bar b {
  margin-right: auto;
}
.btn {
  padding: 3px 10px;
  border: 1px solid var(--pt-line);
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--pt-text);
}
.btn:disabled {
  opacity: 0.4;
}
.hint {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--pt-text-2);
}
.src,
.err {
  margin: 0;
  font-size: 12px;
  color: var(--pt-text-3);
}
.err {
  color: var(--pt-warn);
}
@media (max-width: 1100px) {
  .ex-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .ex-detail {
    width: auto;
    position: static;
    max-height: none;
  }
}
@media (max-width: 760px) {
  .ex-main {
    grid-template-columns: minmax(0, 1fr);
    padding: 8px;
  }
  .ex-main data-facets {
    width: auto;
  }
}
</style>
