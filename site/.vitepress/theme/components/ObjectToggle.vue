<script setup lang="ts">
// The page-wide object switch (lib/contact.ts): rigid or soft. Every section that carries both reads the same state.
import { onMounted } from 'vue'
import { contactObject, restoreContactObject, type ContactObject } from '../lib/contact'

const props = defineProps<{ objects?: Partial<Record<ContactObject, { label?: string; contact_stiffness_n_m?: number; contact_damping_n_s_m?: number }>> }>()
const DEFAULTS: Record<ContactObject, { label: string; k: number; b: number }> = {
  rigid: { label: 'Rigid object', k: 100000, b: 200 },
  soft: { label: 'Soft object', k: 20000, b: 200 },
}
function info(id: ContactObject) {
  const o = props.objects?.[id]
  return { label: o?.label ?? DEFAULTS[id].label, k: o?.contact_stiffness_n_m ?? DEFAULTS[id].k, b: o?.contact_damping_n_s_m ?? DEFAULTS[id].b }
}
onMounted(restoreContactObject)
</script>

<template>
  <div class="object-toggle" role="radiogroup" aria-label="the object the tool hits" data-testid="object-toggle">
    <span class="lead">The tool hits</span>
    <button v-for="id in (['rigid', 'soft'] as ContactObject[])" :key="id" role="radio" :aria-checked="contactObject === id"
            :class="{ on: contactObject === id }" :data-object="id" @click="contactObject = id">
      <b>{{ info(id).label }}</b>
      <span>{{ info(id).k / 1000 }} kN/m · B {{ info(id).b }} N·s/m</span>
    </button>
  </div>
</template>

<style scoped>
.object-toggle {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 6px;
  padding: 5px;
  border: var(--pt-border-w) solid var(--pt-line);
  border-radius: calc(var(--pt-radius-sm) + 4px);
  background: var(--pt-card);
  max-width: 100%;
}
.lead {
  align-self: center;
  padding: 0 6px;
  color: var(--pt-text-3);
  font-size: 12px;
}
button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 6px 12px;
  border-radius: var(--pt-radius-sm);
  color: var(--pt-text-2);
  text-align: left;
}
button b {
  font-size: 13.5px;
}
button span {
  font-family: var(--pt-font-mono);
  font-size: 11px;
  opacity: 0.85;
}
button.on {
  background: var(--pt-brand);
  color: var(--pt-bg);
}
@media (max-width: 480px) {
  .lead {
    display: none;
  }
  button {
    padding: 5px 10px;
  }
  button span {
    font-size: 10px;
  }
}
</style>
