<script setup lang="ts">
// Temporary design picker (bottom-right): switches the three directions live and remembers the pick.
// WHY temporary: it exists so Zach can choose; once a direction is picked this component and the other variants go.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { VARIANTS, applyVariant, currentVariant, type VariantId } from '../lib/variants'

const open = ref(false)
const active = ref<VariantId>('yellowfin')
const root = ref<HTMLElement | null>(null)

function pick(id: VariantId) {
  active.value = id
  applyVariant(id)
  open.value = false
}

function onDocClick(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  active.value = currentVariant()
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="pt-switcher" :class="{ open }">
    <div v-if="open" class="menu" role="menu" aria-label="Design direction">
      <p class="hint">Design direction (temporary picker)</p>
      <button
        v-for="variant in VARIANTS"
        :key="variant.id"
        role="menuitemradio"
        :aria-checked="active === variant.id"
        :class="{ active: active === variant.id }"
        @click="pick(variant.id)"
      >
        <span class="label">{{ variant.label }}</span>
        <span class="blurb">{{ variant.blurb }}</span>
      </button>
    </div>
    <button class="chip" :aria-expanded="open" aria-label="Choose a design direction" @click.stop="open = !open">
      <span class="dot" />
      {{ VARIANTS.find((v) => v.id === active)?.label }}
    </button>
  </div>
</template>

<style scoped>
.pt-switcher {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  font-family: var(--pt-font-base);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: 999px;
  background: var(--pt-bg);
  color: var(--pt-text);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--pt-shadow);
  cursor: pointer;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: conic-gradient(var(--pt-rung-tuned) 0 33%, var(--pt-brand) 0 66%, var(--pt-rung-analytic) 0);
}
.menu {
  width: 248px;
  padding: 8px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: var(--pt-radius);
  background: var(--pt-bg);
  box-shadow: var(--pt-shadow);
}
.hint {
  margin: 2px 6px 6px;
  color: var(--pt-text-3);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.menu button {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--pt-radius-sm);
  text-align: left;
  color: var(--pt-text);
}
.menu button:hover {
  background: var(--pt-bg-soft);
}
.menu button.active {
  background: var(--pt-brand-soft);
}
.label {
  display: block;
  font-size: 13.5px;
  font-weight: 700;
}
.blurb {
  display: block;
  margin-top: 2px;
  color: var(--pt-text-2);
  font-size: 12px;
}
@media print {
  .pt-switcher {
    display: none;
  }
}
</style>
