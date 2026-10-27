/**
 * Canvas drawing for the ArmLab: the arm, its reference, the target ghost, the belt, the contact force, the stiffness
 * ellipses, and the scrolling contact-force plot. Pure functions of a LabSnapshot and a palette (read from the site's --pt-*
 * tokens by the component), so a look change is a redraw.
 */

import type { Lab, LabSnapshot } from './lab'
import { SURFACE_Z } from './lab'
import type { ArmParams, Mat2, Vec2 } from './model'

export interface Palette {
  bg: string
  floor: string
  text: string
  text2: string
  text3: string
  line: string
  brand: string
  brandSoft: string
  accent: string
  ghost: string
  warn: string
  friction: string
  gravity: string
  surface: string
  mono: string
  sans: string
}

/** the world rectangle the stage always shows (m) */
export const WORLD = { xMin: -0.24, xMax: 0.8, zMin: -0.42, zMax: 0.38 }

export interface View {
  scale: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

export function makeView(width: number, height: number): View {
  const scale = Math.min(width / (WORLD.xMax - WORLD.xMin), height / (WORLD.zMax - WORLD.zMin))
  const offsetX = (width - scale * (WORLD.xMax - WORLD.xMin)) / 2 - scale * WORLD.xMin
  const offsetY = (height - scale * (WORLD.zMax - WORLD.zMin)) / 2 + scale * WORLD.zMax
  return { scale, offsetX, offsetY, width, height }
}

export const toScreen = (view: View, x: number, z: number): Vec2 => [view.offsetX + view.scale * x, view.offsetY - view.scale * z]
export const toWorld = (view: View, px: number, py: number): Vec2 => [(px - view.offsetX) / view.scale, (view.offsetY - py) / view.scale]

function link(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, width: number, color: string, dash: number[] = []) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(...a)
  ctx.lineTo(...b)
  ctx.stroke()
  ctx.restore()
}

function arrow(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, color: string, width = 2.5) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0])
  const head = 9
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(...from)
  ctx.lineTo(to[0] - Math.cos(angle) * head * 0.6, to[1] - Math.sin(angle) * head * 0.6)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(...to)
  ctx.lineTo(to[0] - head * Math.cos(angle - 0.42), to[1] - head * Math.sin(angle - 0.42))
  ctx.lineTo(to[0] - head * Math.cos(angle + 0.42), to[1] - head * Math.sin(angle + 0.42))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** The stiffness ellipse {K u : |u| = 1} with each semi-axis drawn at `pxPerSqrtK` x sqrt(k): radius grows as sqrt(k). */
function ellipse(ctx: CanvasRenderingContext2D, center: Vec2, k: Mat2, pxPerSqrtK: number, color: string, dash: number[], width: number) {
  const a = k[0][0]
  const b = 0.5 * (k[0][1] + k[1][0])
  const d = k[1][1]
  const mean = 0.5 * (a + d)
  const spread = Math.hypot(0.5 * (a - d), b)
  const major = Math.max(mean + spread, 0)
  const minor = Math.max(mean - spread, 0)
  const angle = 0.5 * Math.atan2(2 * b, a - d) // world angle of the major axis
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dash)
  ctx.beginPath()
  // screen y points down: a world angle theta is -theta on screen
  ctx.ellipse(center[0], center[1], Math.max(1, pxPerSqrtK * Math.sqrt(major)), Math.max(1, pxPerSqrtK * Math.sqrt(minor)), -angle, 0, 2 * Math.PI)
  ctx.stroke()
  ctx.restore()
}

function zigzag(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, color: string) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (length < 4) return
  const ux = (to[0] - from[0]) / length
  const uy = (to[1] - from[1]) / length
  const turns = Math.max(3, Math.min(10, Math.round(length / 7)))
  const amplitude = 4
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(...from)
  for (let i = 1; i < 2 * turns; i++) {
    const along = (i / (2 * turns)) * length
    const side = (i % 2 ? 1 : -1) * amplitude
    ctx.lineTo(from[0] + ux * along - uy * side, from[1] + uy * along + ux * side)
  }
  ctx.lineTo(...to)
  ctx.stroke()
  ctx.restore()
}

function motor(ctx: CanvasRenderingContext2D, at: Vec2, radius: number, torque: number, cap: number, saturated: boolean, palette: Palette) {
  ctx.save()
  ctx.fillStyle = palette.bg
  ctx.strokeStyle = palette.text2
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(at[0], at[1], radius, 0, 2 * Math.PI)
  ctx.fill()
  ctx.stroke()
  // the torque gauge: an arc from 12 o'clock, clockwise for +, its sweep |tau| / cap of 300 degrees
  const sweep = Math.min(1, Math.abs(torque) / cap) * (300 / 360) * 2 * Math.PI
  const start = -Math.PI / 2
  ctx.strokeStyle = saturated ? palette.warn : palette.brand
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.beginPath()
  if (torque >= 0) ctx.arc(at[0], at[1], radius + 5, start, start + sweep)
  else ctx.arc(at[0], at[1], radius + 5, start - sweep, start)
  ctx.stroke()
  ctx.fillStyle = palette.text2
  ctx.beginPath()
  ctx.arc(at[0], at[1], 2.5, 0, 2 * Math.PI)
  ctx.fill()
  ctx.restore()
}

