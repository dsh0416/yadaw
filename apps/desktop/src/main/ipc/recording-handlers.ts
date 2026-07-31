import { IPC_CHANNELS } from "@yadaw/contracts"
import type { OperationStatusSnapshot } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import type { OperationRecord } from "../kernel/operation-registry"
import { registerRpcHandler } from "./rpc"
import {
  validationFailure,
  validateMutationTarget,
  validateReadTarget
} from "./resource-validation"
import { validateWaveformRequest } from "./support"
import { registerRecordingRpcHandlers } from "./recording-rpc-handlers"

function operationSnapshot(record: OperationRecord): OperationStatusSnapshot {
  const outcome =
    record.state === "committed" ||
    record.state === "not-committed" ||
    record.state === "quarantined"
      ? record.state
      : undefined
  return {
    operationId: record.operationId,
    state: outcome
      ? "terminal"
      : record.state === "cancel-requested"
        ? "cancel-requested"
        : "running",
    ...(outcome ? { outcome } : {}),
    target: record.target,
    cancellable: record.cancellable,
    acknowledged: false
  }
}

export function registerRecordingHandlers(context: IpcHandlerContext): void {
  const { projects, operations, waveforms, lifecycle } = context
  const state = lifecycle.applicationState
  registerRecordingRpcHandlers(context)
  registerRpcHandler(IPC_CHANNELS.assetAudioRead, ({ meta }, value: unknown) => {
    const workspace = state.workspaceSnapshot()
    if (!workspace) return validationFailure(meta, "target")
    const invalid = validateReadTarget(meta, workspace.project)
    if (invalid) return invalid
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new TypeError("Audio asset id must be a non-empty string")
    }
    return projects.readAssetAudio(value)
  })

  registerRpcHandler(IPC_CHANNELS.assetWaveformRead, ({ meta }, value: unknown) => {
    const workspace = state.workspaceSnapshot()
    if (!workspace) return validationFailure(meta, "target")
    const invalid = validateReadTarget(meta, workspace.project)
    if (invalid) return invalid
    return waveforms.readAsset(validateWaveformRequest(value))
  })

  registerRpcHandler(IPC_CHANNELS.operationStatus, ({ meta }, value: unknown) => {
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    const invalid = validateReadTarget(meta, state.desktopSession)
    if (invalid) return invalid
    const status = operations.operationStatus(value)
    return status ? operationSnapshot(status) : null
  })

  registerRpcHandler(IPC_CHANNELS.operationCancel, async ({ meta }, value: unknown) => {
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    const invalid = validateMutationTarget(meta, state.desktopSession)
    if (invalid) return invalid
    const status = await operations.cancelOperation(value)
    return status ? operationSnapshot(status) : null
  })

  registerRpcHandler(IPC_CHANNELS.operationAcknowledge, ({ meta }, value: unknown) => {
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    const invalid = validateMutationTarget(meta, state.desktopSession)
    if (invalid) return invalid
    return operations.acknowledgeOperation(value)
  })
}
