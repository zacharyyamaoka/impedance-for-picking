// A MuJoCo model replayed in the browser: kinematics only (mj_kinematics on recorded qpos, never mj_step), drawn by three.js into
// N side-by-side panes on one canvas (scissored, as pidtuna-website's lib/scene.ts does). Used by the conveyor-pick replays and the
// hand replays. Client-only: imported dynamically from onMounted.
//
// WHY its own small class and not lib/scene.ts's ReplayScene: that one fits the camera to the whole robot and tints links by joint
// error in mrad; a pick is read at the tip, side on, with the contact force on it - a 3 m belt would set scene.ts's framing.

import * as THREE from 'three'
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco'
import { parseColor } from './scene'

export interface ReplayLook {
  bg: string
  arm: string
  tool: string
  belt: string
  stripe: string
  tip: string
  hot: string // the tip at HOT_N and above
  ghost: string // the reference marker
  arrow: string
}

export interface ReplayView {
  /** a site the camera's look-at point follows on the axes given (e.g. the tcp along x as the belt carries it) */
  follow?: string
  /** or a body by name, or 'deepest' (the body furthest down the kinematic tree, e.g. a fingertip) when the model has no such site */
  followBody?: string
  followAxes?: [boolean, boolean, boolean]
  lookat: [number, number, number]
  azimuth: number // degrees, MuJoCo's free-camera convention
  elevation: number
  distance: number
  fovy?: number
}

export interface PaneRect {
  x: number
  y: number
  w: number
  h: number
}

const GEOM_PLANE = 0
const GEOM_SPHERE = 2
const GEOM_CAPSULE = 3
const GEOM_ELLIPSOID = 4
const GEOM_CYLINDER = 5
const GEOM_BOX = 6
const HOT_N = 120 // N: the tip is fully "hot" from here
const ARROW_M_PER_N = 0.001 // the drawn load arrow: 100 N is 10 cm (as the hero video draws it)

type Role = 'arm' | 'tool' | 'tip' | 'belt' | 'stripe' | 'model'

interface Item {
  geom: number
  role: Role
  geometry: THREE.BufferGeometry
  rgba: [number, number, number, number]
}

interface Pane {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  headlight: THREE.DirectionalLight
  meshes: THREE.Mesh[]
  data: MjData
  arrow: THREE.ArrowHelper
  marker: THREE.Mesh
  lookat: THREE.Vector3
  force: number
}

function geometryFor(type: number, size: number[]): THREE.BufferGeometry | null {
  // three's round primitives run along +Y; MuJoCo's along local +Z
  switch (type) {
    case GEOM_SPHERE:
      return new THREE.SphereGeometry(size[0], 24, 16)
    case GEOM_ELLIPSOID:
      return new THREE.SphereGeometry(1, 24, 16).scale(size[0], size[1], size[2])
    case GEOM_CAPSULE:
      return new THREE.CapsuleGeometry(size[0], 2 * size[1], 8, 20).rotateX(Math.PI / 2)
    case GEOM_CYLINDER:
      return new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 28).rotateX(Math.PI / 2)
    case GEOM_BOX:
      return new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2])
    default:
      return null
  }
}

