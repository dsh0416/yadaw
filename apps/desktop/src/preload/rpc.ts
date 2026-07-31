import { ipcRenderer } from "electron"
import { rpcFailure } from "@yadaw/contracts"
import type { RpcError, RpcRequestMeta, RpcResult } from "@yadaw/contracts"

export async function invokeRpc<Value, Args extends readonly unknown[]>(
  channel: string,
  meta: RpcRequestMeta,
  ...args: Args
): Promise<RpcResult<Value>> {
  try {
    return (await ipcRenderer.invoke(channel, meta, ...args)) as RpcResult<Value>
  } catch {
    const mutation = meta.mutation
    const error: RpcError = mutation
      ? {
          code: "operation-timeout-unknown",
          category: "timeout-unknown",
          outcome: "unknown",
          retry: "after-reconcile",
          correlationId: `transport-${meta.requestId}`,
          userMessageKey: "errors.operationOutcomeUnknown",
          ...(meta.target ? { resource: meta.target } : {}),
          details: {
            type: "operation-timeout-unknown",
            dispatched: true
          }
        }
      : {
          code: "transport-unavailable",
          category: "unavailable",
          outcome: "not-committed",
          retry: "safe",
          correlationId: `transport-${meta.requestId}`,
          userMessageKey: "errors.transportUnavailable",
          ...(meta.target ? { resource: meta.target } : {}),
          details: {
            type: "transport-unavailable",
            component: "preload",
            dispatched: false
          }
        }
    return rpcFailure(meta, error)
  }
}
