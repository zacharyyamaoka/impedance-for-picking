// The live demo's loop held to the Python. `<LivePick />` runs lib/livepick/sim.ts in a Web Worker; this runs the SAME module, on
// the SAME @mujoco/mujoco 3.15 WASM build, headlessly in Node, against scripts/export_livepick.py's reference runs (pick.run_case
// at the browser's 4 kHz, MuJoCo 3.11 in Python):
// - the trajectory controller's grid (the browser's own IK + Hermite + mj_inverse) against the Python's;
// - the contact calibration: the browser's efc_R at the first touch against the Python's;
// - every stable reference run: the impact peak and the dwell mean within TOLERANCE (2 % over a 0.5 N floor - the Python study's own
//   convergence rule, pick.CONVERGENCE_TOLERANCE / CONVERGENCE_FLOOR_N);
// - the unguarded high-K pair: TORQUE limit-cycles at its torque caps in both, HOST_SPRING stays off them in both.
// The measured errors are printed per run; the page's info note states the tolerance and the worst error (0.39 %, 2026-10-27).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { MainModule } from '@mujoco/mujoco'
import loadMujoco from '@mujoco/mujoco'
import { type LiveConfig, type ReferenceFile, planFor, referenceParams } from '../../site/.vitepress/theme/lib/livepick/config'
import { MujocoKinematics } from '../../site/.vitepress/theme/lib/livepick/kinematics'
import { ikArrays, jointGrid } from '../../site/.vitepress/theme/lib/livepick/path'
import { type ModelTexts, PickSim } from '../../site/.vitepress/theme/lib/livepick/sim'

const PUBLIC = new URL('../../site/public/', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, PUBLIC)), 'utf8')
const config: LiveConfig = JSON.parse(read('data/livepick-config.json'))
const reference: ReferenceFile = JSON.parse(read('data/livepick-reference.json'))
const texts: ModelTexts = {}
for (const build of Object.values(config.builds)) for (const path of Object.values(build.models)) texts[path] = read(path)

export const TOLERANCE = 0.02
export const FLOOR_N = 0.5
const relative = (value: number, expected: number) => Math.abs(value - expected) / Math.max(Math.abs(expected), FLOOR_N)

let mujoco: MainModule

beforeAll(async () => {
  const wasm = fileURLToPath(new URL('../../node_modules/@mujoco/mujoco/mujoco.wasm', import.meta.url))
  mujoco = (await loadMujoco({ locateFile: () => wasm })) as MainModule
})

describe('the reference path', () => {
  for (const golden of reference.paths) {
    it(`matches the Python grid: ${golden.build}, approach ${golden.approach_m_s ?? 'single speed'}, ${golden.host_rate_hz} Hz`, () => {
      const build = config.builds[golden.build]
      const nominal = mujoco.MjModel.from_xml_string(texts[build.models.nominal])
      const kinematics = new MujocoKinematics(mujoco, nominal, config.sites.tcp, config.joints)
      const armature = nominal.dof_armature as Float64Array
      kinematics.dofIndex.forEach((dof, i) => (armature[dof] = build.armature_nominal[i]))
      const plan = planFor(config.plan, golden.approach_m_s ?? config.plan.descent_speed_m_s)
      const settings = { tolerance: config.path.ik_tolerance, damping: config.path.ik_damping, iterations: config.path.ik_iterations }
      const path = ikArrays(kinematics, plan, config.belt.surface_z, config.home_seed, config.path.rotation, config.path.fine_dt, settings, config.path.ik_stride)
      const grid = jointGrid(mujoco, nominal, kinematics.qposIndex, kinematics.dofIndex, path, 1 / golden.host_rate_hz, config.path.fine_dt, build.coulomb_nm,
        config.path.coulomb_band_rad_s)
      expect(grid.samples).toBe(golden.rows)
      let qError = 0
      let tauError = 0
      let tauScale = 0
      golden.q.forEach((row, k) => {
        const sample = k * golden.stride
        row.forEach((value, j) => {
          qError = Math.max(qError, Math.abs(grid.q[sample * 6 + j] - value))
          const tau = grid.inverse[sample * 6 + j] + (golden.coulomb_feedforward ? grid.coulomb[sample * 6 + j] : 0)
          tauError = Math.max(tauError, Math.abs(tau - golden.tau_ff[k][j]))
          tauScale = Math.max(tauScale, Math.abs(golden.tau_ff[k][j]))
        })
      })
      console.log(`path ${golden.build}/${golden.host_rate_hz} Hz: max |q - q_py| ${qError.toExponential(2)} rad, max |tau_ff - py| ${tauError.toExponential(2)} N.m (of ${tauScale.toFixed(1)})`)
      expect(qError).toBeLessThan(1e-8)
      expect(tauError / tauScale).toBeLessThan(1e-6)
      kinematics.delete()
      nominal.delete()
    })
  }
})

