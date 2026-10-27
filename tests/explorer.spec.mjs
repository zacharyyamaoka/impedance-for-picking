// The Explorer, the joint-loads section and the ablation ladder's factor swap, driven in headless Chrome against the BUILT site, on a
// contract-shaped factorial.json (tests/fixtures/factorial.fixture.json, scripts/make_fixtures.py) until the sim lane lands the real
// one. Run: pnpm --dir /home/bam/impedance-controller-website exec playwright test tests/explorer.spec.mjs
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', 'reports', 'media')
const FIXTURE = join(HERE, 'fixtures', 'factorial.fixture.json')
const IGNORED = [/fonts\.googleapis\.com/, /fonts\.gstatic\.com/, /\/data\/hand(-[^/]*)?\.json/, /\/models\/arm_hand\.xml/]

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

// WHY a fixture: docs/data-contract.md freezes factorial.json's shape; this proves the page reads it before the real file exists
async function useFixture(page) {
  await page.route('**/data/factorial.json', (route) => route.fulfill({ path: FIXTURE, contentType: 'application/json' }))
}

async function openExplorer(page) {
  await page.goto('./#explorer')
  const explorer = page.getByTestId('explorer')
  await explorer.scrollIntoViewIfNeeded()
  await expect(explorer).toHaveAttribute('data-state', 'data')
  await expect(explorer).toHaveAttribute('data-status', 'ready')
  return explorer
}

const rows = (explorer) => explorer.locator('#ix-runs tr.dv-row')
const detail = (page) => page.getByTestId('explorer-detail')
const tab = (explorer, name) => explorer.locator(`#ix-runs .dv-tab[data-name="${name}"]`)

test('the explorer lists all 120 runs, filters by factor, sorts, stars flagged rows', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  const explorer = await openExplorer(page)
  await expect(explorer.locator('#ix-runs .dv-status')).toContainText('120 of 120')
  // one value group per factor in the filter rail, plus "held the checks"
  for (const p of ['build', 'controller', 'approach', 'spring', 'object']) await expect(explorer.locator(`data-facets [data-p="${p}"]`).first()).toBeVisible()
  // flagged rows are starred
  await expect(rows(explorer).filter({ hasText: '★' }).first()).toBeVisible()
  // filter: QDD only -> 40 runs, all QDD
  await explorer.locator('data-facets input[data-p="build"][data-value="QDD 10:1"]').check()
  await expect(explorer.locator('#ix-runs .dv-status')).toContainText('40 of 120')
  for (const text of await rows(explorer).locator('td[data-col="build"]').allInnerTexts()) expect(text).toBe('QDD 10:1')
  await explorer.locator('data-facets input[data-p="build"][data-value="QDD 10:1"]').uncheck()
  await expect(explorer.locator('#ix-runs .dv-status')).toContainText('120 of 120')
  // sort: by touch peak, both ways, the first row is the extreme
  const header = explorer.locator('#ix-runs th[data-sort="touch_peak_n"]')
  const firstTouch = async () => parseFloat((await rows(explorer).first().locator('td[data-col="touch_peak_n"]').innerText()).replace(/[^\d.]/g, ''))
  await header.click()
  const a = await firstTouch()
  await header.click()
  const b = await firstTouch()
  expect(Math.max(a, b)).toBeGreaterThan(150)
  expect(Math.min(a, b)).toBeLessThan(20)
  expect(errors).toEqual([])
})

test("Zach's named views: worst case, + impedance only, + QDD + impedance, best, every controller on the worst arm", async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  const explorer = await openExplorer(page)
  const chips = () => detail(page).locator('.combo-col[data-side="a"] .fchip, .combo-col:not([data-side="b"]) .fchip').allInnerTexts()

  await tab(explorer, 'Worst case').click()
  await expect(rows(explorer)).toHaveCount(2)
  await expect.poll(chips).toEqual(expect.arrayContaining(['UR-style (harmonic drive)', 'Stiff position control', 'Fast (0.2 m/s)', 'No spring']))

  await tab(explorer, 'Worst case + impedance only').click()
  await expect(rows(explorer)).toHaveCount(2)
  await expect.poll(chips).toEqual(expect.arrayContaining(['UR-style (harmonic drive)', 'HOST_SPRING (impedance)', 'Fast (0.2 m/s)']))

  await tab(explorer, 'Worst case + QDD + impedance').click()
  await expect(rows(explorer)).toHaveCount(2)
  await expect.poll(chips).toEqual(expect.arrayContaining(['QDD 10:1', 'HOST_SPRING (impedance)', 'Fast (0.2 m/s)', 'No spring']))
  // the panel reads that run's own numbers (the table's row for it), never the previous view's
  const loadCell = await rows(explorer).filter({ hasText: 'rigid' }).first().locator('td[data-col="max_gear_load"]').innerText()
  await expect(detail(page).locator('[data-fact="load"] td').first()).toHaveText(`×${parseFloat(loadCell.replace(/[^\d.]/g, '')).toFixed(2)}`)

  await tab(explorer, 'Best combination').click()
  await expect(rows(explorer)).toHaveCount(10)
  for (const text of await rows(explorer).locator('td[data-col="name"]').allInnerTexts()) expect(text).not.toContain('★')

  await tab(explorer, 'Every controller on the worst arm').click()
  await expect(rows(explorer)).toHaveCount(10)
  const controllers = new Set(await rows(explorer).locator('td[data-col="controller"]').allInnerTexts())
  expect(controllers.size).toBe(5)
  expect(errors).toEqual([])
})

