import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type {
  MixerParameterPreview,
  ProjectCommand,
  ResourceRef,
  RpcRequestMeta
} from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"
import {
  validationFailure,
  validateMutationTarget,
  validateReadTarget
} from "./resource-validation"

function sameRef(left: ResourceRef | undefined, right: ResourceRef): boolean {
  return (
    left?.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function validateGraphTarget(context: IpcHandlerContext, meta: RpcRequestMeta) {
  const workspace = context.lifecycle.applicationState.workspaceSnapshot()
  if (!workspace || !sameRef(meta.target, workspace.projectGraph)) {
    return rpcFailure(meta, {
      code: "stale-resource",
      category: "stale-resource",
      outcome: "not-committed",
      retry: "after-reconcile",
      correlationId: `stale-${meta.requestId}`,
      userMessageKey: "errors.staleResource",
      ...(meta.target ? { resource: meta.target } : {}),
      details: { type: "stale-resource", reason: "generation-mismatch" }
    })
  }
  return null
}

export function registerMixerHandlers(context: IpcHandlerContext): void {
  const { projectGraph, projectCommands, mixerRuntime, lifecycle, isShuttingDown } = context
  registerRpcHandler(IPC_CHANNELS.projectGraphLoad, async ({ meta }) => {
    const invalid = validateGraphTarget(context, meta)
    if (invalid) return invalid
    if (meta.mutation) {
      return rpcFailure(meta, {
        code: "validation-failed",
        category: "validation",
        outcome: "not-committed",
        retry: "never",
        correlationId: `validation-${meta.requestId}`,
        userMessageKey: "errors.invalidRpcRequest",
        resource: meta.target!,
        details: { type: "validation-failed", field: "mutation" }
      })
    }
    lifecycle.assertMixerLoadAllowed()
    const workspace = lifecycle.applicationState.workspaceSnapshot()!
    return rpcSuccess(meta, await projectGraph.snapshot(), {
      resourceRevision: workspace.revision
    })
  })

  registerRpcHandler(IPC_CHANNELS.projectGraphReload, async ({ meta }) => {
    const invalid = validateGraphTarget(context, meta)
    if (invalid) return invalid
    const workspace = lifecycle.applicationState.workspaceSnapshot()!
    if (!meta.mutation || meta.expectedRevision === undefined) {
      return rpcFailure(meta, {
        code: "validation-failed",
        category: "validation",
        outcome: "not-committed",
        retry: "never",
        correlationId: `validation-${meta.requestId}`,
        userMessageKey: "errors.invalidRpcRequest",
        resource: meta.target!,
        details: { type: "validation-failed", field: "mutation" }
      })
    }
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, {
        code: "revision-conflict",
        category: "conflict",
        outcome: "not-committed",
        retry: "after-reconcile",
        correlationId: `revision-${meta.requestId}`,
        userMessageKey: "errors.revisionConflict",
        resource: workspace.projectGraph,
        details: {
          type: "revision-conflict",
          expectedRevision: meta.expectedRevision,
          actualRevision: workspace.revision
        }
      })
    }
    const begun = context.operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: workspace.projectGraph
    })
    if (!begun.ok) {
      return rpcFailure(meta, {
        code: "resource-busy",
        category: "busy",
        outcome: "not-committed",
        retry: "safe",
        correlationId: `busy-${meta.requestId}`,
        userMessageKey: "errors.resourceBusy",
        resource: workspace.projectGraph,
        details: { type: "resource-busy" }
      })
    }
    if (begun.value.disposition !== "started") {
      return (
        begun.value.operation.result ??
        rpcFailure(meta, {
          code: "resource-busy",
          category: "busy",
          outcome: "not-committed",
          retry: "safe",
          correlationId: `busy-${meta.requestId}`,
          userMessageKey: "errors.resourceBusy",
          resource: workspace.projectGraph,
          details: {
            type: "resource-busy",
            activeOperationId: begun.value.operation.operationId
          }
        })
      )
    }
    try {
      lifecycle.assertMixerLoadAllowed()
      const graph = await projectGraph.load()
      const updated = lifecycle.applicationState.resources.update(
        workspace.projectGraph,
        workspace.revision,
        { graph, deployment: "observed" }
      )
      if (!updated.ok) {
        lifecycle.applicationState.resources.quarantine(workspace.projectGraph)
        const result = rpcFailure(meta, {
          code: "invariant-violation",
          category: "invariant-violation",
          outcome: "quarantined",
          retry: "after-reconcile",
          correlationId: `graph-reload-${meta.requestId}`,
          userMessageKey: "errors.internalInvariant",
          resource: workspace.projectGraph,
          details: { type: "invariant-violation", component: "main" }
        })
        context.operations.registry.finish(meta.mutation.operationId, "quarantined", result)
        return result
      }
      const next = { ...workspace, revision: updated.value.revision, graph }
      lifecycle.applicationState.setWorkspace(next)
      const result = rpcSuccess(meta, graph, { resourceRevision: updated.value.revision })
      context.operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: `graph-reload-${meta.requestId}`,
        userMessageKey: "errors.operationFailed",
        resource: workspace.projectGraph,
        details: {
          type: "resource-unavailable",
          component: "project-worker",
          dispatched: false
        }
      })
      context.operations.registry.finish(meta.mutation.operationId, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.projectCommandExecute, ({ meta }, value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      return rpcFailure(meta, {
        code: "validation-failed",
        category: "validation",
        outcome: "not-committed",
        retry: "never",
        correlationId: `validation-${meta.requestId}`,
        userMessageKey: "errors.invalidRpcRequest",
        ...(meta.target ? { resource: meta.target } : {}),
        details: { type: "validation-failed", field: "command" }
      })
    }
    const command = value as ProjectCommand
    lifecycle.assertMixerCommandAllowed(command)
    return projectCommands.execute(meta, command)
  })

  registerRpcHandler(IPC_CHANNELS.mixerPreview, ({ meta }, value: unknown) => {
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) return validationFailure(meta, "target")
    const invalid = validateMutationTarget(meta, workspace.projectGraph, workspace.revision)
    if (invalid) return invalid
    if (!value || typeof value !== "object") throw new TypeError("Mixer preview must be an object")
    lifecycle.assertMixerPreviewAllowed()
    return mixerRuntime.preview(value as MixerParameterPreview).then(() => undefined)
  })

  registerRpcHandler(IPC_CHANNELS.mixerSnapshot, ({ meta }) => {
    const resources = lifecycle.applicationState.audioResourceSnapshot()
    if (!resources.engine) return validationFailure(meta, "target")
    const invalid = validateReadTarget(meta, resources.engine)
    if (invalid) return invalid
    if (isShuttingDown()) return { meters: [], capturedAt: Date.now() }
    return mixerRuntime.runtimeSnapshot()
  })

  registerRpcHandler(IPC_CHANNELS.mixerClearMeterClips, ({ meta }) => {
    const resources = lifecycle.applicationState.audioResourceSnapshot()
    if (!resources.engine) return validationFailure(meta, "target")
    const invalid = validateMutationTarget(meta, resources.engine, resources.revision)
    if (invalid) return invalid
    return mixerRuntime.clearMeterClips()
  })
}
