import { dialog, ipcMain } from "electron"
import { IPC_CHANNELS, rpcFailure } from "@yadaw/contracts"
import type { ProjectCloseDisposition, RpcRequestMeta } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { t } from "../i18n"
import { registerRpcHandler } from "./rpc"
import {
  assertTrustedSender,
  normalizeAudioRuntime,
  validateCreateProject,
  validateProjectConfiguration
} from "./support"

function validationFailure(meta: RpcRequestMeta, field: string) {
  return rpcFailure(meta, {
    code: "validation-failed",
    category: "validation",
    outcome: "not-committed",
    retry: "never",
    correlationId: `validation-${meta.requestId}`,
    userMessageKey: "errors.invalidRpcRequest",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "validation-failed", field }
  })
}

function cancelledFailure(meta: RpcRequestMeta) {
  return rpcFailure(meta, {
    code: "operation-cancelled",
    category: "cancelled",
    outcome: "not-committed",
    retry: "never",
    correlationId: `cancelled-${meta.requestId}`,
    userMessageKey: "errors.operationCancelled",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "operation-cancelled", committed: false }
  })
}

export function registerProjectHandlers(context: IpcHandlerContext): void {
  const {
    projects,
    recordings,
    operations,
    projectGraph,
    transport,
    lifecycle,
    audioHost: audioHostService,
    synchronizePluginStates,
    projectLifecycle
  } = context

  registerRpcHandler(IPC_CHANNELS.bootstrap, ({ meta }) => {
    if (meta.target || meta.mutation) return validationFailure(meta, "target")
    return projectLifecycle.bootstrap()
  })

  registerRpcHandler(IPC_CHANNELS.projectCreate, async ({ meta }, value: unknown) => {
    let request
    try {
      request = validateCreateProject(value)
    } catch {
      return validationFailure(meta, "request")
    }
    let path = request.path ?? process.env.YADAW_TEST_PROJECT_PATH
    if (!path) {
      const result = await dialog.showSaveDialog({
        title: t("dialog.createProject.title"),
        defaultPath: `${request.name}.yadaw`,
        filters: [{ name: t("dialog.createProject.filter"), extensions: ["yadaw"] }]
      })
      if (result.canceled || !result.filePath) return cancelledFailure(meta)
      path = result.filePath
    }
    return projectLifecycle.create(meta, { ...request, path }, () => undefined)
  })

  registerRpcHandler(IPC_CHANNELS.projectPrepareOpen, async ({ meta }, value: unknown) => {
    const targetFailure = projectLifecycle.validateDesktopRead(meta)
    if (targetFailure) return targetFailure
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return validationFailure(meta, "path")
    }
    let path = typeof value === "string" ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: t("dialog.openProject.title"),
        properties: ["openFile"],
        filters: [{ name: t("dialog.openProject.filter"), extensions: ["yadaw"] }]
      })
      path = result.filePaths[0]
      if (result.canceled || !path) return null
    }
    return {
      path,
      recoverableWorkingCopy: await projects.hasRecoverableWorkingCopy(path)
    }
  })

  registerRpcHandler(
    IPC_CHANNELS.projectOpen,
    ({ meta }, value: unknown, recoverValue: unknown) => {
      if (typeof value !== "string" || !value.trim()) {
        return validationFailure(meta, "path")
      }
      if (recoverValue !== undefined && typeof recoverValue !== "boolean") {
        return validationFailure(meta, "recover")
      }
      return projectLifecycle.open(meta, value, recoverValue === true, () => undefined)
    }
  )

  ipcMain.handle(IPC_CHANNELS.projectSave, async (event, value: unknown) => {
    assertTrustedSender(event)
    const current = projects.current
    if (!current) return null
    lifecycle.beginProject("saving")
    const operationId = `save:${current.id}`
    operations.upsert(
      {
        id: operationId,
        title: t("operation.savingProject"),
        description: current.configuration.name,
        phase: "saving-archive",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        message: null,
        dropoutFrames: 0
      },
      true
    )
    try {
      await synchronizePluginStates()
      const saved = await projects.save(typeof value === "string" ? value : undefined)
      operations.patch(operationId, { phase: "cleaning-up" }, true)
      await recordings.cleanupCommittedForProject(saved.path)
      operations.patch(operationId, { state: "completed" }, true)
      lifecycle.completeProject(saved)
      return saved
    } catch (error) {
      lifecycle.failProject(error)
      operations.patch(
        operationId,
        {
          state: "failed",
          message: error instanceof Error ? error.message : String(error)
        },
        true
      )
      throw error
    }
  })

  registerRpcHandler(IPC_CHANNELS.projectClose, async ({ meta }, value: unknown) => {
    const current = projects.current
    if (!current) {
      return projectLifecycle.close(meta, "discard")
    }
    let disposition = value as ProjectCloseDisposition | undefined
    if (current.dirty && !disposition) return validationFailure(meta, "disposition")
    disposition ??= "discard"
    if (disposition !== "save" && disposition !== "discard" && disposition !== "cancel") {
      return validationFailure(meta, "disposition")
    }
    if (disposition === "save") await synchronizePluginStates()
    const result = await projectLifecycle.close(meta, disposition)
    if (result.ok && result.value.closed) {
      try {
        await transport.command({ type: "stop" })
      } catch {
        // The audio engine may already be stopped.
      }
      if (disposition === "save") {
        await recordings.cleanupCommittedForProject(current.path)
      }
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.projectAssetsList, async (event) => {
    assertTrustedSender(event)
    return projects.listAssets()
  })

  ipcMain.handle(IPC_CHANNELS.projectConfigurationUpdate, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    const previous = projects.current
    if (!previous) throw new Error("No project is open")
    const configuration = validateProjectConfiguration(value)
    const sampleRateChanged = configuration.sampleRate !== previous.configuration.sampleRate
    const graphConfigurationChanged =
      sampleRateChanged ||
      configuration.timeSignatureNumerator !== previous.configuration.timeSignatureNumerator ||
      configuration.timeSignatureDenominator !== previous.configuration.timeSignatureDenominator
    const audioWasRunning = lifecycle.snapshot().audio.status === "running"
    if (sampleRateChanged && audioWasRunning) lifecycle.beginAudio("reconfiguring")
    let configurationUpdated = false
    try {
      const session = await projects.updateConfiguration(configuration)
      configurationUpdated = true
      await projectGraph.refreshFromDatabase(graphConfigurationChanged)
      lifecycle.syncProject(session)
      if (sampleRateChanged && audioWasRunning && audioHostService) {
        lifecycle.completeAudio(normalizeAudioRuntime(await audioHostService.audioEngineSnapshot()))
      }
      return session
    } catch (error) {
      if (!configurationUpdated) {
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.completeAudio(normalizeAudioRuntime(runtime))
        }
        throw error
      }
      try {
        const restored = await projects.updateConfiguration(previous.configuration)
        await projectGraph.refreshFromDatabase(graphConfigurationChanged)
        lifecycle.syncProject(restored)
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          let runtime = await audioHostService.audioEngineSnapshot()
          if (runtime.state !== "running") {
            runtime = await audioHostService.restoreAudioEngine()
          }
          lifecycle.completeAudio(normalizeAudioRuntime(runtime))
        }
      } catch (rollbackError) {
        console.error("Could not roll back the project sample-rate change", rollbackError)
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.failAudio(rollbackError, normalizeAudioRuntime(runtime))
        }
      }
      throw error
    }
  })
}
