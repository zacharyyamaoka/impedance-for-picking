import { defineConfig } from 'vitepress'
import { HEAD_SCRIPT } from './theme/lib/variants'

// The impedance controller's site: one landing page that explains the whole approach, live demos and the evidence.
// Stack and viewer reused from pidtuna-website (VitePress + the official @mujoco/mujoco WASM bindings + three.js).
export default defineConfig({
  title: 'Impedance for picking',
  description: 'Cartesian impedance after the joint trajectory controller, on backdrivable QDD joints: where the spring and damper live, and why.',
  cleanUrls: true,
  lastUpdated: false,
  // WHY: Vite's dev pre-bundling moves @mujoco/mujoco's JS away from its .wasm (same fix as pidtuna-website)
  vite: { optimizeDeps: { exclude: ['@mujoco/mujoco'] } },
  head: [
    ['script', {}, HEAD_SCRIPT],
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&family=Space+Grotesk:wght@500;700&display=swap' }],
  ],
  themeConfig: { logo: '/favicon.svg', nav: [], socialLinks: [] },
})
