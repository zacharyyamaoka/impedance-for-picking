<script setup lang="ts">
// The step bar: the page's sections as one row of steps (Overview -> Problem -> How it works -> ...), sticky under the nav,
// the current one lit as you scroll. On a phone the row scrolls inside itself and keeps the current step in view.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ steps: { id: string; label: string }[] }>()
const active = ref(props.steps[0]?.id ?? '')
const list = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null
const visible = new Map<string, number>()

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.boundingClientRect.top : Infinity)
      // the current step: the last section whose top has passed a line a third of the way down the screen
      const line = window.innerHeight / 3
      let current = props.steps[0]?.id ?? ''
      for (const step of props.steps) {
        const el = document.getElementById(step.id)
        if (el && el.getBoundingClientRect().top <= line) current = step.id
      }
      active.value = current
    },
    { rootMargin: '0px 0px -50% 0px', threshold: [0, 0.01, 0.5, 1] },
  )
  for (const step of props.steps) {
    const el = document.getElementById(step.id)
    if (el) observer.observe(el)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('scroll', onScroll)
})

let pending = false
function onScroll() {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    const line = window.innerHeight / 3
    let current = props.steps[0]?.id ?? ''
    for (const step of props.steps) {
      const el = document.getElementById(step.id)
      if (el && el.getBoundingClientRect().top <= line) current = step.id
    }
    active.value = current
  })
}

watch(active, async (id) => {
  await nextTick()
  const item = list.value?.querySelector<HTMLElement>(`[data-step="${id}"]`)
  if (item && list.value) {
    const box = list.value
    const left = item.offsetLeft - box.clientWidth / 2 + item.clientWidth / 2
    box.scrollTo({ left, behavior: 'smooth' })
  }
})

const indexOf = (id: string) => props.steps.findIndex((s) => s.id === id)
</script>

<template>
  <nav class="step-bar" aria-label="Sections">
    <ol ref="list">
      <li v-for="(step, i) in steps" :key="step.id" :data-step="step.id"
          :class="{ on: step.id === active, done: i < indexOf(active) }">
        <a :href="`#${step.id}`"><span class="n">{{ String(i + 1).padStart(2, '0') }}</span><span class="label">{{ step.label }}</span></a>
      </li>
    </ol>
    <div class="progress" :style="{ width: `${((indexOf(active) + 1) / steps.length) * 100}%` }" />
  </nav>
</template>

<style scoped>
.step-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--pt-bg) 92%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: var(--pt-border-w) solid var(--pt-line);
}
@media (min-width: 960px) {
  /* VitePress fixes its nav from 960 px up; below that the nav scrolls away and the bar sticks to the top */
  .step-bar {
    top: var(--vp-nav-height, 64px);
  }
}
ol {
  display: flex;
  gap: 2px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 6px 16px;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
}
ol::-webkit-scrollbar {
  display: none;
}
li {
  flex: 0 0 auto;
}
a {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 999px;
  color: var(--pt-text-3);
  font-size: 12.5px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.n {
  font-family: var(--pt-font-mono);
  font-size: 10.5px;
  opacity: 0.8;
}
li.done a {
  color: var(--pt-text-2);
}
li.on a {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
a:hover {
  color: var(--pt-text);
}
li.on a:hover {
  color: var(--pt-bg);
}
.progress {
  height: 2px;
  background: var(--pt-brand);
  transition: width 0.3s;
}

</style>

<!-- WHY unscoped: the variant rules key on <html>, and scoped CSS's :global() drops the rest of the selector -->
<style>
/* Scope: channel tabs */
:root[data-variant='scope'] .step-bar a {
  border-radius: 2px;
  font-family: var(--pt-font-mono);
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.04em;
}
:root[data-variant='scope'] .step-bar li.on a {
  background: transparent;
  color: var(--pt-brand);
  box-shadow: inset 0 -2px 0 var(--pt-brand);
}
/* Editorial: numbered running heads, no pills */
:root[data-variant='editorial'] .step-bar {
  background: color-mix(in srgb, var(--pt-bg) 96%, transparent);
}
:root[data-variant='editorial'] .step-bar a {
  border-radius: 0;
  font-size: 12px;
}
:root[data-variant='editorial'] .step-bar li.on a {
  background: transparent;
  color: var(--pt-text);
  font-weight: 600;
  box-shadow: inset 0 -1px 0 var(--pt-text);
}
:root[data-variant='editorial'] .step-bar .progress {
  height: 1px;
  background: var(--pt-accent);
}
</style>
