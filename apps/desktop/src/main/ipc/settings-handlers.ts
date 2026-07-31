import { dialog, ipcMain, shell } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { AudioHostRuntimePreferences, ShortcutPreferences } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import {
  validateAudioHostRuntimePreferences,
  validateShortcutPreferences
} from "../application-settings"
import { installApplicationMenu } from "../application-menu"
import { setMainLocale, t } from "../i18n"
import { assertTrustedSender, validateSettingsPatch } from "./support"
export function registerSettingsHandlers(context: IpcHandlerContext): void {
  const {
    settings,
    projects,
    recordings,
    operations,
    projectGraph,
    audioHost: audioHostService,
    synchronizePluginStates
  } = context
  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event)
    return settings.get()
  })

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (event, value: unknown) => {
    assertTrustedSender(event)
    const patch = validateSettingsPatch(value)
    const updated = await settings.update(patch)
    if (patch.locale !== undefined) {
      setMainLocale(updated.locale)
      installApplicationMenu(process.platform, updated.shortcuts)
    }
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.settingsSetSoftwareMonitoring, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "boolean") {
      throw new TypeError("Software monitoring value must be a boolean")
    }
    if (
      recordings.current ||
      operations.activeCount > 0 ||
      audioHostService?.configurationRestarting
    ) {
      throw new Error("Software monitoring cannot change while audio configuration is busy")
    }
    const current = await settings.get()
    if (current.softwareMonitoringEnabled === value) return current
    if (!projects.current) return settings.setSoftwareMonitoringEnabled(value)

    await projectGraph.setSoftwareMonitoringEnabled(value)
    try {
      return await settings.setSoftwareMonitoringEnabled(value)
    } catch (error) {
      await projectGraph.setSoftwareMonitoringEnabled(current.softwareMonitoringEnabled)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.settingsConfigureAudioHostRuntime, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      recordings.current ||
      operations.activeCount > 0 ||
      audioHostService?.configurationRestarting
    ) {
      throw new Error("Audio host runtime configuration is busy")
    }
    if (!audioHostService) throw new Error("Audio host is not running")
    const preferences = validateAudioHostRuntimePreferences(
      value
    ) satisfies AudioHostRuntimePreferences
    await synchronizePluginStates()
    await audioHostService.configureRuntime(preferences)
    return settings.configureAudioHostRuntime(preferences)
  })

  ipcMain.handle(IPC_CHANNELS.settingsConfigureShortcuts, async (event, value: unknown) => {
    assertTrustedSender(event)
    const shortcuts = validateShortcutPreferences(value) satisfies ShortcutPreferences
    const current = await settings.get()
    if (!audioHostService) throw new Error("Audio host is not running")
    await audioHostService.configureMidiInput(current.midiSync, shortcuts)
    try {
      const updated = await settings.configureShortcuts(shortcuts)
      installApplicationMenu(process.platform, updated.shortcuts)
      return updated
    } catch (error) {
      await audioHostService.configureMidiInput(current.midiSync, current.shortcuts)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.settingsChooseSwap, async (event) => {
    assertTrustedSender(event)
    const current = await settings.get()
    const result = await dialog.showOpenDialog({
      title: t("dialog.chooseSwap.title"),
      defaultPath: current.swapDirectory,
      properties: ["openDirectory", "createDirectory"]
    })
    return result.canceled || !result.filePaths[0]
      ? current
      : settings.update({ swapDirectory: result.filePaths[0] })
  })

  ipcMain.handle(IPC_CHANNELS.settingsOpenSwap, async (event) => {
    assertTrustedSender(event)
    const current = await settings.get()
    const error = await shell.openPath(current.swapDirectory)
    if (error) throw new Error(error)
  })
}
