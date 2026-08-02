import { rmSync, writeFileSync } from "node:fs"
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
  parameterRing: [
    used: number,
    capacity: number,
    softFull: number,
    hardFull: number,
    boundaryFallbacks: number,
    staleEpoch: number
  ],
  closing: boolean,
  runtimeAndArena: [
    workerThreads: number,
    maxBlockingThreads: number,
    egressConcurrency: number,
    arenaRegions: number,
    arenaCapacityBytes: number,
    arenaUsedBytes: number,
    arenaHighWaterBytes: number,
    arenaOffers: number,
    arenaBusy: number,
    arenaQuarantinedRegions: number,
    arenaCopiedBytes: number
  ],
  persistentPages: [active: boolean, activationFailures: number]
]

type TelemetryWire = [
  epoch: unknown,
  graphRevision: number,
  callbackGeneration: number,
  transportState: number,
  positionFrames: number,
  sampleRate: number,
  meters: Array<
    [
      runtimeHandle: number,
      preLeft: number,
      preRight: number,
      postLeft: number,
      postRight: number,
      heldLeft: number,
      heldRight: number,
      clipped: boolean
    ]
  >
]

function decodeWire<T>(bytes: Uint8Array): T {
  return decode(bytes) as T
}

function stableRuntimeHandle(namespace: number, id: string): number {
  let value = (2_166_136_261 ^ namespace) >>> 0
  for (const byte of Buffer.from(id)) {
    value ^= byte
    value = Math.imul(value, 16_777_619) >>> 0
  }
  return Math.max(1, value)
}

