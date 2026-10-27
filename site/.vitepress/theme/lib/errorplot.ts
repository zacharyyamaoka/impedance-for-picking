// The error plot under the panes: canvas 2D, x = tape time. A small strip on top shows the commanded position against
// each rung's actual one; the main plot shows |error| per rung (log 0.01-1000 or linear). The static traces are drawn
// once into an offscreen canvas; each clock tick only blits it and draws the playhead and hover line on top.

import type { RungId } from './replay'

export interface PlotLook {
  text: string
  text2: string
  text3: string
  line: string
  font: string
  rungs: Record<RungId, string>
}

export interface PlotTrace {
  rung: RungId
  values: Float64Array
}

export interface PlotData {
  times: Float64Array
  unit: string
  errors: PlotTrace[]
  position: { label: string; joint: string; unit: string; target: Float64Array; actual: PlotTrace[] }
}

export type PlotScale = 'log' | 'linear'

const LOG_MIN = 0.01
const LOG_MAX = 1000
const MARGIN = { left: 50, right: 12, top: 18 }
const STRIP_H = 64
const GAP = 26
const MAIN_H = 170
const AXIS_H = 22
export const PLOT_HEIGHT = MARGIN.top + STRIP_H + GAP + MAIN_H + AXIS_H

function niceStep(span: number, ticks: number): number {
  const raw = span / ticks
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power
}

function tickLabel(v: number): string {
  if (v === 0) return '0'
  if (Math.abs(v) >= 1000) return `${v / 1000}k`
  return String(Number(v.toPrecision(3)))
}

// WHY tuned drawn last: it is the line the page is about; the others sit under it
const DRAW_ORDER: RungId[] = ['factory', 'analytic', 'oracle', 'tuned']

