import { describe, expect, it } from "vitest"
import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { ResourceRef, RpcRequestMeta } from "@heron/contracts"
import { OperationRegistry } from "../kernel"
import type { IpcHandlerContext } from "./context"
import { beginGuardedMutation, finishGuardedMutation } from "./operation-guard"

function meta(operationId: string, target: ResourceRef): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: `request-${operationId}`,
    target,
    mutation: {
      operationId,
      idempotencyKey: `key-${operationId}`
    }
  }
}

function target(): ResourceRef {
  return {
    kind: "audio-host",
    id: "host",
    epoch: "epoch-1",
    generation: 1
  }
}

function context(
  registry = new OperationRegistry(),
  activeExclusiveOfflineOperationId: string | null = null
): IpcHandlerContext {
  return {
    operations: { registry },
    lifecycle: { activeExclusiveOfflineOperationId }
  } as unknown as IpcHandlerContext
}

describe("beginGuardedMutation", () => {
  it("maps an exclusive offline bounce to resource-busy before registering a mutation", () => {
    const registry = new OperationRegistry()
    const host = target()
    const result = beginGuardedMutation(context(registry, "bounce-1"), meta("op-0", host), host)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "resource-busy",
        details: { type: "resource-busy", activeOperationId: "bounce-1" }
      }
    })
    expect(registry.activeCount).toBe(0)
  })

  it("returns busy when an in-flight operation has no stored result", () => {
    const registry = new OperationRegistry()
    const host = target()
    const request = meta("op-1", host)
    expect(beginGuardedMutation(context(registry), request, host)).toBeNull()
    const replay = beginGuardedMutation(context(registry), request, host)
    expect(replay).toMatchObject({
      ok: false,
      error: {
        code: "resource-busy",
        details: { type: "resource-busy", activeOperationId: "op-1" }
      }
    })
  })

  it("replays a finished operation result with the new request id", () => {
    const registry = new OperationRegistry()
    const host = target()
    const first = meta("op-2", host)
    expect(beginGuardedMutation(context(registry), first, host)).toBeNull()
    const result = {
      ok: true as const,
      requestId: first.requestId,
      operationId: first.mutation!.operationId,
      value: { done: true },
      warnings: []
    }
    finishGuardedMutation(context(registry), first, "committed", result)
    const second = {
      ...first,
      requestId: "request-op-2-retry"
    }
    expect(beginGuardedMutation(context(registry), second, host)).toMatchObject({
      ok: true,
      requestId: "request-op-2-retry",
      value: { done: true }
    })
  })

  it("maps registry capacity failures to resource-busy", () => {
    const registry = new OperationRegistry(1)
    const host = target()
    expect(beginGuardedMutation(context(registry), meta("fill", host), host)).toBeNull()
    finishGuardedMutation(context(registry), meta("fill", host), "committed", {
      ok: true,
      requestId: "request-fill",
      operationId: "fill",
      value: null,
      warnings: []
    })
    const blocked = beginGuardedMutation(context(registry), meta("overflow", host), host)
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "resource-busy" }
    })
  })
})
