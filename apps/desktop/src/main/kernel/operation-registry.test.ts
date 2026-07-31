import { describe, expect, it, vi } from "vitest"
import type { ResourceRef, RpcResult } from "@yadaw/contracts"
import { OperationRegistry } from "./operation-registry"

const target: ResourceRef = {
  kind: "project-session",
  id: "project",
  epoch: "epoch",
  generation: 1
}

function committed(operationId: string): RpcResult<unknown> {
  return {
    ok: true,
    requestId: `request-${operationId}`,
    operationId,
    value: { revision: 2 },
    warnings: []
  }
}

describe("OperationRegistry", () => {
  it("returns the original operation for duplicate idempotency keys", () => {
    const registry = new OperationRegistry()
    const first = registry.begin({
      operationId: "operation-1",
      idempotencyKey: "save",
      target
    })
    const duplicate = registry.begin({
      operationId: "operation-2",
      idempotencyKey: "save",
      target
    })

    expect(first).toMatchObject({ ok: true, value: { disposition: "started" } })
    expect(duplicate).toMatchObject({
      ok: true,
      value: {
        disposition: "existing",
        operation: { operationId: "operation-1" }
      }
    })
  })

  it("retains terminal results until acknowledgement and applies backpressure", () => {
    const registry = new OperationRegistry(1)
    registry.begin({ operationId: "operation-1", idempotencyKey: "save-1", target })
    registry.finish("operation-1", "committed", committed("operation-1"))

    expect(registry.status("operation-1")).toMatchObject({
      ok: true,
      value: { state: "committed", result: { ok: true } }
    })
    expect(
      registry.begin({ operationId: "operation-2", idempotencyKey: "save-2", target })
    ).toMatchObject({
      ok: false,
      error: { code: "operation-busy", retainedTerminalCount: 1, limit: 1 }
    })

    expect(registry.acknowledge("operation-1").ok).toBe(true)
    expect(
      registry.begin({ operationId: "operation-2", idempotencyKey: "save-2", target })
    ).toMatchObject({ ok: true, value: { disposition: "started" } })
  })

  it("reserves terminal capacity when an operation starts", () => {
    const registry = new OperationRegistry(1)
    registry.begin({ operationId: "operation-1", idempotencyKey: "save-1", target })

    expect(
      registry.begin({ operationId: "operation-2", idempotencyKey: "save-2", target })
    ).toMatchObject({
      ok: false,
      error: {
        code: "operation-busy",
        unacknowledgedCount: 1,
        retainedTerminalCount: 0,
        limit: 1
      }
    })
  })

  it("returns the committed result when commit wins a cancellation race", async () => {
    const registry = new OperationRegistry()
    let releaseCancel: ((outcome: "cancelled") => void) | undefined
    const cancelHandler = vi.fn(
      () =>
        new Promise<"cancelled">((resolve) => {
          releaseCancel = resolve
        })
    )
    registry.begin({
      operationId: "operation-1",
      idempotencyKey: "open",
      target,
      cancellable: true,
      cancelHandler
    })

    const cancellation = registry.cancel("operation-1")
    registry.finish("operation-1", "committed", committed("operation-1"))
    releaseCancel?.("cancelled")

    await expect(cancellation).resolves.toMatchObject({
      ok: true,
      value: { state: "committed", result: { ok: true } }
    })
  })

  it("turns cancellation transport failure into a quarantined unknown outcome", async () => {
    const registry = new OperationRegistry()
    registry.begin({
      operationId: "operation-1",
      idempotencyKey: "open",
      target,
      cancellable: true,
      cancelHandler: async () => {
        throw new Error("worker exited")
      }
    })

    await expect(registry.cancel("operation-1")).resolves.toMatchObject({
      ok: true,
      value: {
        state: "quarantined",
        result: {
          ok: false,
          error: {
            code: "operation-timeout-unknown",
            outcome: "unknown"
          }
        }
      }
    })
  })
})
