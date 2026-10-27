// `MujocoKinematics` (sim/mujoco_kinematics.py) on the MuJoCo WASM bindings: the tool pose, the 6 x n world Jacobian (mj_jacSite,
// linear rows first) and the joint-space mass matrix (mj_fullM) of the NOMINAL model - what the controller believes - each sample on
// this instance's own MjData, so the simulated robot's state is never touched.

import type { MainModule, MjData, MjModel } from '@mujoco/mujoco'
import type { KinematicsSample, Mat } from '../impedance'

type Buffer = { GetView(): Float64Array; delete(): void }

export class MujocoKinematics {
  readonly model: MjModel
  readonly data: MjData
  readonly qposIndex: number[]
  readonly dofIndex: number[]
  private readonly mujoco: MainModule
  private readonly siteId: number
  private readonly linear: Buffer
  private readonly angular: Buffer
  private readonly mass: Buffer
  private readonly nv: number

  constructor(mujoco: MainModule, model: MjModel, siteName: string, jointNames: string[]) {
    this.mujoco = mujoco
    this.model = model
    this.data = new mujoco.MjData(model)
    this.nv = model.nv
    this.siteId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, siteName)
    if (this.siteId < 0) throw new Error(`no site ${siteName} in the model`)
    const ids = jointNames.map((name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name))
    if (ids.some((id) => id < 0)) throw new Error(`joints missing from the model: ${jointNames.filter((_, i) => ids[i] < 0)}`)
    const qposadr = model.jnt_qposadr
    const dofadr = model.jnt_dofadr
    this.qposIndex = ids.map((id) => qposadr[id])
    this.dofIndex = ids.map((id) => dofadr[id])
    this.linear = new mujoco.DoubleBuffer(3 * this.nv) as unknown as Buffer
    this.angular = new mujoco.DoubleBuffer(3 * this.nv) as unknown as Buffer
    this.mass = new mujoco.DoubleBuffer(this.nv * this.nv) as unknown as Buffer
  }

  private place(q: ArrayLike<number>) {
    const qpos = this.data.qpos as Float64Array
    for (let i = 0; i < this.qposIndex.length; i++) qpos[this.qposIndex[i]] = q[i]
  }

  /** (position, rotation, jacobian) without the mass matrix: the IK and the divergence check need no more. */
  poseJacobian(q: ArrayLike<number>): { position: number[]; rotation: Mat; jacobian: Mat } {
    const { mujoco, model, data } = this
    this.place(q)
    mujoco.mj_kinematics(model, data)
    mujoco.mj_comPos(model, data)
    mujoco.mj_jacSite(model, data, this.linear, this.angular, this.siteId)
    return { ...this.pose(), jacobian: this.jacobian() }
  }

  /** WHY these stages, not mj_forward (as the Python): kinematics + com frames for the Jacobian, the composite rigid-body pass for M. */
  sample(q: ArrayLike<number>): KinematicsSample {
    const { mujoco, model, data } = this
    this.place(q)
    mujoco.mj_kinematics(model, data)
    mujoco.mj_comPos(model, data)
    mujoco.mj_crb(model, data)
    mujoco.mj_jacSite(model, data, this.linear, this.angular, this.siteId)
    mujoco.mj_fullM(model, data, this.mass)
    const full = this.mass.GetView()
    const nv = this.nv
    const massMatrix = this.dofIndex.map((row) => this.dofIndex.map((col) => full[row * nv + col]))
    return { ...this.pose(), jacobian: this.jacobian(), massMatrix }
  }

  private pose(): { position: number[]; rotation: Mat } {
    const xpos = this.data.site_xpos as Float64Array
    const xmat = this.data.site_xmat as Float64Array
    const s = this.siteId
    const m = xmat.subarray(9 * s, 9 * s + 9)
    return {
      position: [xpos[3 * s], xpos[3 * s + 1], xpos[3 * s + 2]],
      rotation: [
        [m[0], m[1], m[2]],
        [m[3], m[4], m[5]],
        [m[6], m[7], m[8]],
      ],
    }
  }

  private jacobian(): Mat {
    const linear = this.linear.GetView()
    const angular = this.angular.GetView()
    const nv = this.nv
    const rows: Mat = []
    for (let r = 0; r < 3; r++) rows.push(this.dofIndex.map((dof) => linear[r * nv + dof]))
    for (let r = 0; r < 3; r++) rows.push(this.dofIndex.map((dof) => angular[r * nv + dof]))
    return rows
  }

  delete() {
    this.linear.delete()
    this.angular.delete()
    this.mass.delete()
    this.data.delete()
  }
}
