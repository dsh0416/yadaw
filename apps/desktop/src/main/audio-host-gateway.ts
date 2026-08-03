import { decode, encode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type { RpcError } from "@yadaw/contracts"
import { drainHostEvents } from "./audio-host-events"
import {
  extractLargeAttachments,
  hydrateAttachments,
  type ControlResponse,
  type PriorityResponse
} from "./audio-host-wire"

const MAX_LOGICAL_REQUEST_BYTES = 128 * 1024 * 1024

export class AudioHostRequestError extends Error {
  readonly commandType: string
  readonly rpcError: RpcError

  constructor(commandType: string, rpcError: RpcError) {
    super(
      `${rpcError.userMessageKey} (${commandType}, ${rpcError.code}, ${rpcError.correlationId})`
    )
    this.name = "AudioHostRequestError"
    this.commandType = commandType
    this.rpcError = structuredClone(rpcError)
  }
}

function requestError(command: Record<string, unknown>, error?: RpcError): Error {
  if (!error) return new Error("errors.audioEngineUnavailable")
  return new AudioHostRequestError(
    typeof command.type === "string" ? command.type : "unknown-command",
    error
  )
}

export class AudioHostGateway {
  private nextRequestId = 1
  private readonly pending = new Set<Promise<ControlResponse>>()

  constructor(
    private readonly client: () => AudioHostIpcClient | null,
    private readonly unavailable: () => "stopping" | Promise<void> | null,
    private readonly onEditorPreferenceChanged: Parameters<typeof drainHostEvents>[1],
    private readonly pendingPreferenceWrites: Set<Promise<void>>,
    private readonly onEditorClosed?: (instanceId: string) => void,
    private readonly onAraCallback?: Parameters<typeof drainHostEvents>[4],
    private readonly onVst3HostNotification?: Parameters<typeof drainHostEvents>[5]
  ) {}

  request(command: Record<string, unknown>): Promise<ControlResponse> {
    const unavailable = this.unavailable()
    if (unavailable === "stopping" && command.type !== "shutdown") {
      return Promise.reject(new Error("audio host is stopping"))
    }
    if (unavailable && unavailable !== "stopping" && command.type !== "shutdown") {
      return unavailable.then(() => this.requestImmediately(command))
    }
    return this.requestImmediately(command)
  }

  requestImmediately(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const pending = this.performRequest(command, expectedClient)
    this.pending.add(pending)
    void pending.finally(() => this.pending.delete(pending)).catch(() => {})
    return pending
  }

  async priority(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<PriorityResponse> {
    const client = expectedClient ?? this.client()
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const payload = Buffer.from(encode({ request_id: requestId, command }))
    const wireResponse = await client.heartbeat(payload)
    const response = decode(wireResponse.body) as PriorityResponse
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an invalid priority response")
    }
    if (response.result.type === "error") {
      throw requestError(command, response.result.error)
    }
    drainHostEvents(
      client,
      this.onEditorPreferenceChanged,
      this.pendingPreferenceWrites,
      this.onEditorClosed,
      this.onAraCallback,
      this.onVst3HostNotification
    )
    return response
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  private async performRequest(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const client = expectedClient ?? this.client()
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const request = { request_id: requestId, command }
    const attachments: Buffer[] = []
    extractLargeAttachments(request, attachments)
    const payload = Buffer.from(encode(request))
    if (payload.length > MAX_LOGICAL_REQUEST_BYTES) {
      throw new Error("audio host logical request exceeds 128 MiB")
    }
    const wireResponse = await client.request(payload, attachments)
    const response = decode(wireResponse.body) as ControlResponse
    hydrateAttachments(response, wireResponse.attachments)
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an out-of-order response")
    }
    if (response.result.type === "error") {
      throw requestError(command, response.result.error)
    }
    return response
  }
}
