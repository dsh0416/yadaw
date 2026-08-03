import DefaultTheme from "vitepress/theme-without-fonts"
import type { Theme } from "vitepress"
import BlogIndex from "./components/BlogIndex.vue"
import DocsLayout from "./components/DocsLayout.vue"
import HomePage from "./components/HomePage.vue"
import MermaidDiagram from "./components/MermaidDiagram.vue"
import AudioBackendSupportFigure from "./components/manual/AudioBackendSupportFigure.vue"
import "unfonts.css"
import "@fontsource-variable/noto-sans-sc/wght.css"
import "./custom.css"

export default {
  extends: DefaultTheme,
  Layout: DocsLayout,
  enhanceApp({ app }) {
    app.component("AudioBackendSupportFigure", AudioBackendSupportFigure)
    app.component("BlogIndex", BlogIndex)
    app.component("HomePage", HomePage)
    app.component("MermaidDiagram", MermaidDiagram)
  }
} satisfies Theme
