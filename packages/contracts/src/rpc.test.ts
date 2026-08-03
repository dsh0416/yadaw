import { describe, expect, it } from "vitest"

import {
  IPC_PROTOCOL_VERSION,
  isResourceRef,
  isRpcRequestMeta,
  rpcFailure,
  rpcSuccess
} from "./rpc"
import type { RpcError, RpcRequestMeta } from "./rpc"

const desktop = {
  kind: "desktop-session",
  id: "desktop",
  epoch: "18446744073709551615",
  generation: 3
} as const

const mutationMeta: RpcRequestMeta = {
  protocolVersion: IPC_PROTOCOL_VERSION,
  requestId: "request-7",
  target: desktop,
  expectedRevision: 11,
  mutation: {
    operationId: "operation-9",
    idempotencyKey: "open:C:/music/demo.heron"
  }
}

describe("IPC v2 contracts", () => {
  it("keeps epochs lossless beyond JavaScript's safe integer range", () => {
    expect(isResourceRef(desktop)).toBe(true)
    expect(JSON.parse(JSON.stringify(desktop)).epoch).toBe("18446744073709551615")
  })

  it("rejects malformed, stale-shaped, and unknown-version metadata", () => {
    expect(isRpcRequestMeta(mutationMeta)).toBe(true)
    expect(isRpcRequestMeta({ ...mutationMeta, protocolVersion: 1 })).toBe(false)
    expect(isRpcRequestMeta({ ...mutationMeta, target: { ...desktop, epoch: 9 } })).toBe(false)
    expect(
      isRpcRequestMeta({
        ...mutationMeta,
        mutation: { operationId: "", idempotencyKey: "key" }
      })
    ).toBe(false)
  })

  it("serializes the representative request shape identically to Rust", () => {
    expect(JSON.stringify(mutationMeta)).toBe(
      '{"protocolVersion":2,"requestId":"request-7","target":{"kind":"desktop-session","id":"desktop","epoch":"18446744073709551615","generation":3},"expectedRevision":11,"mutation":{"operationId":"operation-9","idempotencyKey":"open:C:/music/demo.heron"}}'
    )
  })

  it("serializes success and typed failure without exception fields", () => {
    expect(JSON.stringify(rpcSuccess(mutationMeta, { projectId: "project-1" }))).toBe(
      '{"ok":true,"requestId":"request-7","operationId":"operation-9","value":{"projectId":"project-1"},"warnings":[]}'
    )

    const error: RpcError = {
      code: "revision-conflict",
      category: "conflict",
      outcome: "not-committed",
      retry: "after-reconcile",
      correlationId: "correlation-2",
      userMessageKey: "errors.revisionConflict",
      resource: desktop,
      details: {
        type: "revision-conflict",
        expectedRevision: 11,
        actualRevision: 12
      }
    }
    const failure = rpcFailure(mutationMeta, error)
    expect(JSON.stringify(failure)).toBe(
      '{"ok":false,"requestId":"request-7","operationId":"operation-9","error":{"code":"revision-conflict","category":"conflict","outcome":"not-committed","retry":"after-reconcile","correlationId":"correlation-2","userMessageKey":"errors.revisionConflict","resource":{"kind":"desktop-session","id":"desktop","epoch":"18446744073709551615","generation":3},"details":{"type":"revision-conflict","expectedRevision":11,"actualRevision":12}}}'
    )
    expect(JSON.stringify(failure)).not.toMatch(/"(message|stack|cause)":/i)
  })
})
