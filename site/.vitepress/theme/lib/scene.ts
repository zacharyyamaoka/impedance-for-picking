// MjModel -> three.js: one WebGLRenderer on one canvas, scissored into one pane per rung. Each pane has its own scene
// (the robot at that rung's actual pose plus a translucent ghost at the commanded pose) and its own camera; one
// OrbitControls on the canvas drives a master camera that every pane copies, so orbit and zoom move all panes at once.
// Client-only (imported dynamically from onMounted).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco'
import type { RobotData, RungId, Tape } from './replay'
import { errorAt, sampleAt, tapeDuration, tapeT0 } from './replay'

export interface Look {
  viewportBg: string
  floor: string
  ghost: string
  link: string // a moving link at zero error
  ink: string // structure and grid lines are mixed from this toward the floor and background
  warn: string // a moving link at 100 mrad / mm of error and beyond
}

export interface PaneRect {
  x: number
  y: number
  w: number
  h: number
}

interface Link {
  geom: number
  driver: number // index into robot.joints, -1 for the fixed structure
  geometry: THREE.BufferGeometry
  ghostGeometry: THREE.BufferGeometry
}

interface Pane {
  rung: RungId
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  headlight: THREE.DirectionalLight
  actual: THREE.Mesh[]
  ghosts: THREE.Mesh[]
  floor: THREE.Mesh
  grid: THREE.LineSegments
}

const GEOM_SPHERE = 2
const GEOM_CAPSULE = 3
const GEOM_ELLIPSOID = 4
const GEOM_CYLINDER = 5
const GEOM_BOX = 6

// WHY a log scale from 0.1 to 100: the four rungs span three decades of error; linear would paint every rung but
// factory the same neutral colour.
const TINT_LOW = 0.1
const TINT_DECADES = 3

/** Parse a CSS colour string (#hex, rgb(), rgba()) into a THREE.Color and its alpha, without three's alpha warning. */
export function parseColor(css: string): { color: THREE.Color; alpha: number } {
  const value = css.trim()
  const rgba = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i)
  if (rgba) {
    const color = new THREE.Color().setRGB(+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255, THREE.SRGBColorSpace)
    let alpha = rgba[4] === undefined ? 1 : +rgba[4]
    if (rgba[5] === '%') alpha /= 100
    return { color, alpha }
  }
  const hex8 = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i)
  if (hex8) return { color: new THREE.Color(`#${hex8[1]}`), alpha: parseInt(hex8[2], 16) / 255 }
  try {
    return { color: new THREE.Color(value), alpha: 1 }
  } catch {
    return { color: new THREE.Color('#888888'), alpha: 1 }
  }
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
      return null // planes are replaced by our own floor; the exported models have no meshes or height fields
  }
}

/** Size of the ghost's geometry: the same primitive, a little fatter. */
function inflate(type: number, size: number[]): number[] {
  if (type === GEOM_BOX || type === GEOM_ELLIPSOID) {
    const pad = 0.12 * Math.min(size[0], size[1], size[2])
    return size.map((v) => v + pad)
  }
  const pad = 0.18 * size[0]
  return type === GEOM_CYLINDER ? [size[0] + pad, size[1] + pad, size[2]] : [size[0] + pad, size[1], size[2]]
}

function fadeTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, '#fff')
  gradient.addColorStop(0.55, '#fff')
  gradient.addColorStop(1, '#000')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

function niceStep(span: number): number {
  const raw = span / 6
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power
}