function writeSineWave(path: string): void {
  const sampleRate = 48_000
  const frames = sampleRate * 2
  const channels = 2
  const bytesPerSample = 2
  const dataBytes = frames * channels * bytesPerSample
  const wave = Buffer.alloc(44 + dataBytes)
  wave.write("RIFF", 0)
  wave.writeUInt32LE(36 + dataBytes, 4)
  wave.write("WAVE", 8)
  wave.write("fmt ", 12)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(channels, 22)
  wave.writeUInt32LE(sampleRate, 24)
  wave.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  wave.writeUInt16LE(channels * bytesPerSample, 32)
  wave.writeUInt16LE(bytesPerSample * 8, 34)
  wave.write("data", 36)
  wave.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((frame * 440 * Math.PI * 2) / sampleRate) * 8_192)
    wave.writeInt16LE(sample, 44 + frame * 4)
    wave.writeInt16LE(sample, 46 + frame * 4)
  }
  writeFileSync(path, wave)
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const audioFixturePath = resolve(tmpdir(), `yadaw-ipc-${process.pid}.wav`)
writeSineWave(audioFixturePath)
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

  const warmPayload = Buffer.alloc(4 * 1024 * 1024, 0x33)
  const warmEcho = await request(
    {
      type: "benchmark-echo",
      payload: {
        storage: "attachment",
        index: 0,
        offset: 0,
        length: warmPayload.byteLength
      }
    },
    [warmPayload]
  )
  const warmReference = warmEcho.decoded.result.payload
  if (!warmReference) throw new Error("warm response did not include an attachment reference")
  const warmReturned = warmEcho.attachments[warmReference.index]?.subarray(
    warmReference.offset,
    warmReference.offset + warmReference.length
  )
  if (warmReturned?.byteLength !== warmPayload.byteLength || warmReturned[0] !== 0x33) {
    throw new Error("warm 4 MiB attachment response mismatch")
  }

  const diagnostics = decodeWire<TransportDiagnosticsWire>(client.transportDiagnostics())
  if (typeof diagnostics[0] !== "string" || diagnostics[7][0] !== 2 || diagnostics[7][2] !== 2) {
    throw new Error("runtime diagnostics mismatch")
  }
  if (!client.persistentSharedPages || !diagnostics[8][0] || diagnostics[8][1] !== 0) {
    throw new Error("persistent shared-page activation mismatch")
  }
  if (diagnostics[7][7] !== 1) {
    throw new Error(`warm arena unexpectedly sent ${diagnostics[7][7]} region offers`)
  }

  const engine = await request({
    type: "start-audio-engine",
    config: {
      backend: "mock",
      input_device_id: "custom:mock-input",
      output_device_id: "custom:mock-output",
      buffer_size: 128,
      session_sample_rate: 48_000
    }
  })
  if (engine.decoded.result.type !== "audio-runtime") {
    throw new Error("mock audio engine start mismatch")
  }
  const graph = await request({
    type: "update-graph",
    update: {
      type: "replace",
      revision: 1,
      graph: {
        sample_rate: 48_000,
        channels: [
          {
            id: "ipc-audio",
            kind: "audio",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: "ipc-output",
            output_bus: null,
            record_armed: false,
            input_monitoring: false,
            input_source: null,
            input_channels: [],
            hardware_output_channels: []
          },
          {
            id: "ipc-master",
            kind: "master",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: null,
            output_bus: null,
            record_armed: false,
            input_monitoring: false,
            input_source: null,
            input_channels: [],
            hardware_output_channels: []
          },
          {
            id: "ipc-output",
            kind: "output",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: null,
            output_bus: null,
            record_armed: false,
            input_monitoring: false,
            input_source: null,
            input_channels: [],
            hardware_output_channels: [1, 2]
          }
        ],
        sends: [],
        clips: [
          {
            id: "ipc-clip",
            channel_id: "ipc-audio",
            start_frame: 0,
            source_offset_frames: 0,
            length_frames: 96_000,
            fade_in_frames: 0,
            fade_out_frames: 0,
            path: audioFixturePath
          }
        ],
        plugins: [],
        midi_clips: [],
        tempo_events: [{ tick: 0, beats_per_minute: 120 }],
        time_signature_events: [{ tick: 0, numerator: 4, denominator: 4 }]
      }
    }
  })
  if (graph.decoded.result.type !== "graph-accepted") {
    throw new Error(`mock graph publication mismatch: ${JSON.stringify(graph.decoded)}`)
  }
  const play = await request({
    type: "transport",
    command: { kind: "play", position_frames: null }
  })
  if (play.decoded.result.type !== "transport-snapshot") {
    throw new Error("mock transport play mismatch")
  }

  const audioHandle = stableRuntimeHandle(1, "ipc-audio")
  const telemetryDeadline = Date.now() + 5_000
  let initialPostPeak = 0
  while (Date.now() < telemetryDeadline) {
    const telemetry = decodeWire<TelemetryWire>(client.readTelemetry())
    const meter = telemetry[6].find((value) => value[0] === audioHandle)
    const postPeak = meter ? Math.max(Math.abs(meter[3]), Math.abs(meter[4])) : 0
    if (
      telemetry[1] === 1 &&
      telemetry[2] > 0 &&
      telemetry[3] === 1 &&
      telemetry[4] > 0 &&
      postPeak > 0.01
    ) {
      initialPostPeak = postPeak
      break
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  if (initialPostPeak === 0) {
    throw new Error("shared telemetry did not expose an advancing playhead and moving meter")
  }

  const parameter = client.enqueueParameter({
    targetKind: "mixer-channel",
    runtimeHandle: audioHandle,
    parameterId: 0,
    normalized: 0,
    gesture: "perform"
  })
  if (parameter.outcome !== (client.persistentSharedPages ? "queued" : "fallback")) {
    throw new Error(`parameter transport mismatch: ${parameter.outcome}`)
  }
  const parameterDeadline = Date.now() + 5_000
  let parameterApplied = false
  while (Date.now() < parameterDeadline) {
    const afterParameter = decodeWire<TransportDiagnosticsWire>(client.transportDiagnostics())
    const telemetry = decodeWire<TelemetryWire>(client.readTelemetry())
    const meter = telemetry[6].find((value) => value[0] === audioHandle)
    const postPeak = meter ? Math.max(Math.abs(meter[3]), Math.abs(meter[4])) : initialPostPeak
    if (afterParameter[5][0] === 0 && postPeak < initialPostPeak * 0.25) {
      parameterApplied = true
      break
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  if (!parameterApplied) {
    throw new Error("shared parameter ring did not reduce the post-fader meter")
  }
  await request({ type: "stop-audio-engine" })
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
  rmSync(audioFixturePath, { force: true })
}