export class ErrorPlot {
  private readonly canvas: HTMLCanvasElement
  private readonly base: HTMLCanvasElement
  private data: PlotData | null = null
  private look: PlotLook | null = null
  private scale: PlotScale = 'log'
  private width = 300
  private dpr = 1
  private dirty = true

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.base = document.createElement('canvas')
  }

  setData(data: PlotData) {
    this.data = data
    this.dirty = true
  }

  setLook(look: PlotLook) {
    this.look = look
    this.dirty = true
  }

  setScale(scale: PlotScale) {
    this.scale = scale
    this.dirty = true
  }

  resize(width: number) {
    this.width = Math.max(200, Math.floor(width))
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const c of [this.canvas, this.base]) {
      c.width = Math.round(this.width * this.dpr)
      c.height = Math.round(PLOT_HEIGHT * this.dpr)
    }
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${PLOT_HEIGHT}px`
    this.dirty = true
  }

  private get plotW() {
    return this.width - MARGIN.left - MARGIN.right
  }

  private span(): [number, number] {
    const times = this.data?.times
    if (!times || times.length === 0) return [0, 1]
    return [times[0], Math.max(times[times.length - 1], times[0] + 1e-6)]
  }

  private x(t: number): number {
    const [t0, t1] = this.span()
    return MARGIN.left + ((t - t0) / (t1 - t0)) * this.plotW
  }

  /** Tape time under a CSS-pixel x, clamped to the tape. */
  timeAt(px: number): number {
    const [t0, t1] = this.span()
    const f = Math.min(1, Math.max(0, (px - MARGIN.left) / this.plotW))
    return t0 + f * (t1 - t0)
  }

  /** Index of the sample nearest to t. */
  indexAt(t: number): number {
    const times = this.data?.times
    if (!times || times.length < 2) return 0
    const i = Math.round((t - times[0]) / (times[1] - times[0]))
    return Math.min(times.length - 1, Math.max(0, i))
  }

  private linearMax(): number {
    let max = 0
    for (const trace of this.data?.errors ?? []) for (const v of trace.values) if (Number.isFinite(v)) max = Math.max(max, v)
    const step = niceStep(Math.max(max, 1e-3), 4)
    return Math.ceil(max / step) * step || step
  }

  private yError(v: number): number {
    const top = MARGIN.top + STRIP_H + GAP
    if (this.scale === 'log') {
      const f = (Math.log10(Math.min(LOG_MAX, Math.max(LOG_MIN, v))) - Math.log10(LOG_MIN)) / (Math.log10(LOG_MAX) - Math.log10(LOG_MIN))
      return top + MAIN_H * (1 - f)
    }
    return top + MAIN_H * (1 - Math.min(1, Math.max(0, v / this.linearMax())))
  }

  private drawBase() {
    const { data, look } = this
    const ctx = this.base.getContext('2d')!
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, PLOT_HEIGHT)
    if (!data || !look || data.times.length === 0) return
    const left = MARGIN.left
    const right = this.width - MARGIN.right
    const font = `11px ${look.font}`
    ctx.font = font
    ctx.lineJoin = 'round'

    const polyline = (values: Float64Array, y: (v: number) => number) => {
      ctx.beginPath()
      let pen = false
      for (let i = 0; i < values.length; i++) {
        const v = values[i]
        if (!Number.isFinite(v)) {
          pen = false
          continue
        }
        const px = this.x(data.times[i])
        if (pen) ctx.lineTo(px, y(v))
        else ctx.moveTo(px, y(v))
        pen = true
      }
      ctx.stroke()
    }

    // --- position strip
    const stripTop = MARGIN.top
    let lo = Infinity
    let hi = -Infinity
    for (const values of [data.position.target, ...data.position.actual.map((a) => a.values)]) {
      for (const v of values) {
        if (!Number.isFinite(v)) continue
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
    if (!Number.isFinite(lo)) lo = hi = 0
    const pad = Math.max((hi - lo) * 0.1, 1e-3)
    lo -= pad
    hi += pad
    const yPos = (v: number) => stripTop + STRIP_H * (1 - (v - lo) / (hi - lo))
    ctx.strokeStyle = look.line
    ctx.lineWidth = 1
    ctx.strokeRect(left + 0.5, stripTop + 0.5, right - left - 1, STRIP_H - 1)
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, stripTop, right - left, STRIP_H)
    ctx.clip()
    ctx.lineWidth = 1.25
    for (const rung of DRAW_ORDER) {
      const trace = data.position.actual.find((a) => a.rung === rung)
      if (!trace) continue
      ctx.strokeStyle = look.rungs[rung]
      polyline(trace.values, yPos)
    }
    ctx.strokeStyle = look.text
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    polyline(data.position.target, yPos)
    ctx.setLineDash([])
    ctx.restore()
    ctx.fillStyle = look.text3
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    const room = right - left
    const label = [
      `${data.position.label} (${data.position.unit}), dashed = commanded`,
      `${data.position.joint} (${data.position.unit}), dashed = commanded`,
      `${data.position.joint} (${data.position.unit})`,
    ].find((text) => ctx.measureText(text).width <= room) ?? data.position.joint
    ctx.fillText(label, left, stripTop - 4)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(tickLabel(Number((hi - pad).toPrecision(3))), left - 6, yPos(hi - pad))
    ctx.fillText(tickLabel(Number((lo + pad).toPrecision(3))), left - 6, yPos(lo + pad))

    // --- error plot
    const top = MARGIN.top + STRIP_H + GAP
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = look.text3
    ctx.fillText(`|error| (${data.unit}), ${this.scale === 'log' ? 'log scale' : 'linear'}`, left, top - 4)
    const ticks: number[] = []
    if (this.scale === 'log') {
      for (let v = LOG_MIN; v <= LOG_MAX * 1.0001; v *= 10) ticks.push(Number(v.toPrecision(1)))
    } else {
      const max = this.linearMax()
      const step = niceStep(max, 4)
      for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(6)))
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const v of ticks) {
      const y = Math.round(this.yError(v)) + 0.5
      ctx.strokeStyle = look.line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
      ctx.fillStyle = look.text3
      ctx.fillText(tickLabel(v), left - 6, y)
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, top - 1, right - left, MAIN_H + 2)
    ctx.clip()
    ctx.lineWidth = 1.6
    for (const rung of DRAW_ORDER) {
      const trace = data.errors.find((e) => e.rung === rung)
      if (!trace) continue
      ctx.strokeStyle = look.rungs[rung]
      polyline(trace.values, (v) => this.yError(v))
    }
    ctx.restore()

    // --- time axis
    const [t0, t1] = this.span()
    const step = niceStep(t1 - t0, Math.max(2, Math.floor(this.plotW / 70)))
    ctx.fillStyle = look.text3
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
      const x = Math.round(this.x(t)) + 0.5
      ctx.strokeStyle = look.line
      ctx.beginPath()
      ctx.moveTo(x, top + MAIN_H)
      ctx.lineTo(x, top + MAIN_H + 4)
      ctx.stroke()
      ctx.fillText(`${Number(t.toPrecision(3))} s`, x, top + MAIN_H + 6)
    }
    this.dirty = false
  }

  /** Blit the cached traces, then the playhead at t and an optional hover line at time hover. */
  draw(t: number, hover: number | null = null) {
    if (this.dirty) this.drawBase()
    const ctx = this.canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(this.base, 0, 0)
    if (!this.data || !this.look) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const line = (time: number, color: string, width: number, dash: number[]) => {
      const x = Math.round(this.x(time)) + 0.5
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(x, MARGIN.top)
      ctx.lineTo(x, MARGIN.top + STRIP_H + GAP + MAIN_H)
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (hover !== null) line(hover, this.look.text3, 1, [2, 3])
    line(t, this.look.text, 1.5, [])
  }
}
