// The page-wide "what does the tool hit" switch: one state for every section that has both objects (the ablation ladder, the arm
// builds, the hand study). WHY one top-level switch, not both on one chart (Zach, 2026-10-27): "I prefer switching it top level vs
// having it all on the same chart" - flipping it swaps every number and trace in those sections at once.
import { ref, watch } from 'vue'

export type ContactObject = 'rigid' | 'soft'
const KEY = 'impedance-contact-object'

export const contactObject = ref<ContactObject>('rigid')

let restored = false
/** Restore the remembered choice once, on the client. */
export function restoreContactObject() {
  if (restored || typeof window === 'undefined') return
  restored = true
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'soft' || saved === 'rigid') contactObject.value = saved
  } catch {
    /* private mode */
  }
  watch(contactObject, (value) => {
    try {
      localStorage.setItem(KEY, value)
    } catch {
      /* private mode */
    }
  })
}

/** Fetch a JSON file the page renders at run time; null while it does not exist yet (a placeholder shows). */
export async function fetchOptional<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    // VitePress' preview answers a missing file with its 404 page (HTML): that is "not there yet", not data
    if (!type.includes('json')) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}
