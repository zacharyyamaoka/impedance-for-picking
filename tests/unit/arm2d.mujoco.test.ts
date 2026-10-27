// The ArmLab's physics against MuJoCo: the same 2-link arm (an MJCF built from the same parameters) run in MuJoCo 3.11 at
// 100 kHz by scripts/export_law_fixtures.py, and here by lib/arm2d at the demo's 8 kHz. The joint torque law and the belt's
// Kelvin-Voigt force are the same definitions on both sides (MuJoCo gets them through qfrc_applied), so what is checked is
// the arm itself: M(q), Coriolis, gravity, armature, viscous and dry friction, and the contact force's mapping through J^T.
import { afterAll, describe, expect, test } from 'vitest'
import { Arm2d, DEFAULT_ARM, type Vec2 } from '../../site/.vitepress/theme/lib/arm2d/model'
import { fixture } from './golden'

const data = fixture('arm2d_mujoco.json')
const PHYSICS_HZ = 8000
const results: string[] = []

/**
 * Tolerances, stated (the measured errors print in the summary). WHY these sizes: the TS integrates at 8 kHz, MuJoCo at
 * 100 kHz, so a first-order integrator's O(dt) drift is the floor (measured 0.4 mm over a 1.15 m free swing); the belt's
 * 100 kN/m contact rings at ~70 Hz, so the impact transient sampled every 1 ms differs by a fraction of a step (bounded at 4 %
 * of the peak); the dry-friction cases add MuJoCo's soft frictionloss (a constraint with a 0.1 ms time constant here, which
 * creeps) against the TS's exact stick / slip, hence the looser final-force bound with Coulomb.
 */
const TOLERANCE = {
  free_swing: { q: 2e-3, toolMm: 1, peakRel: 0, transientRel: 0, finalN: 0 },
  free_swing_coulomb: { q: 2e-3, toolMm: 1, peakRel: 0, transientRel: 0, finalN: 0 },
  pressed_contact: { q: 2e-3, toolMm: 1, peakRel: 0.03, transientRel: 0.04, finalN: 0.5 },
  pressed_contact_coulomb: { q: 2e-3, toolMm: 1, peakRel: 0.03, transientRel: 0.04, finalN: 1.5 },
} as const

function simulate(entry: any) {
  const arm = new Arm2d(DEFAULT_ARM, { q: entry.q0 as Vec2, v: entry.v0 as Vec2, coulomb: entry.coulomb as Vec2, surfaceZ: entry.surfaceZ ?? null })
  const dt = 1 / PHYSICS_HZ
  const every = Math.round(1e-3 / dt)
  const steps = Math.round(entry.durationS / dt)
  const out = { q: [] as Vec2[], tool: [] as Vec2[], force: [] as number[] }
  for (let step = 0; step <= steps; step++) {
    if (step % every === 0) {
      out.q.push([...arm.q])
      out.tool.push(arm.tool())
      out.force.push(arm.contactForceAt())
    }
    if (step === steps) break
    let tau: Vec2 = [0, 0]
    if (entry.pd) {
      const caps = DEFAULT_ARM.torqueCap
      tau = [0, 1].map((i) => {
        const value = entry.pd.kp[i] * (entry.pd.target[i] - arm.q[i]) - entry.pd.kd[i] * arm.v[i] + entry.pd.ff[i]
        return Math.max(-caps[i], Math.min(caps[i], value))
      }) as Vec2
    }
    arm.step(dt, tau)
  }
  return out
}

describe('the demo arm is the arm the MuJoCo fixture was built from', () => {
  test('parameters', () => {
    expect(data.arm).toEqual(DEFAULT_ARM)
  })
})

describe('lib/arm2d (8 kHz) against MuJoCo (100 kHz)', () => {
  for (const entry of data.cases) {
    test(entry.name, () => {
      const ours = simulate(entry)
      const theirs = entry.mujoco
      expect(ours.q.length).toBe(theirs.q.length)
      let qError = 0
      let toolError = 0
      let forceError = 0
      let peakOurs = 0
      let peakTheirs = 0
      let travel = 0
      for (let i = 0; i < theirs.q.length; i++) {
        qError = Math.max(qError, Math.abs(ours.q[i][0] - theirs.q[i][0]), Math.abs(ours.q[i][1] - theirs.q[i][1]))
        toolError = Math.max(toolError, Math.hypot(ours.tool[i][0] - theirs.tip[i][0], ours.tool[i][1] - theirs.tip[i][1]))
        forceError = Math.max(forceError, Math.abs(ours.force[i] - theirs.contactForce[i]))
        peakOurs = Math.max(peakOurs, ours.force[i])
        peakTheirs = Math.max(peakTheirs, theirs.contactForce[i])
        travel = Math.max(travel, Math.hypot(theirs.tip[i][0] - theirs.tip[0][0], theirs.tip[i][1] - theirs.tip[0][1]))
      }
      const last = theirs.q.length - 1
      const finalForce = `${ours.force[last].toFixed(2)} vs ${theirs.contactForce[last].toFixed(2)} N`
      results.push(
        `${entry.name}: ${entry.durationS} s, tool travel ${(travel * 1e3).toFixed(0)} mm; max |q - q_mj| ${qError.toExponential(2)} rad, ` +
          `max tool error ${(toolError * 1e3).toFixed(3)} mm` +
          (entry.surfaceZ != null ? `, max contact-force error ${forceError.toFixed(2)} N (peak ${peakOurs.toFixed(1)} vs ${peakTheirs.toFixed(1)} N, final ${finalForce})` : ''),
      )
      const tolerance = TOLERANCE[entry.name as keyof typeof TOLERANCE]
      expect(travel).toBeGreaterThan(0.01) // the case actually moves
      expect(qError).toBeLessThanOrEqual(tolerance.q)
      expect(toolError * 1e3).toBeLessThanOrEqual(tolerance.toolMm)
      if (entry.surfaceZ != null) {
        expect(peakTheirs).toBeGreaterThan(5) // the case actually presses
        expect(Math.abs(peakOurs - peakTheirs) / peakTheirs).toBeLessThanOrEqual(tolerance.peakRel)
        expect(forceError / peakTheirs).toBeLessThanOrEqual(tolerance.transientRel)
        expect(Math.abs(ours.force[last] - theirs.contactForce[last])).toBeLessThanOrEqual(tolerance.finalN)
      }
    })
  }
})

afterAll(() => {
  console.log(`arm2d vs MuJoCo ${data.mujocoVersion} (fixture dt ${data.mujocoDtS} s, ours 1/${PHYSICS_HZ} s):\n${results.join('\n')}`)
})
