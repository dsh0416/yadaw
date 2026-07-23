import { BrowserWindow } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { OperationEvent, OperationSnapshot } from "@yadaw/contracts"

export class OperationService {
  private readonly operations = new Map<string, OperationSnapshot>()
  private readonly cancelHandlers = new Map<string, () => Promise<void>>()
  private readonly lastPublished = new Map<string, number>()

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
    if (handler) this.cancelHandlers.set(id, handler)
    else this.cancelHandlers.delete(id)
  }

  async cancel(id: string): Promise<void> {
    const operation = this.operations.get(id)
    if (!operation?.cancellable) return
    await this.cancelHandlers.get(id)?.()
  }

  remove(id: string): void {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id)
    this.cancelHandlers.delete(id)
    this.lastPublished.delete(id)
    const event: OperationEvent = { type: "remove", operation }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.operationEvent, event)
    }
  }
}
