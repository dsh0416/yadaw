import { createHead } from "@unhead/vue/client"
import { createApp } from "vue"
import { createPinia } from "pinia"
import App from "./App.vue"
import { i18n, setAppLocale } from "./i18n"
import { router } from "./router"
import { useApplicationSettingsStore } from "./stores/applicationSettings"
import "unfonts.css"
import "@heron/ui/styles.css"
import "./styles.css"

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  const pinia = createPinia()
  const head = createHead()

  app.use(pinia)
  app.use(router)
  app.use(i18n)
  app.use(head)

  const settingsStore = useApplicationSettingsStore(pinia)
  await settingsStore.load()
  const locale = settingsStore.settings?.locale
  if (locale) setAppLocale(locale)

  app.mount("#root")
}

void bootstrap()
