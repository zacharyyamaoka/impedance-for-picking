import { defineConfig } from 'vitepress'
import { HEAD_SCRIPT } from './theme/lib/variants'

// The impedance controller's site: one landing page that explains the whole approach, live demos and the evidence.
// Stack and viewer reused from pidtuna-website (VitePress + the official @mujoco/mujoco WASM bindings + three.js).
// WHY an env var for the base: GitHub Pages serves the site under /impedance-for-picking/ (.github/workflows/pages.yml sets
// SITE_BASE), while `pnpm run dev` and the default Playwright run keep serving it at /. Normalised to "/x/".
const raw = process.env.SITE_BASE ?? '/'
const base = `/${raw.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')

export default defineConfig({
  base,
  title: 'Impedance for picking',
  description: 'Cartesian impedance after the joint trajectory controller, on backdrivable QDD joints: where the spring and damper live, and why.',
  cleanUrls: true,
  lastUpdated: false,
  // WHY: Vite's dev pre-bundling moves @mujoco/mujoco's JS away from its .wasm (same fix as pidtuna-website)
  // WHY worker format 'es': LivePick's physics worker reuses lib/mujoco.ts, whose dynamic import() can't code-split into Vite's
  // default iife worker bundle (the build fails otherwise); ES-module workers run in Chrome 80+, Safari 15+, Firefox 114+
  vite: { optimizeDeps: { exclude: ['@mujoco/mujoco'] }, worker: { format: 'es' } },
  // WHY: data-ui's <data-views> / <data-facets> are custom elements (vendored in site/public/data-ui/ by scripts/vendor_data_ui.py),
  // not Vue components - the same as pidtuna-website
  vue: { template: { compilerOptions: { isCustomElement: (tag: string) => tag.startsWith('data-') } } },
  head: [
    ['script', {}, HEAD_SCRIPT],
    // WHY `${base}`: VitePress does not prefix head links with the base
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['link', { rel: 'icon', href: `${base}favicon.ico`, sizes: '32x32' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&family=Space+Grotesk:wght@500;700&display=swap' }],
  ],
  themeConfig: { logo: '/favicon.svg', nav: [], socialLinks: [] },
})
