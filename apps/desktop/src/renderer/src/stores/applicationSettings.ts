import { defineStore } from "pinia"
import { ref } from "vue"
import type { ApplicationSettings, ApplicationSettingsPatch } from "@yadaw/contracts"

export const useApplicationSettingsStore = defineStore("application-settings", () => {
  const settings = ref<ApplicationSettings | null>(null)
  const loading = ref(false)
  const error = ref("")

  async function load(): Promise<void> {
    loading.value = true
    error.value = ""
    try {
      settings.value = await window.yadaw.getApplicationSettings()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to load application settings."
    } finally {
      loading.value = false
    }
  }

  async function update(patch: ApplicationSettingsPatch): Promise<void> {
    settings.value = await window.yadaw.updateApplicationSettings(patch)
  }

  async function chooseSwapDirectory(): Promise<void> {
    settings.value = await window.yadaw.chooseSwapDirectory()
  }

  return { settings, loading, error, load, update, chooseSwapDirectory }
})
