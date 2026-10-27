import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import Landing from './components/Landing.vue'
import ArmLab from './components/ArmLab.vue'
import ReplayViewer from './components/ReplayViewer.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Landing', Landing)
    app.component('ArmLab', ArmLab)
    app.component('ReplayViewer', ReplayViewer)
  },
} satisfies Theme
