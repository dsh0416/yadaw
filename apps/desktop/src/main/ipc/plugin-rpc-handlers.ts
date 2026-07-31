import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, isResourceRef, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type {
  PluginParameterCommand,
  ResourceRef,
  RpcError,
  RpcRequestMeta,
  RpcResult
} from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"

function sameRef(left: ResourceRef | undefined | null, right: ResourceRef | undefined | null) {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function error(
  meta: RpcRequestMeta,
  kind: "validation" | "stale" | "conflict" | "busy" | "unavailable",
  value?: number | string
): RpcError {
  const common = {
    correlationId: randomUUID(),
    ...(meta.target ? { resource: meta.target } : {})
  }
  if (kind === "validation") {
    return {
      code: "validation-failed",
      category: "validation",
      outcome: "not-committed",
      retry: "never",
      userMessageKey: "errors.invalidRpcRequest",
      details: { type: "validation-failed", field: "plugin" },
      ...common
    }
  }
  if (kind === "stale") {
    return {
      code: "stale-resource",
      category: "stale-resource",
      outcome: "not-committed",
      retry: "after-reconcile",
      userMessageKey: "errors.staleResource",
      details: { type: "stale-resource", reason: "generation-mismatch" },
      ...common
    }
  }
  if (kind === "conflict") {
    return {
      code: "revision-conflict",
      category: "conflict",
      outcome: "not-committed",
      retry: "after-reconcile",
      userMessageKey: "errors.revisionConflict",
      details: {
        type: "revision-conflict",
        expectedRevision: meta.expectedRevision ?? -1,
        actualRevision: typeof value === "number" ? value : -1
      },
      ...common
    }
  }
  if (kind === "busy") {
    return {
      code: "resource-busy",
      category: "busy",
      outcome: "not-committed",
      retry: "safe",
      userMessageKey: "errors.resourceBusy",
      details: {
        type: "resource-busy",
        ...(typeof value === "string" ? { activeOperationId: value } : {})
      },
      ...common
    }
  }
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    userMessageKey: "errors.pluginUnavailable",
    details: { type: "resource-unavailable", component: "audio-host", dispatched: true },
    ...common
  }
}

function rebind(meta: RpcRequestMeta, result: RpcResult<unknown>): RpcResult<unknown> {
  return { ...structuredClone(result), requestId: meta.requestId }
}

function beginMutation(
  context: IpcHandlerContext,
  meta: RpcRequestMeta,
  target: ResourceRef
): RpcResult<never> | RpcResult<unknown> | null {
  if (!meta.mutation) return rpcFailure(meta, error(meta, "validation"))
  const existing = context.operations.registry.status(meta.mutation.operationId)
  if (existing.ok) {
    return existing.value.result
      ? rebind(meta, existing.value.result)
      : rpcFailure(meta, error(meta, "busy", existing.value.operationId))
  }
  const begun = context.operations.registry.begin({
    operationId: meta.mutation.operationId,
    idempotencyKey: meta.mutation.idempotencyKey,
    target
  })
  if (!begun.ok) return rpcFailure(meta, error(meta, "busy", meta.mutation.operationId))
  if (begun.value.disposition === "existing") {
    return begun.value.operation.result
      ? rebind(meta, begun.value.operation.result)
      : rpcFailure(meta, error(meta, "busy", begun.value.operation.operationId))
  }
  return null
}

function finish(
  context: IpcHandlerContext,
  meta: RpcRequestMeta,
  outcome: "committed" | "not-committed" | "quarantined",
  result: RpcResult<unknown>
): void {
  context.operations.registry.finish(meta.mutation!.operationId, outcome, result)
}

