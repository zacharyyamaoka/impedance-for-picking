// The contact-force strip under the live view: Fz in 1 ms bins (each bin's max, so the impact peak survives), scrolling while a
// pick runs and showing the whole pick once it is over; the impact peak marked, the dwell's mean drawn across the dwell, the
// previous run faded behind, and - when the settings match one of scripts/export_livepick.py's reference runs - the Python's own
// trace dashed on top. Plain canvas 2D.

export interface PlotLook {
  text: string
  muted: string
  grid: string
  band: string
  trace: string
  previous: string
  reference: string
  peak: string
  font: string
}

export interface Trace {
  fz: Float32Array | number[]
  count: number
  /** metric time of bin 0 and the bin width */
  t0: number
  dt: number
}

export interface PlotInput {
  look: PlotLook
  current: Trace | null
  previous: Trace | null
  reference: Trace | null
  /** metric time now (the right edge while scrolling) */
  now: number
  /** null: show [t0, end]; else the scrolling window's width in s */
  windowS: number | null
  startS: number
  endS: number
  dwell: [number, number]
  peak: { t: number; value: number } | null
  dwellMean: number | null
}

function niceStep(span: number, target: number): number {
  const raw = span / target
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power
}

function maxIn(trace: Trace | null, from: number, to: number): number {
  if (!trace) return 0
  let peak = 0
  const first = Math.max(0, Math.floor((from - trace.t0) / trace.dt))
  const last = Math.min(trace.count, Math.ceil((to - trace.t0) / trace.dt) + 1)
  for (let i = first; i < last; i++) if (trace.fz[i] > peak) peak = trace.fz[i]
  return peak
}

export function drawForcePlot(canvas: HTMLCanvasElement, width: number, height: number, input: PlotInput) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const { look } = input
  const left = 40
  const right = 10
  const top = 10
  const bottom = 22
  const plotW = Math.max(10, width - left - right)
  const plotH = Math.max(10, height - top - bottom)
  const x1 = input.windowS == null ? input.endS : Math.max(input.now, input.startS + input.windowS)
  const x0 = input.windowS == null ? input.startS : x1 - input.windowS
  const peakVisible = Math.max(maxIn(input.current, x0, x1), maxIn(input.previous, x0, x1), maxIn(input.reference, x0, x1))
  const yMax = Math.max(10, peakVisible * 1.12)
  const X = (t: number) => left + ((t - x0) / (x1 - x0)) * plotW
  const Y = (f: number) => top + plotH - (f / yMax) * plotH
  ctx.font = `11px ${look.font}`
  ctx.textBaseline = 'middle'
  // the dwell band
  const [d0, d1] = input.dwell
  if (d1 > x0 && d0 < x1) {
    ctx.fillStyle = look.band
    ctx.fillRect(X(Math.max(d0, x0)), top, X(Math.min(d1, x1)) - X(Math.max(d0, x0)), plotH)
  }
  // grid + axis labels
  ctx.strokeStyle = look.grid
  ctx.fillStyle = look.muted
  ctx.lineWidth = 1
  const yStep = niceStep(yMax, 4)
  ctx.textAlign = 'right'
  for (let f = 0; f <= yMax + 1e-9; f += yStep) {
    const y = Math.round(Y(f)) + 0.5
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + plotW, y)
    ctx.stroke()
    ctx.fillText(`${f}`, left - 6, y)
  }
  ctx.save()
  ctx.translate(10, top + plotH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textAlign = 'center'
  ctx.fillText('Fz (N)', 0, 0)
  ctx.restore()
  const xStep = niceStep(x1 - x0, Math.max(3, Math.floor(plotW / 90)))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let t = Math.ceil(x0 / xStep) * xStep; t <= x1 + 1e-9; t += xStep) {
    const x = Math.round(X(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, top + plotH)
    ctx.lineTo(x, top + plotH + 4)
    ctx.stroke()
    ctx.fillText(`${Number(t.toFixed(3))} s`, x, top + plotH + 6)
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top - 2, plotW, plotH + 4)
  ctx.clip()
  const stroke = (trace: Trace | null, color: string, widthPx: number, dash: number[] = []) => {
    if (!trace || !trace.count) return
    ctx.strokeStyle = color
    ctx.lineWidth = widthPx
    ctx.setLineDash(dash)
    ctx.beginPath()
    const first = Math.max(0, Math.floor((x0 - trace.t0) / trace.dt) - 1)
    const last = Math.min(trace.count, Math.ceil((x1 - trace.t0) / trace.dt) + 2)
    // WHY a max per pixel column: thousands of 1 ms bins on a few hundred pixels must not hide the impact spike
    const perPixel = Math.max(1, Math.floor((last - first) / plotW))
    let started = false
    for (let i = first; i < last; i += perPixel) {
      let value = 0
      for (let k = i; k < Math.min(i + perPixel, last); k++) if (trace.fz[k] > value) value = trace.fz[k]
      const x = X(trace.t0 + i * trace.dt)
      const y = Y(value)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
  stroke(input.previous, look.previous, 1.25)
  stroke(input.current, look.trace, 1.75)
  stroke(input.reference, look.reference, 1.25, [5, 4])
  // dwell mean across the dwell
  if (input.dwellMean != null && d1 > x0 && d0 < x1) {
    ctx.strokeStyle = look.text
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    const y = Y(input.dwellMean)
    ctx.beginPath()
    ctx.moveTo(X(Math.max(d0, x0)), y)
    ctx.lineTo(X(Math.min(d1, x1)), y)
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
  // the impact peak
  if (input.peak && input.peak.t >= x0 && input.peak.t <= x1) {
    const x = X(input.peak.t)
    const y = Y(input.peak.value)
    ctx.fillStyle = look.peak
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, 2 * Math.PI)
    ctx.fill()
    ctx.font = `600 11px ${look.font}`
    ctx.textBaseline = 'middle'
    const label = `impact ${input.peak.value.toFixed(1)} N`
    const textWidth = ctx.measureText(label).width
    const toLeft = x + 8 + textWidth > left + plotW
    ctx.textAlign = toLeft ? 'right' : 'left'
    ctx.fillText(label, toLeft ? x - 8 : x + 8, Math.max(top + 8, y))
  }
  if (input.dwellMean != null && d1 > x0 && d0 < x1) {
    ctx.fillStyle = look.text
    ctx.font = `11px ${look.font}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillText(`dwell mean ${input.dwellMean.toFixed(1)} N`, Math.min(X(Math.min(d1, x1)), left + plotW) - 4, Y(input.dwellMean) - 3)
  }
}
