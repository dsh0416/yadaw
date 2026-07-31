import { randomUUID } from "node:crypto"
import { BrowserWindow, dialog } from "electron"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type {
  MidiImportPlan,
  MidiRuntimeResourceSnapshot,
  MidiSyncPreferences,
  ResourceRef,
  RpcError,
  RpcRequestMeta,
  RpcResult
} from "@yadaw/contracts"
import { validateMidiSyncPreferences } from "../application-settings"
import { t } from "../i18n"
import type { IpcHandlerContext } from "./context"
import { reconcileAudioHostEpoch } from "./audio-host-reconcile"
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
  kind: "validation" | "stale" | "conflict" | "busy" | "unavailable" | "unknown",
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
      details: { type: "validation-failed", field: "midi" },
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
  if (kind === "unknown") {
    return {
      code: "operation-timeout-unknown",
      category: "timeout-unknown",
      outcome: "unknown",
      retry: "after-reconcile",
      userMessageKey: "errors.operationOutcomeUnknown",
      details: { type: "operation-timeout-unknown", dispatched: true },
      ...common
    }
  }
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    userMessageKey: "errors.midiUnavailable",
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
): RpcResult<unknown> | null {
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
  if (meta.mutation) {
    context.operations.registry.finish(meta.mutation.operationId, outcome, result)
  }
}

function publish(snapshot: MidiRuntimeResourceSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.midiInputEvent, structuredClone(snapshot))
  }
}

function importPlan(value: unknown): MidiImportPlan | null {
  if (!value || typeof value !== "object") return null
  const plan = value as Partial<MidiImportPlan>
  return typeof plan.token === "string" &&
    plan.token.length > 0 &&
    Number.isSafeInteger(plan.insertionTick) &&
    typeof plan.importTempoMap === "boolean" &&
    Array.isArray(plan.tracks)
    ? (plan as MidiImportPlan)
    : null
}

export function registerMidiRpcHandlers(context: IpcHandlerContext): void {
  const { lifecycle, midiImport, audioHost, settings, recordings } = context
  const state = lifecycle.applicationState
  const reconcileAudioHost = () =>
    reconcileAudioHostEpoch({
      audioHost,
      lifecycle,
      recordings
    })

  registerRpcHandler(IPC_CHANNELS.midiInputSnapshot, async ({ meta }) => {
    await reconcileAudioHost()
    const resources = state.audioResourceSnapshot()
    if (!sameRef(meta.target, resources.midiRuntime)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    try {
      return rpcSuccess(meta, state.midiRuntimeSnapshot(await audioHost.midiInputSnapshot()))
    } catch {
      return rpcFailure(meta, error(meta, "unavailable"))
    }
  })

  registerRpcHandler(IPC_CHANNELS.midiInputConfigure, async ({ meta }, value: unknown) => {
    await reconcileAudioHost()
    const resources = state.audioResourceSnapshot()
    if (!sameRef(meta.target, resources.midiRuntime)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    const resolved = state.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) return rpcFailure(meta, error(meta, "stale"))
    if (meta.expectedRevision !== resolved.value.revision) {
      return rpcFailure(meta, error(meta, "conflict", resolved.value.revision))
    }
    let preferences: MidiSyncPreferences
    try {
      preferences = validateMidiSyncPreferences(value)
    } catch {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const guarded = beginMutation(context, meta, resources.midiRuntime)
    if (guarded) return guarded
    if (recordings.current || audioHost.configurationRestarting) {
      const result = rpcFailure(meta, error(meta, "busy"))
      finish(context, meta, "not-committed", result)
      return result
    }
    const current = await settings.get()
    try {
      await audioHost.configureMidiInput(preferences, current.shortcuts)
      try {
        await settings.configureMidiInput(preferences)
      } catch {
        try {
          await audioHost.configureMidiInput(current.midiSync, current.shortcuts)
        } catch {
          const result = rpcFailure(meta, error(meta, "unknown"))
          finish(context, meta, "quarantined", result)
          return result
        }
        const result = rpcFailure(meta, error(meta, "unavailable"))
        finish(context, meta, "not-committed", result)
        return result
      }
      const snapshot = state.advanceMidiRuntime(await audioHost.midiInputSnapshot())
      publish(snapshot)
      const result = rpcSuccess(meta, snapshot, { resourceRevision: snapshot.revision })
      finish(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.midiControlLearning, async ({ meta }, value: unknown) => {
    await reconcileAudioHost()
    const resources = state.audioResourceSnapshot()
    if (typeof value !== "boolean") return rpcFailure(meta, error(meta, "validation"))
    if (!sameRef(meta.target, resources.midiRuntime)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    const resolved = state.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) return rpcFailure(meta, error(meta, "stale"))
    if (meta.expectedRevision !== resolved.value.revision) {
      return rpcFailure(meta, error(meta, "conflict", resolved.value.revision))
    }
    const guarded = beginMutation(context, meta, resources.midiRuntime)
    if (guarded) return guarded
    try {
      await audioHost.setMidiControlLearning(value)
      const snapshot = state.advanceMidiRuntime(await audioHost.midiInputSnapshot())
      publish(snapshot)
      const result = rpcSuccess(meta, snapshot, { resourceRevision: snapshot.revision })
      finish(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.midiImportPrepare, async ({ meta }, value: unknown) => {
    const workspace = state.workspaceSnapshot()
    if (!workspace || !sameRef(meta.target, workspace.project)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    const guarded = beginMutation(context, meta, workspace.project)
    if (guarded) return guarded
    let path = typeof value === "string" && value.trim() ? value : undefined
    try {
      lifecycle.assertProjectWriteAllowed()
      if (!path) {
        const selected = await dialog.showOpenDialog({
          title: t("dialog.importMidi.title"),
          properties: ["openFile"],
          filters: [{ name: t("dialog.importMidi.filter"), extensions: ["mid", "midi"] }]
        })
        path = selected.filePaths[0]
        if (selected.canceled || !path) {
          const result = rpcSuccess(meta, null)
          finish(context, meta, "committed", result)
          return result
        }
      }
      const result = rpcSuccess(meta, await midiImport.prepare(path, workspace.projectGraph))
      finish(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      finish(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.midiImportCommit, async ({ meta }, value: unknown) => {
    const workspace = state.workspaceSnapshot()
    const plan = importPlan(value)
    if (!workspace || !sameRef(meta.target, workspace.projectGraph)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (!plan) return rpcFailure(meta, error(meta, "validation"))
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, error(meta, "conflict", workspace.revision))
    }
    const guarded = beginMutation(context, meta, workspace.projectGraph)
    if (guarded) return guarded
    try {
      lifecycle.assertProjectWriteAllowed()
      const value = await midiImport.commit(meta, plan)
      const result = rpcSuccess(meta, value, { resourceRevision: value.workspace.revision })
      finish(context, meta, "committed", result)
      return result
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const committed = message.includes("Committed MIDI import resource could not advance")
      const result = rpcFailure(meta, error(meta, committed ? "unknown" : "unavailable"))
      finish(context, meta, committed ? "quarantined" : "not-committed", result)
      return result
    }
  })
}
