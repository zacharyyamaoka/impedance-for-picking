// <ArmLab /> on the BUILT site: it mounts, the arm follows a dragged target, a mode switch moves the torque between the board
// and the host, TORQUE at 100 Hz / 7 ms with high K goes unstable while HOST_SPRING holds, the panel boundary drags and is
// remembered, the phone layout stacks, and nothing throws.
//
//   pnpm --dir /home/bam/impedance-controller-website exec vitepress build site
//   pnpm --dir /home/bam/impedance-controller-website exec playwright test tests/armlab.spec.mjs
//
// ARMLAB_MEDIA=1 also records the report's screenshots and demo clip into reports/media/armlab/ (the "media" test).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MEDIA = join(ROOT, 'reports', 'media', 'armlab')

/** Collect page exceptions and console errors; resource 404s are listed apart (ArmLab itself fetches nothing). */
function watchErrors(page) {
  const errors = []
  const failedResources = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (message.text().startsWith('Failed to load resource')) return
    errors.push(`console: ${message.text()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`)
  })
  return { errors, failedResources }
}

async function openLab(page) {
  await page.goto('/', { waitUntil: 'networkidle' })
  // the landing page's sticky bars would cover the lab in screenshots and swallow clicks near its top edge
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('body *')) {
      const position = getComputedStyle(element).position
      if ((position === 'sticky' || position === 'fixed') && !element.closest('[data-testid=arm-lab]')) element.style.visibility = 'hidden'
    }
  })
  const lab = page.getByTestId('arm-lab')
  await lab.scrollIntoViewIfNeeded()
  await expect(page.getByTestId('arm-lab-canvas')).toBeVisible()
  await page.waitForFunction(() => window.__armLab && window.__armLab.snapshot() && window.__armLab.lab.t > 0.3)
  return lab
}

const snapshot = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__armLab.snapshot())))
const simTime = (page) => page.evaluate(() => window.__armLab.lab.t)

/** wait for `seconds` of SIMULATED time (headless frames are slow; the sim runs ~real time on a laptop) */
async function waitSim(page, seconds) {
  const start = await simTime(page)
  await page.waitForFunction((target) => window.__armLab.lab.t >= target, start + seconds, { timeout: 60_000 })
}

/** drag on the stage from one fraction of the canvas to another */
async function dragStage(page, from, to, steps = 12) {
  const canvas = page.getByTestId('arm-lab-canvas')
  await canvas.scrollIntoViewIfNeeded() // on a phone the lab is taller than the screen
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps })
  await page.mouse.up()
}

/** the canvas fraction of a world point (the stage's view transform) */
async function worldToFraction(page, x, z) {
  return page.evaluate(([px, pz]) => {
    const canvas = document.querySelector('[data-testid=arm-lab-canvas]')
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const world = { xMin: -0.24, xMax: 0.8, zMin: -0.42, zMax: 0.38 }
    const scale = Math.min(width / (world.xMax - world.xMin), height / (world.zMax - world.zMin))
    const offsetX = (width - scale * (world.xMax - world.xMin)) / 2 - scale * world.xMin
    const offsetY = (height - scale * (world.zMax - world.zMin)) / 2 + scale * world.zMax
    return [(offsetX + scale * px) / width, (offsetY - scale * pz) / height]
  }, [x, z])
}

