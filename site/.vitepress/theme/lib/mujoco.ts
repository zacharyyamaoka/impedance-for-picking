// One MuJoCo WASM module per page, loaded on first use. Client-only: VitePress server-renders every page, so this file is
// only ever reached through a dynamic import from onMounted.
// WHY the official @mujoco/mujoco root build: no threads, so no COOP/COEP headers on Cloudflare and no iOS memory blow-up
// (MuJoCo-in-the-browser research, 2026-10-26).

import type { MainModule } from '@mujoco/mujoco'

let modulePromise: Promise<MainModule> | null = null

export function loadMujoco(): Promise<MainModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
        import('@mujoco/mujoco'),
        import('@mujoco/mujoco/mujoco.wasm?url'),
      ])
      return factory({ locateFile: () => wasmUrl }) as Promise<MainModule>
    })()
    // A failed load (offline, blocked wasm) may be retried by the next viewer instead of caching the rejection
    modulePromise.catch(() => {
      modulePromise = null
    })
  }
  return modulePromise
}
