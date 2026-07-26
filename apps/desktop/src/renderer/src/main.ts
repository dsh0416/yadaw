import { createApp } from "vue"
import { createPinia } from "pinia"
import App from "./App.vue"
import { router } from "./router"
import "@yadaw/ui/styles.css"
import "./styles.css"

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.mount("#root")
