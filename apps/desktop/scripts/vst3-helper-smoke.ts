import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { decode, encode } from "@msgpack/msgpack"

interface PluginParameter {
  id: number
}

interface AudioHostMeter {
  channel_id: string
  held_left: number
  held_right: number
}

interface WireResult {
  type: string
  message?: string
  editor_kind?: string
  open?: boolean
  parameters?: PluginParameter[]
  component_state?: { bytes?: Uint8Array }
  latency_samples?: number
  tail_samples?: number
  meters?: AudioHostMeter[]
}

interface WireResponse {
  request_id: number
  result: WireResult
}

interface PendingRequest {
  resolve: (result: WireResult) => void
  reject: (reason?: unknown) => void
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const bridgeFilename =
  process.platform === "win32"
    ? "yadaw-vst3-bridge.dll"
    : process.platform === "darwin"
      ? "libyadaw-vst3-bridge.dylib"
      : "libyadaw-vst3-bridge.so"
const [helperPath, bridgePath, pluginPath] = process.argv.slice(2)
const resolvedHelper =
  helperPath ?? resolve(repositoryRoot, "target", "debug", `yadaw-audio-host${executableSuffix}`)
const resolvedBridge =
  bridgePath ?? resolve(repositoryRoot, "target", "vst3-fixtures", "bin", bridgeFilename)
const resolvedPlugin =
  pluginPath ?? resolve(repositoryRoot, "target", "vst3-fixtures", "VST3", "Debug", "again.vst3")
const resolvedSynth = resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "VST3",
  "Debug",
  "note-expression-synth.vst3"
)
const smokeExecutable = resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "bin",
  `yadaw-vst3-smoke${executableSuffix}`
)
const smoke = spawnSync(smokeExecutable, [resolvedPlugin, resolvedSynth], {
  stdio: "inherit"
})
if (smoke.status !== 0) {
  throw new Error(`VST3 block-processing smoke test exited with ${smoke.status}`)
}

const crashMarker = resolve(tmpdir(), `yadaw-vst3-smoke-${process.pid}.marker`)
const child = spawn(
  resolvedHelper,
  ["--vst3-bridge", resolvedBridge, "--crash-marker", crashMarker],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, YADAW_TEST_VIRTUAL_AUDIO: "1" }
  }
)
let nextRequestId = 1
let received = Buffer.alloc(0)
const pending = new Map<number, PendingRequest>()
child.once("exit", (code, signal) => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`audio-host exited (${signal ?? code ?? "unknown"})`))
  }
  pending.clear()
})

