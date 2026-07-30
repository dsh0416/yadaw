import DefaultTheme from "vitepress/theme-without-fonts"
import HomePage from "./components/HomePage.vue"
import type { Theme } from "vitepress"
import "./custom.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("HomePage", HomePage)
  }
} satisfies Theme
