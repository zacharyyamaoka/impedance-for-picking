// The landing page, driven in a real (headless) Chrome against the BUILT site (vitepress preview, playwright.config.mjs).
// Run: pnpm --dir /home/bam/impedance-controller-website run build, then pnpm --dir /home/bam/impedance-controller-website exec playwright test tests/landing.spec.mjs
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'media')
const SECTIONS = ['overview', 'problem', 'how', 'demo', 'board', 'impact', 'explorer', 'joints', 'fingers', 'results', 'tuning', 'crisp', 'verification', 'reproduce']
const VARIANTS = ['crisp', 'scope', 'editorial']

// Third-party font CSS may be unreachable offline; that is not the page's error. The hand study's files land from another lane
// (docs/data-contract.md): until they do, their 404s are the expected "not there yet", and the page shows a placeholder. The same
// holds for factorial.json (the Explorer and the joint-loads section) and the v2 hand study's replay tapes.
const IGNORED = [/fonts\.googleapis\.com/, /fonts\.gstatic\.com/, /\/data\/hand(-[^/]*)?\.json/, /\/models\/arm_hand\.xml/, /\/data\/factorial\.json/]

function collectErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = `${message.text()} ${message.location()?.url ?? ''}`
    if (!IGNORED.some((pattern) => pattern.test(text))) errors.push(`console: ${text}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !IGNORED.some((pattern) => pattern.test(response.url()))) errors.push(`http ${response.status()}: ${response.url()}`)
  })
  return errors
}

/** Share of a screenshot's pixels that differ clearly from its corner pixel (the pane background). */
async function inkShare(page, locator) {
  const png = (await locator.screenshot()).toString('base64')
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const { data: px } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const bg = [px[0], px[1], px[2]]
    let ink = 0
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 40) ink++
    }
    return ink / (px.length / 4)
  }, png)
}

async function useVariant(page, variant) {
  await page.addInitScript((v) => {
    try {
      localStorage.setItem('impedance-variant', v)
    } catch {}
  }, variant)
}

test('every section renders, with no console errors', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('./')
  for (const id of SECTIONS) {
    const section = page.locator(`main.lp > section#${id}`)
    await expect(section, id).toHaveCount(1)
    await section.scrollIntoViewIfNeeded()
    await expect(section.locator('h1, h2').first(), `${id} heading`).toBeVisible()
    const text = (await section.innerText()).trim()
    expect(text.length, `${id} has content`).toBeGreaterThan(200)
  }
  // the step bar lists every section, and lights the one in view
  await expect(page.locator('.step-bar li')).toHaveCount(SECTIONS.length)
  await page.locator('.step-bar li[data-step="results"] a').click()
  await expect(page.locator('.step-bar li.on')).toHaveAttribute('data-step', 'results')
  // the numbers come from site.json: the headline tiles are filled, never a dash
  const tiles = await page.locator('.tile b').allInnerTexts()
  expect(tiles.length).toBe(4)
  for (const tile of tiles) expect(tile).not.toContain('—')
  // hardware readiness is stated, and stated as not met
  await expect(page.getByTestId('readiness')).toContainText('NOT met')
  expect(errors).toEqual([])
})

test('the hero video loads', async ({ page }) => {
  await page.goto('./')
  const video = page.getByTestId('hero-video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  const meta = await video.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, d: v.duration, muted: v.muted, loop: v.loop, poster: v.poster }))
  expect(meta.w).toBeGreaterThan(0)
  expect(meta.d).toBeGreaterThan(1)
  expect(meta.muted).toBe(true)
  expect(meta.loop).toBe(true)
  expect(meta.poster).toContain('hero-poster.png')
})

test('the replay draws the recorded runs in WebGL, plays, and switches the surface', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('./#demo')
  const replay = page.getByTestId('pick-replay')
  await replay.scrollIntoViewIfNeeded()
  await expect(replay).toHaveAttribute('data-ready', 'true', { timeout: 90_000 })
  const views = replay.locator('.view')
  await expect(views).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    const share = await inkShare(page, views.nth(i))
    expect(share, `pane ${i + 1}: the arm, tool and belt are drawn, not just the clear colour`).toBeGreaterThan(0.05)
  }
  // the touch peaks are the comparison's own numbers (results.json, re-run bit-identical by the exporter)
  await expect(replay.locator('.pane[data-row="stiff"] .facts')).toContainText('178 N')
  await expect(replay.locator('.pane[data-row="spring + host_spring"] .facts')).toContainText('38 N')
  // the clock advances while playing
  const clock = page.getByTestId('replay-clock')
  const before = await clock.textContent()
  if ((await page.getByTestId('replay-play').textContent())?.trim() === 'Play') await page.getByTestId('replay-play').click()
  await expect.poll(() => clock.textContent(), { timeout: 10_000 }).not.toBe(before)
  // +20 mm: the stiff row's touch peak is that run's (172 N)
  await replay.getByRole('radio', { name: '+20 mm' }).click()
  await expect(replay.locator('.pane[data-row="stiff"] .facts')).toContainText('172 N')
  expect(errors).toEqual([])
})

