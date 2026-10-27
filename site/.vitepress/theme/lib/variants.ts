// The design directions behind the bottom-right switcher. Variant 1 is the default; the choice is remembered per browser.
// WHY a temporary in-app switcher, not a URL flag: Zach picks between directions by clicking, and the pick survives reloads.
export const VARIANTS = [
  { id: 'yellowfin', label: '1 · Yellowfin', blurb: 'Deep-ocean navy, fin yellow. Calm technical.' },
  { id: 'tin', label: '2 · Tin', blurb: 'The tuna-can label. Loud, retro, playful.' },
  { id: 'scope', label: '3 · Scope', blurb: 'An oscilloscope. Phosphor traces on black.' },
] as const

export type VariantId = (typeof VARIANTS)[number]['id']
export const DEFAULT_VARIANT: VariantId = 'yellowfin'
export const STORAGE_KEY = 'pidtuna-variant'

export function currentVariant(): VariantId {
  if (typeof document === 'undefined') return DEFAULT_VARIANT
  const id = document.documentElement.dataset.variant as VariantId | undefined
  return VARIANTS.some((v) => v.id === id) ? (id as VariantId) : DEFAULT_VARIANT
}

export function applyVariant(id: VariantId) {
  document.documentElement.dataset.variant = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  window.dispatchEvent(new CustomEvent('pidtuna-variant', { detail: id }))
}

// Runs in <head> before first paint so a remembered variant never flashes the default.
export const HEAD_SCRIPT = `try{var v=localStorage.getItem('${STORAGE_KEY}');document.documentElement.dataset.variant=(v==='tin'||v==='scope'||v==='yellowfin')?v:'${DEFAULT_VARIANT}'}catch(e){document.documentElement.dataset.variant='${DEFAULT_VARIANT}'}`

/** Read a CSS custom property off <html> (re-read after a variant or dark-mode change). */
export function cssVar(name: string, fallback = '#888'): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** Call fn whenever the look changes: variant switch or VitePress dark-mode toggle. Returns an unsubscribe. */
export function onLookChange(fn: () => void): () => void {
  const observer = new MutationObserver(fn)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-variant'] })
  window.addEventListener('pidtuna-variant', fn)
  return () => {
    observer.disconnect()
    window.removeEventListener('pidtuna-variant', fn)
  }
}
