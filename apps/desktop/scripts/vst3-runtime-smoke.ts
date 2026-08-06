import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostRuntime } from "@heron/dsp-node"

interface PluginParameter {
  parameter_key: string
  value: number
}

interface AudioHostMeter {
  channel_id: string
  held_left: number
  held_right: number
}

interface WireResult {
  type: string
  error?: { user_message_key?: string }
  parameters?: PluginParameter[]
  state?: {
    version: number
    chunks: Array<{ key: string; bytes: { storage: string; bytes?: Uint8Array } }>
  }
  latency_samples?: number
  tail_samples?: number
  meters?: AudioHostMeter[]
}

interface WireResponse {
  request_id: number
  result: WireResult
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const [pluginPath, synthPath, againNativeId, synthNativeId] = process.argv.slice(2)
const resolvedPlugin =
  pluginPath ?? resolve(repositoryRoot, "target", "vst3-fixtures", "VST3", "Release", "again.vst3")
const resolvedSynth =
  synthPath ??
  resolve(
    repositoryRoot,
    "target",
    "vst3-fixtures",
    "VST3",
    "Release",
    "note-expression-synth.vst3"
  )
const resolvedAgainNativeId = againNativeId ?? "41347FD6FED64094AFBB12B7DBA1D441"
const resolvedSynthNativeId = synthNativeId ?? "41466D9BB0654576B641098F686371B3"
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

try {
  const loaded = await send({
    type: "load-plugin",
    instance_id: "again-1",
    locator: {
      format: "vst3",
      artifact_path: resolvedPlugin,
      native_id: resolvedAgainNativeId
    },
    plugin_kind: "effect",
    audio_mode: "stereo",
    active_aux_inputs: [{ input_port_key: "vst3:audio:input:1", channels: 1 }],
    sample_rate: 48_000,
    state: { version: 1, chunks: [] }
  })
  if (loaded.type !== "plugin-loaded") throw new Error("load response mismatch")
  const synthLoaded = await send({
    type: "load-plugin",
    instance_id: "synth-1",
    locator: {
      format: "vst3",
      artifact_path: resolvedSynth,
      native_id: resolvedSynthNativeId
    },
    plugin_kind: "instrument",
    audio_mode: "stereo",
    sample_rate: 48_000,
    state: { version: 1, chunks: [] }
  })
  if (synthLoaded.type !== "plugin-loaded") throw new Error("synth load response mismatch")
  const listed = await send({ type: "plugin-parameters", instance_id: "again-1" })
  const listedParameters = listed.parameters
  if (listed.type !== "plugin-parameters" || !listedParameters?.length) {
    throw new Error("AGain did not expose parameters")
  }
  const parameter = listedParameters[0]
  if (!parameter) throw new Error("AGain parameter list became empty")
  for (const gesture of ["begin", "perform", "end"]) {
    await send({
      type: "set-plugin-parameter",
      instance_id: "again-1",
      parameter_key: parameter.parameter_key,
      value: parameter.value,
      gesture
    })
  }
  const state = await send({ type: "save-plugin-state", instance_id: "again-1" })
  const componentState = state.state?.chunks.find((chunk) => chunk.key === "component")?.bytes.bytes
  if (state.type !== "plugin-state" || !(componentState instanceof Uint8Array)) {
    throw new Error("state response mismatch")
  }
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
        instance_id: "again-1",
        channel_id: "instrument-1",
        role: "insert",
        slot_order: 0,
        audio_mode: "stereo",
        enabled: true,
        latency_samples: loaded.latency_samples ?? 0,
        tail_samples: loaded.tail_samples ?? 0
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
  await new Promise((resolve) => setTimeout(resolve, 150))
  const meters = await send({ type: "mixer-snapshot" })
  const instrumentMeter = meters.meters?.find((meter) => meter.channel_id === "instrument-1")
  if (!instrumentMeter || Math.max(instrumentMeter.held_left, instrumentMeter.held_right) <= 0) {
    throw new Error("mock live graph did not render the VST3 instrument/effect chain")
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
  await send({ type: "unload-plugin", instance_id: "again-1" })
  console.log(
    `VST3 embedded runtime live graph passed (${listedParameters.length} parameters, ` +
      `${componentState.length} component bytes, meter ` +
      `${Math.max(instrumentMeter.held_left, instrumentMeter.held_right).toFixed(4)})`
  )
} finally {
  clearInterval(uiPump)
  runtime.close()
  // EmbeddedAudioHost::close is intentionally non-blocking. Keep Node alive
  // long enough for the runtime thread to retire the graph and stop its actors.
  await new Promise((resolve) => setTimeout(resolve, 250))
}
