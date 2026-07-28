import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type {
  ApplicationSettings,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences,
  ResolvedAudioHostRuntimePreferences,
  MeterPeakHold,
  MeterReturnRate,
  ThemePreference
} from "@yadaw/contracts"

export const useApplicationSettingsStore = defineStore("application-settings", () => {
  const settings = shallowRef<ApplicationSettings | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  const applyingAudioRuntime = shallowRef(false)
  const applyingSoftwareMonitoring = shallowRef(false)
  const resolvedAudioHostRuntime = shallowRef<ResolvedAudioHostRuntimePreferences | null>(null)
  let loadPromise: Promise<void> | null = null

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      loading.value = true
      error.value = ""
      try {
        settings.value = await window.yadaw.getApplicationSettings()
      } catch (reason) {
        error.value =
          reason instanceof Error ? reason.message : "Unable to load application settings."
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

  async function updateDisplaySetting(
    patch: Pick<ApplicationSettingsPatch, "meterPeakHold" | "meterReturnRate">
  ): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value) return

    const previous = settings.value
    settings.value = { ...previous, ...patch }
    error.value = ""
    try {
      settings.value = await window.yadaw.updateApplicationSettings(patch)
    } catch (reason) {
      settings.value = previous
      error.value =
        reason instanceof Error ? reason.message : "Unable to save mixer display settings."
    }
  }

  function setMeterPeakHold(meterPeakHold: MeterPeakHold): Promise<void> {
    return updateDisplaySetting({ meterPeakHold })
  }

  function setMeterReturnRate(meterReturnRate: MeterReturnRate): Promise<void> {
    return updateDisplaySetting({ meterReturnRate })
  }

  async function chooseSwapDirectory(): Promise<void> {
    settings.value = await window.yadaw.chooseSwapDirectory()
  }

  async function openSwapDirectory(): Promise<void> {
    await window.yadaw.openSwapDirectory()
  }

  async function configureAudioHostRuntime(
    preferences: AudioHostRuntimePreferences
  ): Promise<void> {
    if (applyingAudioRuntime.value) return
    applyingAudioRuntime.value = true
    error.value = ""
    try {
      settings.value = await window.yadaw.configureAudioHostRuntime(preferences)
      await refreshAudioHostRuntimeDiagnostics()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to restart the audio helper."
      throw reason
    } finally {
      applyingAudioRuntime.value = false
    }
  }

  async function setSoftwareMonitoringEnabled(enabled: boolean): Promise<void> {
    if (applyingSoftwareMonitoring.value) return
    if (!settings.value) await load()
    if (!settings.value || settings.value.softwareMonitoringEnabled === enabled) return

    const previous = settings.value
    settings.value = { ...previous, softwareMonitoringEnabled: enabled }
    applyingSoftwareMonitoring.value = true
    error.value = ""
    try {
      settings.value = await window.yadaw.setSoftwareMonitoringEnabled(enabled)
    } catch (reason) {
      settings.value = previous
      error.value =
        reason instanceof Error ? reason.message : "Unable to change software monitoring."
      throw reason
    } finally {
      applyingSoftwareMonitoring.value = false
    }
  }

  async function refreshAudioHostRuntimeDiagnostics(): Promise<void> {
    const snapshot = await window.yadaw.systemPerformanceSnapshot()
    resolvedAudioHostRuntime.value = snapshot.audioIpc?.runtime.resolved ?? null
  }

  return {
    settings,
    loading,
    error,
    applyingAudioRuntime,
    applyingSoftwareMonitoring,
    resolvedAudioHostRuntime,
    load,
    update,
    setTheme,
    setMeterPeakHold,
    setMeterReturnRate,
    chooseSwapDirectory,
    openSwapDirectory,
    configureAudioHostRuntime,
    setSoftwareMonitoringEnabled,
    refreshAudioHostRuntimeDiagnostics
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationSettingsStore, import.meta.hot))
}
