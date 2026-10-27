import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import Landing from './components/Landing.vue'
import ArmLab from './components/ArmLab.vue'
import ReplayViewer from './components/ReplayViewer.vue'
import './style.css'

// LivePick (the live MuJoCo pick, another lane) registers itself when its file exists. WHY a glob, not an import: the page builds
// before that lane lands and keeps building after it - no broken import either way.
const livePick = Object.values(import.meta.glob('./components/LivePick.vue', { eager: true }))[0] as { default?: unknown } | undefined

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Landing', Landing)
    app.component('ArmLab', ArmLab)
    app.component('ReplayViewer', ReplayViewer)
    if (livePick?.default) app.component('LivePick', livePick.default as never)
  },
} satisfies Theme