function label(ctx: CanvasRenderingContext2D, text: string, at: Vec2, palette: Palette, options: { color?: string; align?: CanvasTextAlign; size?: number; mono?: boolean; baseline?: CanvasTextBaseline } = {}) {
  ctx.save()
  ctx.fillStyle = options.color ?? palette.text2
  ctx.font = `${options.size ?? 12}px ${options.mono ? palette.mono : palette.sans}`
  ctx.textAlign = options.align ?? 'left'
  ctx.textBaseline = options.baseline ?? 'middle'
  ctx.fillText(text, at[0], at[1])
  ctx.restore()
}

export function drawStage(ctx: CanvasRenderingContext2D, view: View, snapshot: LabSnapshot, params: ArmParams, palette: Palette, dragging: boolean) {
  const s = view.scale
  ctx.clearRect(0, 0, view.width, view.height)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, view.width, view.height)

  // floor, pedestal and belt
  const floorZ = WORLD.zMin + 0.02
  const [, floorY] = toScreen(view, 0, floorZ)
  ctx.fillStyle = palette.floor
  ctx.fillRect(0, floorY, view.width, view.height - floorY)
  const [pedLeft, pedTop] = toScreen(view, -0.045, 0)
  ctx.fillStyle = palette.floor
  ctx.strokeStyle = palette.line
  ctx.lineWidth = 1
  ctx.fillRect(pedLeft, pedTop, 0.09 * s, floorY - pedTop)
  ctx.strokeRect(pedLeft, pedTop, 0.09 * s, floorY - pedTop)
  const beltLeft = 0.12
  const [beltX0, beltTop] = toScreen(view, beltLeft, SURFACE_Z)
  const [beltX1, beltBottom] = toScreen(view, WORLD.xMax + 0.05, SURFACE_Z - 0.035)
  ctx.fillStyle = palette.surface
  ctx.fillRect(beltX0, beltTop, beltX1 - beltX0, beltBottom - beltTop)
  ctx.save()
  ctx.beginPath()
  ctx.rect(beltX0, beltTop, beltX1 - beltX0, beltBottom - beltTop)
  ctx.clip()
  ctx.strokeStyle = palette.line
  ctx.lineWidth = 1
  for (let x = beltX0 - 40; x < beltX1; x += 12) {
    ctx.beginPath()
    ctx.moveTo(x, beltBottom)
    ctx.lineTo(x + (beltBottom - beltTop), beltTop)
    ctx.stroke()
  }
  ctx.restore()
  link(ctx, [beltX0, beltTop], [beltX1, beltTop], 2, palette.text3)
  const roller = toScreen(view, beltLeft, SURFACE_Z - 0.0175)
  ctx.fillStyle = palette.bg
  ctx.strokeStyle = palette.text3
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(roller[0], roller[1], (beltBottom - beltTop) / 2, 0, 2 * Math.PI)
  ctx.fill()
  ctx.stroke()
  label(ctx, `belt · ${(params.contactK / 1000).toFixed(0)} kN/m, ${params.contactB} N·s/m`, [Math.min(beltX1, view.width) - 8, (beltBottom + floorY) / 2 + 2], palette, { align: 'right', size: 11, color: palette.text3 })

  // the reference arm (where the trajectory wants the joints) and the spring from the tool to its reference point
  const base = toScreen(view, 0, 0)
  const elbowRef = toScreen(view, params.l1 * Math.cos(snapshot.qRef[0]), params.l1 * Math.sin(snapshot.qRef[0]))
  const toolRef = toScreen(view, ...snapshot.toolRef)
  link(ctx, base, elbowRef, 0.022 * s, palette.ghost)
  link(ctx, elbowRef, toolRef, 0.018 * s, palette.ghost)

  // target ghost and the clamp line to the reachable point
  const target = toScreen(view, ...snapshot.target)
  ctx.save()
  ctx.strokeStyle = palette.brand
  ctx.lineWidth = dragging ? 2.5 : 1.75
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.arc(target[0], target[1], dragging ? 17 : 14, 0, 2 * Math.PI)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(target[0] - 6, target[1])
  ctx.lineTo(target[0] + 6, target[1])
  ctx.moveTo(target[0], target[1] - 6)
  ctx.lineTo(target[0], target[1] + 6)
  ctx.stroke()
  ctx.restore()
  // the target's name only while it sits apart from the tool (it would cover the tool's own labels otherwise)
  if (Math.hypot(...toScreen(view, ...snapshot.tool).map((value, i) => value - target[i]) as Vec2) > 40)
    label(ctx, 'target', [target[0] + 20, target[1] - 12], palette, { size: 11, color: palette.brand })

  // the arm
  const elbow = toScreen(view, params.l1 * Math.cos(snapshot.q[0]), params.l1 * Math.sin(snapshot.q[0]))
  const tool = toScreen(view, ...snapshot.tool)
  zigzag(ctx, tool, toolRef, palette.accent)
  link(ctx, base, elbow, 0.034 * s, palette.brand)
  link(ctx, elbow, tool, 0.026 * s, palette.brand)
  const radius = Math.max(9, 0.03 * s)
  motor(ctx, elbow, radius * 0.85, snapshot.torque[1].total, snapshot.torque[1].cap, snapshot.torque[1].saturated > 0.2, palette)
  motor(ctx, base, radius, snapshot.torque[0].total, snapshot.torque[0].cap, snapshot.torque[0].saturated > 0.2, palette)
  ctx.fillStyle = palette.text
  ctx.beginPath()
  ctx.arc(tool[0], tool[1], Math.max(4, 0.012 * s), 0, 2 * Math.PI)
  ctx.fill()

  // stiffness ellipses at the tool: radius ~ sqrt(k), sqrt(5000 N/m) -> 26 % of the stage's height
  const pxPerSqrtK = (0.13 * view.height) / Math.sqrt(5000)
  if (snapshot.requestedK) ellipse(ctx, tool, snapshot.requestedK, pxPerSqrtK, palette.text3, [5, 4], 1.5)
  ellipse(ctx, tool, snapshot.realizedK, pxPerSqrtK, palette.brand, [], 2)

  // the belt's push on the tool, and an external shove
  if (snapshot.contactForce > 0.05) {
    const length = Math.min(0.32 * view.height, 3 * snapshot.contactForce)
    const foot: Vec2 = [tool[0], toScreen(view, 0, SURFACE_Z)[1]]
    arrow(ctx, [foot[0], foot[1] + length], foot, palette.accent, 3)
    label(ctx, `${snapshot.contactForce.toFixed(1)} N`, [foot[0] + 9, foot[1] + 20], palette, { color: palette.text, mono: true, size: 12 })
  }
  if (Math.hypot(...snapshot.externalForce) > 0) {
    const direction = Math.sign(snapshot.externalForce[0]) || 1
    const length = 4 * Math.abs(snapshot.externalForce[0])
    arrow(ctx, [tool[0] - direction * (length + 16), tool[1]], [tool[0] - direction * 14, tool[1]], palette.warn, 3)
    label(ctx, `${Math.abs(snapshot.externalForce[0]).toFixed(0)} N push`, [tool[0] - direction * (length / 2 + 16), tool[1] - 12], palette, { align: 'center', size: 11, color: palette.warn })
  }
}

