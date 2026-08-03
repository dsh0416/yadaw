import { BrowserWindow } from "electron"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type {
  OperationEvent,
  OperationSnapshot,
  ResourceRef,
  RpcError,
  RpcResult
} from "@heron/contracts"
import { OperationRegistry } from "./kernel/operation-registry"
import type { OperationRecord } from "./kernel/operation-registry"

function terminalResult(operation: OperationSnapshot): {
  outcome: "committed" | "not-committed" | "quarantined"
  result: RpcResult<unknown>
} {
  if (operation.state === "completed") {
    return {
      outcome: "committed",
      result: {
        ok: true,
        requestId: `operation:${operation.id}`,
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
        requestId: `operation:${operation.id}`,
        operationId: operation.id,
        error: {
          code: "operation-cancelled",
          category: "cancelled",
          outcome: "not-committed",
          retry: "never",
          correlationId: `operation:${operation.id}`,
          userMessageKey: "errors.operationCancelled",
          details: {
            type: "operation-cancelled",
            committed: false
          }
        }
      }
    }
  }
  const error: RpcError = operation.error ?? {
    code: "invariant-violation",
    category: "invariant-violation",
    outcome: "quarantined",
    retry: "after-reconcile",
    correlationId: `operation:${operation.id}`,
    userMessageKey: "errors.internalInvariant",
    details: {
      type: "invariant-violation",
      component: "main"
    }
  }
  return {
    outcome: error.outcome === "not-committed" ? "not-committed" : "quarantined",
    result: {
      ok: false,
      requestId: `operation:${operation.id}`,
      operationId: operation.id,
      error
    }
  }
}

export class OperationService {
  private readonly operations = new Map<string, OperationSnapshot>()
  private readonly cancelHandlers = new Map<string, () => Promise<void>>()
  private readonly lastPublished = new Map<string, number>()
  private eventSequence = 0

  constructor(
    readonly registry: OperationRegistry,
    private readonly defaultTarget: ResourceRef
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
    this.eventSequence += 1
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.operationEvent, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sourceEpoch: this.defaultTarget.epoch,
        sequence: this.eventSequence,
        resourceRevision: this.eventSequence,
        operationId: operation.id,
        payload: event
      })
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
    this.eventSequence += 1
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.operationEvent, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sourceEpoch: this.defaultTarget.epoch,
        sequence: this.eventSequence,
        resourceRevision: this.eventSequence,
        operationId: operation.id,
        payload: event
      })
    }
  }
}