test.describe('ArmLab, desktop', () => {
  test.use({ viewport: { width: 1400, height: 1000 } })

  test('mounts, follows a dragged target, presses into the belt', async ({ page }) => {
    const watched = watchErrors(page)
    await openLab(page)
    const before = await snapshot(page)
    // drag the ghost from the tool to 3 cm into the belt, 10 cm to the left
    const from = await worldToFraction(page, ...before.tool)
    const to = await worldToFraction(page, before.tool[0] - 0.1, -0.33)
    await dragStage(page, from, to)
    const target = (await snapshot(page)).target
    expect(Math.abs(target[1] - -0.33)).toBeLessThan(0.01)
    await waitSim(page, 2.5)
    const after = await snapshot(page)
    const moved = Math.hypot(after.tool[0] - before.tool[0], after.tool[1] - before.tool[1])
    console.log(`tool moved ${(moved * 1000).toFixed(0)} mm to (${after.tool.map((v) => v.toFixed(3))}), contact ${after.contactForce.toFixed(1)} N`)
    expect(moved).toBeGreaterThan(0.06)
    expect(Math.abs(after.tool[0] - (before.tool[0] - 0.1))).toBeLessThan(0.02)
    expect(after.contactForce).toBeGreaterThan(5) // the target sits in the belt: the tool presses on it
    // off-screen, the simulation pauses
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(400)
    const parked = await simTime(page)
    await page.waitForTimeout(1200)
    expect(await simTime(page)).toBe(parked)
    expect(watched.errors).toEqual([])
    if (watched.failedResources.length) console.log(`resources that failed (not ArmLab's): ${watched.failedResources.join(', ')}`)
  })

  test('a mode switch moves the torque between the board PD and the host', async ({ page }) => {
    const watched = watchErrors(page)
    await openLab(page)
    await page.getByTestId('mode-stiff').click()
    const start = await snapshot(page)
    await dragStage(page, await worldToFraction(page, ...start.tool), await worldToFraction(page, start.tool[0], -0.33))
    await waitSim(page, 2)
    await page.evaluate(() => window.__armLab.snapshot())
    const stiff = (await snapshot(page)).torque
    await page.getByTestId('mode-torque').click()
    await waitSim(page, 1.5)
    const torque = (await snapshot(page)).torque
    const pdShare = (split) => split.reduce((sum, joint) => sum + Math.abs(joint.boardPd), 0)
    const hostShare = (split) => split.reduce((sum, joint) => sum + Math.abs(joint.hostFf), 0)
    console.log(`stiff: board PD ${pdShare(stiff).toFixed(2)} N.m, host ${hostShare(stiff).toFixed(2)}; torque: board PD ${pdShare(torque).toFixed(2)}, host ${hostShare(torque).toFixed(2)}`)
    expect(pdShare(stiff)).toBeGreaterThan(1)
    expect(hostShare(stiff)).toBeLessThan(0.01)
    expect(pdShare(torque)).toBe(0)
    expect(hostShare(torque)).toBeGreaterThan(1)
    // the bars show it too
    const boardBar = page.locator('[data-joint=shoulder] [data-term=pd]')
    await expect(boardBar).toHaveAttribute('data-value', /^-?0\.000$/)
    expect(watched.errors).toEqual([])
  })

  test('TORQUE at 100 Hz / 7 ms with high K goes unstable; HOST_SPRING holds', async ({ page }) => {
    const watched = watchErrors(page)
    await openLab(page)
    await page.getByTestId('preset-unstable').click()
    await waitSim(page, 0.5)
    const home = await snapshot(page)
    expect(home.settings).toMatchObject({ mode: 'torque', kx: 5000, kz: 5000, hostRateHz: 100, delayMs: 7 })
    await dragStage(page, await worldToFraction(page, ...home.tool), await worldToFraction(page, home.tool[0] - 0.06, home.tool[1] + 0.04))
    await waitSim(page, 3)
    const torque = await snapshot(page)
    await expect(page.getByTestId('arm-lab-warning')).toHaveAttribute('data-status', 'unstable')
    await page.getByTestId('mode-host_spring').click()
    await page.getByTestId('reset').click()
    await waitSim(page, 0.5)
    const again = await snapshot(page)
    await dragStage(page, await worldToFraction(page, ...again.tool), await worldToFraction(page, again.tool[0] - 0.06, again.tool[1] + 0.04))
    await waitSim(page, 3)
    const hostSpring = await snapshot(page)
    console.log(`torque: oscillation ${(torque.ripple * 1000).toFixed(0)} mm/s, wn ${torque.ceiling.jointWn.map((v) => v.toFixed(0))} vs ceiling ${torque.ceiling.wnCeiling.toFixed(1)}; ` +
      `host_spring: oscillation ${(hostSpring.ripple * 1000).toFixed(1)} mm/s, ceiling ${hostSpring.ceiling.wnCeiling.toFixed(1)}, s ${hostSpring.stiffnessScale.toFixed(2)}`)
    expect(torque.ceiling.status).toBe('unstable')
    expect(torque.ripple).toBeGreaterThan(0.1)
    expect(hostSpring.settings.kx).toBe(5000)
    expect(hostSpring.ceiling.status).toBe('ok')
    expect(hostSpring.ripple).toBeLessThan(0.02)
    await expect(page.getByTestId('arm-lab-warning')).toHaveCount(0)
    expect(watched.errors).toEqual([])
  })

  test('the panel boundary drags and the width is remembered', async ({ page }) => {
    await openLab(page)
    const panel = page.getByTestId('arm-lab-panel')
    const splitter = page.getByTestId('arm-lab-splitter')
    const before = (await panel.boundingBox()).width
    const handle = await splitter.boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 80, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()
    const after = (await panel.boundingBox()).width
    const stageAfter = (await page.getByTestId('arm-lab-canvas').boundingBox()).width
    console.log(`panel ${before.toFixed(1)} -> ${after.toFixed(1)} px (dragged 80 px), stage ${stageAfter.toFixed(0)} px`)
    expect(after - before).toBeGreaterThan(77)
    expect(after - before).toBeLessThan(83)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('arm-lab').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => window.__armLab)
    const reloaded = (await page.getByTestId('arm-lab-panel').boundingBox()).width
    console.log(`after reload: panel ${reloaded.toFixed(1)} px`)
    expect(Math.abs(reloaded - after)).toBeLessThan(2)
    await page.evaluate(() => localStorage.removeItem('armlab-panel-width'))
  })
})

