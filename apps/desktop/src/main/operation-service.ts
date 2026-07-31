import { BrowserWindow } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { OperationEvent, OperationSnapshot, ResourceRef, RpcResult } from "@yadaw/contracts"
import { OperationRegistry } from "./kernel/operation-registry"
import type { OperationRecord } from "./kernel/operation-registry"

const legacyDesktopTarget: ResourceRef = {
  kind: "desktop-session",
  id: "legacy-desktop",
  epoch: "legacy",
  generation: 0
}

function terminalResult(operation: OperationSnapshot): {
  outcome: "committed" | "not-committed" | "quarantined"
  result: RpcResult<unknown>
} {
  if (operation.state === "completed") {
    return {
      outcome: "committed",
      result: {
        ok: true,
        requestId: `legacy-${operation.id}`,
        operationId: operation.id,
        value: null,
        warnings: []
      }
    }
  }
  if (operation.state === "cancelled") {
    return {
      outcome: "not-committed",
      result: {
        ok: false,
        requestId: `legacy-${operation.id}`,
        operationId: operation.id,
        error: {
          code: "operation-cancelled",
          category: "cancelled",
          outcome: "not-committed",
          retry: "never",
          correlationId: `legacy-${operation.id}`,
          userMessageKey: "errors.operationCancelled",
          details: {
            type: "operation-cancelled",
            committed: false
          }
        }
      }
    }
  }
  return {
    outcome: "not-committed",
    result: {
      ok: false,
      requestId: `legacy-${operation.id}`,
      operationId: operation.id,
      error: {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: `legacy-${operation.id}`,
        userMessageKey: "errors.operationFailed",
        details: {
          type: "resource-unavailable",
          component: "main",
          dispatched: true
        }
      }
    }
  }
}

export class OperationService {
  private readonly operations = new Map<string, OperationSnapshot>()
  private readonly cancelHandlers = new Map<string, () => Promise<void>>()
  private readonly lastPublished = new Map<string, number>()

  constructor(
    readonly registry = new OperationRegistry(),
    private readonly defaultTarget: ResourceRef = legacyDesktopTarget
  ) {}

  get activeCount(): number {
    return this.registry.activeCount
  }

  private publish(operation: OperationSnapshot, force = false): void {
    const now = Date.now()
    const last = this.lastPublished.get(operation.id) ?? 0
    if (!force && now - last < 100) return
    this.lastPublished.set(operation.id, now)
    const event: OperationEvent = { type: "upsert", operation: structuredClone(operation) }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.operationEvent, event)
    }
  }

  upsert(operation: OperationSnapshot, force = false): void {
    this.operations.set(operation.id, structuredClone(operation))
    const status = this.registry.status(operation.id)
    if (!status.ok) {
      this.registry.begin({
        operationId: operation.id,
        idempotencyKey: operation.id,
        target: this.defaultTarget,
        cancellable: operation.cancellable
      })
    }
    if (operation.state !== "running") {
      const terminal = terminalResult(operation)
      this.registry.finish(operation.id, terminal.outcome, terminal.result)
    }
    this.publish(operation, force)
  }

  patch(id: string, patch: Partial<OperationSnapshot>, force = false): OperationSnapshot {
    const current = this.operations.get(id)
    if (!current) throw new Error(`Unknown operation ${id}`)
    const next = { ...current, ...patch }
    this.upsert(next, force)
    return next
  }

  setCancelHandler(id: string, handler: (() => Promise<void>) | null): void {
    if (handler) {
      this.cancelHandlers.set(id, handler)
      this.registry.setCancellationHandler(id, async () => {
        await handler()
        return "cancelled"
      })
    } else {
      this.cancelHandlers.delete(id)
      this.registry.setCancellationHandler(id, null)
    }
  }

  async cancel(id: string): Promise<void> {
    const operation = this.operations.get(id)
    if (!operation?.cancellable) return
    await this.registry.cancel(id)
  }

  operationStatus(id: string): OperationRecord | null {
    const status = this.registry.status(id)
    return status.ok ? status.value : null
  }

  async cancelOperation(id: string): Promise<OperationRecord | null> {
    const result = await this.registry.cancel(id)
    return result.ok ? result.value : null
  }

  acknowledgeOperation(id: string): boolean {
    return this.registry.acknowledge(id).ok
  }

  remove(id: string): void {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id)
    this.cancelHandlers.delete(id)
    this.lastPublished.delete(id)
    const status = this.registry.status(id)
    if (status.ok) {
      if (status.value.state === "running" || status.value.state === "cancel-requested") {
        const terminal = terminalResult({ ...operation, state: "cancelled" })
        this.registry.finish(id, terminal.outcome, terminal.result)
      }
      this.registry.acknowledge(id)
    }
    const event: OperationEvent = { type: "remove", operation }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.operationEvent, event)
    }
  }
}
