/**
 * `lib/impedance` - the browser port of `bam_impedance_controller` (Zach's Cartesian impedance stage after the joint
 * trajectory controller, on moteus QDD joints). Source of truth: the Python package in ~/bam_ws on lane
 * `claude/bam-impedance-controller` (src/core/mdp/agent/controllers/bam_impedance_controller); this is a port, not a
 * lookalike: `scripts/export_law_fixtures.py` runs the Python on random cases and `tests/unit/law.golden.test.ts` holds this
 * code to it at 1e-9 relative.
 *
 * Shared by the 2-link ArmLab (m = 2, n = 2) and the MuJoCo UR5e demo (m = 6, n = 6). Pure functions, no state, no DOM.
 *
 * ```ts
 * import { impedanceCommand, ImpedanceMode } from './lib/impedance'
 * const command = impedanceCommand(
 *   { mode: ImpedanceMode.HOST_SPRING, impedance: { stiffness: [3000, 300] }, joints, host: { periodS: 0.01, delayS: 0.007 } },
 *   { positions: qRef, velocities: qdRef, effort: gravity },   // the trajectory controller's point
 *   { positions: q, velocities: qd },                           // measured
 *   { position: toolRef, jacobian: jRef, massMatrix: mRef },    // kinematics at the reference
 *   { position: tool, jacobian: j, massMatrix: m },             // kinematics at the measurement (TORQUE, HOST_SPRING)
 * )
 * // per joint: command.kpScale, command.kdScale, command.feedforwardTorque (+ what it renders, the scale s, clamps)
 * ```
 *
 * Modules: `types` (contracts), `law` (impedanceCommand and its matrices), `stability` (host ceilings), `friction` (the
 * contact-aware Coulomb feed-forward), `linalg` (the small dense matrix ops they need).
 */

export * from './types'
export * from './law'
export * from './stability'
export * from './friction'
export * as linalg from './linalg'
