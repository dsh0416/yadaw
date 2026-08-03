import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@heron/audio-host-client"

interface WireResponse {
  request_id: number
  result: {
    type: string
    message?: string
    active_mode?: "native" | "parameters"
    open?: boolean
  }
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const [helperArgument, pluginArgument, classIdArgument, pluginKindArgument] = process.argv.slice(2)
const helperPath =
  helperArgument ??
  resolve(repositoryRoot, "target", "debug", `heron-audio-host${executableSuffix}`)
const pluginPath =
  pluginArgument ??
  resolve(repositoryRoot, "target", "vst3-fixtures", "VST3", "Debug", "note-expression-synth.vst3")
const classId = classIdArgument ?? "41466D9BB0654576B641098F686371B3"
const pluginKind = pluginKindArgument ?? "instrument"
const initialMode = process.env.HERON_EDITOR_SMOKE_INITIAL_MODE ?? "native"
if (initialMode !== "native" && initialMode !== "parameters") {
  throw new Error("HERON_EDITOR_SMOKE_INITIAL_MODE must be native or parameters")
}
const observationDelayMs = Number.parseInt(process.env.HERON_EDITOR_SMOKE_DELAY_MS ?? "250", 10)
if (!Number.isFinite(observationDelayMs) || observationDelayMs < 0 || observationDelayMs > 60_000) {
  throw new Error("HERON_EDITOR_SMOKE_DELAY_MS must be between 0 and 60000")
}
const client = new AudioHostIpcClient(
  helperPath,
  resolve(tmpdir(), `heron-vst3-editor-${process.pid}.marker`),
  2,
  4,
  2
)
let requestId = 1

async function request(command: unknown): Promise<WireResponse["result"]> {
  const id = requestId++
  const response = await client.request(
    Buffer.from(
      encode({
        request_id: id,
        command
      })
    )
  )
  const decoded = decode(response.body) as WireResponse
  if (decoded.request_id !== id) throw new Error("audio-host response ID mismatch")
  if (decoded.result.type === "error") {
    throw new Error(decoded.result.message ?? "audio-host returned an error")
  }
  return decoded.result
}

try {
  const editorContext = {
    channel_name: "Editor Smoke",
    channel_color: "#58c6c2",
    plugin_name: "VST3 Fixture",
    appearance: { theme: "dark", locale: "en-US" }
  }
  await request({
    type: "load-plugin",
    instance_id: "editor-smoke",
    module_path: pluginPath,
    class_id: classId,
    plugin_kind: pluginKind,
    audio_mode: "stereo",
    sample_rate: 48_000,
    component_state: { storage: "inline", bytes: new Uint8Array() },
    controller_state: { storage: "inline", bytes: new Uint8Array() }
  })

  const initial = await request({
    type: "open-plugin-editor",
    instance_id: "editor-smoke",
    preference: { mode: initialMode, zoom_percent: 100 },
    context: editorContext
  })
  if (initial.type !== "plugin-editor" || !initial.open || initial.active_mode !== initialMode) {
    throw new Error(`${initialMode} editor window did not open`)
  }
  const focused = await request({
    type: "open-plugin-editor",
    instance_id: "editor-smoke",
    preference: { mode: initialMode, zoom_percent: 100 },
    context: editorContext
  })
  if (!focused.open || focused.active_mode !== initial.active_mode) {
    throw new Error("reopening the editor did not focus/reuse the existing window")
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, observationDelayMs))
  await request({ type: "close-plugin-editor", instance_id: "editor-smoke" })
  const parameters = await request({
    type: "open-plugin-editor",
    instance_id: "editor-smoke",
    preference: { mode: "parameters", zoom_percent: 200 },
    context: { ...editorContext, appearance: { theme: "light", locale: "zh-cmn-Hans-CN" } }
  })
  if (!parameters.open || parameters.active_mode !== "parameters") {
    throw new Error("parameter editor window did not open at 200%")
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, observationDelayMs))
  await request({ type: "close-plugin-editor", instance_id: "editor-smoke" })
  await request({ type: "shutdown" })
  console.log(`VST3 editor smoke passed (initial=${initial.active_mode}, parameter zoom=200%)`)
} finally {
  client.close()
}
