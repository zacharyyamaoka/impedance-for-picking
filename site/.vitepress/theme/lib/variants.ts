// The design directions behind the bottom-right switcher. Variant 1 is the default; the choice is remembered per browser.
// WHY a temporary in-app switcher, not a URL flag: Zach picks between directions by clicking, and the pick survives reloads.
// WHY the API and the --pt-* token names are unchanged from pidtuna-website: other lanes' components (ArmLab, LivePick) read
// cssVar('--pt-…') and onLookChange, so a new direction is new token VALUES, never new names.
export const VARIANTS = [
  { id: 'crisp', label: '1 · Lab notebook', blurb: 'Cream grid, teal accents, rounded cards. Calm and explanatory.' },
  { id: 'scope', label: '2 · Scope', blurb: 'A bench oscilloscope: graticule, phosphor traces, mono type.' },
  { id: 'editorial', label: '3 · Editorial', blurb: 'One column of serif text, hairline rules, figures that breathe.' },
] as const

export type VariantId = (typeof VARIANTS)[number]['id']
export const DEFAULT_VARIANT: VariantId = 'crisp'
export const STORAGE_KEY = 'impedance-variant'

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
  // WHY the old event name: listeners written against pidtuna-website's lib keep working
  window.dispatchEvent(new CustomEvent('pidtuna-variant', { detail: id }))
}

const IDS = VARIANTS.map((v) => `v==='${v.id}'`).join('||')

// Runs in <head> before first paint so a remembered variant never flashes the default.
export const HEAD_SCRIPT = `try{var v=localStorage.getItem('${STORAGE_KEY}');document.documentElement.dataset.variant=(${IDS})?v:'${DEFAULT_VARIANT}'}catch(e){document.documentElement.dataset.variant='${DEFAULT_VARIANT}'}`

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
