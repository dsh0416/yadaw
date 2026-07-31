import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type {
  AppLocale,
  ApplicationSettings,
  ApplicationSettingsRef,
  ApplicationSettingsResourceSnapshot,
  DesktopSessionRef,
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

import { mutationMeta, readMeta, rpcErrorMessage } from "../rpc"
function t(key: string): string {
  return i18n.global.t(key)
}

export const useApplicationSettingsStore = defineStore("application-settings", () => {
  const settings = shallowRef<ApplicationSettings | null>(null)
  const loading = shallowRef(false)
  const resource = shallowRef<ApplicationSettingsRef | null>(null)
  const revision = shallowRef(0)
  const desktopSession = shallowRef<DesktopSessionRef | null>(null)
  const error = shallowRef("")
  const applyingAudioRuntime = shallowRef(false)
  const applyingSoftwareMonitoring = shallowRef(false)
  const resolvedAudioHostRuntime = shallowRef<ResolvedAudioHostRuntimePreferences | null>(null)
  let loadPromise: Promise<void> | null = null
  let mutationTail: Promise<void> = Promise.resolve()

  function applySnapshot(
    snapshot: ApplicationSettingsResourceSnapshot,
    desktop?: DesktopSessionRef
  ): void {
    if (desktop) desktopSession.value = structuredClone(desktop)
    resource.value = structuredClone(snapshot.settings)
    revision.value = snapshot.revision
    settings.value = structuredClone(snapshot.value)
    error.value = ""
  }

  async function reconcileSettings(): Promise<boolean> {
    if (resource.value) {
      const current = await window.yadaw.getApplicationSettings(readMeta(resource.value))
      if (current.ok) {
        applySnapshot(current.value)
        return true
      }
      if (current.error.category !== "stale-resource") {
        error.value = rpcErrorMessage(current.error)
        return false
      }
    }
    const bootstrap = await window.yadaw.bootstrap(readMeta())
    if (!bootstrap.ok) {
      error.value = rpcErrorMessage(bootstrap.error)
      return false
    }
    applySnapshot(bootstrap.value.settings, bootstrap.value.desktopSession)
    return true
  }

  async function applyMutation(
    operation: string,
    invoke: (
      meta: ReturnType<typeof mutationMeta>
    ) => ReturnType<typeof window.yadaw.updateApplicationSettings>
  ): Promise<boolean> {
    const scheduled = mutationTail.then(async () => {
      if (!resource.value) await load()
      if (!resource.value) return false
      let result = await invoke(mutationMeta(resource.value, operation, revision.value))
      if (
        !result.ok &&
        result.error.outcome === "not-committed" &&
        result.error.retry === "after-reconcile"
      ) {
        const reconciled = await reconcileSettings()
        if (!reconciled || !resource.value) return false
        result = await invoke(mutationMeta(resource.value, operation, revision.value))
      }
      if (!result.ok) {
        error.value = rpcErrorMessage(result.error)
        return false
      }
      applySnapshot(result.value)
      return true
    })
    mutationTail = scheduled.then(
      () => undefined,
      () => undefined
    )
    return scheduled
  }

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      loading.value = true
      error.value = ""
      try {
        if (!resource.value) {
          const bootstrap = await window.yadaw.bootstrap(readMeta())
          if (!bootstrap.ok) {
            error.value = rpcErrorMessage(bootstrap.error)
            return
          }
          applySnapshot(bootstrap.value.settings, bootstrap.value.desktopSession)
        } else {
          const result = await window.yadaw.getApplicationSettings(readMeta(resource.value))
          if (!result.ok) error.value = rpcErrorMessage(result.error)
          else applySnapshot(result.value)
        }
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
    await applyMutation("settings-update", (meta) =>
      window.yadaw.updateApplicationSettings(meta, patch)
    )
  }

  async function setTheme(theme: ThemePreference): Promise<void> {
    if (!settings.value) await load()
    if (!settings.value || settings.value.theme === theme) return

    const previous = settings.value
    settings.value = { ...previous, theme }
    error.value = ""
    try {
      const applied = await applyMutation("settings-theme", (meta) =>
        window.yadaw.updateApplicationSettings(meta, { theme })
      )
      if (!applied) settings.value = previous
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
      const applied = await applyMutation("settings-locale", (meta) =>
        window.yadaw.updateApplicationSettings(meta, { locale })
      )
      if (!applied) settings.value = previous
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
      const applied = await applyMutation("settings-display", (meta) =>
        window.yadaw.updateApplicationSettings(meta, patch)
      )
      if (!applied) settings.value = previous
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
      const applied = await applyMutation("settings-midi-center", (meta) =>
        window.yadaw.updateApplicationSettings(meta, { midiCenterCStandard })
      )
      if (!applied) settings.value = previous
    } catch (reason) {
      settings.value = previous
      error.value = reason instanceof Error ? reason.message : t("errors.unableToSaveMidiSettings")
    }
  }

  async function chooseSwapDirectory(): Promise<void> {
    await applyMutation("settings-choose-swap", (meta) => window.yadaw.chooseSwapDirectory(meta))
  }

  async function openSwapDirectory(): Promise<void> {
    if (!resource.value) await load()
    if (!resource.value) return
    const result = await window.yadaw.openSwapDirectory(
      mutationMeta(resource.value, "settings-open-swap", revision.value)
    )
    if (!result.ok) error.value = rpcErrorMessage(result.error)
  }

  async function configureAudioHostRuntime(
    preferences: AudioHostRuntimePreferences
  ): Promise<void> {
    if (applyingAudioRuntime.value) return
    applyingAudioRuntime.value = true
    error.value = ""
    try {
      const applied = await applyMutation("settings-audio-runtime", (meta) =>
        window.yadaw.configureAudioHostRuntime(meta, preferences)
      )
      if (!applied) throw new Error(error.value)
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
      const applied = await applyMutation("settings-software-monitoring", (meta) =>
        window.yadaw.setSoftwareMonitoringEnabled(meta, enabled)
      )
      if (!applied) settings.value = previous
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
      const applied = await applyMutation("settings-shortcuts", (meta) =>
        window.yadaw.configureShortcuts(meta, shortcuts)
      )
      if (!applied) settings.value = previous
    } catch (reason) {
      settings.value = previous
      error.value =
        reason instanceof Error ? reason.message : t("errors.unableToSaveShortcutSettings")
      throw reason
    }
  }

  async function refreshAudioHostRuntimeDiagnostics(): Promise<void> {
    const target = desktopSession.value
    if (!target) return
    const result = await window.yadaw.systemPerformanceSnapshot(readMeta(target))
    if (result.ok) resolvedAudioHostRuntime.value = result.value.audioIpc?.runtime.resolved ?? null
    else error.value = rpcErrorMessage(result.error)
  }

  return {
    resource,
    desktopSession,
    revision,
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
