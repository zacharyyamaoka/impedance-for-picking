import { defineConfig } from 'vitest/config'

// WHY an explicit include: vitest's default glob also matches tests/*.spec.mjs, which are Playwright specs (their test() throws
// outside Playwright's runner). Unit tests live in tests/unit/.
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'] } })
