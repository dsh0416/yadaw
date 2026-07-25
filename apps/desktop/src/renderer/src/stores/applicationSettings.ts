import { defineStore } from "pinia"
import { shallowRef } from "vue"
import type {
  ApplicationSettings,
  ApplicationSettingsPatch,
  ThemePreference
} from "@yadaw/contracts"

export const useApplicationSettingsStore = defineStore("application-settings", () => {
  const settings = shallowRef<ApplicationSettings | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  let loadPromise: Promise<void> | null = null

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      loading.value = true
      error.value = ""
      try {
        settings.value = await window.yadaw.getApplicationSettings()
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : "Unable to load application settings."
      } finally {
        loading.value = false
        loadPromise = null
      }
    })()
    return loadPromise
  }

  async function update(patch: ApplicationSettingsPatch): Promise<void> {
    settings.value = await window.yadaw.updateApplicationSettings(patch)
  }

  async function setTheme(theme: ThemePreference): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value || settings.value.theme === theme) return

    const previous = settings.value
    settings.value = { ...previous, theme }
    error.value = ""
    try {
      settings.value = await window.yadaw.updateApplicationSettings({ theme })
    } catch (reason) {
      settings.value = previous
      error.value = reason instanceof Error ? reason.message : "Unable to save display settings."
    }
  }

  async function chooseSwapDirectory(): Promise<void> {
    settings.value = await window.yadaw.chooseSwapDirectory()
  }

  return { settings, loading, error, load, update, setTheme, chooseSwapDirectory }
})