test('a row opens its traces in the detail panel; "compare to" shows two runs side by side', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  const explorer = await openExplorer(page)
  await tab(explorer, 'Every controller on the worst arm').click()
  const target = rows(explorer).filter({ hasText: 'host_spring' }).first()
  await target.locator('td').first().click()
  // the kit's own peek stays shut: the panel beside the table is the detail
  await expect(explorer.locator('#ix-runs .dv-peek')).toBeHidden()
  const card = detail(page).getByTestId('run-card')
  await expect(card).toHaveAttribute('data-pair', 'false')
  await expect(card.locator('.fchip').filter({ hasText: 'HOST_SPRING (impedance)' })).toBeVisible()
  await expect(card.locator('.fz-spark path.trace')).toHaveCount(1)
  await expect(card.locator('.joint-traces .jt-row')).toHaveCount(6)
  await expect(card.locator('.gear-bars .gb-row')).toHaveCount(6)
  // pin it as A, pick the stiff run as B
  await detail(page).getByTestId('pin-run').click()
  await rows(explorer).filter({ hasText: 'ur5e · stiff' }).first().locator('td').first().click()
  await expect(card).toHaveAttribute('data-pair', 'true')
  await expect(card.locator('.combo-col')).toHaveCount(2)
  await expect(card.locator('.fchip.diff')).toHaveCount(2)
  await expect(card.locator('.fz-spark path.trace')).toHaveCount(2)
  await expect(card.locator('thead th')).toHaveCount(4)
  const aTouch = await card.locator('[data-fact="touch"] td').nth(0).innerText()
  await detail(page).getByTestId('swap-pair').click()
  await expect(card.locator('[data-fact="touch"] td').nth(1)).toHaveText(aTouch)
  await detail(page).getByTestId('unpin-run').click()
  await expect(card).toHaveAttribute('data-pair', 'false')
  expect(errors).toEqual([])
})

test("the detail panel's edge drags (measured) and the width is remembered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  const explorer = await openExplorer(page)
  const panel = detail(page)
  const handle = page.locator('#ix-detail + .dv-splitter')
  await expect(handle).toBeVisible()
  const box = async (locator) => locator.evaluate((el) => el.getBoundingClientRect().toJSON())
  const before = await box(panel)
  const table = await box(explorer.locator('#ix-runs'))
  const h = await box(handle)
  // the handle sits on the panel's left edge
  expect(Math.abs(h.x + h.width / 2 - before.left)).toBeLessThan(4)
  await page.mouse.move(h.x + h.width / 2, h.y + 40)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 - 60, h.y + 40, { steps: 4 })
  await page.mouse.move(h.x + h.width / 2 - 150, h.y + 40, { steps: 6 })
  await page.mouse.up()
  const after = await box(panel)
  const tableAfter = await box(explorer.locator('#ix-runs'))
  expect(after.width - before.width).toBeGreaterThan(140)
  expect(after.width - before.width).toBeLessThan(160)
  expect(Math.abs(after.right - before.right)).toBeLessThan(2)
  expect(table.width - tableAfter.width).toBeGreaterThan(140)
  // remembered across a reload
  await page.reload()
  await openExplorer(page)
  const reloaded = await box(detail(page))
  expect(Math.abs(reloaded.width - after.width)).toBeLessThan(2)
  // double-click resets to the default (420 px)
  await page.locator('#ix-detail + .dv-splitter').dblclick()
  await expect.poll(async () => Math.round((await box(detail(page))).width)).toBe(420)
})

