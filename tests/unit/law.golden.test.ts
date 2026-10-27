// The browser runs the SAME impedance law as the Python package: every case in tests/fixtures/law_cases.json was computed by
// bam_impedance_controller itself (scripts/export_law_fixtures.py, the lane venv) and the TypeScript port must match it to
// 1e-9 relative, field by field.
import { afterAll, describe, expect, test } from 'vitest'
import {
  type ImpedanceConfig,
  cartesianDamping,
  impedanceCommand,
  operationalSpaceInertia,
  poseError,
  realizedCartesianStiffness,
} from '../../site/.vitepress/theme/lib/impedance'
import { ErrorLedger, TOLERANCE, fixture, relativeError } from './golden'

const data = fixture('law_cases.json')
const ledger = new ErrorLedger()
const FIELDS = ['position', 'velocity', 'kpScale', 'kdScale', 'feedforwardTorque', 'renderedJointStiffness', 'renderedJointDamping', 'stiffnessScale'] as const

function runCase(group: string, entry: any) {
  const command = impedanceCommand(entry.config as ImpedanceConfig, entry.reference, entry.measured, entry.atReference, entry.atMeasured)
  for (const field of FIELDS) {
    const error = relativeError(command[field], entry.expected[field])
    ledger.record(`${group} ${entry.config.mode}`, error)
    expect(error, `${entry.name}.${field}`).toBeLessThanOrEqual(TOLERANCE)
  }
  expect(command.clamped, `${entry.name}.clamped`).toEqual(entry.expected.clamped)
  expect(command.mode).toBe(entry.expected.mode)
}

describe('impedanceCommand matches the Python law (6-D task)', () => {
  test(`${data.cases.length} cases, n = 6 / 7, every mode`, () => {
    expect(data.cases.length).toBe(200)
    for (const entry of data.cases) runCase('6-D', entry)
  })
})

describe('impedanceCommand matches the Python law (planar m = 2 task, embedded in the 6-D law)', () => {
  test(`${data.planar.length} planar cases, every mode`, () => {
    expect(data.planar.length).toBe(80)
    for (const entry of data.planar) {
      expect(entry.m).toBe(2)
      expect(entry.atReference.jacobian.length).toBe(2)
      runCase('planar', entry)
    }
  })
})

describe('the law\'s building blocks match', () => {
  test('pose_error (incl. angles near 0 and pi)', () => {
    for (const entry of data.helpers.poseError) {
      const error = relativeError(poseError(entry.positionD, entry.rotationD, entry.position, entry.rotation), entry.expected)
      ledger.record('pose_error', error)
      expect(error).toBeLessThanOrEqual(TOLERANCE)
    }
  })
  test('operational_space_inertia (incl. rank-deficient n = 5)', () => {
    for (const entry of data.helpers.operationalSpaceInertia) {
      const error = relativeError(operationalSpaceInertia(entry.sample), entry.expected)
      ledger.record('operational_space_inertia', error)
      expect(error).toBeLessThanOrEqual(TOLERANCE)
    }
  })
  test('cartesian_damping, INERTIA and UNIT_MASS', () => {
    for (const entry of data.helpers.cartesianDamping) {
      const error = relativeError(cartesianDamping(entry.impedance, entry.sample, entry.design, 6), entry.expected)
      ledger.record(`cartesian_damping ${entry.design}`, error)
      expect(error).toBeLessThanOrEqual(TOLERANCE)
    }
  })
  test('realized_cartesian_stiffness', () => {
    for (const entry of data.helpers.realizedCartesianStiffness) {
      const error = relativeError(realizedCartesianStiffness(entry.jointStiffness, entry.jacobian), entry.expected)
      ledger.record('realized_cartesian_stiffness', error)
      expect(error).toBeLessThanOrEqual(TOLERANCE)
    }
  })
})

describe('the law is stateless and a switch takes effect on the next tick', () => {
  test('same inputs, same output; mode switch changes the command', () => {
    const entry = data.planar.find((item: any) => item.config.mode === 'host_spring')
    const first = impedanceCommand(entry.config, entry.reference, entry.measured, entry.atReference, entry.atMeasured)
    const again = impedanceCommand(entry.config, entry.reference, entry.measured, entry.atReference, entry.atMeasured)
    expect(again).toEqual(first)
    const torque = impedanceCommand({ ...entry.config, mode: 'torque' }, entry.reference, entry.measured, entry.atReference, entry.atMeasured)
    expect(torque.kdScale.every((value: number) => value === 0)).toBe(true)
    expect(first.kdScale.some((value: number) => value > 0)).toBe(true)
  })
})

afterAll(() => {
  console.log(`law golden vectors (source ${data.source.package} @ ${data.source.commit}):\n${ledger.summary()}`)
})
