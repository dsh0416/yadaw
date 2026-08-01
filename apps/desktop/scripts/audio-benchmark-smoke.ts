import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"
import { audioHostBinary } from "./native-binaries.ts"

interface BenchmarkScenario {
  plugins: number
  measured_blocks: number
  p99_block_ms: number
}

interface WireResponse {
  result: {
    type: string
    message?: string
    report?: {
      overall_realtime_factor: number
      worst_p99_deadline_utilization_percent: number
      scenarios: BenchmarkScenario[]
    }
  }
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const helperPath = audioHostBinary(repositoryRoot)
const pluginPath = resolve(repositoryRoot, "target", "bundles", "YADAW Gain.vst3")
const client = new AudioHostIpcClient(
  helperPath,
  resolve(tmpdir(), `yadaw-audio-benchmark-${process.pid}.marker`),
  2,
  4,
  2
)

let requestId = 1
async function rawRequest(
  command: unknown,
  attachments: Buffer[] = []
): Promise<{ result: WireResponse["result"]; attachments: Buffer[] }> {
  const response = await client.request(
    Buffer.from(encode({ request_id: requestId++, command })),
    attachments
  )
  const decoded = decode(response.body) as WireResponse
  if (decoded.result.type === "error") {
    throw new Error(decoded.result.message ?? "audio-host request failed")
  }
  return { result: decoded.result, attachments: response.attachments }
}

async function request(command: unknown): Promise<WireResponse["result"]> {
  return (await rawRequest(command)).result
}

async function echo(payloadBytes: number): Promise<void> {
  const payload = Buffer.alloc(payloadBytes, 0x5a)
  const result = (
    await rawRequest(
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
  ).result
  if (result.type !== "benchmark-echo") throw new Error("benchmark echo response mismatch")
}

async function runIpcSmoke(): Promise<void> {
  for (let index = 0; index < 208; index += 1) await echo(256)
  await echo(4 * 1024 * 1024)
  for (let index = 0; index < 26; index += 1) await echo(4 * 1024 * 1024)
  for (const concurrency of [1, 4, 8, 16]) {
    const rounds = Math.max(2, Math.ceil(32 / concurrency))
    await echo(4 * 1024 * 1024)
    for (let round = 0; round < rounds; round += 1) {
      await Promise.all(Array.from({ length: concurrency }, () => echo(4 * 1024 * 1024)))
    }
  }
  await Promise.all(Array.from({ length: 128 }, () => echo(256)))
}

const pluginInstanceIds = Array.from(
  { length: 64 },
  (_, index) => `__yadaw-audio-benchmark-gain-${index}`
)
const projectPluginInstanceId = "__yadaw-project-open-gain"

async function loadGain(instanceId: string): Promise<void> {
  const loaded = await request({
    type: "load-plugin",
    instance_id: instanceId,
    module_path: pluginPath,
    class_id: "59CABE21E605B9C9EE928D6C3B236BBF",
    plugin_kind: "effect",
    audio_mode: "stereo",
    sample_rate: 48_000,
    component_state: { storage: "inline", bytes: new Uint8Array() },
    controller_state: { storage: "inline", bytes: new Uint8Array() }
  })
  if (loaded.type !== "plugin-loaded") throw new Error("VST3 load response mismatch")
}

try {
  // Keep a normal project-owned instance in a live graph while both benchmark passes run. This
  // catches lifecycle and scheduling boundaries that only exist while an open project is rendering.
  await loadGain(projectPluginInstanceId)
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
  if (engine.type !== "audio-runtime") throw new Error("audio engine start response mismatch")
  const graph = await request({
    type: "update-graph",
    update: {
      type: "replace",
      revision: 1,
      graph: {
        sample_rate: 48_000,
        channels: [
          {
            id: "project-audio",
            kind: "audio",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: "output",
            record_armed: false,
            input_monitoring: true,
            input_source: "hardware",
            input_channels: [1, 2],
            hardware_output_channels: []
          },
          {
            id: "master",
            kind: "master",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: null,
            record_armed: false,
            input_monitoring: false,
            input_channels: [],
            hardware_output_channels: []
          },
          {
            id: "output",
            kind: "output",
            gain_db: 0,
            pan: 0,
            muted: false,
            soloed: false,
            output_channel_id: null,
            record_armed: false,
            input_monitoring: false,
            input_channels: [],
            hardware_output_channels: [1, 2]
          }
        ],
        sends: [],
        clips: [],
        plugins: [
          {
            instance_id: projectPluginInstanceId,
            channel_id: "project-audio",
            role: "insert",
            slot_order: 0,
            audio_mode: "stereo",
            enabled: true,
            latency_samples: 0,
            tail_samples: 0
          }
        ],
        midi_clips: [],
        tempo_events: [{ tick: 0, beats_per_minute: 120 }],
        time_signature_events: [{ tick: 0, numerator: 4, denominator: 4 }]
      }
    }
  })
  if (graph.type !== "graph-accepted") throw new Error("project graph response mismatch")
  const transport = await request({
    type: "transport",
    command: { kind: "play", position_frames: null }
  })
  if (transport.type !== "transport-snapshot") throw new Error("transport response mismatch")

  for (let iteration = 0; iteration < 2; iteration += 1) {
    for (const instanceId of pluginInstanceIds) {
      await loadGain(instanceId)
    }

    const result = await request({
      type: "run-audio-benchmark",
      plugin_instance_ids: pluginInstanceIds
    })
    const report = result.report
    if (
      result.type !== "audio-benchmark" ||
      !report ||
      report.scenarios.length !== 3 ||
      report.scenarios.some((scenario) => scenario.measured_blocks === 0) ||
      report.scenarios.map((scenario) => scenario.plugins).join(",") !== "8,32,64" ||
      !Number.isFinite(report.overall_realtime_factor) ||
      !Number.isFinite(report.worst_p99_deadline_utilization_percent)
    ) {
      throw new Error("audio benchmark report mismatch")
    }

    for (const instanceId of pluginInstanceIds) {
      const unloaded = await request({
        type: "unload-plugin",
        instance_id: instanceId
      })
      if (unloaded.type !== "accepted") throw new Error("VST3 unload response mismatch")
    }

    console.log(
      `Audio benchmark VST3 smoke pass ${iteration + 1}/2 (${report.scenarios
        .map(
          (scenario) => `${scenario.plugins} plug-ins/${scenario.p99_block_ms.toFixed(3)} ms p99`
        )
        .join(", ")})`
    )
  }

  const ipcStarted = performance.now()
  await runIpcSmoke()
  console.log(`Audio IPC smoke passed (${(performance.now() - ipcStarted).toFixed(1)} ms)`)

  const stopped = await request({ type: "stop-audio-engine" })
  if (stopped.type !== "audio-runtime") throw new Error("audio engine stop response mismatch")
  const unloadedProjectPlugin = await request({
    type: "unload-plugin",
    instance_id: projectPluginInstanceId
  })
  if (unloadedProjectPlugin.type !== "accepted") {
    throw new Error("project VST3 unload response mismatch")
  }
} finally {
  try {
    await client.heartbeat(
      Buffer.from(
        encode({
          request_id: requestId++,
          command: { type: "shutdown" }
        })
      )
    )
  } finally {
    client.close()
  }
}
