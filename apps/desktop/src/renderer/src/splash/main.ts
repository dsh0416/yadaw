import { createApp } from "vue"
import type { DefineComponent } from "vue"
import { createPinia } from "pinia"
import SplashApp from "./SplashApp.vue"
import "unfonts.css"
import "@yadaw/ui/styles.css"

createApp(SplashApp as DefineComponent)
  .use(createPinia())
  .mount("#splash-root")