export class ReplayScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly canvas: HTMLCanvasElement
  private readonly master: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly fade: THREE.CanvasTexture
  private mujoco: MainModule | null = null
  private model: MjModel | null = null
  private datas = new Map<RungId, MjData>()
  private targetData: MjData | null = null
  private robot: RobotData | null = null
  private tape: Tape | null = null
  private links: Link[] = []
  private jointAdr: number[] = []
  private passiveAdr: { name: string; adr: number }[] = []
  private panes: Pane[] = []
  private rects: PaneRect[] = []
  private width = 1
  private height = 1
  private look: Look | null = null
  private colors = { neutral: new THREE.Color(), structure: new THREE.Color(), warn: new THREE.Color() }
  private bounds = new THREE.Box3()
  private modelCamera: THREE.Vector3 | null = null
  private scratch = new THREE.Matrix4()

  constructor(canvas: HTMLCanvasElement, onChange: () => void) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.autoClear = false
    this.renderer.setScissorTest(true)
    this.master = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
    this.master.up.set(0, 0, 1) // MuJoCo is z-up
    this.controls = new OrbitControls(this.master, canvas)
    this.controls.enableDamping = false
    this.controls.enablePan = false
    this.controls.addEventListener('change', onChange)
    this.fade = fadeTexture()
  }

  /** Build the model, one MjData per rung plus one for the commanded ghost, and one pane per rung. */
  load(mujoco: MainModule, xml: string, robot: RobotData, rungs: RungId[]) {
    this.unload()
    this.mujoco = mujoco
    this.robot = robot
    const model = mujoco.MjModel.from_xml_string(xml)
    this.model = model
    for (const rung of rungs) this.datas.set(rung, new mujoco.MjData(model))
    this.targetData = new mujoco.MjData(model)

    // Read model arrays only after every MjData exists: heap growth detaches earlier views
    const jointObj = mujoco.mjtObj.mjOBJ_JOINT.value
    const jointId = (name: string) => mujoco.mj_name2id(model, jointObj, name)
    const qposadr = model.jnt_qposadr
    const drivenIds = robot.joints.map((j) => jointId(j.model_joint))
    this.jointAdr = drivenIds.map((id) => (id >= 0 ? qposadr[id] : -1))
    this.passiveAdr = robot.passive.map((name) => ({ name, adr: jointId(name) >= 0 ? qposadr[jointId(name)] : -1 }))

    // Which driven joint moves each body: the nearest driven joint on the body or an ancestor (passive joints are
    // skipped, so the five-bar's coupler takes the colour of the crank that carries it)
    const bodyDriver = (body: number): number => {
      const jntadr = model.body_jntadr
      const jntnum = model.body_jntnum
      const parent = model.body_parentid
      for (let b = body; b > 0; b = parent[b]) {
        for (let k = 0; k < jntnum[b]; k++) {
          const index = drivenIds.indexOf(jntadr[b] + k)
          if (index >= 0) return index
        }
      }
      return -1
    }

    const types = model.geom_type
    const sizes = model.geom_size
    const bodies = model.geom_bodyid
    const links: Link[] = []
    for (let g = 0; g < model.ngeom; g++) {
      const geometry = geometryFor(types[g], [sizes[3 * g], sizes[3 * g + 1], sizes[3 * g + 2]])
      if (!geometry) continue
      geometry.computeBoundingBox()
      const size = [sizes[3 * g], sizes[3 * g + 1], sizes[3 * g + 2]]
      links.push({ geom: g, driver: bodyDriver(bodies[g]), geometry, ghostGeometry: geometryFor(types[g], inflate(types[g], size))! })
    }
    this.links = links

    // Camera direction: the model's own camera when it has one (the five-bar is drawn in its x-z plane), else a 3/4 view
    this.modelCamera = null
    if (model.ncam > 0) {
      // cam_xpos is filled by mj_camlight, not by mj_kinematics
      mujoco.mj_kinematics(model, this.targetData)
      mujoco.mj_camlight(model, this.targetData)
      const cam = this.targetData.cam_xpos
      this.modelCamera = new THREE.Vector3(cam[0], cam[1], cam[2])
    }

    for (const rung of rungs) this.panes.push(this.buildPane(rung))
    if (this.look) this.setLook(this.look)
  }

  private buildPane(rung: RungId): Pane {
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.7))
    const headlight = new THREE.DirectionalLight(0xffffff, 1.8)
    scene.add(headlight, headlight.target)
    const actual: THREE.Mesh[] = []
    const ghosts: THREE.Mesh[] = []
    for (const link of this.links) {
      const mesh = new THREE.Mesh(link.geometry, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }))
      mesh.matrixAutoUpdate = false
      scene.add(mesh)
      actual.push(mesh)
      if (link.driver >= 0) {
        const ghost = new THREE.Mesh(
          link.ghostGeometry,
          // WHY the back faces of a slightly fatter copy: where the joint is on its command the real link hides all but
          // a thin rim, so tuned robots keep their error colour; where it lags, the whole ghost shows beside it
          new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide }),
        )
        ghost.matrixAutoUpdate = false
        ghost.renderOrder = 1
        ghost.userData.link = link
        scene.add(ghost)
        ghosts.push(ghost)
      }
    }
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, alphaMap: this.fade, depthWrite: false }),
    )
    floor.renderOrder = -1
    scene.add(floor)
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
    )
    grid.renderOrder = -1
    scene.add(grid)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
    camera.up.set(0, 0, 1)
    return { rung, scene, camera, headlight, actual, ghosts, floor, grid }
  }

  setTape(tape: Tape) {
    this.tape = tape
  }

  /** Write one tape time into every MjData and run kinematics (replay never steps physics). */
  private pose(t: number) {
    const { mujoco, model, robot, tape, targetData } = this
    if (!mujoco || !model || !robot || !tape || !targetData) return
    const t0 = tapeT0(tape)
    const write = (data: MjData, rung: RungId | null) => {
      const qpos = data.qpos // live view: re-read on every call
      robot.joints.forEach((joint, i) => {
        const adr = this.jointAdr[i]
        if (adr < 0) return
        const series = rung ? tape.rungs[rung]?.[joint.name] : tape.target[joint.name]
        qpos[adr] = series ? sampleAt(series.q, series.t0, tape.dt, t) : joint.home
      })
      for (const { name, adr } of this.passiveAdr) {
        const path = rung ? tape.passive?.[rung]?.[name] : tape.target_passive?.[name]
        if (adr >= 0 && path) qpos[adr] = sampleAt(path, t0, tape.dt, t)
      }
      mujoco.mj_kinematics(model, data)
    }
    write(targetData, null)
    for (const [rung, data] of this.datas) write(data, rung)
  }

  private place(mesh: THREE.Mesh, xpos: ArrayLike<number>, xmat: ArrayLike<number>, g: number) {
    const p = 3 * g
    const r = 9 * g
    mesh.matrix.set(
      xmat[r], xmat[r + 1], xmat[r + 2], xpos[p],
      xmat[r + 3], xmat[r + 4], xmat[r + 5], xpos[p + 1],
      xmat[r + 6], xmat[r + 7], xmat[r + 8], xpos[p + 2],
      0, 0, 0, 1,
    )
    mesh.matrixWorldNeedsUpdate = true
  }

  /** Pose every pane at tape time t and tint each moving link by its driving joint's error now. */
  setTime(t: number) {
    const { tape, robot, targetData } = this
    if (!tape || !robot || !targetData) return
    this.pose(t)
    const gx = targetData.geom_xpos
    const gm = targetData.geom_xmat
    const errors = new Map<RungId, number[]>()
    for (const pane of this.panes) {
      errors.set(pane.rung, robot.joints.map((joint) => errorAt(tape, pane.rung, joint.name, t)))
    }
    for (const pane of this.panes) {
      const data = this.datas.get(pane.rung)!
      const xpos = data.geom_xpos
      const xmat = data.geom_xmat
      const jointErrors = errors.get(pane.rung)!
      pane.actual.forEach((mesh, k) => {
        const link = this.links[k]
        this.place(mesh, xpos, xmat, link.geom)
        const material = mesh.material as THREE.MeshStandardMaterial
        if (link.driver < 0) {
          material.color.copy(this.colors.structure)
        } else {
          const error = jointErrors[link.driver]
          const level = Number.isFinite(error) && error > 0 ? Math.log10(error / TINT_LOW) / TINT_DECADES : 0
          material.color.copy(this.colors.neutral).lerp(this.colors.warn, Math.min(1, Math.max(0, level)))
        }
      })
      for (const ghost of pane.ghosts) this.place(ghost, gx, gm, (ghost.userData.link as Link).geom)
    }
  }

  /** Fit the master camera to the robot's bounding box over the whole tape, for every rung and the command. */
  fit() {
    const { tape, targetData } = this
    if (!tape || !targetData || this.links.length === 0) return
    const box = new THREE.Box3()
    const moving = new THREE.Box3()
    const structure = new THREE.Box3()
    const geomBox = new THREE.Box3()
    const duration = tapeDuration(tape)
    const samples = 24
    for (let s = 0; s <= samples; s++) {
      this.pose(tapeT0(tape) + (duration * s) / samples)
      for (const data of [targetData, ...this.datas.values()]) {
        const xpos = data.geom_xpos
        const xmat = data.geom_xmat
        for (const link of this.links) {
          const p = 3 * link.geom
          const r = 9 * link.geom
          this.scratch.set(
            xmat[r], xmat[r + 1], xmat[r + 2], xpos[p],
            xmat[r + 3], xmat[r + 4], xmat[r + 5], xpos[p + 1],
            xmat[r + 6], xmat[r + 7], xmat[r + 8], xpos[p + 2],
            0, 0, 0, 1,
          )
          geomBox.copy(link.geometry.boundingBox!).applyMatrix4(this.scratch)
          box.union(geomBox)
          ;(link.driver >= 0 ? moving : structure).union(geomBox)
        }
      }
    }
    this.bounds.copy(box)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.y, size.z, 1e-3)

    // A slightly raised view so the floor reads as a floor even from a level model camera
    // WHY a near-level view for hanging robots: the hands' fingers hang under the palm, which any view from above hides
    const hanging = !structure.isEmpty() && !moving.isEmpty() && moving.getCenter(new THREE.Vector3()).z < structure.min.z
    const elevation = hanging ? 0.06 : 0.3
    const dir = this.modelCamera ? this.modelCamera.clone().sub(center) : new THREE.Vector3(0.6, -1, elevation)
    if (dir.lengthSq() < 1e-9) dir.set(0.6, -1, elevation)
    dir.normalize()
    if (!hanging && dir.z < 0.2) dir.z = 0.2
    dir.normalize()

    // Distance that keeps every box corner inside the frustum at the panes' aspect
    const aspect = this.rects.length ? this.rects[0].w / Math.max(1, this.rects[0].h) : 1
    const vHalf = THREE.MathUtils.degToRad(this.master.fov / 2)
    const hHalf = Math.atan(Math.tan(vHalf) * aspect)
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1))
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0)
    right.normalize()
    const up = new THREE.Vector3().crossVectors(right, dir).normalize()
    let distance = 0
    const corner = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center)
      const along = corner.dot(dir)
      distance = Math.max(distance, along + Math.abs(corner.dot(right)) / Math.tan(hHalf), along + Math.abs(corner.dot(up)) / Math.tan(vHalf))
    }
    distance *= 1.12
    this.master.position.copy(center).addScaledVector(dir, distance)
    this.master.near = distance / 100
    this.master.far = distance * 20
    this.master.updateProjectionMatrix()
    this.controls.target.copy(center)
    this.controls.minDistance = distance * 0.2
    this.controls.maxDistance = distance * 5
    this.controls.update()

    // Floor at the lowest point of the motion, a little wider than the robot
    const floorZ = box.min.z - span * 0.002
    const extent = span * 2.4
    const step = niceStep(extent)
    const half = Math.ceil(extent / 2 / step) * step
    const lines: number[] = []
    // Grid lines are chords of a circle inside the floor's radial fade, so no line ends at a hard square edge
    const radius = half * 0.8
    for (let v = -half; v <= half + 1e-9; v += step) {
      if (Math.abs(v) >= radius) continue
      const chord = Math.sqrt(radius * radius - v * v)
      lines.push(center.x + v, center.y - chord, 0, center.x + v, center.y + chord, 0)
      lines.push(center.x - chord, center.y + v, 0, center.x + chord, center.y + v, 0)
    }
    for (const pane of this.panes) {
      pane.floor.scale.set(2 * half, 2 * half, 1)
      pane.floor.position.set(center.x, center.y, floorZ - span * 0.001)
      pane.grid.geometry.dispose()
      pane.grid.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
      pane.grid.position.z = floorZ
    }
  }

  setLook(look: Look) {
    this.look = look
    const bg = parseColor(look.viewportBg).color
    const floor = parseColor(look.floor).color
    const ink = parseColor(look.ink).color
    this.colors.neutral.copy(parseColor(look.link).color)
    this.colors.structure.copy(ink).lerp(bg, 0.45)
    this.colors.warn.copy(parseColor(look.warn).color)
    const ghost = parseColor(look.ghost)
    const grid = floor.clone().lerp(ink, 0.3)
    for (const pane of this.panes) {
      for (const mesh of pane.ghosts) {
        const material = mesh.material as THREE.MeshBasicMaterial
        material.color.copy(ghost.color)
        // WHY a floor on the ghost's opacity: the tokens' 0.16-0.22 alpha vanishes over a lit robot
        material.opacity = Math.min(0.6, Math.max(0.35, ghost.alpha * 1.8))
      }
      ;(pane.floor.material as THREE.MeshBasicMaterial).color.copy(floor)
      ;(pane.grid.material as THREE.LineBasicMaterial).color.copy(grid)
      ;(pane.grid.material as THREE.LineBasicMaterial).opacity = 0.8
      ;(pane.scene.userData as { bg?: THREE.Color }).bg = bg
    }
  }

  /** Canvas size in CSS px and one rect per pane (CSS px from the top left). */
  layout(width: number, height: number, rects: PaneRect[]) {
    this.width = width
    this.height = height
    this.rects = rects
    this.renderer.setSize(width, height, false)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  render() {
    const renderer = this.renderer
    renderer.setScissor(0, 0, this.width, this.height)
    renderer.setViewport(0, 0, this.width, this.height)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    this.panes.forEach((pane, i) => {
      const rect = this.rects[i]
      if (!rect || rect.w < 2 || rect.h < 2) return
      const y = this.height - rect.y - rect.h
      renderer.setScissor(rect.x, y, rect.w, rect.h)
      renderer.setViewport(rect.x, y, rect.w, rect.h)
      const bg = (pane.scene.userData as { bg?: THREE.Color }).bg
      renderer.setClearColor(bg ?? 0x888888, 1)
      renderer.clear()
      const camera = pane.camera
      camera.position.copy(this.master.position)
      camera.quaternion.copy(this.master.quaternion)
      camera.fov = this.master.fov
      camera.near = this.master.near
      camera.far = this.master.far
      camera.aspect = rect.w / rect.h
      camera.updateProjectionMatrix()
      pane.headlight.position.copy(camera.position)
      pane.headlight.target.position.copy(this.controls.target)
      pane.headlight.target.updateMatrixWorld()
      renderer.render(pane.scene, camera)
    })
  }

  private unload() {
    for (const pane of this.panes) {
      for (const mesh of [...pane.actual, ...pane.ghosts]) (mesh.material as THREE.Material).dispose()
      ;(pane.floor.material as THREE.Material).dispose()
      pane.floor.geometry.dispose()
      ;(pane.grid.material as THREE.Material).dispose()
      pane.grid.geometry.dispose()
      pane.scene.clear()
    }
    this.panes = []
    for (const link of this.links) {
      link.geometry.dispose()
      link.ghostGeometry.dispose()
    }
    this.links = []
    for (const data of this.datas.values()) data.delete()
    this.datas.clear()
    this.targetData?.delete()
    this.targetData = null
    this.model?.delete()
    this.model = null
    this.tape = null
    this.robot = null
  }

  dispose() {
    this.unload()
    this.controls.dispose()
    this.fade.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