test('joint loads: per-joint gear load against the rating, safe speed, life, UR-style vs QDD', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  await page.goto('./#joints')
  const loads = page.getByTestId('joint-loads')
  await loads.scrollIntoViewIfNeeded()
  await expect(loads).toHaveAttribute('data-state', 'data')
  await expect(loads.locator('.build')).toHaveCount(3)
  for (const build of ['ur5e', 'qdd', 'qdd_light']) {
    const card = loads.locator(`.build[data-build="${build}"]`)
    await expect(card.locator('.gb-row')).toHaveCount(6)
    await expect(card.locator('[data-k="safe"] dd')).toContainText('m/s')
    await expect(card.locator('[data-k="life"] dd')).toContainText('picks')
    await expect(card.locator('[data-k="years"] dt')).toContainText('1,800 picks/h, 16 h/day')
  }
  // the worst case: the UR-style arm's gears go past the rating (red), the QDD's do not, and the answer says so
  await expect(loads.locator('.build[data-build="ur5e"]')).toHaveAttribute('data-over', 'true')
  await expect(loads.locator('.build[data-build="ur5e"] .gb-bar.over').first()).toBeVisible()
  const redBar = await loads.locator('.build[data-build="ur5e"] .gb-bar.over').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  const warn = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--pt-warn)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
  expect(redBar).toBe(warn)
  await expect(loads.getByTestId('joint-answer')).toContainText('UR-style')
  await expect(loads.getByTestId('why-backdrivable')).toContainText('N²')
  await expect(loads.getByTestId('life-caveat')).toContainText('estimate')
  await loads.getByTestId('gearbox-models').locator('summary').click()
  await expect(loads.getByTestId('gearbox-models').locator('tbody tr')).toHaveCount(18)
  // slow + spring: every build under its ratings
  await loads.locator('[data-factor="approach"] button[data-value="slow"]').click()
  await loads.locator('[data-factor="spring"] button[data-value="on"]').click()
  await expect(loads.locator('.gb-bar.over')).toHaveCount(0)
  expect(errors).toEqual([])
})

test("the ablation ladder: swap one rung's factor, read the pair", async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await useFixture(page)
  await page.goto('./#impact')
  const ladder = page.getByTestId('ablation-ladder')
  await ladder.scrollIntoViewIfNeeded()
  const r0 = ladder.locator('.rung[data-rung="R0"]')
  await expect(r0.getByTestId('rung-swaps').locator('select')).toHaveCount(4)
  await r0.locator('select[data-factor="controller"]').selectOption('host_spring')
  const pair = ladder.getByTestId('ladder-pair')
  await expect(pair).toBeVisible()
  await expect(pair).toContainText('controller → HOST_SPRING (impedance)')
  await expect(pair.getByTestId('run-card')).toHaveAttribute('data-pair', 'true')
  await expect(pair.locator('.fchip.diff')).toHaveCount(2)
  // swapping back to the rung's own value closes the pair
  await r0.locator('select[data-factor="controller"]').selectOption('stiff')
  await expect(pair).toHaveCount(0)
  expect(errors).toEqual([])
})

test('390 px phone: the explorer and the joint loads fit, nothing pokes out', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await useFixture(page)
  await openExplorer(page)
  await expect(page.getByTestId('joint-loads')).toHaveAttribute('data-state', 'data')
  const result = await page.evaluate(() => {
    const width = window.innerWidth
    const offenders = []
    for (const el of document.querySelectorAll('#explorer *, #joints *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.right <= width + 1) continue
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
  expect(result.scrollWidth).toBeLessThanOrEqual(result.width)
  expect(result.offenders).toEqual([])
})

test('until factorial.json lands, the explorer and the joint loads say so (no error)', async ({ page }) => {
  const errors = collectErrors(page)
  await page.route('**/data/factorial.json', (route) => route.fulfill({ status: 404, body: 'not yet' }))
  await page.goto('./#explorer')
  await expect(page.getByTestId('explorer')).toHaveAttribute('data-state', 'pending')
  await expect(page.getByTestId('explorer').locator('.pending-note')).toBeVisible()
  await expect(page.getByTestId('joint-loads')).toHaveAttribute('data-state', 'pending')
  expect(errors.filter((e) => !/factorial\.json/.test(e))).toEqual([])
})

test('screenshots: the explorer and the joint loads, desktop and phone (review media)', async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true })
  for (const view of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height } })
    const page = await context.newPage()
    await useFixture(page)
    const explorer = await openExplorer(page)
    const scrollTo = (selector) => page.evaluate((selector) => {
      const el = document.querySelector(selector)
      const header = (document.querySelector('.VPNav')?.getBoundingClientRect().height ?? 0) + (document.querySelector('.step-bar')?.getBoundingClientRect().height ?? 0)
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (window.innerWidth >= 960 ? header : 48) - 8)
    }, selector)
    await tab(explorer, 'Worst case + QDD + impedance').click()
    await expect(rows(explorer)).toHaveCount(2)
    await scrollTo('#ix-runs')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `explorer-${view.name}.png`) })
    // compare: the worst case (A) against worst + QDD + impedance (B)
    await detail(page).getByTestId('pin-run').click()
    await tab(explorer, 'Worst case').click()
    await rows(explorer).filter({ hasText: 'rigid' }).first().locator('td').first().click()
    await detail(page).getByTestId('swap-pair').click()
    await scrollTo('#ix-detail')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `explorer-compare-${view.name}.png`) })
    await scrollTo('#joints .joint-loads')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `joint-loads-${view.name}.png`) })
    await context.close()
  }
})

test('screenshot: the hand study as the sim lane wrote it (review media)', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('./#fingers')
  const hand = page.getByTestId('hand-study')
  await hand.scrollIntoViewIfNeeded()
  await expect(hand).not.toHaveAttribute('data-state', 'loading')
  await page.waitForTimeout(800)
  await hand.screenshot({ path: join(SHOTS, 'hand-study-desktop.png') })
})