describe('the live loop against pick.run_case', () => {
  const stable = reference.runs.filter((run) => run.guard !== false)
  const rows: string[] = []
  for (const run of stable) {
    it(`${run.id}: impact peak and dwell mean within ${100 * TOLERANCE} %`, () => {
      const { scene, live } = referenceParams(run)
      const sim = new PickSim(mujoco, config, texts, scene, live)
      let regularizer: number | null = null
      while (sim.step()) if (regularizer === null && sim.contactSeen) regularizer = sim.contactRegularizer()
      const metrics = sim.metrics()
      const expected = run.metrics
      const peakError = relative(metrics.impactPeakN, expected.impact_peak_fz_n as number)
      const dwellError = relative(metrics.dwellMeanN ?? 0, expected.dwell_fz_mean_n as number)
      const calibration = config.builds[scene.build].calibration[scene.compensator ? 'comp' : 'bare']
      const row = `${run.id.padEnd(36)} impact ${metrics.impactPeakN.toFixed(2).padStart(7)} vs ${(expected.impact_peak_fz_n as number).toFixed(2).padStart(7)} N (${(100 * peakError).toFixed(3)} %)  dwell ${(metrics.dwellMeanN ?? 0).toFixed(3).padStart(7)} vs ${(expected.dwell_fz_mean_n as number).toFixed(3).padStart(7)} N (${(100 * dwellError).toFixed(3)} %)  touch ${metrics.firstTouchS?.toFixed(5)} vs ${(expected.first_touch_s as number).toFixed(5)} s  efc_R ${regularizer?.toFixed(4)} vs ${calibration.efc_R.toFixed(4)}`
      rows.push(row)
      console.log(row)
      expect(metrics.diverged).toBe(false)
      expect(regularizer).not.toBeNull()
      expect(Math.abs(regularizer! - calibration.efc_R) / calibration.efc_R).toBeLessThan(1e-6)
      expect(peakError).toBeLessThan(TOLERANCE)
      expect(dwellError).toBeLessThan(TOLERANCE)
      sim.dispose()
    })
  }

  it('TORQUE at high K with the host ceiling off limit-cycles at its caps; HOST_SPRING does not (as in the Python)', () => {
    for (const run of reference.runs.filter((entry) => entry.guard === false)) {
      const { scene, live } = referenceParams(run)
      const sim = new PickSim(mujoco, config, texts, scene, live)
      while (sim.step());
      const metrics = sim.metrics()
      const expected = run.metrics.saturation as number
      console.log(`${run.id.padEnd(36)} saturation ${metrics.saturation.toFixed(3)} vs ${expected.toFixed(3)}, impact ${metrics.impactPeakN.toFixed(1)} vs ${(run.metrics.impact_peak_fz_n as number).toFixed(1)} N`)
      if (live.controller === 'torque') expect(metrics.saturation).toBeGreaterThan(0.05)
      else expect(metrics.saturation).toBe(0)
      expect(expected > 0.05).toBe(live.controller === 'torque')
      sim.dispose()
    }
  })
})
