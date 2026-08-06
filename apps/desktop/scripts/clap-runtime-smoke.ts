import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostRuntime } from "@heron/dsp-node"

interface PluginParameter {
  parameter_key: string
  value: number
  read_only: boolean
}

interface AudioHostMeter {
  channel_id: string
  held_left: number
  held_right: number
}

interface PluginStateEnvelope {
  version: number
  chunks: Array<{ key: string; bytes: { storage: string; bytes?: Uint8Array } }>
}

interface WireResult {
  type: string
  error?: { user_message_key?: string }
  parameters?: PluginParameter[]
  state?: PluginStateEnvelope
  latency_samples?: number
  tail_samples?: number
  meters?: AudioHostMeter[]
}

interface WireResponse {
  request_id: number
  result: WireResult
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const [pluginPath] = process.argv.slice(2)
const resolvedPlugin =
  pluginPath ?? resolve(repositoryRoot, "target", "clap-fixtures", "plugins", "clap-plugins.clap")
const runtime = new AudioHostRuntime(2, 4)
const uiPump = setInterval(() => runtime.drainUiWork(), 8)
uiPump.unref()
let nextRequestId = 1

async function send(command: unknown): Promise<WireResult> {
  const requestId = nextRequestId++
  const commandType =
    typeof command === "object" && command !== null && "type" in command
      ? String(command.type)
      : "unknown"
  const response = await runtime.request(Buffer.from(encode({ request_id: requestId, command })))
  const decoded = decode(response.body) as WireResponse
  if (decoded.request_id !== requestId) {
    throw new Error(`received response for unknown request ${decoded.request_id}`)
  }
  if (decoded.result.type === "error") {
    throw new Error(
      `${commandType} failed: ${decoded.result.error?.user_message_key ?? "unknown error"}`
    )
  }
  return decoded.result
}

function loadCommand(
  instanceId: string,
  nativeId: string,
  pluginKind: "effect" | "instrument",
  state: PluginStateEnvelope = { version: 1, chunks: [] }
): object {
  return {
    type: "load-plugin",
    instance_id: instanceId,
    locator: { format: "clap", artifact_path: resolvedPlugin, native_id: nativeId },
    plugin_kind: pluginKind,
    audio_mode: "stereo",
    sample_rate: 48_000,
    state
  }
}

try {
  const effectLoaded = await send(
    loadCommand("effect-1", "com.github.free-audio.clap.gain", "effect")
  )
  if (effectLoaded.type !== "plugin-loaded") throw new Error("effect load response mismatch")

  const listed = await send({ type: "plugin-parameters", instance_id: "effect-1" })
  const parameters = listed.parameters
  if (listed.type !== "plugin-parameters" || !parameters?.length) {
    throw new Error("official CLAP Gain did not expose parameters")
  }
  const editable = parameters.find((parameter) => !parameter.read_only)
  if (!editable) throw new Error("official CLAP Gain has no editable parameter")
  for (const gesture of ["begin", "perform", "end"] as const) {
    await send({
      type: "set-plugin-parameter",
      instance_id: "effect-1",
      parameter_key: editable.parameter_key,
      value: editable.value,
      gesture
    })
  }

  const saved = await send({ type: "save-plugin-state", instance_id: "effect-1" })
  const mainState = saved.state?.chunks.find((chunk) => chunk.key === "main")?.bytes.bytes
  if (saved.type !== "plugin-state" || !(mainState instanceof Uint8Array)) {
    throw new Error("official CLAP plug-in did not return its main state chunk")
  }

  const synthLoaded = await send(
    loadCommand("synth-1", "com.github.free-audio.clap.synth", "instrument")
  )
  if (synthLoaded.type !== "plugin-loaded") throw new Error("synth load response mismatch")

  const liveGraph = {
    sample_rate: 48_000,
    channels: [
      {
        id: "instrument-1",
        kind: "instrument",
        gain_db: 0,
        pan: 0,
        muted: false,
        soloed: false,
        output_channel_id: "output",
        record_armed: false,
        input_channels: [],
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
        input_channels: [],
        hardware_output_channels: [1, 2]
      }
    ],
    sends: [],
    clips: [],
    plugins: [
      {
        instance_id: "synth-1",
        channel_id: "instrument-1",
        role: "instrument",
        slot_order: 0,
        audio_mode: "stereo",
        enabled: true,
        latency_samples: synthLoaded.latency_samples ?? 0,
        tail_samples: synthLoaded.tail_samples ?? 0
      },
      {
        instance_id: "effect-1",
        channel_id: "instrument-1",
        role: "insert",
        slot_order: 0,
        audio_mode: "stereo",
        enabled: true,
        latency_samples: effectLoaded.latency_samples ?? 0,
        tail_samples: effectLoaded.tail_samples ?? 0
      }
    ],
    midi_clips: [
      {
        id: "clip-1",
        channel_id: "instrument-1",
        start_tick: 0,
        source_offset_ticks: 0,
        length_ticks: 960,
        notes: {
          storage: "inline",
          notes: [
            {
              start_tick: 0,
              duration_ticks: 960,
              channel: 0,
              key: 60,
              velocity: 110,
              release_velocity: 0
            }
          ]
        },
        events: { storage: "inline", events: [] }
      }
    ],
    tempo_events: [{ tick: 0, beats_per_minute: 120 }],
    time_signature_events: [{ tick: 0, numerator: 4, denominator: 4 }]
  }
  await send({
    type: "update-graph",
    update: {
      type: "replace",
      revision: 1,
      graph: liveGraph
    }
  })
  await send({
    type: "start-audio-engine",
    config: {
      backend: "mock",
      input_device_id: "custom:mock-duplex",
      output_device_id: "custom:mock-duplex",
      buffer_size: 128
    }
  })
  await send({ type: "transport", command: { kind: "play" } })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const meters = await send({ type: "mixer-snapshot" })
  const instrumentMeter = meters.meters?.find((meter) => meter.channel_id === "instrument-1")
  if (!instrumentMeter || Math.max(instrumentMeter.held_left, instrumentMeter.held_right) <= 0) {
    throw new Error("mock live graph did not render the official CLAP instrument/effect chain")
  }
  await send({
    type: "update-graph",
    update: {
      type: "replace",
      revision: 2,
      graph: { ...liveGraph, plugins: [], midi_clips: [] }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await send({ type: "stop-audio-engine" })
  await send({ type: "unload-plugin", instance_id: "synth-1" })
  await send({ type: "unload-plugin", instance_id: "effect-1" })
  console.log(
    `CLAP official fixture passed (${parameters.length} parameters, ${mainState.length} state ` +
      `bytes, meter ${Math.max(instrumentMeter.held_left, instrumentMeter.held_right).toFixed(4)})`
  )
} finally {
  clearInterval(uiPump)
  runtime.close()
  // EmbeddedAudioHost::close is intentionally non-blocking. Keep Node alive
  // long enough for the runtime thread to retire the graph and unload modules.
  await new Promise((resolve) => setTimeout(resolve, 250))
}
