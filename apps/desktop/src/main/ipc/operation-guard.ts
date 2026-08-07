import { randomUUID } from "node:crypto"
import { rpcFailure } from "@heron/contracts"
import type { ResourceRef, RpcError, RpcRequestMeta, RpcResult } from "@heron/contracts"
import type { IpcHandlerContext } from "./context"

function rebindResult(meta: RpcRequestMeta, result: RpcResult<unknown>): RpcResult<unknown> {
  return {
    ...structuredClone(result),
    requestId: meta.requestId
  }
}

function busyError(meta: RpcRequestMeta, activeOperationId?: string): RpcError {
  return {
    code: "resource-busy",
    category: "busy",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.resourceBusy",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "resource-busy",
      ...(activeOperationId ? { activeOperationId } : {})
    }
  }
}

function validationError(meta: RpcRequestMeta): RpcError {
  return {
    code: "validation-failed",
    category: "validation",
    outcome: "not-committed",
    retry: "never",
    correlationId: randomUUID(),
    userMessageKey: "errors.invalidRpcRequest",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "validation-failed", field: "mutation" }
  }
}

export function exclusiveOfflineOperationFailure(
  context: IpcHandlerContext,
  meta: RpcRequestMeta
): RpcResult<never> | null {
  const operationId = context.lifecycle.activeExclusiveOfflineOperationId
  return operationId ? rpcFailure(meta, busyError(meta, operationId)) : null
}

/** Returns a replay/busy/validation result, or null when the mutation has been started. */
export function beginGuardedMutation(
  context: IpcHandlerContext,
  meta: RpcRequestMeta,
  target: ResourceRef
): RpcResult<unknown> | null {
  if (!meta.mutation) return rpcFailure(meta, validationError(meta))
  const exclusive = exclusiveOfflineOperationFailure(context, meta)
  if (exclusive) return exclusive
  const existing = context.operations.registry.status(meta.mutation.operationId)
  if (existing.ok) {
    return existing.value.result
      ? rebindResult(meta, existing.value.result)
      : rpcFailure(meta, busyError(meta, existing.value.operationId))
  }
  const begun = context.operations.registry.begin({
    operationId: meta.mutation.operationId,
    idempotencyKey: meta.mutation.idempotencyKey,
    target
  })
  if (!begun.ok) {
    return rpcFailure(
      meta,
      begun.error.code === "operation-conflict"
        ? validationError(meta)
        : busyError(meta, meta.mutation.operationId)
    )
  }
  if (begun.value.disposition === "existing") {
    return begun.value.operation.result
      ? rebindResult(meta, begun.value.operation.result)
      : rpcFailure(meta, busyError(meta, begun.value.operation.operationId))
  }
  return null
}

export function finishGuardedMutation(
  context: IpcHandlerContext,
  meta: RpcRequestMeta,
  outcome: "committed" | "not-committed" | "quarantined",
  result: RpcResult<unknown>
): void {
  if (!meta.mutation) return
  context.operations.registry.finish(meta.mutation.operationId, outcome, result)
}
