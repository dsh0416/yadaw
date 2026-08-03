import type { IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION, rpcFailure } from "@heron/contracts"
import type { RpcRequestMeta } from "@heron/contracts"
import { registerRpcHandler } from "./rpc"

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "") },
  ipcMain: { handle }
}))

const meta: RpcRequestMeta = {
  protocolVersion: IPC_PROTOCOL_VERSION,
  requestId: "request-1"
}

function registeredHandler() {
  return handle.mock.calls.at(-1)?.[1] as (
    event: IpcMainInvokeEvent,
    meta: unknown,
    ...args: unknown[]
  ) => Promise<unknown>
}

describe("registerRpcHandler", () => {
  beforeEach(() => {
    handle.mockReset()
  })

  it("wraps a successful handler value in RpcResult", async () => {
    registerRpcHandler("test:read", (_context, value: number) => ({ doubled: value * 2 }), {
      authenticate: () => {}
    })

    await expect(registeredHandler()({} as IpcMainInvokeEvent, meta, 4)).resolves.toEqual({
      ok: true,
      requestId: "request-1",
      value: { doubled: 8 },
      warnings: []
    })
  })

  it("does not dispatch malformed or unknown-version requests", async () => {
    const handler = vi.fn()
    registerRpcHandler("test:guard", handler, { authenticate: () => {} })

    const result = await registeredHandler()({} as IpcMainInvokeEvent, {
      protocolVersion: 1,
      requestId: "request-old"
    })

    expect(handler).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      requestId: "request-old",
      error: {
        code: "protocol-mismatch",
        outcome: "not-committed",
        details: { expectedVersion: 2, receivedVersion: 1 }
      }
    })
  })

  it("maps sender rejection to validation without dispatching", async () => {
    const handler = vi.fn()
    const logger = { error: vi.fn() }
    registerRpcHandler("test:sender", handler, {
      authenticate: () => {
        throw new Error("untrusted origin")
      },
      logger
    })

    const result = await registeredHandler()({} as IpcMainInvokeEvent, meta)

    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      ok: false,
      requestId: "request-1",
      error: {
        code: "validation-failed",
        outcome: "not-committed",
        details: { field: "sender" }
      }
    })
  })

  it("logs an unexpected cause once and returns a quarantined typed failure", async () => {
    const logger = { error: vi.fn() }
    registerRpcHandler(
      "test:failure",
      () => {
        throw new Error("secret internal detail")
      },
      { authenticate: () => {}, logger }
    )

    const result = await registeredHandler()({} as IpcMainInvokeEvent, meta)

    expect(logger.error).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      ok: false,
      requestId: "request-1",
      error: {
        code: "invariant-violation",
        outcome: "quarantined",
        retry: "after-reconcile"
      }
    })
    expect(JSON.stringify(result)).not.toContain("secret internal detail")
  })

  it("preserves an explicit monadic failure returned by the handler", async () => {
    const failure = rpcFailure(meta, {
      code: "resource-busy",
      category: "busy",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "correlation-1",
      userMessageKey: "errors.busy",
      details: { type: "resource-busy" }
    })
    registerRpcHandler("test:domain-failure", () => failure, { authenticate: () => {} })

    await expect(registeredHandler()({} as IpcMainInvokeEvent, meta)).resolves.toBe(failure)
  })
})