function send(command: unknown): Promise<WireResult> {
  return new Promise((resolveResult, reject) => {
    const requestId = nextRequestId++
    pending.set(requestId, { resolve: resolveResult, reject })
    const payload = Buffer.from(
      encode({
        request_id: requestId,
        command
      })
    )
    const frame = Buffer.alloc(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    child.stdin.write(frame)
  })
}

child.stdout.on("data", (chunk: Buffer) => {
  received = Buffer.concat([received, chunk])
  while (received.length >= 4 && received.length >= received.readUInt32BE(0) + 4) {
    const length = received.readUInt32BE(0)
    const response = decode(received.subarray(4, length + 4)) as WireResponse
    received = received.subarray(length + 4)
    const waiter = pending.get(response.request_id)
    pending.delete(response.request_id)
    if (!waiter) {
      throw new Error(`received response for unknown request ${response.request_id}`)
    }
    if (response.result.type === "error") {
      waiter.reject(new Error(response.result.message))
    } else {
      waiter.resolve(response.result)
    }
  }
})

try {
  const loaded = await send({
    type: "load-plugin",
    instance_id: "again-1",
    module_path: resolvedPlugin,
    class_id: "84E8DE5F92554F5396FAE4133C935A18",
    sample_rate: 48_000,
    component_state: { storage: "inline", bytes: new Uint8Array() },
    controller_state: { storage: "inline", bytes: new Uint8Array() }
  })
  if (loaded.type !== "plugin-loaded") throw new Error("load response mismatch")
  const synthLoaded = await send({
    type: "load-plugin",
    instance_id: "synth-1",
    module_path: resolvedSynth,
    class_id: "41466D9BB0654576B641098F686371B3",
    sample_rate: 48_000,
    component_state: { storage: "inline", bytes: new Uint8Array() },
    controller_state: { storage: "inline", bytes: new Uint8Array() }
  })
  if (synthLoaded.type !== "plugin-loaded") throw new Error("synth load response mismatch")
  const listed = await send({ type: "plugin-parameters", instance_id: "again-1" })
  const listedParameters = listed.parameters
  if (listed.type !== "plugin-parameters" || !listedParameters?.length) {
    throw new Error("AGain did not expose parameters")
  }
  const editor = await send({ type: "open-plugin-editor", instance_id: "again-1" })
  const editorKind = editor.editor_kind
  if (editorKind !== "native" && editorKind !== "generic") {
    throw new Error("plugin editor did not report native or generic fallback")
  }
  const focused = await send({ type: "open-plugin-editor", instance_id: "again-1" })
  if (editorKind === "native" && !focused.open) {
    throw new Error("opening the existing editor did not focus/reuse it")
  }
  await send({ type: "close-plugin-editor", instance_id: "again-1" })
  const parameter = listedParameters[0]
  if (!parameter) throw new Error("AGain parameter list became empty")
  for (const gesture of ["begin", "perform", "end"]) {
    await send({
      type: "set-plugin-parameter",
      instance_id: "again-1",
      parameter_id: parameter.id,
      normalized: 0.25,
      gesture
    })
  }
  const state = await send({ type: "save-plugin-state", instance_id: "again-1" })
  const componentState = state.component_state?.bytes
  if (state.type !== "plugin-state" || !(componentState instanceof Uint8Array)) {
    throw new Error("state response mismatch")
  }
  await send({
    type: "load-graph",
    revision: 1,
    graph: {
      sample_rate: 48_000,
      channels: [
        {
          id: "instrument-1",
          kind: "instrument",
          gain_db: 0,
          pan: 0,
          muted: false,
          soloed: false,
          output_index: 2,
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
          channel_index: 0,
          role: "instrument",
          slot_order: 0,
          enabled: true,
          latency_samples: synthLoaded.latency_samples ?? 0,
          tail_samples: synthLoaded.tail_samples ?? 0
        },
        {
          instance_id: "again-1",
          channel_index: 0,
          role: "insert",
          slot_order: 0,
          enabled: true,
          latency_samples: loaded.latency_samples ?? 0,
          tail_samples: loaded.tail_samples ?? 0
        }
      ],
      midi_clips: [
        {
          id: "clip-1",
          channel_index: 0,
          start_tick: 0,
          source_offset_ticks: 0,
          length_ticks: 960,
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
        }
      ],
      tempo_events: [{ tick: 0, beats_per_minute: 120 }],
      time_signature_events: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  })
  await send({
    type: "start-audio-engine",
    config: {
      backend: "virtual",
      input_device_id: "virtual-stereo",
      output_device_id: "virtual-stereo",
      buffer_size: 128
    }
  })
  await send({ type: "transport", command: { kind: "play" } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const meters = await send({ type: "mixer-snapshot" })
  const instrumentMeter = meters.meters?.find((meter) => meter.channel_id === "instrument-1")
  if (!instrumentMeter || Math.max(instrumentMeter.held_left, instrumentMeter.held_right) <= 0) {
    throw new Error("virtual live graph did not render the VST3 instrument/effect chain")
  }
  await send({ type: "stop-audio-engine" })
  console.log(
    `VST3 helper live graph passed (${listedParameters.length} parameters, ` +
      `${componentState.length} component bytes, meter ` +
      `${Math.max(instrumentMeter.held_left, instrumentMeter.held_right).toFixed(4)})`
  )
  await send({ type: "shutdown" })
} catch (error) {
  child.kill()
  throw error
}
