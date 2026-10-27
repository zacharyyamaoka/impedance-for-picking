// <LivePick /> in the built site (vitepress preview or BASE_URL): MuJoCo in a worker, the canvas draws, a pick makes contact, the
// controllers behave as the Python says they do, the side panel resizes and folds, and the phone layout stacks.
// WHY the timings are generous: the pick is 2.85 s of simulated time played in real time, and headless Chrome renders WebGL in software.
import { expect, test } from '@playwright/test'

// WHY relative: under SITE_BASE the site lives below a prefix (playwright.config.mjs), and './' resolves against it
const LIVE = './live.html'

function watchConsole(page) {
  const errors = []
  page.on('console', (message) => {
    // WHY: factorial.json lands from the sim lane (docs/data-contract.md); until then its 404 is the Explorer's expected "not yet"
    if (message.type() === 'error' && !/\/data\/factorial\.json/.test(message.location()?.url ?? '')) errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function ready(page) {
  const root = page.getByTestId('livepick')
  await root.scrollIntoViewIfNeeded()
  await expect(page.getByTestId('livepick-run')).toBeEnabled({ timeout: 60_000 })
  await expect(root.locator('.lp-loading')).toHaveCount(0)
  return root
}

/** Distinct colours in a 32 x 32 grid over the WebGL canvas: a blank (cleared-only) canvas has one. */
async function canvasColours(page) {
  return page.getByTestId('livepick-canvas').evaluate((canvas) => {
    const probe = document.createElement('canvas')
    probe.width = 32
    probe.height = 32
    const ctx = probe.getContext('2d')
    ctx.drawImage(canvas, 0, 0, 32, 32)
    const data = ctx.getImageData(0, 0, 32, 32).data
    const colours = new Set()
    for (let i = 0; i < data.length; i += 4) colours.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`)
    return colours.size
  })
}

async function setSlider(page, testId, position) {
  await page.getByTestId(testId).fill(String(position))
}

async function runPick(page, root) {
  await page.getByTestId('livepick-run').click()
  await expect(root).toHaveAttribute('data-state', 'running')
}

test('the live pick draws, runs a pick and matches the Python reference', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.goto(LIVE)
  const root = await ready(page)
  expect(await canvasColours(page)).toBeGreaterThan(12)
  await runPick(page, root)
  // the arm moves: the time readout advances in (about) real time
  await expect.poll(async () => Number(await root.getAttribute('data-t')), { timeout: 10_000 }).toBeGreaterThan(0.4)
  await expect(root).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
  const impact = Number(await page.getByTestId('livepick-impact').innerText())
  expect(impact).toBeGreaterThan(50)
  // the default settings are one of export_livepick.py's reference runs: the page overlays the Python's trace and numbers
  const python = await page.getByTestId('livepick-python-ref').innerText()
  const pythonImpact = Number(python.match(/([\d.]+) N impact/)[1])
  expect(Math.abs(impact - pythonImpact) / pythonImpact).toBeLessThan(0.02)
  expect(await canvasColours(page)).toBeGreaterThan(12)
  expect(errors).toEqual([])
})

test('torque mode at 100 Hz / 7 ms and high K limit-cycles with the host ceiling off; host spring does not', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.goto(LIVE)
  const root = await ready(page)
  await page.getByTestId('livepick-rate').locator('[data-value="100"]').click()
  await setSlider(page, 'livepick-delay-slider', 7)
  await setSlider(page, 'livepick-kxy-slider', 761) // 10,000 N/m on the log slider
  await setSlider(page, 'livepick-kz-slider', 773) // 3,000 N/m
  await expect(page.getByTestId('livepick-kxy')).toHaveText('10,000')
  await expect(page.getByTestId('livepick-kz')).toHaveText('3,000')
  await page.getByTestId('livepick-controller').locator('[data-value="torque"]').click()
  await page.getByTestId('livepick-guard').uncheck()

  const sawLimitCycle = async () => {
    let seen = false
    await runPick(page, root)
    for (let i = 0; i < 40 && (await root.getAttribute('data-state')) === 'running'; i++) {
      const label = await page.getByTestId('livepick-stability').innerText()
      if (label === 'Limit cycle' || label === 'Diverged') {
        seen = true
        console.log(`t = ${await root.getAttribute('data-t')} s: ${label} - ${await root.locator('.lp-stability-detail').innerText()}`)
      }
      await page.waitForTimeout(100)
    }
    await expect(root).toHaveAttribute('data-state', /done|diverged/, { timeout: 60_000 })
    return seen
  }
  expect(await sawLimitCycle()).toBe(true)

  await page.getByTestId('livepick-controller').locator('[data-value="host_spring"]').click()
  expect(await sawLimitCycle()).toBe(false)
  expect(errors).toEqual([])
})

test('the controls panel resizes by drag, remembers its width and folds', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.goto(LIVE)
  await page.evaluate(() => localStorage.removeItem('livepick.panelWidth'))
  await page.reload()
  await ready(page)
  const panel = page.getByTestId('livepick-panel')
  const split = page.getByTestId('livepick-panel-split')
  const before = (await panel.boundingBox()).width
  const handle = await split.boundingBox()
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2 + 60
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 40, y, { steps: 4 })
  await page.mouse.move(x - 80, y, { steps: 4 })
  await page.mouse.up()
  const after = (await panel.boundingBox()).width
  expect(after - before).toBeGreaterThan(78)
  expect(after - before).toBeLessThan(82)
  await page.reload()
  await ready(page)
  expect(Math.abs((await panel.boundingBox()).width - after)).toBeLessThan(1.5)
  await page.getByTestId('livepick-fold').click()
  await expect(panel).toBeHidden()
  await page.getByTestId('livepick-fold').click()
  await expect(panel).toBeVisible()
})

test('at 390 px the controls stack under the view and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(LIVE)
  await ready(page)
  const stage = await page.getByTestId('livepick-canvas').boundingBox()
  const panel = await page.getByTestId('livepick-panel').boundingBox()
  expect(panel.y).toBeGreaterThan(stage.y + stage.height)
  expect(panel.width).toBeLessThanOrEqual(390)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  expect(await canvasColours(page)).toBeGreaterThan(12)
})

test('the landing page mounts it too and autoruns a pick once in view', async ({ page }) => {
  const errors = watchConsole(page)
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.goto('./')
  const root = await ready(page)
  await expect(root).toHaveAttribute('data-state', /running|done/, { timeout: 30_000 })
  expect(errors).toEqual([])
})
