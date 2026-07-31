import { createHead } from "@unhead/vue/client"
import { createApp } from "vue"
import type { DefineComponent } from "vue"
import { createPinia } from "pinia"
import SplashApp from "./SplashApp.vue"
import "unfonts.css"
import "@yadaw/ui/styles.css"

const app = createApp(SplashApp as DefineComponent)
app.use(createPinia())
app.use(createHead())
app.mount("#splash-root")
