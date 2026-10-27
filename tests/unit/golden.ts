// Shared helpers for the golden-vector tests: load a fixture, compare arrays norm-wise relative, keep the worst error.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TOLERANCE = 1e-9

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'))
}

export function number(value: number | string | null): number {
  if (value === 'inf') return Infinity
  if (value === '-inf') return -Infinity
  return value as number
}

function flatten(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(flatten)
  return [value as number]
}

/**
 * Relative error of `actual` against `expected`, norm-wise: max |a - b| / max |b| over the whole array (an absolute floor of
 * 1e-12 for all-zero arrays). WHY norm-wise, not per element: an element that cancels to ~1e-17 in both has no meaningful
 * relative error, and 1e-9 of the array's scale is the claim that the two compute the same law.
 */
export function relativeError(actual: unknown, expected: unknown): number {
  const a = flatten(actual)
  const b = flatten(expected)
  if (a.length !== b.length) return Infinity
  let scale = 0
  let worst = 0
  for (let i = 0; i < b.length; i++) {
    if (!Number.isFinite(b[i]) || !Number.isFinite(a[i])) {
      if (a[i] !== b[i]) return Infinity
      continue
    }
    scale = Math.max(scale, Math.abs(b[i]))
    worst = Math.max(worst, Math.abs(a[i] - b[i]))
  }
  return worst / Math.max(scale, 1e-12)
}

/** Worst errors seen per label, printed by the suite's afterAll for the report. */
export class ErrorLedger {
  private worst = new Map<string, { error: number; count: number }>()
  record(label: string, error: number) {
    const entry = this.worst.get(label) ?? { error: 0, count: 0 }
    entry.error = Math.max(entry.error, error)
    entry.count += 1
    this.worst.set(label, entry)
  }
  summary(): string {
    return [...this.worst.entries()].map(([label, { error, count }]) => `${label}: ${count} checks, max rel. error ${error.toExponential(2)}`).join('\n')
  }
}
