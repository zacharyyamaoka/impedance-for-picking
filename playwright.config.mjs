// Playwright drives the BUILT site, the same files GitHub Pages serves.
// WHY swiftshader flags: headless Chrome has no GPU here, and the replay viewer needs WebGL.
//
// Three ways to run it:
// - default: `vitepress preview` of a root-base build, at http://127.0.0.1:${PW_PORT:-4496}/
// - SITE_BASE=/impedance-for-picking/: the build made with that same SITE_BASE, served under the prefix by scripts/serve_base.mjs
//   (GitHub Pages' layout: nothing outside the prefix exists), at http://127.0.0.1:${PW_PORT:-4498}/impedance-for-picking/
// - BASE_URL=<a deployed site>: the same checks against the live site (no local server)
// Specs navigate with relative paths (page.goto('./#demo')), so one suite runs under any base.
import { defineConfig } from '@playwright/test'

const remote = process.env.BASE_URL
const siteBase = process.env.SITE_BASE ? `/${process.env.SITE_BASE.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/') : null
const prefixed = siteBase && siteBase !== '/'
const PORT = Number(process.env.PW_PORT ?? (prefixed ? 4498 : 4496))
const local = `http://127.0.0.1:${PORT}${prefixed ? siteBase : '/'}`

export default defineConfig({
  testDir: 'tests',
  // WHY: tests/unit holds vitest files; Playwright must only run the page specs
  testMatch: '*.spec.mjs',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: remote || local,
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: remote
    ? undefined
    : {
        command: prefixed
          ? `node scripts/serve_base.mjs --base ${siteBase} --port ${PORT}`
          : `pnpm exec vitepress preview site --port ${PORT} --host 127.0.0.1`,
        url: local,
        reuseExistingServer: true,
        timeout: 60_000,
      },
})
