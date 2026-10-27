/**
 * A planar 2-link revolute arm in the vertical (x, z) plane, with real rigid-body dynamics: M(q), Coriolis / centrifugal
 * terms, gravity, rotor armature, joint Coulomb and viscous friction, and a belt surface the tool can be pressed into.
 *
 * Conventions: base at the origin, z up, gravity -z. q1 is link 1's angle from +x toward +z, q2 link 2's angle relative to
 * link 1 (the MJCF in scripts/export_law_fixtures.py: hinges about -y). The tool is a small mass at link 2's tip.
 *
 * Integration (one `step` of dt, semi-implicit Euler as MuJoCo's Euler integrator):
 *   (M + dt B) v' = M v + dt (tau + J^T F_contact - c(q, v) - g(q)) - dt f_c,   q' = q + dt v'
 * with the viscous damping B implicit and the Coulomb friction f_c a box constraint |f_c,i| <= c_i solved exactly for the two
 * joints (stick or slip, the KKT conditions of min 1/2 |v' - v*|^2_(M + dt B) + dt sum c_i |v'_i|) - the same model as
 * MuJoCo's frictionloss, without its softness.
 *
 * The belt: a Kelvin-Voigt spring-damper on the tool's penetration d = surfaceZ - z_tool, F_n = max(0, k d + b d'). NOTE the
 * Kelvin-Voigt touch jump: at first contact d = 0 but d' = the approach speed, so the force jumps from 0 to b v at once
 * (100 N at 0.5 m/s with b = 200 N.s/m) - part of why a fast approach peaks so much higher than a slow one. A Hunt-Crossley
 * contact (b scaled by d) would remove the jump. The belt is frictionless along x.
 *
 * Checked against MuJoCo 3.11 on the same arm (tests/unit/arm2d.mujoco.test.ts): free swing, dry-friction swing, pressed
 * contact.
 */

export interface ArmParams {
  l1: number
  l2: number
  m1: number
  lc1: number
  /** link 1's inertia about its centre of mass (kg.m^2, about the hinge axis) */
  i1: number
  m2: number
  lc2: number
  i2: number
  /** the suction tool at link 2's tip */
  toolMass: number
  toolInertia: number
  /** reflected rotor inertia per joint (kg.m^2): a 10:1 QDD's JMC-like rotor reflects ~1.83e-3 */
  armature: [number, number]
  /** viscous joint friction (N.m.s/rad) */
  viscous: [number, number]
  /** each joint's torque cap (N.m) */
  torqueCap: [number, number]
  /** dry friction as a fraction of the cap: BAM's Gen-1 10:1 JMC joints measured ~23 % */
  coulombFraction: number
  gravity: number
  /** the belt's Kelvin-Voigt stiffness (N/m) and damping (N.s/m): the assumed contact of the Python comparison */
  contactK: number
  contactB: number
}

/** A light QDD arm: 0.35 + 0.30 m, ~2 kg moving, 10:1 JMC-like rotors and friction. Mirrored in export_law_fixtures.py. */
export const DEFAULT_ARM: ArmParams = {
  l1: 0.35,
  l2: 0.3,
  m1: 1.2,
  lc1: 0.16,
  i1: 0.012,
  m2: 0.5,
  lc2: 0.13,
  i2: 0.004,
  toolMass: 0.25,
  toolInertia: 4e-5,
  armature: [1.83e-3, 1.83e-3],
  viscous: [0.03, 0.03],
  torqueCap: [20, 10],
  coulombFraction: 0.23,
  gravity: 9.81,
  contactK: 100000,
  contactB: 200,
}

export type Vec2 = [number, number]
export type Mat2 = [[number, number], [number, number]]

/** Link 2 and the tool lumped into one rigid body (the tool is welded to the tip). */
function lumped(p: ArmParams) {
  const mass = p.m2 + p.toolMass
  const com = (p.m2 * p.lc2 + p.toolMass * p.l2) / mass
  const inertia = p.i2 + p.m2 * (p.lc2 - com) ** 2 + p.toolInertia + p.toolMass * (p.l2 - com) ** 2
  return { mass, com, inertia }
}

export interface StepResult {
  /** the belt's normal force on the tool (N, +z) */
  contactForce: number
  /** the dry friction torque the joints felt this step (N.m, opposing motion) */
  frictionTorque: Vec2
  /** true when a joint is stuck */
  stuck: [boolean, boolean]
}

export class Arm2d {
  readonly params: ArmParams
  q: Vec2
  v: Vec2
  /** the dry friction per joint (N.m) */
  coulomb: Vec2
  /** belt surface height (m), or null for no belt */
  surfaceZ: number | null
  private readonly link2: { mass: number; com: number; inertia: number }

