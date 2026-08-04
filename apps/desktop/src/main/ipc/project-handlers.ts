import { dialog } from "electron"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@heron/contracts"
import type { ProjectCloseDisposition, RpcRequestMeta } from "@heron/contracts"
import type { IpcHandlerContext } from "./context"
import { t } from "../settings"
import { isProjectFilePath, PROJECT_FILE_FILTER_EXTENSION } from "../project"
import { registerRpcHandler } from "./rpc"
import {
  validationFailure as resourceValidationFailure,
  validateMutationTarget,
  validateReadTarget
} from "./resource-validation"
import {
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
    let path = request.path ?? process.env.HERON_TEST_PROJECT_PATH
    if (!path) {
      const result = await dialog.showSaveDialog({
        title: t("dialog.createProject.title"),
        defaultPath: `${request.name}.heron`,
        filters: [
          { name: t("dialog.createProject.filter"), extensions: [PROJECT_FILE_FILTER_EXTENSION] }
        ]
      })
      if (result.canceled || !result.filePath) return cancelledFailure(meta)
      path = result.filePath
    }
    return projectLifecycle.create(meta, { ...request, path })
  })

  registerRpcHandler(IPC_CHANNELS.projectPrepareOpen, async ({ meta }, value: unknown) => {
    const targetFailure = projectLifecycle.validateDesktopRead(meta)
    if (targetFailure) return targetFailure
    if (
      value !== undefined &&
      (typeof value !== "string" || !value.trim() || !isProjectFilePath(value))
    ) {
      return validationFailure(meta, "path")
    }
    let path = typeof value === "string" ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: t("dialog.openProject.title"),
        properties: ["openFile"],
        filters: [
          { name: t("dialog.openProject.filter"), extensions: [PROJECT_FILE_FILTER_EXTENSION] }
        ]
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
      if (typeof value !== "string" || !value.trim() || !isProjectFilePath(value)) {
        return validationFailure(meta, "path")
      }
      if (recoverValue !== undefined && typeof recoverValue !== "boolean") {
        return validationFailure(meta, "recover")
      }
      return projectLifecycle.open(meta, value, recoverValue === true)
    }
  )

  registerRpcHandler(IPC_CHANNELS.projectSave, async ({ meta }, value: unknown) => {
    const current = projects.current
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (
      !current ||
      !workspace ||
      !meta.mutation ||
      !meta.target ||
      meta.target.kind !== workspace.project.kind ||
      meta.target.id !== workspace.project.id ||
      meta.target.epoch !== workspace.project.epoch ||
      meta.target.generation !== workspace.project.generation
    ) {
      return validationFailure(meta, "target")
    }
    const begun = operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: workspace.project
    })
    if (!begun.ok) return validationFailure(meta, "operation")
    if (begun.value.disposition !== "started") {
      const result = begun.value.operation.result
      return result ?? validationFailure(meta, "operation")
    }
    lifecycle.beginProject("saving")
    const operationId = meta.mutation.operationId
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
        error: null,
        dropoutFrames: 0
      },
      true
    )
    let archiveCommitted = false
    try {
      await synchronizePluginStates()
      const saved = await projects.save(
        typeof value === "string" ? value : undefined,
        meta.mutation.operationId
      )
      archiveCommitted = true
      operations.patch(operationId, { phase: "cleaning-up" }, true)
      await recordings.cleanupCommittedForProject(saved.path)
      const resolved = lifecycle.applicationState.resources.resolve(workspace.project)
      if (!resolved.ok) throw new Error("Saved project resource became stale")
      const committed = lifecycle.applicationState.resources.update(
        workspace.project,
        resolved.value.revision,
        saved
      )
      if (!committed.ok) throw new Error("Saved project resource could not advance")
      const next = { ...workspace, session: saved }
      lifecycle.applicationState.setWorkspace(next)
      lifecycle.completeProject(saved)
      const result = rpcSuccess(meta, next, { resourceRevision: committed.value.revision })
      operations.registry.finish(operationId, "committed", result)
      operations.patch(operationId, { state: "completed" }, true)
      return result
    } catch (error) {
      lifecycle.failProject(error)
      const result = archiveCommitted
        ? rpcFailure(meta, {
            code: "operation-timeout-unknown",
            category: "timeout-unknown",
            outcome: "unknown",
            retry: "after-reconcile",
            correlationId: `save-${meta.requestId}`,
            userMessageKey: "errors.operationOutcomeUnknown",
            resource: workspace.project,
            details: { type: "operation-timeout-unknown", dispatched: true }
          })
        : rpcFailure(meta, {
            code: "resource-unavailable",
            category: "unavailable",
            outcome: "not-committed",
            retry: "safe",
            correlationId: `save-${meta.requestId}`,
            userMessageKey: "errors.operationFailed",
            resource: workspace.project,
            details: {
              type: "resource-unavailable",
              component: "project-worker",
              dispatched: false
            }
          })
      operations.registry.finish(
        operationId,
        archiveCommitted ? "quarantined" : "not-committed",
        result
      )
      operations.patch(
        operationId,
        {
          state: "failed",
          error: result.error
        },
        true
      )
      return result
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
    return projectLifecycle.close(meta, disposition, {
      preparePersistedState: disposition === "save" ? () => synchronizePluginStates() : undefined,
      stopTransport: async () => {
        try {
          await transport.command({ type: "stop" })
        } catch {
          // The audio engine may already be stopped.
        }
      },
      cleanupCommittedState:
        disposition === "save"
          ? () => recordings.cleanupCommittedForProject(current.path)
          : undefined
    })
  })

  registerRpcHandler(IPC_CHANNELS.projectAssetsList, async ({ meta }) => {
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) return resourceValidationFailure(meta, "target")
    const invalid = validateReadTarget(meta, workspace.project)
    if (invalid) return invalid
    return projects.listAssets()
  })

  registerRpcHandler(IPC_CHANNELS.projectConfigurationUpdate, async ({ meta }, value: unknown) => {
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) return resourceValidationFailure(meta, "target")
    const invalid = validateMutationTarget(meta, workspace.projectGraph, workspace.revision)
    if (invalid) return invalid
    lifecycle.assertProjectWriteAllowed()
    const previous = projects.current
    if (!previous) throw new Error("No project is open")
    const configuration = validateProjectConfiguration(value)
    const sampleRateChanged = configuration.sampleRate !== previous.configuration.sampleRate
    const graphConfigurationChanged =
      sampleRateChanged ||
      configuration.timeSignatureNumerator !== previous.configuration.timeSignatureNumerator ||
      configuration.timeSignatureDenominator !== previous.configuration.timeSignatureDenominator
    const begun = operations.registry.begin({
      operationId: meta.mutation!.operationId,
      idempotencyKey: meta.mutation!.idempotencyKey,
      target: workspace.projectGraph
    })
    if (!begun.ok) return resourceValidationFailure(meta, "operation")
    if (begun.value.disposition !== "started") {
      return begun.value.operation.result ?? resourceValidationFailure(meta, "operation")
    }
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
      const next = lifecycle.applicationState.commitWorkspaceProjection(
        session,
        await projectGraph.snapshot(),
        await projects.listAssets()
      )
      const result = rpcSuccess(meta, session, { resourceRevision: next.revision })
      operations.registry.finish(meta.mutation!.operationId, "committed", result)
      return result
    } catch (_error) {
      if (!configurationUpdated) {
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.completeAudio(normalizeAudioRuntime(runtime))
        }
        const result = rpcFailure(meta, {
          code: "resource-unavailable",
          category: "unavailable",
          outcome: "not-committed",
          retry: "safe",
          correlationId: `project-config-${meta.requestId}`,
          userMessageKey: "errors.operationFailed",
          resource: workspace.projectGraph,
          details: {
            type: "resource-unavailable",
            component: "project-worker",
            dispatched: false
          }
        })
        operations.registry.finish(meta.mutation!.operationId, "not-committed", result)
        return result
      }
      let rollbackFailed = false
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
        rollbackFailed = true
        console.error("Could not roll back the project sample-rate change", rollbackError)
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.failAudio(rollbackError, normalizeAudioRuntime(runtime))
        }
      }
      const result = rollbackFailed
        ? rpcFailure(meta, {
            code: "invariant-violation",
            category: "invariant-violation",
            outcome: "quarantined",
            retry: "after-reconcile",
            correlationId: `project-config-${meta.requestId}`,
            userMessageKey: "errors.internalInvariant",
            resource: workspace.projectGraph,
            details: { type: "invariant-violation", component: "main" }
          })
        : rpcFailure(meta, {
            code: "resource-unavailable",
            category: "unavailable",
            outcome: "not-committed",
            retry: "safe",
            correlationId: `project-config-${meta.requestId}`,
            userMessageKey: "errors.operationFailed",
            resource: workspace.projectGraph,
            details: {
              type: "resource-unavailable",
              component: "project-worker",
              dispatched: true
            }
          })
      operations.registry.finish(
        meta.mutation!.operationId,
        rollbackFailed ? "quarantined" : "not-committed",
        result
      )
      return result
    }
  })
}
