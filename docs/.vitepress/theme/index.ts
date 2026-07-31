import DefaultTheme from "vitepress/theme-without-fonts"
import BlogIndex from "./components/BlogIndex.vue"
import HomePage from "./components/HomePage.vue"
import type { Theme } from "vitepress"
import "unfonts.css"
import "./custom.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BlogIndex", BlogIndex)
    app.component("HomePage", HomePage)
  }
} satisfies Theme
