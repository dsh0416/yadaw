import { randomUUID } from "node:crypto"
import { rpcFailure } from "@heron/contracts"
import type { ResourceRef, RpcRequestMeta, RpcResult } from "@heron/contracts"

export function sameResourceRef(left: ResourceRef | undefined, right: ResourceRef): boolean {
  return (
    left?.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

export function validationFailure(meta: RpcRequestMeta, field: string): RpcResult<never> {
  return rpcFailure(meta, {
    code: "validation-failed",
    category: "validation",
    outcome: "not-committed",
    retry: "never",
    correlationId: randomUUID(),
    userMessageKey: "errors.invalidRpcRequest",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "validation-failed", field }
  })
}

export function staleResourceFailure(meta: RpcRequestMeta, target: ResourceRef): RpcResult<never> {
  return rpcFailure(meta, {
    code: "stale-resource",
    category: "stale-resource",
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.staleResource",
    resource: meta.target ?? target,
    details: { type: "stale-resource", reason: "generation-mismatch" }
  })
}

export function revisionConflictFailure(
  meta: RpcRequestMeta,
  target: ResourceRef,
  actualRevision: number
): RpcResult<never> {
  return rpcFailure(meta, {
    code: "revision-conflict",
    category: "conflict",
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.revisionConflict",
    resource: target,
    details: {
      type: "revision-conflict",
      expectedRevision: meta.expectedRevision ?? -1,
      actualRevision
    }
  })
}

export function validateReadTarget(
  meta: RpcRequestMeta,
  target: ResourceRef
): RpcResult<never> | null {
  if (meta.mutation) return validationFailure(meta, "mutation")
  if (!sameResourceRef(meta.target, target)) return staleResourceFailure(meta, target)
  return null
}

export function validateMutationTarget(
  meta: RpcRequestMeta,
  target: ResourceRef,
  actualRevision?: number
): RpcResult<never> | null {
  if (!meta.mutation) return validationFailure(meta, "mutation")
  if (!sameResourceRef(meta.target, target)) return staleResourceFailure(meta, target)
  if (actualRevision !== undefined && meta.expectedRevision !== actualRevision) {
    return revisionConflictFailure(meta, target, actualRevision)
  }
  return null
}