test.describe('ArmLab, phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true })

  test('stacks, fits the width, and the target still drags', async ({ page }) => {
    const watched = watchErrors(page)
    const lab = await openLab(page)
    await expect(page.getByTestId('arm-lab-splitter')).toBeHidden()
    const labBox = await lab.boundingBox()
    const canvasBox = await page.getByTestId('arm-lab-canvas').boundingBox()
    const panelBox = await page.getByTestId('arm-lab-panel').boundingBox()
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    console.log(`phone: lab ${labBox.width.toFixed(0)} px wide, canvas ${canvasBox.width.toFixed(0)}x${canvasBox.height.toFixed(0)}, panel below at y ${panelBox.y.toFixed(0)}, page scrollWidth ${scrollWidth}`)
    expect(scrollWidth).toBeLessThanOrEqual(390)
    expect(labBox.x + labBox.width).toBeLessThanOrEqual(390)
    expect(panelBox.y).toBeGreaterThan(canvasBox.y + canvasBox.height) // the controls sit below the stage
    expect(Math.abs(panelBox.width - labBox.width)).toBeLessThan(4)
    const before = await snapshot(page)
    await dragStage(page, await worldToFraction(page, ...before.tool), await worldToFraction(page, before.tool[0] - 0.08, before.tool[1] + 0.05))
    await waitSim(page, 2)
    const after = await snapshot(page)
    expect(Math.hypot(after.tool[0] - before.tool[0], after.tool[1] - before.tool[1])).toBeGreaterThan(0.05)
    expect(watched.errors).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------ media for the report
test.describe('media', () => {
  test.skip(!process.env.ARMLAB_MEDIA, 'set ARMLAB_MEDIA=1 to record the report media')
  test.setTimeout(240_000)

  test('desktop and phone screenshots', async ({ browser }) => {
    mkdirSync(MEDIA, { recursive: true })
    const desktop = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    const lab = await openLab(desktop)
    await desktop.getByTestId('preset-press').click()
    await waitSim(desktop, 3)
    await lab.screenshot({ path: join(MEDIA, 'desktop-press.png') })
    await desktop.getByTestId('preset-approach').click()
    await waitSim(desktop, 5.5)
    await lab.screenshot({ path: join(MEDIA, 'desktop-approach-fast-vs-slow.png') })
    await desktop.getByTestId('preset-push').click()
    await desktop.getByTestId('mode-joint').click()
    await waitSim(desktop, 1.3)
    await lab.screenshot({ path: join(MEDIA, 'desktop-joint-push.png') })
    await desktop.getByTestId('preset-unstable').click()
    await waitSim(desktop, 0.4)
    const home = await snapshot(desktop)
    await dragStage(desktop, await worldToFraction(desktop, ...home.tool), await worldToFraction(desktop, home.tool[0] - 0.06, home.tool[1] + 0.04))
    await waitSim(desktop, 2.5)
    await lab.screenshot({ path: join(MEDIA, 'desktop-torque-unstable.png') })
    await desktop.close()
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true })
    const phoneLab = await openLab(phone)
    await phone.getByTestId('preset-press').click()
    await waitSim(phone, 3)
    await phoneLab.screenshot({ path: join(MEDIA, 'phone-press.png') })
    await phone.screenshot({ path: join(MEDIA, 'phone-viewport.png') })
    await phone.close()
  })

  test('demo clip (~12 s, muted mp4)', async ({ browser }) => {
    mkdirSync(MEDIA, { recursive: true })
    const raw = join(MEDIA, 'raw-video')
    rmSync(raw, { recursive: true, force: true })
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, recordVideo: { dir: raw, size: { width: 1400, height: 1000 } } })
    const page = await context.newPage()
    const videoStart = Date.now()
    const lab = await openLab(page)
    await page.evaluate(() => window.scrollBy(0, document.querySelector('[data-testid=arm-lab]').getBoundingClientRect().top - 8))
    const box = await lab.boundingBox()
    const begin = Date.now()
    const stamp = () => (Date.now() - begin) / 1000
    const cues = []
    const home = await snapshot(page)
    await page.waitForTimeout(800)
    cues.push(['drag into the belt', stamp()])
    await dragStage(page, await worldToFraction(page, ...home.tool), await worldToFraction(page, home.tool[0] - 0.04, -0.33), 10)
    await page.waitForTimeout(1500)
    cues.push(['stiff joint PD', stamp()])
    await page.getByTestId('mode-stiff').click()
    await page.waitForTimeout(1800)
    cues.push(['torque at 100 Hz / 7 ms, K 5000', stamp()])
    await page.getByTestId('preset-unstable').click()
    await page.waitForTimeout(400)
    const before = await snapshot(page)
    await dragStage(page, await worldToFraction(page, ...before.tool), await worldToFraction(page, before.tool[0] - 0.06, before.tool[1] + 0.04), 8)
    await page.waitForTimeout(2600)
    cues.push(['host spring', stamp()])
    await page.getByTestId('mode-host_spring').click()
    await page.waitForTimeout(2200)
    const lead = (begin - videoStart) / 1000 // the page load before the first cue: trimmed off
    await context.close()
    const webm = readdirSync(raw).find((name) => name.endsWith('.webm'))
    const out = join(MEDIA, 'armlab-demo.mp4')
    // crop to the component, 30 fps, H.264 for any browser, no audio track
    const crop = `crop=${Math.floor(box.width / 2) * 2}:${Math.floor(Math.min(box.height, 1000 - box.y) / 2) * 2}:${Math.round(box.x)}:${Math.round(box.y)}`
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', lead.toFixed(2), '-i', join(raw, webm), '-vf', `${crop},scale=1120:-2,fps=30`, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
    const gif = join(MEDIA, 'armlab-demo.gif')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-vf', 'fps=10,scale=560:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer', gif])
    rmSync(raw, { recursive: true, force: true })
    const size = statSync(out).size
    console.log(`clip ${out}: ${(size / 1e6).toFixed(2)} MB; cues ${JSON.stringify(cues)}; gif ${(statSync(gif).size / 1e6).toFixed(2)} MB (trimmed ${lead.toFixed(1)} s of page load)`)
    expect(size).toBeLessThan(3e6)
    expect(existsSync(out)).toBe(true)
  })
})
