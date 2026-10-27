// contact_aware_friction (the latch and the re-keyed Coulomb feed-forward) matches the Python package tick by tick.
import { afterAll, describe, expect, test } from 'vitest'
import { type FrictionLatchState, type ImpedanceConfig, contactAwareFriction, initialFrictionLatch } from '../../site/.vitepress/theme/lib/impedance'
import { ErrorLedger, TOLERANCE, fixture, relativeError } from './golden'

const data = fixture('friction_cases.json')
const ledger = new ErrorLedger()

describe('contact_aware_friction matches the Python', () => {
  test(`${data.sequences.length} sequences of 14 host ticks (approach, contact, lift)`, () => {
    let latches = 0
    for (const sequence of data.sequences) {
      const config: ImpedanceConfig = {
        mode: 'host_spring',
        impedance: { stiffness: [3000, 3000, 500, 150, 150, 150] },
        joints: sequence.joints,
        host: sequence.host,
        frictionCompensation: 'contact_aware',
      }
      let state: FrictionLatchState = initialFrictionLatch()
      for (const tick of sequence.ticks) {
        const atReference = { position: tick.atReferencePosition, rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], jacobian: sequence.jacobian }
        const atMeasured = { position: tick.atMeasuredPosition, rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], jacobian: sequence.jacobian }
        const [torque, next] = contactAwareFriction(config, tick.reference, tick.measured, atReference, atMeasured, state)
        const error = relativeError(torque, tick.expectedTorque)
        ledger.record('contact_aware_friction torque', error)
        expect(error).toBeLessThanOrEqual(TOLERANCE)
        expect(next.latched).toBe(tick.expectedLatched)
        expect(relativeError(next.inwardSpeeds, tick.expectedSpeeds)).toBeLessThanOrEqual(TOLERANCE)
        latches += next.latched ? 1 : 0
        state = next
      }
    }
    expect(latches).toBeGreaterThan(0)
  })
})

afterAll(() => {
  console.log(`friction golden vectors (source ${data.source.package} @ ${data.source.commit}):\n${ledger.summary()}`)
})
