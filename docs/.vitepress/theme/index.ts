import DefaultTheme from "vitepress/theme-without-fonts"
import type { Theme } from "vitepress"
import BlogIndex from "./components/BlogIndex.vue"
import HomePage from "./components/HomePage.vue"
import "unfonts.css"
import "@fontsource-variable/noto-sans-sc/wght.css"
import "./custom.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BlogIndex", BlogIndex)
    app.component("HomePage", HomePage)
  }
} satisfies Theme