  constructor(params: ArmParams = DEFAULT_ARM, options: { q?: Vec2; v?: Vec2; coulomb?: Vec2; surfaceZ?: number | null } = {}) {
    this.params = params
    this.link2 = lumped(params)
    this.q = options.q ? [...options.q] : [0, 0]
    this.v = options.v ? [...options.v] : [0, 0]
    this.coulomb = options.coulomb ? [...options.coulomb] : [params.coulombFraction * params.torqueCap[0], params.coulombFraction * params.torqueCap[1]]
    this.surfaceZ = options.surfaceZ === undefined ? null : options.surfaceZ
  }

  massMatrix(q: Vec2 = this.q): Mat2 {
    const p = this.params
    const { mass, com, inertia } = this.link2
    const c2 = Math.cos(q[1])
    const m11 = p.i1 + p.m1 * p.lc1 * p.lc1 + inertia + mass * (p.l1 * p.l1 + com * com + 2 * p.l1 * com * c2) + p.armature[0]
    const m12 = inertia + mass * (com * com + p.l1 * com * c2)
    const m22 = inertia + mass * com * com + p.armature[1]
    return [
      [m11, m12],
      [m12, m22],
    ]
  }

  /** c(q, qd): the Coriolis and centrifugal torques */
  coriolis(q: Vec2 = this.q, v: Vec2 = this.v): Vec2 {
    const { mass, com } = this.link2
    const h = mass * this.params.l1 * com * Math.sin(q[1])
    return [-h * (2 * v[0] * v[1] + v[1] * v[1]), h * v[0] * v[0]]
  }

  /** g(q): the torque gravity asks of each joint (what a gravity feed-forward supplies) */
  gravityTorque(q: Vec2 = this.q): Vec2 {
    const p = this.params
    const { mass, com } = this.link2
    const c1 = Math.cos(q[0])
    const c12 = Math.cos(q[0] + q[1])
    return [(p.m1 * p.lc1 + mass * p.l1) * p.gravity * c1 + mass * com * p.gravity * c12, mass * com * p.gravity * c12]
  }

  tool(q: Vec2 = this.q): Vec2 {
    const p = this.params
    return [p.l1 * Math.cos(q[0]) + p.l2 * Math.cos(q[0] + q[1]), p.l1 * Math.sin(q[0]) + p.l2 * Math.sin(q[0] + q[1])]
  }

  elbow(q: Vec2 = this.q): Vec2 {
    return [this.params.l1 * Math.cos(q[0]), this.params.l1 * Math.sin(q[0])]
  }

  /** the tool's (x, z) Jacobian */
  jacobian(q: Vec2 = this.q): Mat2 {
    const p = this.params
    const s1 = Math.sin(q[0])
    const c1 = Math.cos(q[0])
    const s12 = Math.sin(q[0] + q[1])
    const c12 = Math.cos(q[0] + q[1])
    return [
      [-p.l1 * s1 - p.l2 * s12, -p.l2 * s12],
      [p.l1 * c1 + p.l2 * c12, p.l2 * c12],
    ]
  }

  toolVelocity(q: Vec2 = this.q, v: Vec2 = this.v): Vec2 {
    const j = this.jacobian(q)
    return [j[0][0] * v[0] + j[0][1] * v[1], j[1][0] * v[0] + j[1][1] * v[1]]
  }

  /** The belt's normal force at a state (N, +z). */
  contactForceAt(q: Vec2 = this.q, v: Vec2 = this.v): number {
    if (this.surfaceZ == null) return 0
    const penetration = this.surfaceZ - this.tool(q)[1]
    if (penetration <= 0) return 0
    const rate = -this.toolVelocity(q, v)[1]
    return Math.max(0, this.params.contactK * penetration + this.params.contactB * rate)
  }

  /**
   * Advance one step of `dt` under the joint torques `tau` (already capped by the boards) and an optional external force
   * on the tool (N, world x / z).
   */
  step(dt: number, tau: Vec2, external: Vec2 = [0, 0]): StepResult {
    const q = this.q
    const v = this.v
    const jacobian = this.jacobian(q)
    const contact = this.contactForceAt(q, v)
    const force: Vec2 = [external[0], external[1] + contact]
    const tauExternal: Vec2 = [jacobian[0][0] * force[0] + jacobian[1][0] * force[1], jacobian[0][1] * force[0] + jacobian[1][1] * force[1]]
    const mass = this.massMatrix(q)
    const bias = this.coriolis(q, v)
    const gravity = this.gravityTorque(q)
    const a: Mat2 = [
      [mass[0][0] + dt * this.params.viscous[0], mass[0][1]],
      [mass[1][0], mass[1][1] + dt * this.params.viscous[1]],
    ]
    const rhs: Vec2 = [
      mass[0][0] * v[0] + mass[0][1] * v[1] + dt * (tau[0] + tauExternal[0] - bias[0] - gravity[0]),
      mass[1][0] * v[0] + mass[1][1] * v[1] + dt * (tau[1] + tauExternal[1] - bias[1] - gravity[1]),
    ]
    const free = solve2(a, rhs)
    const bound: Vec2 = [dt * this.coulomb[0], dt * this.coulomb[1]]
    const next = coulombBox(a, free, bound)
    const dv: Vec2 = [free[0] - next[0], free[1] - next[1]]
    const frictionTorque: Vec2 = [-(a[0][0] * dv[0] + a[0][1] * dv[1]) / dt, -(a[1][0] * dv[0] + a[1][1] * dv[1]) / dt]
    this.v = next
    this.q = [q[0] + dt * next[0], q[1] + dt * next[1]]
    return { contactForce: contact, frictionTorque, stuck: [next[0] === 0 && this.coulomb[0] > 0, next[1] === 0 && this.coulomb[1] > 0] }
  }
}

