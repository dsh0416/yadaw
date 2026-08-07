import { randomUUID } from "node:crypto"
import { dialog, nativeTheme, shell } from "electron"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  ApplicationSettings,
  ApplicationSettingsResourceSnapshot,
  AudioHostRuntimePreferences,
  RpcFailure,
  RpcRequestMeta,
  RpcResult,
  ShortcutPreferences
} from "@heron/contracts"
import type { IpcHandlerContext } from "./context"
import { exclusiveOfflineOperationFailure } from "./operation-guard"
import { registerRpcHandler } from "./rpc"
import { validateMutationTarget, validateReadTarget } from "./resource-validation"
import {
  setMainLocale,
  t,
  validateAudioHostRuntimePreferences,
  validateShortcutPreferences
} from "../settings"
import { installApplicationMenu } from "../app"
import { validateSettingsPatch } from "./support"

function operationFailure(
  meta: RpcRequestMeta,
  resource: ApplicationSettingsResourceSnapshot["settings"],
  quarantined: boolean
): RpcFailure {
  if (quarantined) {
    return rpcFailure(meta, {
      code: "invariant-violation",
      category: "invariant-violation",
      outcome: "quarantined",
      retry: "after-reconcile",
      correlationId: randomUUID(),
      userMessageKey: "errors.internalInvariant",
      resource,
      details: { type: "invariant-violation", component: "main" }
    })
  }
  return rpcFailure(meta, {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.operationFailed",
    resource,
    details: {
      type: "resource-unavailable",
      component: "main",
      dispatched: true
    }
  })
}

export function registerSettingsRpcHandlers(context: IpcHandlerContext): void {
  const {
    settings,
    projects,
    recordings,
    operations,
    projectGraph,
    lifecycle,
    audioHost: audioHostService,
    synchronizePluginStates
  } = context
  const state = lifecycle.applicationState

  const snapshot = async (): Promise<ApplicationSettingsResourceSnapshot> =>
    state.synchronizeApplicationSettings(await settings.get())

  const mutate = async (
    meta: RpcRequestMeta,
    action: (current: ApplicationSettings) => Promise<ApplicationSettings>
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>> => {
    const before = await snapshot()
    const invalid = validateMutationTarget(meta, before.settings, before.revision)
    if (invalid) return invalid
    const exclusive = exclusiveOfflineOperationFailure(context, meta)
    if (exclusive) return exclusive
    const begun = operations.registry.begin({
      operationId: meta.mutation!.operationId,
      idempotencyKey: meta.mutation!.idempotencyKey,
      target: before.settings
    })
    if (!begun.ok) return operationFailure(meta, before.settings, false)
    if (begun.value.disposition !== "started") {
      return (
        (begun.value.operation.result as
          | RpcResult<ApplicationSettingsResourceSnapshot>
          | undefined) ?? operationFailure(meta, before.settings, false)
      )
    }
    try {
      const updated = await action(structuredClone(before.value))
      const next = state.synchronizeApplicationSettings(updated)
      const result = rpcSuccess(meta, next, { resourceRevision: next.revision })
      operations.registry.finish(meta.mutation!.operationId, "committed", result)
      return result
    } catch (error) {
      const after = await snapshot()
      const changed = JSON.stringify(after.value) !== JSON.stringify(before.value)
      const result = operationFailure(meta, before.settings, changed)
      operations.registry.finish(
        meta.mutation!.operationId,
        changed ? "quarantined" : "not-committed",
        result
      )
      console.error(`[settings] ${result.error.correlationId} mutation failed`, error)
      return result
    }
  }

  registerRpcHandler(IPC_CHANNELS.settingsGet, async ({ meta }) => {
    const current = await snapshot()
    const invalid = validateReadTarget(meta, current.settings)
    if (invalid) return invalid
    return rpcSuccess(meta, current, { resourceRevision: current.revision })
  })

  registerRpcHandler(IPC_CHANNELS.settingsUpdate, ({ meta }, value: unknown) =>
    mutate(meta, async () => {
      const patch = validateSettingsPatch(value)
      const updated = await settings.update(patch)
      if (patch.locale !== undefined) {
        setMainLocale(updated.locale)
        installApplicationMenu(process.platform, updated.shortcuts)
      }
      if (patch.locale !== undefined || patch.theme !== undefined) {
        await audioHostService
          .configurePluginEditorAppearance({
            theme:
              updated.theme === "system"
                ? nativeTheme.shouldUseDarkColors
                  ? "dark"
                  : "light"
                : updated.theme,
            locale: updated.locale
          })
          .catch((error: unknown) => {
            console.error("Could not update plug-in editor appearance", error)
          })
      }
      return updated
    })
  )

  registerRpcHandler(IPC_CHANNELS.settingsSetSoftwareMonitoring, ({ meta }, value: unknown) =>
    mutate(meta, async (current) => {
      if (typeof value !== "boolean") throw new TypeError("invalid software monitoring value")
      if (
        recordings.current ||
        operations.activeCount > 1 ||
        audioHostService.configurationRestarting
      ) {
        throw new Error("software monitoring is busy")
      }
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
  )

  registerRpcHandler(IPC_CHANNELS.settingsConfigureAudioHostRuntime, ({ meta }, value: unknown) =>
    mutate(meta, async (current) => {
      if (
        recordings.current ||
        operations.activeCount > 1 ||
        audioHostService.configurationRestarting
      ) {
        throw new Error("audio host runtime configuration is busy")
      }
      const preferences = validateAudioHostRuntimePreferences(
        value
      ) satisfies AudioHostRuntimePreferences
      await synchronizePluginStates()
      await audioHostService.configureRuntime(preferences)
      try {
        return await settings.configureAudioHostRuntime(preferences)
      } catch (error) {
        await audioHostService.configureRuntime(current.audioHostRuntime)
        throw error
      }
    })
  )

  registerRpcHandler(IPC_CHANNELS.settingsConfigureShortcuts, ({ meta }, value: unknown) =>
    mutate(meta, async (current) => {
      const shortcuts = validateShortcutPreferences(value) satisfies ShortcutPreferences
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
  )

  registerRpcHandler(IPC_CHANNELS.settingsChooseSwap, ({ meta }) =>
    mutate(meta, async (current) => {
      const result = await dialog.showOpenDialog({
        title: t("dialog.chooseSwap.title"),
        defaultPath: current.swapDirectory,
        properties: ["openDirectory", "createDirectory"]
      })
      return result.canceled || !result.filePaths[0]
        ? current
        : settings.update({ swapDirectory: result.filePaths[0] })
    })
  )

  registerRpcHandler(IPC_CHANNELS.settingsOpenSwap, async ({ meta }) => {
    const current = await snapshot()
    const invalid = validateMutationTarget(meta, current.settings, current.revision)
    if (invalid) return invalid
    const error = await shell.openPath(current.value.swapDirectory)
    if (error) return operationFailure(meta, current.settings, false)
  })
}
