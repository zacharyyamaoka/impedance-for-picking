// The ArmLab's closed loop, headless: what the demo is meant to show has to be true of the simulation itself.
import { describe, expect, test } from 'vitest'
import { HOME_TARGET, Lab, PRESETS, SURFACE_Z } from '../../site/.vitepress/theme/lib/arm2d/lab'
import { hostWnCeiling } from '../../site/.vitepress/theme/lib/impedance'

const HIGH_K = { kx: 5000, kz: 5000, zeta: 1, hostRateHz: 100, delayMs: 7, hostGuard: false }

describe('the delayed damper is what goes unstable (100 Hz / 7 ms, K = 5000 N/m)', () => {
  test('TORQUE oscillates and is flagged; HOST_SPRING holds and is not', () => {
    const torque = new Lab({ ...HIGH_K, mode: 'torque' })
    const hostSpring = new Lab({ ...HIGH_K, mode: 'host_spring' })
    // WHY a step of the target: the arm starts at rest on its reference and the joints' dry friction holds a still arm, so the
    // loop needs a disturbance to show its (in)stability - the demo's drag does the same
    for (const lab of [torque, hostSpring]) {
      lab.advance(0.5)
      lab.setTarget(HOME_TARGET[0] - 0.06, HOME_TARGET[1] + 0.04)
      lab.advance(2.5)
    }
    const a = torque.snapshot()
    const b = hostSpring.snapshot()
    console.log(`torque: ripple ${a.ripple.toFixed(3)} m/s, ceiling ${a.ceiling.wnCeiling?.toFixed(1)} rad/s, joint wn ${a.ceiling.jointWn.map((x) => x.toFixed(1))}`)
    console.log(`host_spring: ripple ${b.ripple.toFixed(4)} m/s, ceiling ${b.ceiling.wnCeiling?.toFixed(1)} rad/s, joint wn ${b.ceiling.jointWn.map((x) => x.toFixed(1))}, s ${b.stiffnessScale.toFixed(3)}`)
    expect(a.ceiling.status).toBe('unstable')
    expect(a.ripple).toBeGreaterThan(0.1)
    expect(b.ceiling.status).toBe('ok')
    expect(b.ripple).toBeLessThan(0.01)
    expect(a.ceiling.wnCeiling).toBeCloseTo(hostWnCeiling(0.01, 0.007, 1, false), 9)
  })
  test('the host guard (host_kp_max = ceiling / 2) softens TORQUE until it holds', () => {
    const guarded = new Lab({ ...HIGH_K, mode: 'torque', hostGuard: true })
    guarded.advance(0.5)
    guarded.setTarget(HOME_TARGET[0] - 0.06, HOME_TARGET[1] + 0.04)
    guarded.advance(2.5)
    const snapshot = guarded.snapshot()
    console.log(`torque + guard: s ${snapshot.stiffnessScale.toFixed(3)}, ripple ${snapshot.ripple.toFixed(4)} m/s`)
    expect(snapshot.stiffnessScale).toBeLessThan(1)
    expect(snapshot.ripple).toBeLessThan(0.01)
  })
})

describe('pressing into the belt', () => {
  test('frictionless joints: the dwell force is the z spring times the depth', () => {
    const lab = new Lab({ mode: 'host_spring', kx: 3000, kz: 600, jointFriction: 'none', frictionFeedforward: 'off' })
    lab.setTarget(HOME_TARGET[0], SURFACE_Z - 0.03)
    lab.advance(3)
    const snapshot = lab.snapshot()
    console.log(`press 3 cm at 600 N/m: ${snapshot.contactForce.toFixed(2)} N (spring alone: 18 N)`)
    expect(snapshot.contactForce).toBeGreaterThan(15)
    expect(snapshot.contactForce).toBeLessThan(21)
  })
  test('the stiff joint PD presses far harder than the soft z spring', () => {
    const stiff = new Lab({ mode: 'stiff', jointFriction: 'none', frictionFeedforward: 'off' })
    stiff.setTarget(HOME_TARGET[0], SURFACE_Z - 0.03)
    stiff.advance(3)
    const force = stiff.snapshot().contactForce
    console.log(`stiff joint PD, 3 cm: ${force.toFixed(1)} N`)
    expect(force).toBeGreaterThan(1.5 * 18) // 1.5x what the 600 N/m z spring asks for at 3 cm
  })
  test('fast approach peaks higher than slow (preset)', () => {
    const lab = new Lab()
    lab.runPreset(PRESETS.find((preset) => preset.id === 'approach')!)
    lab.advance(5.5)
    const [fast, slow] = lab.marks
    console.log(`approach: fast peak ${fast.peak.toFixed(1)} N, slow peak ${slow.peak.toFixed(1)} N`)
    expect(fast.peak).toBeGreaterThan(1.5 * slow.peak)
  })
})

describe('a mode switch moves the torque between board and host', () => {
  test('stiff: the board PD carries it; torque: the host does', () => {
    const lab = new Lab({ mode: 'stiff', jointFriction: 'none', frictionFeedforward: 'off' })
    lab.setTarget(HOME_TARGET[0], SURFACE_Z - 0.03)
    lab.advance(2)
    lab.snapshot()
    lab.advance(0.1)
    const stiff = lab.snapshot().torque
    lab.update({ mode: 'torque', kx: 1500, kz: 600 })
    lab.advance(1)
    lab.snapshot()
    lab.advance(0.1)
    const torque = lab.snapshot().torque
    console.log(`stiff: pd ${stiff.map((j) => j.boardPd.toFixed(2))} host ${stiff.map((j) => j.hostFf.toFixed(2))}; torque: pd ${torque.map((j) => j.boardPd.toFixed(2))} host ${torque.map((j) => j.hostFf.toFixed(2))}`)
    expect(Math.abs(stiff[0].boardPd)).toBeGreaterThan(1)
    expect(stiff.every((joint) => joint.hostFf === 0)).toBe(true)
    expect(torque.every((joint) => joint.boardPd === 0)).toBe(true)
    expect(Math.abs(torque[0].hostFf) + Math.abs(torque[1].hostFf)).toBeGreaterThan(1)
  })
})

describe('a preset that starts pressed does not start inside the belt', () => {
  test('sideways push: no reset spike', () => {
    const lab = new Lab({ mode: 'joint' })
    lab.runPreset(PRESETS.find((preset) => preset.id === 'push')!)
    let peak = 0
    for (let i = 0; i < 80; i++) {
      lab.advance(0.01)
      peak = Math.max(peak, lab.snapshot().contactForce)
    }
    console.log(`push preset, first 0.8 s: peak ${peak.toFixed(1)} N`)
    expect(peak).toBeLessThan(150)
  })
})