export function solve2(a: Mat2, b: Vec2): Vec2 {
  const det = a[0][0] * a[1][1] - a[0][1] * a[1][0]
  return [(a[1][1] * b[0] - a[0][1] * b[1]) / det, (a[0][0] * b[1] - a[1][0] * b[0]) / det]
}

/**
 * argmin_v 1/2 (v - free)^T A (v - free) + sum bound_i |v_i| for two joints (A symmetric positive definite), exactly: the
 * unique point meeting the KKT conditions among the nine stick / slip patterns.
 */
export function coulombBox(a: Mat2, free: Vec2, bound: Vec2): Vec2 {
  if (bound[0] <= 0 && bound[1] <= 0) return [free[0], free[1]]
  // both stuck: the force needed to hold v = 0 fits inside both boxes
  const hold: Vec2 = [-(a[0][0] * free[0] + a[0][1] * free[1]), -(a[1][0] * free[0] + a[1][1] * free[1])]
  if (Math.abs(hold[0]) <= bound[0] && Math.abs(hold[1]) <= bound[1]) return [0, 0]
  // one slides, the other is stuck
  for (const [slide, stick] of [
    [0, 1],
    [1, 0],
  ] as const) {
    for (const sign of [1, -1]) {
      const vSlide = free[slide] + (a[slide][stick] * free[stick] - bound[slide] * sign) / a[slide][slide]
      if (Math.sign(vSlide) !== sign) continue
      const residual = a[stick][slide] * (vSlide - free[slide]) + a[stick][stick] * (0 - free[stick])
      if (Math.abs(residual) <= bound[stick]) {
        const out: Vec2 = [0, 0]
        out[slide] = vSlide
        return out
      }
    }
  }
  // both slide
  for (const s0 of [1, -1])
    for (const s1 of [1, -1]) {
      const shift = solve2(a, [bound[0] * s0, bound[1] * s1])
      const candidate: Vec2 = [free[0] - shift[0], free[1] - shift[1]]
      if (Math.sign(candidate[0]) === s0 && Math.sign(candidate[1]) === s1) return candidate
    }
  // a tie on a boundary (measure zero): projected Gauss-Seidel settles it
  const out: Vec2 = [free[0], free[1]]
  for (let iteration = 0; iteration < 500; iteration++) {
    for (const i of [0, 1]) {
      const j = 1 - i
      const target = free[i] - (a[i][j] * (out[j] - free[j])) / a[i][i]
      const threshold = bound[i] / a[i][i]
      out[i] = target > threshold ? target - threshold : target < -threshold ? target + threshold : 0
    }
  }
  return out
}

/** Elbow-up inverse kinematics (q2 <= 0), the target pulled inside the reachable annulus. */
export function inverseKinematics(params: ArmParams, x: number, z: number): Vec2 {
  const reach = params.l1 + params.l2
  const inner = Math.abs(params.l1 - params.l2)
  let distance = Math.hypot(x, z)
  let px = x
  let pz = z
  const max = 0.995 * reach
  const min = inner + 0.02
  if (distance > max || distance < min) {
    const clamped = Math.min(max, Math.max(min, distance))
    const scale = distance > 1e-9 ? clamped / distance : 0
    px = distance > 1e-9 ? x * scale : clamped
    pz = distance > 1e-9 ? z * scale : 0
    distance = clamped
  }
  const cosine = (px * px + pz * pz - params.l1 * params.l1 - params.l2 * params.l2) / (2 * params.l1 * params.l2)
  const q2 = -Math.acos(Math.max(-1, Math.min(1, cosine)))
  const q1 = Math.atan2(pz, px) - Math.atan2(params.l2 * Math.sin(q2), params.l1 + params.l2 * Math.cos(q2))
  return [q1, q2]
}

/** The point the IK actually reaches for (x, z): the target pulled inside the reachable annulus. */
export function reachable(params: ArmParams, x: number, z: number): Vec2 {
  const q = inverseKinematics(params, x, z)
  return [params.l1 * Math.cos(q[0]) + params.l2 * Math.cos(q[0] + q[1]), params.l1 * Math.sin(q[0]) + params.l2 * Math.sin(q[0] + q[1])]
}
