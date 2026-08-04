import { resolve } from "node:path"
import { writeFile } from "node:fs/promises"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostRuntime } from "@heron/dsp-node"
import { app, BaseWindow, desktopCapturer } from "electron"
import {
  ElectronPluginEditorWindows,
  type PluginEditorToolbarAction
} from "../src/main/audio-host/audio-host-editor-windows.ts"

interface WireResponse {
  request_id: number
  result: {
    type: string
    message?: string
    active_mode?: "native" | "parameters"
    open?: boolean
    parameters?: Array<{
      id: number
      title: string
      units: string
      step_count: number
      default_normalized: number
      normalized: number
      formatted?: string
      flags: number
    }>
    state?: {
      active_mode: "native" | "parameters"
      zoom_percent: number
      compare_slot: "a" | "b"
      can_compare: boolean
      can_paste: boolean
      can_undo: boolean
      can_redo: boolean
      sidechain_buses: Array<{
        input_bus_index: number
        name: string
        source_channel_id: string | null
      }>
      sidechain_sources: Array<{
        id: string
        name: string
        kind: "audio" | "instrument" | "aux"
      }>
      sidechain_pending: boolean
    }
  }
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const [pluginArgument, classIdArgument, pluginKindArgument] = process.argv.slice(2)
const pluginPath =
  pluginArgument ??
  resolve(repositoryRoot, "target", "vst3-fixtures", "VST3", "Debug", "note-expression-synth.vst3")
const classId = classIdArgument ?? "41466D9BB0654576B641098F686371B3"
const pluginKind = pluginKindArgument ?? "instrument"
const observationDelayMs = Number.parseInt(process.env.HERON_EDITOR_SMOKE_DELAY_MS ?? "250", 10)
const requireInteraction = process.env.HERON_EDITOR_SMOKE_REQUIRE_INTERACTION === "1"
const screenshotPath = process.env.HERON_EDITOR_SMOKE_SCREENSHOT
if (!Number.isFinite(observationDelayMs) || observationDelayMs < 0 || observationDelayMs > 60_000) {
  throw new Error("HERON_EDITOR_SMOKE_DELAY_MS must be between 0 and 60000")
}
async function run(): Promise<void> {
  console.log("VST3 editor smoke: Electron ready")
  const parent = new BaseWindow({
    title: "Heron VST3 editor smoke",
    show: false,
    width: 800,
    height: 600,
    useContentSize: true
  })
  const editorWindows = new ElectronPluginEditorWindows(parent)
  let liveClient: AudioHostRuntime | null = null
  let uiDrainScheduled = false
  const scheduleUiDrain = (): void => {
    if (uiDrainScheduled) return
    uiDrainScheduled = true
    setImmediate(() => {
      uiDrainScheduled = false
      const client = liveClient
      if (!client) return
      const pending = client.drainUiWork()
      editorWindows.drain(client)
      if (pending) scheduleUiDrain()
    })
  }
  const client = new AudioHostRuntime(2, 4, undefined, scheduleUiDrain)
  liveClient = client
  const uiPump = setInterval(() => {
    scheduleUiDrain()
  }, 8)
  scheduleUiDrain()
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

  async function applyToolbarAction(action: PluginEditorToolbarAction) {
    const result = await request({
      type: "apply-plugin-editor-action",
      instance_id: "editor-smoke",
      action
    })
    if (result.type !== "plugin-editor-toolbar" || !result.state) {
      throw new Error("audio-host returned an invalid toolbar response")
    }
    return {
      activeMode: result.state.active_mode,
      zoomPercent: result.state.zoom_percent,
      compareSlot: result.state.compare_slot,
      canCompare: result.state.can_compare,
      canPaste: result.state.can_paste,
      canUndo: result.state.can_undo,
      canRedo: result.state.can_redo,
      sidechainBuses: result.state.sidechain_buses.map((bus) => ({
        inputBusIndex: bus.input_bus_index,
        name: bus.name,
        ...(bus.source_channel_id === null ? {} : { sourceChannelId: bus.source_channel_id })
      })),
      sidechainSources: result.state.sidechain_sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind
      })),
      sidechainPending: result.state.sidechain_pending
    }
  }

  async function readParameters() {
    const result = await request({ type: "plugin-parameters", instance_id: "editor-smoke" })
    if (result.type !== "plugin-parameters" || !result.parameters) {
      throw new Error("audio-host returned an invalid parameter response")
    }
    return result.parameters
  }

  try {
    const editorContext = {
      channel_name: "Editor Smoke",
      channel_color: "#58c6c2",
      plugin_name: "VST3 Fixture",
      appearance: { theme: "dark", locale: "en-US" }
    }
    console.log("VST3 editor smoke: loading plug-in")
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
    console.log("VST3 editor smoke: plug-in loaded")

    console.log("VST3 editor smoke: opening native editor")
    const initial = await editorWindows.open(
      client,
      "editor-smoke",
      {
        channelName: editorContext.channel_name,
        channelColor: editorContext.channel_color,
        pluginName: editorContext.plugin_name,
        theme: "dark",
        locale: "en-US"
      },
      async () => {
        const result = await request({
          type: "open-plugin-editor",
          instance_id: "editor-smoke",
          preference: { mode: "native", zoom_percent: 100 },
          context: editorContext
        })
        return {
          editorMode: result.active_mode === "native" ? "native" : "parameters",
          open: result.open === true
        }
      },
      applyToolbarAction,
      async () => {
        return (await readParameters()).map((parameter) => ({
          id: parameter.id,
          title: parameter.title,
          shortTitle: parameter.title,
          units: parameter.units,
          stepCount: parameter.step_count,
          defaultNormalized: parameter.default_normalized,
          normalized: parameter.normalized,
          ...(parameter.formatted === undefined ? {} : { formatted: parameter.formatted }),
          flags: parameter.flags
        }))
      },
      async (parameterId, normalized, gesture) => {
        await request({
          type: "set-plugin-parameter",
          instance_id: "editor-smoke",
          parameter_id: parameterId,
          normalized,
          gesture
        })
      },
      async () => {
        await request({ type: "close-plugin-editor", instance_id: "editor-smoke" })
      }
    )
    if (!initial.open || initial.editorMode !== "native") {
      throw new Error("native editor window did not open")
    }
    console.log("VST3 editor smoke: native editor attached")
    const toolbar = client.editorToolbarState("editor-smoke")
    if (!toolbar?.canCompare || toolbar.compareSlot !== "a") {
      throw new Error("native editor toolbar state is unavailable")
    }
    await applyToolbarAction({ type: "copy" })
    await applyToolbarAction({ type: "compare", slot: "b" })
    await applyToolbarAction({ type: "paste" })
    await applyToolbarAction({ type: "zoom", zoom_percent: 125 })
    await applyToolbarAction({ type: "zoom", zoom_percent: 100 })
    const parametersMode = await applyToolbarAction({ type: "mode", mode: "parameters" })
    if (parametersMode.activeMode !== "parameters") {
      throw new Error("parameter editor mode did not activate")
    }
    const parameters = await readParameters()
    const editable = parameters.find((parameter) => (parameter.flags & 2) === 0)
    if (!editable) throw new Error("parameter editor has no editable parameters")
    await request({
      type: "set-plugin-parameter",
      instance_id: "editor-smoke",
      parameter_id: editable.id,
      normalized: editable.normalized,
      gesture: "begin"
    })
    await request({
      type: "set-plugin-parameter",
      instance_id: "editor-smoke",
      parameter_id: editable.id,
      normalized: editable.normalized,
      gesture: "perform"
    })
    await request({
      type: "set-plugin-parameter",
      instance_id: "editor-smoke",
      parameter_id: editable.id,
      normalized: editable.normalized,
      gesture: "end"
    })
    const nativeMode = await applyToolbarAction({ type: "mode", mode: "native" })
    if (nativeMode.activeMode !== "native") {
      throw new Error("native editor mode did not reactivate")
    }
    console.log("VST3 editor smoke: toolbar actions passed")
    const focused = await request({
      type: "open-plugin-editor",
      instance_id: "editor-smoke",
      preference: { mode: "native", zoom_percent: 100 },
      context: editorContext
    })
    if (!focused.open || focused.active_mode !== "native") {
      throw new Error("reopening the editor did not focus/reuse the existing window")
    }

    const beforeInteraction = new Map(
      (await readParameters()).map((parameter) => [parameter.id, parameter.normalized])
    )
    console.log(
      "VST3 editor smoke: windows",
      BaseWindow.getAllWindows().map((window) => ({
        title: window.getTitle(),
        bounds: window.getBounds(),
        contentSize: window.getContentSize()
      }))
    )
    if (screenshotPath) {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1962, height: 1464 }
      })
      const source = sources.find((candidate) => candidate.name === "Editor Smoke — VST3 Fixture")
      if (!source) throw new Error("could not capture the native editor smoke window")
      await writeFile(screenshotPath, source.thumbnail.toPNG())
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, observationDelayMs))
    const changedParameters = (await readParameters()).filter(
      (parameter) => beforeInteraction.get(parameter.id) !== parameter.normalized
    )
    if (changedParameters.length > 0) {
      console.log(
        `VST3 editor smoke: native interaction changed ${changedParameters.length} parameter(s)`
      )
    } else if (requireInteraction) {
      throw new Error("native editor interaction did not change any plug-in parameter")
    }
    await editorWindows.close("editor-smoke")
    parent.destroy()
    await request({ type: "shutdown" })
    console.log("VST3 native editor smoke passed")
  } finally {
    clearInterval(uiPump)
    await editorWindows.closeAll()
    if (!parent.isDestroyed()) parent.destroy()
    client.close()
    liveClient = null
    app.quit()
  }
}

void app
  .whenReady()
  .then(run)
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
