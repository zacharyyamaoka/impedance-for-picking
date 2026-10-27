// Playwright drives the BUILT site (vitepress preview), the same files Cloudflare serves.
// WHY swiftshader flags: headless Chrome has no GPU here, and the replay viewer needs WebGL.
import { defineConfig } from '@playwright/test'

const PORT = 4496
// BASE_URL=the deployed site runs the same checks against the live site (no local server).
const remote = process.env.BASE_URL

export default defineConfig({
  testDir: 'tests',
  // WHY: tests/unit holds vitest files; Playwright must only run the page specs
  testMatch: '*.spec.mjs',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: remote || `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: remote ? undefined : {
    command: `pnpm exec vitepress preview site --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
