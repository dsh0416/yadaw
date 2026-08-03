import type { ResourceRef, RpcError, RpcResult } from "@heron/contracts"
import { kernelFailure, kernelSuccess } from "./result"
import type { KernelResult } from "./result"

export type OperationTerminalOutcome = "committed" | "not-committed" | "quarantined"
export type OperationState = "running" | "cancel-requested" | OperationTerminalOutcome
export type CancellationOutcome = "cancelled" | "unknown"

export interface OperationRecord {
  operationId: string
  idempotencyKey: string
  target: ResourceRef
  state: OperationState
  cancellable: boolean
  startedAt: number
  completedAt?: number
  result?: RpcResult<unknown>
}

interface StoredOperation extends OperationRecord {
  cancelHandler?: () => Promise<CancellationOutcome>
}

export type OperationRegistryError =
  | { code: "operation-not-found"; operationId: string }
  | {
      code: "operation-busy"
      unacknowledgedCount: number
      retainedTerminalCount: number
      limit: number
    }
  | { code: "operation-conflict"; operationId: string }

export interface BeginOperationOptions {
  operationId: string
  idempotencyKey: string
  target: ResourceRef
  cancellable?: boolean
  cancelHandler?: () => Promise<CancellationOutcome>
}

export interface BeginOperationResult {
  disposition: "started" | "existing"
  operation: OperationRecord
}

function targetKey(target: ResourceRef): string {
  return `${target.epoch}:${target.kind}:${target.id}:${target.generation}`
}

function idempotencyKey(options: Pick<BeginOperationOptions, "target" | "idempotencyKey">): string {
  return `${targetKey(options.target)}:${options.idempotencyKey}`
}

function cloneOperation(operation: StoredOperation): OperationRecord {
  return structuredClone({
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    target: operation.target,
    state: operation.state,
    cancellable: operation.cancellable,
    startedAt: operation.startedAt,
    ...(operation.completedAt === undefined ? {} : { completedAt: operation.completedAt }),
    ...(operation.result === undefined ? {} : { result: operation.result })
  })
}

function isTerminal(state: OperationState): state is OperationTerminalOutcome {
  return state === "committed" || state === "not-committed" || state === "quarantined"
}

function cancellationFailure(operation: StoredOperation, outcome: CancellationOutcome): RpcError {
  if (outcome === "unknown") {
    return {
      code: "operation-timeout-unknown",
      category: "timeout-unknown",
      outcome: "unknown",
      retry: "after-reconcile",
      correlationId: `cancel-${operation.operationId}`,
      userMessageKey: "errors.operationOutcomeUnknown",
      resource: operation.target,
      details: {
        type: "operation-timeout-unknown",
        dispatched: true
      }
    }
  }
  return {
    code: "operation-cancelled",
    category: "cancelled",
    outcome: "not-committed",
    retry: "never",
    correlationId: `cancel-${operation.operationId}`,
    userMessageKey: "errors.operationCancelled",
    resource: operation.target,
    details: {
      type: "operation-cancelled",
      committed: false
    }
  }
}

export class OperationRegistry {
  private readonly operations = new Map<string, StoredOperation>()
  private readonly idempotency = new Map<string, string>()

  constructor(
    private readonly terminalLimit = 2_048,
    private readonly now: () => number = Date.now
  ) {}

  get activeCount(): number {
    let count = 0
    for (const operation of this.operations.values()) {
      if (!isTerminal(operation.state)) count += 1
    }
    return count
  }

  get retainedTerminalCount(): number {
    let count = 0
    for (const operation of this.operations.values()) {
      if (isTerminal(operation.state)) count += 1
    }
    return count
  }