export class MjReplay {
  readonly renderer: THREE.WebGLRenderer
  private readonly canvas: HTMLCanvasElement
  private mujoco: MainModule | null = null
  private model: MjModel | null = null
  private items: Item[] = []
  private panes: Pane[] = []
  private rects: PaneRect[] = []
  private width = 1
  private height = 1
  private view: ReplayView | null = null
  private followSite = -1
  private followBody = -1
  private qposAdr = new Map<string, number>()
  private look: ReplayLook | null = null
  private colors = { tip: new THREE.Color(), hot: new THREE.Color(), bg: new THREE.Color() }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.autoClear = false
    this.renderer.setScissorTest(true)
  }

  load(mujoco: MainModule, xml: string, paneCount: number, view: ReplayView) {
    this.unload()
    this.mujoco = mujoco
    this.view = view
    const model = mujoco.MjModel.from_xml_string(xml)
    this.model = model
    const datas: MjData[] = []
    for (let i = 0; i < paneCount; i++) datas.push(new mujoco.MjData(model))
    // Read model arrays only after every MjData exists: heap growth detaches earlier views (lib/scene.ts's lesson)
    const name = (kind: number, id: number) => mujoco.mj_id2name(model, kind, id) ?? ''
    const jointObj = mujoco.mjtObj.mjOBJ_JOINT.value
    const geomObj = mujoco.mjtObj.mjOBJ_GEOM.value
    const bodyObj = mujoco.mjtObj.mjOBJ_BODY.value
    const siteObj = mujoco.mjtObj.mjOBJ_SITE.value
    const qposadr = model.jnt_qposadr
    for (let j = 0; j < model.njnt; j++) this.qposAdr.set(name(jointObj, j), qposadr[j])
    this.followSite = view.follow ? mujoco.mj_name2id(model, siteObj, view.follow) : -1
    this.followBody = -1
    if (this.followSite < 0 && view.followBody) {
      if (view.followBody === 'deepest') {
        const parent = model.body_parentid
        let best = -1
        let bestDepth = -1
        for (let b = 1; b < model.nbody; b++) {
          let depth = 0
          for (let a = b; a > 0; a = parent[a]) depth++
          if (depth > bestDepth) [best, bestDepth] = [b, depth]
        }
        this.followBody = best
      } else {
        this.followBody = mujoco.mj_name2id(model, bodyObj, view.followBody)
      }
    }

    const types = model.geom_type
    const sizes = model.geom_size
    const groups = model.geom_group
    const bodies = model.geom_bodyid
    const rgba = model.geom_rgba
    for (let g = 0; g < model.ngeom; g++) {
      if (types[g] === GEOM_PLANE) continue
      const geometry = geometryFor(types[g], [sizes[3 * g], sizes[3 * g + 1], sizes[3 * g + 2]])
      if (!geometry) continue
      const geomName = name(geomObj, g)
      const bodyName = name(bodyObj, bodies[g])
      let role: Role = 'model'
      if (groups[g] === 3) role = 'arm'
      else if (geomName === 'tip_contact') role = 'tip'
      else if (geomName === 'tool_housing') role = 'tool'
      else if (geomName === 'belt_surface') role = 'belt'
      else if (bodyName === 'belt') role = 'stripe'
      this.items.push({ geom: g, role, geometry, rgba: [rgba[4 * g], rgba[4 * g + 1], rgba[4 * g + 2], rgba[4 * g + 3]] })
    }

    for (const data of datas) {
      const scene = new THREE.Scene()
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.6))
      const headlight = new THREE.DirectionalLight(0xffffff, 1.6)
      scene.add(headlight, headlight.target)
      const meshes = this.items.map((item) => {
        const material = new THREE.MeshStandardMaterial({ roughness: item.role === 'belt' ? 0.9 : 0.5, metalness: item.role === 'arm' ? 0.25 : 0.05 })
        const mesh = new THREE.Mesh(item.geometry, material)
        mesh.matrixAutoUpdate = false
        scene.add(mesh)
        return mesh
      })
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.05, 0xff0000, 0.018, 0.012)
      arrow.visible = false
      scene.add(arrow)
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.003, 0.0025),
        // WHY no depth test: the reference sits inside the belt (25-35 mm below the true surface) and must still read
        new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
      )
      marker.renderOrder = 2
      marker.visible = false
      scene.add(marker)
      const camera = new THREE.PerspectiveCamera(view.fovy ?? 40, 1, 0.01, 20)
      camera.up.set(0, 0, 1)
      this.panes.push({ scene, camera, headlight, meshes, data, arrow, marker, lookat: new THREE.Vector3(...view.lookat), force: 0 })
    }
    if (this.look) this.setLook(this.look)
  }

  /** Joint positions by joint name (the pick tapes); joints left out keep their value. */
  setQposByName(pane: number, values: Record<string, number>) {
    const p = this.panes[pane]
    if (!p || !this.mujoco || !this.model) return
    const qpos = p.data.qpos // a live view: re-read on every call
    for (const [joint, value] of Object.entries(values)) {
      const adr = this.qposAdr.get(joint)
      if (adr !== undefined && adr >= 0) qpos[adr] = value
    }
    this.pose(pane)
  }

  /** The whole qpos vector, in the model's order (the hand tapes). */
  setQpos(pane: number, values: ArrayLike<number>) {
    const p = this.panes[pane]
    if (!p || !this.mujoco || !this.model) return
    const qpos = p.data.qpos
    const n = Math.min(values.length, this.model.nq)
    for (let i = 0; i < n; i++) qpos[i] = values[i]
    this.pose(pane)
  }

  private pose(pane: number) {
    const p = this.panes[pane]
    const { mujoco, model, view } = this
    if (!mujoco || !model || !view) return
    mujoco.mj_kinematics(model, p.data)
    const xpos = p.data.geom_xpos
    const xmat = p.data.geom_xmat
    this.items.forEach((item, k) => {
      const mesh = p.meshes[k]
      const g = item.geom
      const a = 3 * g
      const b = 9 * g
      mesh.matrix.set(
        xmat[b], xmat[b + 1], xmat[b + 2], xpos[a],
        xmat[b + 3], xmat[b + 4], xmat[b + 5], xpos[a + 1],
        xmat[b + 6], xmat[b + 7], xmat[b + 8], xpos[a + 2],
        0, 0, 0, 1,
      )
      mesh.matrixWorldNeedsUpdate = true
    })
    p.lookat.set(...view.lookat)
    const followed = this.followSite >= 0 ? p.data.site_xpos : this.followBody >= 0 ? p.data.xpos : null
    if (followed) {
      const s = 3 * (this.followSite >= 0 ? this.followSite : this.followBody)
      const axes = view.followAxes ?? [true, true, true]
      if (axes[0]) p.lookat.x = followed[s]
      if (axes[1]) p.lookat.y = followed[s + 1]
      if (axes[2]) p.lookat.z = followed[s + 2]
    }
  }

  /** The followed site's world position in a pane (the tcp), or null. */
  site(pane: number): THREE.Vector3 | null {
    const p = this.panes[pane]
    if (!p || this.followSite < 0) return null
    const site = p.data.site_xpos
    const s = 3 * this.followSite
    return new THREE.Vector3(site[s], site[s + 1], site[s + 2])
  }

  /** The contact force on the tip: its colour and a load arrow above it (100 N = 10 cm). */
  setForce(pane: number, fz: number) {
    const p = this.panes[pane]
    if (!p) return
    p.force = fz
    const tcp = this.site(pane)
    this.items.forEach((item, k) => {
      if (item.role !== 'tip') return
      const material = p.meshes[k].material as THREE.MeshStandardMaterial
      material.color.copy(this.colors.tip).lerp(this.colors.hot, Math.min(1, Math.max(0, fz / HOT_N)))
    })
    if (!tcp || fz < 0.5) {
      p.arrow.visible = false
      return
    }
    const length = Math.max(0.02, ARROW_M_PER_N * fz)
    p.arrow.visible = true
    p.arrow.position.set(tcp.x + 0.045, tcp.y, tcp.z + length)
    p.arrow.setLength(length, Math.min(0.02, 0.4 * length), 0.012)
  }

  /** Where the reference asks the tip to be (height in world z), drawn as a bar through the belt; null hides it. */
  setReference(pane: number, z: number | null) {
    const p = this.panes[pane]
    if (!p) return
    const tcp = this.site(pane)
    if (z === null || !tcp) {
      p.marker.visible = false
      return
    }
    p.marker.visible = true
    p.marker.position.set(tcp.x, tcp.y, z)
  }

  setLook(look: ReplayLook) {
    this.look = look
    const color = (css: string) => parseColor(css).color
    this.colors.tip.copy(color(look.tip))
    this.colors.hot.copy(color(look.hot))
    this.colors.bg.copy(color(look.bg))
    const roles: Record<Role, THREE.Color | null> = {
      arm: color(look.arm), tool: color(look.tool), tip: color(look.tip), belt: color(look.belt), stripe: color(look.stripe), model: null,
    }
    for (const p of this.panes) {
      this.items.forEach((item, k) => {
        const material = p.meshes[k].material as THREE.MeshStandardMaterial
        const role = roles[item.role]
        if (role) material.color.copy(role)
        else material.color.setRGB(item.rgba[0], item.rgba[1], item.rgba[2], THREE.SRGBColorSpace)
      })
      ;(p.arrow.line.material as THREE.LineBasicMaterial).color.copy(color(look.arrow))
      ;(p.arrow.cone.material as THREE.MeshBasicMaterial).color.copy(color(look.arrow))
      const ghost = parseColor(look.ghost)
      const marker = p.marker.material as THREE.MeshBasicMaterial
      marker.color.copy(ghost.color)
      marker.opacity = Math.max(0.6, ghost.alpha)
      this.setForce(this.panes.indexOf(p), p.force)
    }
  }

  layout(width: number, height: number, rects: PaneRect[]) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.rects = rects
    this.renderer.setSize(this.width, this.height, false)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`
  }

  render() {
    const { renderer, view } = this
    if (!view) return
    renderer.setScissor(0, 0, this.width, this.height)
    renderer.setViewport(0, 0, this.width, this.height)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    const az = THREE.MathUtils.degToRad(view.azimuth)
    const el = THREE.MathUtils.degToRad(view.elevation)
    // MuJoCo's free camera looks along (cos el cos az, cos el sin az, sin el) from lookat - distance * that
    const forward = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el))
    this.panes.forEach((pane, i) => {
      const rect = this.rects[i]
      if (!rect || rect.w < 2 || rect.h < 2) return
      const y = this.height - rect.y - rect.h
      renderer.setScissor(rect.x, y, rect.w, rect.h)
      renderer.setViewport(rect.x, y, rect.w, rect.h)
      renderer.setClearColor(this.colors.bg, 1)
      renderer.clear()
      const camera = pane.camera
      camera.position.copy(pane.lookat).addScaledVector(forward, -view.distance)
      camera.lookAt(pane.lookat)
      camera.aspect = rect.w / rect.h
      camera.updateProjectionMatrix()
      pane.headlight.position.copy(camera.position).add(new THREE.Vector3(0.3, 0, 0.6))
      pane.headlight.target.position.copy(pane.lookat)
      pane.headlight.target.updateMatrixWorld()
      renderer.render(pane.scene, camera)
    })
  }

  private unload() {
    for (const pane of this.panes) {
      for (const mesh of pane.meshes) (mesh.material as THREE.Material).dispose()
      pane.arrow.dispose()
      ;(pane.marker.material as THREE.Material).dispose()
      pane.marker.geometry.dispose()
      pane.scene.clear()
      pane.data.delete()
    }
    this.panes = []
    for (const item of this.items) item.geometry.dispose()
    this.items = []
    this.qposAdr.clear()
    this.model?.delete()
    this.model = null
  }

  dispose() {
    this.unload()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
