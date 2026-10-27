// The live pick in three.js: the TRUE model's geoms posed from the worker's frames (no MuJoCo on the main thread), a floor, a
// translucent ghost at the trajectory's reference tcp tied to the real tcp by a line - the spring the impedance renders - and an
// arrow for the contact force. One renderer, one camera, OrbitControls. Client-only (imported from onMounted).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { parseColor } from '../scene'
import type { Frame, GeomInfo } from './protocol'

const GEOM_SPHERE = 2
const GEOM_CAPSULE = 3
const GEOM_ELLIPSOID = 4
const GEOM_CYLINDER = 5
const GEOM_BOX = 6
const FORCE_M_PER_N = 0.0009 // the force arrow: 0.9 mm per newton
const FORCE_MAX_M = 0.22

export interface ViewLook {
  background: string
  floor: string
  grid: string
  arm: string
  belt: string
  ghost: string
  force: string
  forceHigh: string
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

export class LiveView {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50)
  private readonly controls: OrbitControls
  private meshes: { mesh: THREE.Mesh; role: GeomInfo['role'] }[] = []
  private readonly floor: THREE.Mesh
  private grid: THREE.GridHelper
  private readonly ghost: THREE.Mesh
  private readonly spring: THREE.Line
  private readonly arrow: THREE.ArrowHelper
  private readonly matrix = new THREE.Matrix4()
  private look: ViewLook | null = null
  private dirty = true
  private width = 1
  private height = 1

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.camera.up.set(0, 0, 1) // MuJoCo is z-up
    // WHY this framing: the pick happens at (-0.10, -0.45, 0.10); from the belt's far side the arm, the tool and the contact all read
    this.camera.position.set(0.7, -1.7, 0.85)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(-0.14, -0.28, 0.3)
    this.controls.enablePan = true
    this.controls.minDistance = 0.3
    this.controls.maxDistance = 5
    this.controls.addEventListener('change', () => (this.dirty = true))
    this.controls.update()
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0.8, -0.6, 2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-1, -1.5, 0.8)
    this.scene.add(fill)
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 }))
    this.floor.position.z = -0.001
    this.scene.add(this.floor)
    this.grid = new THREE.GridHelper(4, 40, 0xcccccc, 0xcccccc)
    this.grid.rotation.x = Math.PI / 2
    this.scene.add(this.grid)
    this.ghost = new THREE.Mesh(new THREE.SphereGeometry(0.011, 20, 14), new THREE.MeshBasicMaterial({ color: 0x0f766e, transparent: true, opacity: 0.45, depthWrite: false }))
    this.scene.add(this.ghost)
    this.spring = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x0f766e }))
    this.scene.add(this.spring)
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.05, 0xc2410c, 0.018, 0.012)
    this.arrow.visible = false
    this.scene.add(this.arrow)
  }

  setGeoms(geoms: GeomInfo[]) {
    for (const { mesh } of this.meshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.meshes = []
    for (const geom of geoms) {
      const geometry = geometryFor(geom.type, geom.size)
      if (!geometry) continue
      const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.matrixAutoUpdate = false
      this.scene.add(mesh)
      this.meshes.push({ mesh, role: geom.role })
      const [r, g, b] = geom.rgba
      if (geom.role !== 'arm' && geom.role !== 'belt') material.color.setRGB(r, g, b, THREE.SRGBColorSpace)
    }
    if (this.look) this.setLook(this.look)
    this.dirty = true
  }

  setLook(look: ViewLook) {
    this.look = look
    const background = parseColor(look.background).color
    this.renderer.setClearColor(background, 1)
    ;(this.floor.material as THREE.MeshStandardMaterial).color.copy(parseColor(look.floor).color)
    this.scene.remove(this.grid)
    this.grid.geometry.dispose()
    const gridColor = parseColor(look.grid).color
    this.grid = new THREE.GridHelper(4, 40, gridColor, gridColor)
    this.grid.rotation.x = Math.PI / 2
    this.scene.add(this.grid)
    for (const { mesh, role } of this.meshes) {
      const material = mesh.material as THREE.MeshStandardMaterial
      if (role === 'arm') material.color.copy(parseColor(look.arm).color)
      if (role === 'belt') material.color.copy(parseColor(look.belt).color)
    }
    const ghost = parseColor(look.ghost).color
    ;(this.ghost.material as THREE.MeshBasicMaterial).color.copy(ghost)
    ;(this.spring.material as THREE.LineBasicMaterial).color.copy(ghost)
    this.dirty = true
  }

  update(frame: Frame) {
    const { xpos, xmat } = frame
    this.meshes.forEach(({ mesh }, k) => {
      const m = xmat.subarray(9 * k, 9 * k + 9)
      // MuJoCo's xmat is row-major; Matrix4.set takes row-major too
      this.matrix.set(m[0], m[1], m[2], xpos[3 * k], m[3], m[4], m[5], xpos[3 * k + 1], m[6], m[7], m[8], xpos[3 * k + 2], 0, 0, 0, 1)
      mesh.matrix.copy(this.matrix)
      mesh.matrixWorldNeedsUpdate = true
    })
    const [rx, ry, rz] = frame.referenceTcp
    this.ghost.position.set(rx, ry, rz)
    const positions = this.spring.geometry.getAttribute('position') as THREE.BufferAttribute
    positions.setXYZ(0, rx, ry, rz)
    positions.setXYZ(1, frame.tcp[0], frame.tcp[1], frame.tcp[2])
    positions.needsUpdate = true
    if (frame.fzNow > 0.5) {
      const length = Math.min(FORCE_MAX_M, FORCE_M_PER_N * frame.fzNow)
      this.arrow.visible = true
      this.arrow.position.set(frame.tcp[0], frame.tcp[1], frame.tcp[2] + 0.003)
      this.arrow.setLength(Math.max(length, 0.02), Math.min(0.018, 0.4 * Math.max(length, 0.02)), 0.012)
      if (this.look) this.arrow.setColor(parseColor(frame.fzNow > 100 ? this.look.forceHigh : this.look.force).color)
    } else {
      this.arrow.visible = false
    }
    this.dirty = true
  }

  resize(width: number, height: number) {
    if (width < 2 || height < 2) return
    this.width = width
    this.height = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    // a narrow (phone) view: step back so the arm and the belt both stay in frame
    this.camera.fov = width / height < 1.4 ? 42 : 32
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  render(force = false) {
    if (!this.dirty && !force) return
    this.dirty = false
    this.renderer.render(this.scene, this.camera)
  }

  /** Whether anything at all was drawn (the blank-canvas check reads this through the page). */
  get size() {
    return { width: this.width, height: this.height }
  }

  dispose() {
    this.controls.dispose()
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.renderer.dispose()
  }
}