test('all three design directions switch, and the choice is remembered', async ({ page }) => {
  await page.goto('./')
  const backgrounds = new Set()
  for (const [index, variant] of VARIANTS.entries()) {
    await page.locator('.pt-switcher .chip').click()
    await page.locator('.pt-switcher .menu button').nth(index).click()
    await expect(page.locator('html')).toHaveAttribute('data-variant', variant)
    backgrounds.add(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pt-bg').trim()))
    const display = await page.locator('main.lp h1').evaluate((h) => getComputedStyle(h).fontFamily)
    expect(display.length).toBeGreaterThan(0)
  }
  expect(backgrounds.size, 'each direction has its own background').toBe(3)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-variant', 'editorial')
})

test('the ceiling chart is the exported table and answers the controls', async ({ page }) => {
  await page.goto('./#board')
  const chart = page.getByTestId('ceiling-chart')
  await chart.scrollIntoViewIfNeeded()
  // 100 Hz / 7 ms: stability.host_wn_ceiling's 55.7 and 233.6 rad/s, x4.2 / x17.6
  await expect(chart.locator('.readout')).toContainText('55.7 rad/s')
  await expect(chart.locator('.readout')).toContainText('233.6 rad/s')
  await expect(chart.locator('.readout')).toContainText('×4.2')
  await chart.getByRole('radio', { name: '1000 Hz' }).click()
  await expect(chart.locator('.readout')).not.toContainText('55.7 rad/s')
  await chart.locator('input.scrub').evaluate((input) => {
    input.value = '0'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(chart.locator('.readout')).toContainText('0 ms')
})

test('the soft / rigid switch swaps the ablation ladder and the arm builds together', async ({ page }) => {
  await page.goto('./#impact')
  const ladder = page.getByTestId('ablation-ladder')
  await ladder.scrollIntoViewIfNeeded()
  await expect(ladder).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 })
  const toggle = page.locator('#impact').getByTestId('object-toggle')
  await toggle.locator('[data-object="rigid"]').click()
  const builds = page.getByTestId('builds-chart')
  const buildsRigid = await builds.locator('.val').first().innerText()
  if ((await ladder.getAttribute('data-state')) === 'data') {
    await expect(ladder.locator('.rung')).toHaveCount(6)
    const rigid = await ladder.locator('.rung[data-rung="R0"] .num b').first().innerText()
    await toggle.locator('[data-object="soft"]').click()
    await expect(ladder.locator('.rung[data-rung="R0"] .num b').first()).not.toHaveText(rigid)
  } else {
    await expect(ladder.locator('.pending-note')).toBeVisible()
    await toggle.locator('[data-object="soft"]').click()
  }
  await expect(builds.locator('.val').first()).not.toHaveText(buildsRigid)
  // one state for the page: the hand study's switch follows
  await expect(page.locator('#fingers').getByTestId('object-toggle').locator('[data-object="soft"]')).toHaveAttribute('aria-checked', 'true')
})

test('the hand study renders a contract-shaped hand.json (fixture until the sim lane lands it)', async ({ page }) => {
  const errors = collectErrors(page)
  // WHY a fixture: docs/data-contract.md freezes the shape; this proves the component reads it, before the real file exists
  await page.route('**/data/hand.json', (route) => route.fulfill({ path: join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hand.fixture.json'), contentType: 'application/json' }))
  await page.goto('./#fingers')
  const hand = page.getByTestId('hand-study')
  await hand.scrollIntoViewIfNeeded()
  await expect(hand).toHaveAttribute('data-state', 'data')
  await expect(hand.locator('.case')).toHaveCount(3)
  await expect(hand.locator('.summary')).toContainText('H2')
  const rigid = await hand.locator('.case[data-case="H0"] .nums').innerText()
  await page.locator('#fingers').getByTestId('object-toggle').locator('[data-object="soft"]').click()
  await expect(hand.locator('.case[data-case="H0"] .nums')).not.toHaveText(rigid)
  expect(errors).toEqual([])
})

test('the hand study renders a v2 hand.json: rigid fingers with compliant joints, contact models, the H-cases folded', async ({ page }) => {
  const errors = collectErrors(page)
  // WHY a fixture: docs/data-contract.md "hand.json v2 additions" freezes the shape; scripts/make_fixtures.py writes it
  await page.route('**/data/hand.json', (route) => route.fulfill({ path: join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hand2.fixture.json'), contentType: 'application/json' }))
  await page.goto('./#fingers')
  const hand = page.getByTestId('hand-study')
  await hand.scrollIntoViewIfNeeded()
  await expect(hand).toHaveAttribute('data-state', 'data')
  await expect(hand.getByTestId('hand-answer')).toContainText('compliant finger joints')
  // the soft arm first: J0 rigid, two virtual-spring stiffnesses, one series-elastic
  await expect(hand.locator('.jcase')).toHaveCount(4)
  await expect(hand.locator('.jgroup')).toHaveCount(3)
  await expect(hand.locator('.jcase[data-case="J1-k500-arm_soft"] .travel .tbar')).toHaveCount(4)
  await expect(hand.getByTestId('hand-kchart').locator('circle')).toHaveCount(3)
  await expect(hand.getByTestId('hand-metrics')).toContainText('60 ms after first touch')
  // the stiff arm: only the rigid-joint case in the fixture
  await hand.locator('[data-arm="stiff"]').click()
  await expect(hand.locator('.jcase')).toHaveCount(1)
  // the contact models: the chosen one marked, the finding stated
  const models = hand.getByTestId('contact-models')
  await expect(models.locator('tbody tr')).toHaveCount(2)
  await expect(models.locator('tr.chosen')).toContainText('Hunt-Crossley')
  // the first study's H-cases sit folded underneath, and still answer the object switch
  const legacy = hand.getByTestId('hand-legacy')
  await legacy.locator('summary').click()
  await expect(legacy.locator('.case')).toHaveCount(3)
  const before = await hand.locator('.jcase').first().locator('.nums').innerText()
  await page.locator('#fingers').getByTestId('object-toggle').locator('[data-object="soft"]').click()
  await expect(hand.locator('.jcase').first().locator('.nums')).not.toHaveText(before)
  expect(errors).toEqual([])
})

test('390 px phone: no horizontal scroll and nothing pokes out of the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const variant of VARIANTS) {
    await useVariant(page, variant)
    await page.goto('./')
    await page.waitForLoadState('networkidle')
    const result = await page.evaluate(() => {
      const width = window.innerWidth
      const offenders = []
      for (const el of document.querySelectorAll('main.lp *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.right <= width + 1) continue
        // inside a box that scrolls sideways on its own (tables, the step bar, code) is fine. WHY not hidden / clip too: <html> clips
        // overflow-x, so counting a clipping ancestor would excuse content that is simply cut off (mutation-checked: a 700 px div in a
        // card passed the first version of this gate)
        let scroller = false
        for (let a = el.parentElement; a; a = a.parentElement) {
          const o = getComputedStyle(a).overflowX
          if (o === 'auto' || o === 'scroll') {
            if (a.getBoundingClientRect().right <= width + 1) scroller = true
            break
          }
        }
        if (!scroller) offenders.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(r.right)}`)
      }
      return { scrollWidth: document.documentElement.scrollWidth, width, offenders: offenders.slice(0, 10) }
    })
    expect(result.scrollWidth, `${variant}: page scroll width`).toBeLessThanOrEqual(result.width)
    expect(result.offenders, `${variant}: elements past the right edge`).toEqual([])
  }
})

test('screenshots of each direction, desktop and phone (review media)', async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  const views = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ]
  for (const variant of VARIANTS) {
    for (const scheme of ['light', 'dark']) {
      for (const view of views) {
        if (scheme === 'dark' && view.name === 'phone' && variant !== 'scope') continue
        const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: scheme })
        const page = await context.newPage()
        await useVariant(page, variant)
        await page.goto('./')
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: join(SHOTS, `landing-${variant}-${scheme}-${view.name}-hero.png`) })
        for (const id of ['demo', 'impact', 'results']) {
          await page.evaluate((id) => {
            const el = document.getElementById(id)
            const header = (document.querySelector('.VPNav')?.getBoundingClientRect().height ?? 0) + (document.querySelector('.step-bar')?.getBoundingClientRect().height ?? 0)
            window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (window.innerWidth >= 960 ? header : 48) - 8)
          }, id)
          if (id === 'demo') await expect(page.getByTestId('pick-replay')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 })
          await page.waitForTimeout(id === 'demo' ? 1500 : 500)
          await page.screenshot({ path: join(SHOTS, `landing-${variant}-${scheme}-${view.name}-${id}.png`) })
        }
        await context.close()
      }
    }
  }
})
