import DefaultTheme from "vitepress/theme-without-fonts"
import type { Theme } from "vitepress"
import { createPinia } from "pinia"
import BlogIndex from "./components/BlogIndex.vue"
import DocsLayout from "./components/DocsLayout.vue"
import HomePage from "./components/HomePage.vue"
import MermaidDiagram from "./components/MermaidDiagram.vue"
import AudioBackendSupportFigure from "./components/manual/AudioBackendSupportFigure.vue"
import RoutingPlayground from "./components/manual/RoutingPlayground.vue"
import { createMixerDemoI18n } from "./mixer-demo-i18n"
import "unfonts.css"
import "@fontsource-variable/noto-sans-sc/wght.css"
import "./custom.css"
import "../../../packages/ui/src/styles/tokens.css"
import "../../../packages/ui/src/styles/domain-palette.css"

export default {
  extends: DefaultTheme,
  Layout: DocsLayout,
  enhanceApp({ app }) {
    app.use(createPinia())
    app.use(createMixerDemoI18n())
    app.component("AudioBackendSupportFigure", AudioBackendSupportFigure)
    app.component("BlogIndex", BlogIndex)
    app.component("HomePage", HomePage)
    app.component("MermaidDiagram", MermaidDiagram)
    app.component("RoutingPlayground", RoutingPlayground)
  }
} satisfies Theme
