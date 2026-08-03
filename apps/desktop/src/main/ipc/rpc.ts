import { ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { IPC_PROTOCOL_VERSION, isRpcRequestMeta, rpcFailure, rpcSuccess } from "@heron/contracts"
import type { RpcError, RpcRequestMeta, RpcResult } from "@heron/contracts"
import { assertTrustedSender } from "./support"

export interface RpcHandlerContext {
  event: IpcMainInvokeEvent
  meta: RpcRequestMeta
}

export type RpcHandler<Args extends readonly unknown[], Value> = (
  context: RpcHandlerContext,
  ...args: Args
) => Promise<RpcResult<Value> | Value> | RpcResult<Value> | Value

export interface RpcLogger {
  error(event: {
    correlationId: string
    requestId: string
    operationId?: string
    channel: string
    error: unknown
  }): void
}

export interface RegisterRpcHandlerOptions {
  authenticate?: (event: IpcMainInvokeEvent) => void
  logger?: RpcLogger
}

const defaultLogger: RpcLogger = {
  error(event) {
    console.error(
      `[rpc] ${event.channel} failed (${event.correlationId}, request ${event.requestId})`,
      event.error
    )
  }
}

function requestIdFrom(value: unknown): string {
  if (typeof value !== "object" || value === null) return "invalid-request"
  const requestId = (value as { requestId?: unknown }).requestId
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "invalid-request"
}

function receivedVersionFrom(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const version = (value as { protocolVersion?: unknown }).protocolVersion
  return typeof version === "number" && Number.isSafeInteger(version) ? version : undefined
}

function invalidMetaFailure(value: unknown): RpcResult<never> {
  const requestId = requestIdFrom(value)
  const receivedVersion = receivedVersionFrom(value)
  return rpcFailure(
    { requestId },
    {
      code: "protocol-mismatch",
      category: "validation",
      outcome: "not-committed",
      retry: "never",
      correlationId: randomUUID(),
      userMessageKey: "errors.protocolMismatch",
      details: {
        type: "protocol-mismatch",
        expectedVersion: IPC_PROTOCOL_VERSION,
        ...(receivedVersion === undefined ? {} : { receivedVersion })
      }
    }
  )
}

function rejectedSenderFailure(meta: RpcRequestMeta, correlationId: string): RpcResult<never> {
  return rpcFailure(meta, {
    code: "validation-failed",
    category: "validation",
    outcome: "not-committed",
    retry: "never",
    correlationId,
    userMessageKey: "errors.untrustedSender",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "validation-failed",
      field: "sender"
    }
  })
}

function unexpectedFailure(meta: RpcRequestMeta, correlationId: string): RpcResult<never> {
  const error: RpcError = {
    code: "invariant-violation",
    category: "invariant-violation",
    outcome: "quarantined",
    retry: "after-reconcile",
    correlationId,
    userMessageKey: "errors.internalInvariant",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "invariant-violation",
      component: "main"
    }
  }
  return rpcFailure(meta, error)
}

function isRpcResult<Value>(value: RpcResult<Value> | Value): value is RpcResult<Value> {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { ok?: unknown; requestId?: unknown }
  return (
    (candidate.ok === true || candidate.ok === false) && typeof candidate.requestId === "string"
  )
}

export function registerRpcHandler<Args extends readonly unknown[], Value>(
  channel: string,
  handler: RpcHandler<Args, Value>,
  options: RegisterRpcHandlerOptions = {}
): void {
  const authenticate = options.authenticate ?? assertTrustedSender
  const logger = options.logger ?? defaultLogger

  ipcMain.handle(
    channel,
    async (
      event: IpcMainInvokeEvent,
      rawMeta: unknown,
      ...args: Args
    ): Promise<RpcResult<Value>> => {
      if (!isRpcRequestMeta(rawMeta)) return invalidMetaFailure(rawMeta)
      const meta = rawMeta
      try {
        authenticate(event)
      } catch (error) {
        const correlationId = randomUUID()
        logger.error({
          correlationId,
          requestId: meta.requestId,
          ...(meta.mutation ? { operationId: meta.mutation.operationId } : {}),
          channel,
          error
        })
        return rejectedSenderFailure(meta, correlationId)
      }
      try {
        const result = await handler({ event, meta }, ...args)
        return isRpcResult(result) ? result : rpcSuccess(meta, result)
      } catch (error) {
        const correlationId = randomUUID()
        logger.error({
          correlationId,
          requestId: meta.requestId,
          ...(meta.mutation ? { operationId: meta.mutation.operationId } : {}),
          channel,
          error
        })
        return unexpectedFailure(meta, correlationId)
      }
    }
  )
}