/** The contact force over the last 8 s, with the presets' marks and their peaks. */
export function drawForcePlot(ctx: CanvasRenderingContext2D, width: number, height: number, lab: Lab, palette: Palette) {
  ctx.clearRect(0, 0, width, height)
  const history = lab.history
  const windowS = 8
  const now = lab.t
  const left = 34
  const right = width - 8
  const top = 8
  const bottom = height - 18
  let peak = 0
  for (let i = 0; i < history.size; i++) peak = Math.max(peak, history.force[i])
  const yMax = Math.max(20, Math.ceil((peak * 1.15) / 10) * 10)
  const x = (t: number) => left + ((t - (now - windowS)) / windowS) * (right - left)
  const y = (f: number) => bottom - (f / yMax) * (bottom - top)
  ctx.strokeStyle = palette.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, bottom)
  ctx.lineTo(right, bottom)
  ctx.stroke()
  label(ctx, `${yMax}`, [left - 6, top + 2], palette, { align: 'right', size: 10, mono: true, color: palette.text3 })
  label(ctx, '0', [left - 6, bottom], palette, { align: 'right', size: 10, mono: true, color: palette.text3 })
  label(ctx, `contact force, N · last ${windowS} s`, [left + 4, bottom + 10], palette, { size: 10, color: palette.text3 })
  lab.marks.forEach((mark, index) => {
    if (mark.t < now - windowS) return
    const px = x(mark.t)
    ctx.save()
    ctx.strokeStyle = palette.text3
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(px, top)
    ctx.lineTo(px, bottom)
    ctx.stroke()
    ctx.restore()
    // alternate rows so neighbouring marks' labels do not collide
    const text = `${mark.label}${mark.peak > 0.5 ? ` · peak ${mark.peak.toFixed(0)} N` : ''}`
    ctx.font = `10px ${palette.sans}`
    const fits = px + 4 + ctx.measureText(text).width <= right
    label(ctx, text, [fits ? px + 4 : px - 4, top + 6 + (index % 2) * 13], palette, { size: 10, color: palette.text2, align: fits ? 'left' : 'right' })
  })
  if (!history.size) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top - 2, right - left, bottom - top + 4)
  ctx.clip()
  ctx.strokeStyle = palette.accent
  ctx.lineWidth = 1.75
  ctx.lineJoin = 'round'
  ctx.beginPath()
  const length = history.t.length
  const start = (history.head - history.size + length) % length
  for (let i = 0; i < history.size; i++) {
    const index = (start + i) % length
    const px = x(history.t[index])
    const py = y(history.force[index])
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  ctx.restore()
}
