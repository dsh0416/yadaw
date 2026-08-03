import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { ResourceRef, RpcError, RpcRequestMeta } from "@heron/contracts"
import { i18n } from "./i18n"

function nextId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`
}

export function readMeta(target?: ResourceRef): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: nextId("request"),
    ...(target ? { target: structuredClone(target) } : {})
  }
}

export function mutationMeta(
  target: ResourceRef,
  operation: string,
  expectedRevision?: number
): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: nextId("request"),
    target: structuredClone(target),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    mutation: {
      operationId: nextId(operation),
      idempotencyKey: nextId("idempotency")
    }
  }
}

export function rpcErrorMessage(error: RpcError): string {
  const translated = i18n.global.t(error.userMessageKey)
  return translated === error.userMessageKey ? error.code : translated
}
