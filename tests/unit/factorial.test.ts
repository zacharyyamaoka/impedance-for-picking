// The factorial's helpers and the Explorer's data-ui inputs, against the contract-shaped fixture (scripts/make_fixtures.py).
// The .base document is also checked by data-ui's own checker (bin/data-ui.mjs check), so a filter it cannot parse fails here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  FACTORS, RUNG_COMBOS, WORST, armLife, compact, findRun, gearAmplification, lifeYears, runId, toBase, toDataset, worstJoint, years,
  type Factorial,
} from '../../site/.vitepress/theme/lib/factorial'

const data = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'factorial.fixture.json'), 'utf8')) as Factorial

describe('the factorial helpers', () => {
  test('the fixture is the full 3 × 5 × 2 × 2 × 2 = 120 runs, each combination once', () => {
    expect(data.runs).toHaveLength(120)
    expect(new Set(data.runs.map(runId)).size).toBe(120)
  })
  test('every ladder rung is a factorial combination', () => {
    for (const combo of Object.values(RUNG_COMBOS)) expect(findRun(data, { ...combo, object: 'rigid' })).not.toBeNull()
  })
  test('worst joint and arm life pick the extreme joint', () => {
    const run = findRun(data, { ...WORST, object: 'rigid' })!
    const w = worstJoint(run)
    expect(w.ratio).toBe(Math.max(...run.gear_load_ratio))
    expect(armLife(run).picks).toBe(Math.min(...run.gear_life_picks))
    expect(gearAmplification(run)).toBeGreaterThan(1)
  })
  test('life in years at 1,800 picks/h, 16 h/day', () => {
    expect(lifeYears(1800 * 16 * 365)).toBeCloseTo(1, 12)
    expect(years(2.04)).toBe('2.0 y')
    expect(years(1 / 365)).toBe('1.0 d')
    expect(compact(12_345_678)).toBe('12.3 M')
    expect(compact(NaN)).toBe('—')
  })
})

describe("the Explorer's dataset and views", () => {
  const dataset = toDataset(data)
  const { base, presets } = toBase(data)
  test('one row per run, flagged rows starred', () => {
    expect(dataset.rows).toHaveLength(120)
    const flagged = dataset.rows.filter((r) => !r.held)
    expect(flagged.length).toBeGreaterThan(0)
    for (const row of flagged) expect(row.name.startsWith('★')).toBe(true)
  })
  test("Zach's named presets are all there", () => {
    expect(presets.map((p) => p.name)).toEqual(expect.arrayContaining([
      'Worst case', 'Worst case + impedance only', 'Worst case + QDD + impedance', 'Best combination', 'Every controller on the worst arm',
    ]))
    for (const p of presets) if (p.focus) expect(findRun(data, p.focus), p.name).not.toBeNull()
  })
  // WHY zero warnings too: the checker only WARNS on a filter data-ui cannot evaluate (mutation-checked: a broken preset filter
  // reads as a warning), and such a preset would show an error instead of its runs
  test("data-ui's checker accepts the .base and dataset (no errors, no warnings)", () => {
    const checker = '/home/bam/data-ui/bin/data-ui.mjs'
    if (!existsSync(checker)) return
    const dir = mkdtempSync(join(tmpdir(), 'factorial-base-'))
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(dataset))
    writeFileSync(join(dir, 'views.base'), JSON.stringify({ data: 'runs.json', ...base }, null, 1))
    let out = ''
    try {
      out = execFileSync('node', [checker, 'check', join(dir, 'views.base'), '--data', join(dir, 'runs.json'), '--json'], { encoding: 'utf8' })
    } catch (error) {
      out = String((error as { stdout?: string }).stdout ?? error)
    }
    const report = JSON.parse(out)
    expect(report.errors, out).toBe(0)
    expect(report.warnings, out).toBe(0)
    expect(FACTORS.length).toBe(5)
  })
})
