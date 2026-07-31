import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type {
  AppLocale,
  ApplicationSettings,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences,
  ResolvedAudioHostRuntimePreferences,
  MeterPeakHold,
  MeterReturnRate,
  MidiCenterCStandard,
  ShortcutPreferences,
  ThemePreference
} from "@yadaw/contracts"
import { i18n } from "../i18n"

function t(key: string): string {
  return i18n.global.t(key)
}

export const useApplicationSettingsStore = defineStore("application-settings", () => {
  const settings = shallowRef<ApplicationSettings | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  const applyingAudioRuntime = shallowRef(false)
  const applyingSoftwareMonitoring = shallowRef(false)
  const resolvedAudioHostRuntime = shallowRef<ResolvedAudioHostRuntimePreferences | null>(null)
  let loadPromise: Promise<void> | null = null

  function applySnapshot(snapshot: ApplicationSettings): void {
    settings.value = structuredClone(snapshot)
    error.value = ""
  }

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      loading.value = true
      error.value = ""
      try {
        settings.value = await window.yadaw.getApplicationSettings()
      } catch (reason) {
        error.value =
          reason instanceof Error ? reason.message : t("errors.unableToLoadApplicationSettings")
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
      error.value =
        reason instanceof Error ? reason.message : t("errors.unableToSaveDisplaySettings")
    }
  }

  async function setLocale(locale: AppLocale): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value || settings.value.locale === locale) return

    const previous = settings.value
    settings.value = { ...previous, locale }
    error.value = ""
    try {
      settings.value = await window.yadaw.updateApplicationSettings({ locale })
    } catch (reason) {
      settings.value = previous
      error.value =
        reason instanceof Error ? reason.message : t("errors.unableToSaveDisplaySettings")
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
        reason instanceof Error ? reason.message : t("errors.unableToSaveMixerDisplaySettings")
    }
  }

  function setMeterPeakHold(meterPeakHold: MeterPeakHold): Promise<void> {
    return updateDisplaySetting({ meterPeakHold })
  }

  function setMeterReturnRate(meterReturnRate: MeterReturnRate): Promise<void> {
    return updateDisplaySetting({ meterReturnRate })
  }

  async function setMidiCenterCStandard(midiCenterCStandard: MidiCenterCStandard): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value || settings.value.midiCenterCStandard === midiCenterCStandard) return

    const previous = settings.value
    settings.value = { ...previous, midiCenterCStandard }
    error.value = ""
    try {
      settings.value = await window.yadaw.updateApplicationSettings({ midiCenterCStandard })
    } catch (reason) {
      settings.value = previous
      error.value = reason instanceof Error ? reason.message : t("errors.unableToSaveMidiSettings")
    }
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
      error.value =
        reason instanceof Error ? reason.message : t("errors.unableToRestartAudioHelper")
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
        reason instanceof Error ? reason.message : t("errors.unableToChangeSoftwareMonitoring")
      throw reason
    } finally {
      applyingSoftwareMonitoring.value = false
    }
  }

  async function configureShortcuts(shortcuts: ShortcutPreferences): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value) return
    const previous = settings.value
    settings.value = { ...previous, shortcuts: structuredClone(shortcuts) }
    error.value = ""
    try {
      settings.value = await window.yadaw.configureShortcuts(shortcuts)
    } catch (reason) {
      settings.value = previous
      error.value =
        reason instanceof Error ? reason.message : t("errors.unableToSaveShortcutSettings")
      throw reason
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
    applySnapshot,
    load,
    update,
    setTheme,
    setLocale,
    setMeterPeakHold,
    setMeterReturnRate,
    setMidiCenterCStandard,
    chooseSwapDirectory,
    openSwapDirectory,
    configureAudioHostRuntime,
    configureShortcuts,
    setSoftwareMonitoringEnabled,
    refreshAudioHostRuntimeDiagnostics
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationSettingsStore, import.meta.hot))
}
