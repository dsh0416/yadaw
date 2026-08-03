import { beforeEach, describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { RpcRequestMeta } from "@heron/contracts"
import { invokeRpc } from "../../preload/rpc"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock("electron", () => ({
  ipcRenderer: { invoke }
}))

describe("invokeRpc", () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it("returns a successful transport result unchanged", async () => {
    const result = { ok: true, requestId: "read-1", value: 7, warnings: [] } as const
    invoke.mockResolvedValue(result)
    const meta: RpcRequestMeta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "read-1"
    }

    await expect(invokeRpc<number, []>("test:read", meta)).resolves.toBe(result)
  })

  it("maps read rejection to a safely retryable unavailable result", async () => {
    invoke.mockRejectedValue(new Error("renderer was destroyed"))
    const meta: RpcRequestMeta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "read-2"
    }

    await expect(invokeRpc<number, []>("test:read", meta)).resolves.toMatchObject({
      ok: false,
      requestId: "read-2",
      error: {
        code: "transport-unavailable",
        outcome: "not-committed",
        retry: "safe",
        details: { dispatched: false }
      }
    })
  })

  it("maps dispatched mutation rejection to timeout-unknown", async () => {
    invoke.mockRejectedValue(new Error("response channel closed"))
    const meta: RpcRequestMeta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "mutation-1",
      mutation: {
        operationId: "operation-1",
        idempotencyKey: "key-1"
      }
    }

    await expect(invokeRpc<number, []>("test:mutate", meta)).resolves.toMatchObject({
      ok: false,
      requestId: "mutation-1",
      operationId: "operation-1",
      error: {
        code: "operation-timeout-unknown",
        outcome: "unknown",
        retry: "after-reconcile",
        details: { dispatched: true }
      }
    })
  })
})