  begin(
    options: BeginOperationOptions
  ): KernelResult<BeginOperationResult, OperationRegistryError> {
    const existingById = this.operations.get(options.operationId)
    const key = idempotencyKey(options)
    const existingId = this.idempotency.get(key)
    if (existingById) {
      if (existingById.idempotencyKey !== options.idempotencyKey) {
        return kernelFailure({ code: "operation-conflict", operationId: options.operationId })
      }
      return kernelSuccess({
        disposition: "existing",
        operation: cloneOperation(existingById)
      })
    }
    if (existingId) {
      const existing = this.operations.get(existingId)
      if (existing) {
        return kernelSuccess({
          disposition: "existing",
          operation: cloneOperation(existing)
        })
      }
    }
    if (this.operations.size >= this.terminalLimit) {
      return kernelFailure({
        code: "operation-busy",
        unacknowledgedCount: this.operations.size,
        retainedTerminalCount: this.retainedTerminalCount,
        limit: this.terminalLimit
      })
    }

    const operation: StoredOperation = {
      operationId: options.operationId,
      idempotencyKey: options.idempotencyKey,
      target: structuredClone(options.target),
      state: "running",
      cancellable: options.cancellable ?? false,
      startedAt: this.now(),
      ...(options.cancelHandler ? { cancelHandler: options.cancelHandler } : {})
    }
    this.operations.set(operation.operationId, operation)
    this.idempotency.set(key, operation.operationId)
    return kernelSuccess({
      disposition: "started",
      operation: cloneOperation(operation)
    })
  }

  status(operationId: string): KernelResult<OperationRecord, OperationRegistryError> {
    const operation = this.operations.get(operationId)
    return operation
      ? kernelSuccess(cloneOperation(operation))
      : kernelFailure({ code: "operation-not-found", operationId })
  }

  setCancellationHandler(
    operationId: string,
    handler: (() => Promise<CancellationOutcome>) | null
  ): KernelResult<OperationRecord, OperationRegistryError> {
    const operation = this.operations.get(operationId)
    if (!operation) return kernelFailure({ code: "operation-not-found", operationId })
    if (isTerminal(operation.state)) {
      return kernelFailure({ code: "operation-conflict", operationId })
    }
    operation.cancelHandler = handler ?? undefined
    operation.cancellable = handler !== null
    return kernelSuccess(cloneOperation(operation))
  }

  finish(
    operationId: string,
    outcome: OperationTerminalOutcome,
    result: RpcResult<unknown>
  ): KernelResult<OperationRecord, OperationRegistryError> {
    const operation = this.operations.get(operationId)
    if (!operation) return kernelFailure({ code: "operation-not-found", operationId })
    if (isTerminal(operation.state)) {
      if (operation.state !== outcome) {
        return kernelFailure({ code: "operation-conflict", operationId })
      }
      return kernelSuccess(cloneOperation(operation))
    }
    operation.state = outcome
    operation.completedAt = this.now()
    operation.result = structuredClone(result)
    operation.cancelHandler = undefined
    return kernelSuccess(cloneOperation(operation))
  }

  async cancel(
    operationId: string
  ): Promise<KernelResult<OperationRecord, OperationRegistryError>> {
    const operation = this.operations.get(operationId)
    if (!operation) return kernelFailure({ code: "operation-not-found", operationId })
    if (isTerminal(operation.state) || !operation.cancellable || !operation.cancelHandler) {
      return kernelSuccess(cloneOperation(operation))
    }
    operation.state = "cancel-requested"
    let outcome: CancellationOutcome
    try {
      outcome = await operation.cancelHandler()
    } catch {
      outcome = "unknown"
    }
    const raced = this.operations.get(operationId)
    if (!raced) return kernelFailure({ code: "operation-not-found", operationId })
    if (isTerminal(raced.state)) return kernelSuccess(cloneOperation(raced))

    const error = cancellationFailure(raced, outcome)
    const result: RpcResult<unknown> = {
      ok: false,
      requestId: `cancel-${operationId}`,
      operationId,
      error
    }
    return this.finish(operationId, outcome === "unknown" ? "quarantined" : "not-committed", result)
  }

  acknowledge(operationId: string): KernelResult<void, OperationRegistryError> {
    const operation = this.operations.get(operationId)
    if (!operation) return kernelFailure({ code: "operation-not-found", operationId })
    if (!isTerminal(operation.state)) {
      return kernelFailure({ code: "operation-conflict", operationId })
    }
    this.operations.delete(operationId)
    this.idempotency.delete(
      idempotencyKey({
        target: operation.target,
        idempotencyKey: operation.idempotencyKey
      })
    )
    return kernelSuccess(undefined)
  }

  snapshot(): OperationRecord[] {
    return [...this.operations.values()].map(cloneOperation)
  }
}
