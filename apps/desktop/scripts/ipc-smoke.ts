import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"

interface AttachmentReference {
  index: number
  offset: number
  length: number
}

interface WireResponse {
  result: {
    type: string
    egress_active?: number
    payload?: AttachmentReference
  }
}

type TransportDiagnosticsWire = [
  sessionEpoch: string,
  requests: [normalPending: number, priorityPending: number, capacity: number, timeouts: number],
  sharedMemory: unknown,
  eventQueueDepth: number,
  telemetry: unknown,
  parameterRing: unknown,
  closing: boolean,
  runtimeAndArena: [
    workerThreads: number,
    maxBlockingThreads: number,
    egressConcurrency: number,
    arenaRegions: number
  ]
]

function decodeWire<T>(bytes: Uint8Array): T {
  return decode(bytes) as T
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const client = new AudioHostIpcClient(
  resolve(repositoryRoot, "target", "debug", `yadaw-audio-host${executableSuffix}`),
  resolve(tmpdir(), `yadaw-ipc-${process.pid}.marker`),
  2,
  4,
  2
)
let requestId = 1

async function request(command: unknown, attachments: Buffer[] = []) {
  const response = await client.request(
    Buffer.from(
      encode({
        request_id: requestId++,
        command
      })
    ),
    attachments
  )
  return {
    decoded: decodeWire<WireResponse>(response.body),
    attachments: response.attachments
  }
}

try {
  const heartbeat = decodeWire<WireResponse>(
    (
      await client.heartbeat(
        Buffer.from(
          encode({
            request_id: requestId++,
            command: { type: "heartbeat" }
          })
        )
      )
    ).body
  )
  if (heartbeat.result.type !== "heartbeat" || heartbeat.result.egress_active === undefined) {
    throw new Error("priority heartbeat diagnostics mismatch")
  }

  const pong = await request({ type: "ping" })
  if (!["pong", "heartbeat"].includes(pong.decoded.result.type)) {
    throw new Error(`ping response mismatch: ${JSON.stringify(pong.decoded)}`)
  }

  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const echoed = await request(
    {
      type: "benchmark-echo",
      payload: {
        storage: "attachment",
        index: 0,
        offset: 0,
        length: payload.byteLength
      }
    },
    [payload]
  )
  const reference = echoed.decoded.result.payload
  if (!reference) throw new Error("benchmark response did not include an attachment reference")
  const returned = echoed.attachments[reference.index]?.subarray(
    reference.offset,
    reference.offset + reference.length
  )
  if (
    echoed.decoded.result.type !== "benchmark-echo" ||
    returned?.byteLength !== payload.byteLength ||
    returned[0] !== 0x5a
  ) {
    throw new Error("4 MiB attachment response mismatch")
  }

  const diagnostics = decodeWire<TransportDiagnosticsWire>(client.transportDiagnostics())
  if (typeof diagnostics[0] !== "string" || diagnostics[7][0] !== 2 || diagnostics[7][2] !== 2) {
    throw new Error("runtime diagnostics mismatch")
  }
  console.log(
    `IPC smoke passed (session ${diagnostics[0]}, ${returned.byteLength} bytes, ${diagnostics[7][3]} client arena region)`
  )

  const shutdownId = requestId++
  await client.heartbeat(
    Buffer.from(
      encode({
        request_id: shutdownId,
        command: { type: "shutdown" }
      })
    )
  )
} finally {
  client.close()
}
