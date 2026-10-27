// host_wn_ceiling, host_kp_limits and the closed loop's spectral radius match the Python package (stability.py): the
// instability warning in the ArmLab is the same number the controller's own ceiling check computes.
import { afterAll, describe, expect, test } from 'vitest'
import { closedLoopMatrix, hostKpLimits, hostWnCeiling, linalg } from '../../site/.vitepress/theme/lib/impedance'
import { ErrorLedger, TOLERANCE, fixture, number, relativeError } from './golden'

const data = fixture('stability_cases.json')
const ledger = new ErrorLedger()

describe('host_wn_ceiling matches the Python', () => {
  test(`${data.ceilings.length} ceilings: 100-1000 Hz x 0-10 ms x zeta x board damping`, () => {
    for (const entry of data.ceilings) {
      const actual = hostWnCeiling(entry.periodS, entry.delayS, entry.dampingRatio, entry.boardDamping)
      const expected = number(entry.expected)
      const error = relativeError([actual], [expected])
      ledger.record('host_wn_ceiling', error)
      expect(error, JSON.stringify({ ...entry, actual })).toBeLessThanOrEqual(TOLERANCE)
    }
  })
  test('the README\'s numbers: 100 Hz / 7 ms, zeta 1 -> wn 55.7 host PD, 233.6 host spring over a board damper', () => {
    expect(hostWnCeiling(0.01, 0.007, 1, false)).toBeCloseTo(55.7, 1)
    expect(hostWnCeiling(0.01, 0.007, 1, true)).toBeCloseTo(233.6, 0)
  })
})

describe('host_kp_limits and the closed-loop eigenvalues', () => {
  test('host_kp_limits', () => {
    for (const entry of data.limits) {
      const error = relativeError(hostKpLimits(entry.inertias, entry.periodS, entry.delayS, entry.dampingRatio, entry.boardDamping), entry.expected)
      ledger.record('host_kp_limits', error)
      expect(error).toBeLessThanOrEqual(TOLERANCE)
    }
  })
  test('closed-loop matrix and its spectral radius', () => {
    for (const entry of data.spectralRadius) {
      const matrix = closedLoopMatrix(entry.wn, entry.dampingRatio, entry.periodS, entry.delayS, entry.boardDamping)
      const matrixError = relativeError(matrix, entry.matrix)
      const radiusError = relativeError([linalg.spectralRadius(matrix)], [entry.expected])
      ledger.record('closed-loop matrix', matrixError)
      ledger.record('spectral radius (numpy eigvals)', radiusError)
      expect(matrixError).toBeLessThanOrEqual(TOLERANCE)
      expect(radiusError).toBeLessThanOrEqual(TOLERANCE)
    }
  })
})

afterAll(() => {
  console.log(`stability golden vectors (source ${data.source.package} @ ${data.source.commit}):\n${ledger.summary()}`)
})