function parameterCommand(value: unknown): PluginParameterCommand | null {
  if (!value || typeof value !== "object") return null
  const command = value as Partial<PluginParameterCommand>
  return isResourceRef(command.plugin) &&
    command.plugin.kind === "plugin-instance" &&
    typeof command.helperEpoch === "string" &&
    command.helperEpoch.length > 0 &&
    Number.isInteger(command.pluginGeneration) &&
    typeof command.sequence === "string" &&
    /^[0-9]+$/u.test(command.sequence) &&
    Number.isInteger(command.parameterId) &&
    typeof command.normalized === "number" &&
    Number.isFinite(command.normalized) &&
    command.normalized >= 0 &&
    command.normalized <= 1 &&
    (command.gesture === "begin" || command.gesture === "perform" || command.gesture === "end")
    ? (command as PluginParameterCommand)
    : null
}

export function registerPluginRpcHandlers(context: IpcHandlerContext): void {
  const { plugins, lifecycle, audioHost } = context
  const state = lifecycle.applicationState

  registerRpcHandler(IPC_CHANNELS.pluginsList, ({ meta }) => {
    if (!sameRef(meta.target, state.desktopSession)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    return rpcSuccess(meta, plugins.list())
  })

  registerRpcHandler(IPC_CHANNELS.pluginsScan, async ({ meta }, value: unknown) => {
    if (!sameRef(meta.target, state.desktopSession)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const guarded = beginMutation(context, meta, state.desktopSession)
    if (guarded) return guarded
    try {
      const catalog = await plugins.scan(value ?? {})
      const result = rpcSuccess(meta, catalog)
      finish(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.pluginEditorOpen, async ({ meta }, value: unknown) => {
    if (typeof value !== "string" || value.length === 0) {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const workspace = state.workspaceSnapshot()
    if (!workspace || !sameRef(meta.target, workspace.projectGraph)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, error(meta, "conflict", workspace.revision))
    }
    const guarded = beginMutation(context, meta, workspace.projectGraph)
    if (guarded) return guarded
    let resource = null
    try {
      resource = await state.pluginInstanceSnapshot(value, () => plugins.closeEditor(value))
      if (!resource) {
        const result = rpcFailure(meta, error(meta, "stale"))
        finish(context, meta, "not-committed", result)
        return result
      }
      const status = await plugins.openEditor(value)
      const result = rpcSuccess(
        meta,
        { resource, status },
        {
          resourceRevision: resource.revision
        }
      )
      finish(context, meta, "committed", result)
      return result
    } catch {
      if (resource) await state.resources.drop(resource.plugin)
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.pluginEditorClose, async ({ meta }) => {
    if (!meta.target || meta.target.kind !== "plugin-instance") {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const guarded = beginMutation(context, meta, meta.target)
    if (guarded) return guarded
    try {
      await plugins.closeEditor(meta.target.id)
      await state.resources.drop(meta.target)
      const result = rpcSuccess(meta, undefined)
      finish(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.pluginParametersGet, async ({ meta }) => {
    if (!meta.target || meta.target.kind !== "plugin-instance") {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const resource = await state.pluginInstanceSnapshot(meta.target.id, () =>
      plugins.closeEditor(meta.target!.id)
    )
    if (!resource || !sameRef(meta.target, resource.plugin)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    try {
      return rpcSuccess(meta, await plugins.parameters(meta.target.id), {
        resourceRevision: resource.revision
      })
    } catch {
      return rpcFailure(meta, error(meta, "unavailable"))
    }
  })

  registerRpcHandler(IPC_CHANNELS.pluginParameterSet, async ({ meta }, value: unknown) => {
    const command = parameterCommand(value)
    const target = meta.target
    if (!meta.mutation || !command || !target || target.kind !== "plugin-instance") {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const resource = await state.pluginInstanceSnapshot(target.id, () =>
      plugins.closeEditor(target.id)
    )
    if (
      !resource ||
      !sameRef(target, resource.plugin) ||
      !sameRef(command.plugin, resource.plugin) ||
      command.pluginGeneration !== resource.plugin.generation ||
      command.helperEpoch !== state.audioHost.epoch
    ) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    try {
      return rpcSuccess(meta, await audioHost.enqueuePluginParameter(command))
    } catch {
      return rpcFailure(meta, error(meta, "unavailable"))
    }
  })
}
