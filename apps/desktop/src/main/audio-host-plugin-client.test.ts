import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  PluginDescriptor,
  PluginInstanceState,
  PluginParameterCommand
} from "@heron/contracts"
import { AudioHostPluginClient } from "./audio-host-plugin-client"
import type { ControlResponse } from "./audio-host-wire"

type HostRequest = (command: Record<string, unknown>) => Promise<ControlResponse>

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "ABCDEF0123456789ABCDEF0123456789",
  modulePath: "/plugins/Effect.vst3",
  name: "Effect",
  vendor: "Heron Studio",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["stereo"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const plugin: PluginInstanceState = {
  id: "plugin-1",
  channelId: "master",
  role: "insert",
  slotOrder: 0,
  classId: descriptor.classId,
  descriptor,
  audioMode: "stereo",
  enabled: true,
  sidechainInputs: [],
  componentState: new Uint8Array([1, 2]),
  controllerState: new Uint8Array([3, 4])
}

describe("AudioHostPluginClient", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function createClient(options?: {
    client?: { enqueueParameter: ReturnType<typeof vi.fn> } | null
    request?: ReturnType<typeof vi.fn>
    requestImmediately?: ReturnType<typeof vi.fn>
  }) {
    const request = options?.request ?? vi.fn()
    const requestImmediately = options?.requestImmediately ?? vi.fn()
    const ipcClient = options?.client === undefined ? { enqueueParameter: vi.fn() } : options.client
    const client = new AudioHostPluginClient(
      () => ipcClient as never,
      request as unknown as HostRequest,
      requestImmediately as unknown as HostRequest
    )
    return { client, request, requestImmediately, ipcClient }
  }

  it("loads a plugin and caches its runtime handle", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({
      result: {
        type: "plugin-loaded",
        runtime_handle: 7,
        latency_samples: 32,
        tail_samples: 64
      }
    })

    await expect(client.loadPlugin(plugin, 48_000)).resolves.toEqual({
      classId: descriptor.classId,
      runtimeHandle: 7,
      latencySamples: 32,
      tailSamples: 64
    })
    await expect(client.loadPlugin(plugin, 48_000)).resolves.toEqual({
      classId: descriptor.classId,
      runtimeHandle: 7,
      latencySamples: 32,
      tailSamples: 64
    })
    expect(request).toHaveBeenCalledOnce()
    expect(client.has("plugin-1")).toBe(true)
    expect(client.status("plugin-1")).toMatchObject({ runtimeHandle: 7 })
    expect(client.loadedInstanceIds()).toEqual(["plugin-1"])
  })

  it("rejects invalid load responses", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({ result: { type: "ok" } })

    await expect(client.loadPlugin(plugin, 48_000)).rejects.toThrow(/invalid plugin load/)
  })

  it("uses the immediate request path when asked", async () => {
    const { client, requestImmediately } = createClient()
    requestImmediately.mockResolvedValue({
      result: { type: "plugin-loaded", runtime_handle: 1, latency_samples: 0, tail_samples: null }
    })

    await client.loadPluginWithRequest(plugin, 48_000, true)
    expect(requestImmediately).toHaveBeenCalledOnce()
  })

  it("unloads plugins and clears bypass state", async () => {
    const { client, request } = createClient()
    request
      .mockResolvedValueOnce({
        result: { type: "plugin-loaded", runtime_handle: 1, latency_samples: 0, tail_samples: null }
      })
      .mockResolvedValueOnce({ result: { type: "ok" } })
    await client.loadPlugin(plugin, 48_000)
    client.bypass("plugin-1")
    expect(client.isBypassed("plugin-1")).toBe(true)

    await client.unloadPlugin("plugin-1")
    expect(client.has("plugin-1")).toBe(false)
    expect(client.isBypassed("plugin-1")).toBe(false)
  })

  it("keeps failed unloads tracked for reconciliation", async () => {
    const { client, request } = createClient()
    request
      .mockResolvedValueOnce({
        result: { type: "plugin-loaded", runtime_handle: 1, latency_samples: 0, tail_samples: null }
      })
      .mockRejectedValueOnce(new Error("helper unavailable"))
      .mockResolvedValueOnce({ result: { type: "ok" } })
    await client.loadPlugin(plugin, 48_000)

    await expect(client.unloadPlugin("plugin-1")).rejects.toThrow("helper unavailable")
    expect(client.loadedInstanceIds()).toEqual(["plugin-1"])

    await expect(client.unloadPlugin("plugin-1")).resolves.toBeUndefined()
    expect(client.loadedInstanceIds()).toEqual([])
  })

  it("maps parameter list responses", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({
      result: {
        type: "plugin-parameters",
        parameters: [
          {
            id: 1,
            title: "Gain",
            units: "dB",
            step_count: 0,
            default_normalized: 0.5,
            normalized: 0.25,
            flags: 0
          }
        ]
      }
    })

    await expect(client.pluginParameters("plugin-1")).resolves.toEqual([
      {
        id: 1,
        title: "Gain",
        shortTitle: "Gain",
        units: "dB",
        stepCount: 0,
        defaultNormalized: 0.5,
        normalized: 0.25,
        flags: 0
      }
    ])
  })

  it("opens and closes editors", async () => {
    const { client, request } = createClient()
    request
      .mockResolvedValueOnce({
        result: { type: "plugin-editor", active_mode: "native", open: true }
      })
      .mockResolvedValueOnce({ result: { type: "ok" } })

    await expect(
      client.openPluginEditor(
        "plugin-1",
        { mode: "native", zoomPercent: 100 },
        {
          channelName: "Lead",
          channelColor: "#58c6c2",
          pluginName: "Fixture",
          appearance: { theme: "dark", locale: "en-US" }
        }
      )
    ).resolves.toEqual({ editorMode: "native", open: true })
    expect(request).toHaveBeenNthCalledWith(1, {
      type: "open-plugin-editor",
      instance_id: "plugin-1",
      preference: { mode: "native", zoom_percent: 100 },
      context: {
        channel_name: "Lead",
        channel_color: "#58c6c2",
        plugin_name: "Fixture",
        appearance: { theme: "dark", locale: "en-US" }
      }
    })
    await client.closePluginEditor("plugin-1")
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("forwards resolved editor appearance updates", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({ result: { type: "ok" } })

    await client.configurePluginEditorAppearance({ theme: "light", locale: "zh-cmn-Hans-CN" })

    expect(request).toHaveBeenCalledWith({
      type: "configure-plugin-editor-appearance",
      appearance: { theme: "light", locale: "zh-cmn-Hans-CN" }
    })
  })

  it("falls back to request when enqueue has no live client/handle", async () => {
    const { client, request } = createClient({ client: null })
    request.mockResolvedValue({ result: { type: "ok" } })
    const command: PluginParameterCommand = {
      plugin: {
        kind: "plugin-instance",
        id: "plugin-1",
        epoch: "e",
        generation: 1
      },
      helperEpoch: "e",
      pluginGeneration: 1,
      sequence: "1",
      parameterId: 1,
      normalized: 0.5,
      gesture: "perform"
    }

    await expect(client.enqueuePluginParameter(command)).resolves.toMatchObject({
      outcome: "queued",
      sequence: "1"
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-plugin-parameter", instance_id: "plugin-1" })
    )
  })

  it("coalesces soft-full perform gestures and flushes later", async () => {
    vi.useFakeTimers()
    const enqueueParameter = vi
      .fn()
      .mockReturnValueOnce({ outcome: "soft-full", sequence: "9" })
      .mockReturnValueOnce({ outcome: "queued", sequence: "10" })
    const { client, request } = createClient({ client: { enqueueParameter } })
    request.mockResolvedValue({
      result: { type: "plugin-loaded", runtime_handle: 3, latency_samples: 0, tail_samples: null }
    })
    await client.loadPlugin(plugin, 48_000)

    const result = await client.enqueuePluginParameter({
      plugin: { kind: "plugin-instance", id: "plugin-1", epoch: "e", generation: 1 },
      helperEpoch: "e",
      pluginGeneration: 1,
      sequence: "9",
      parameterId: 2,
      normalized: 0.8,
      gesture: "perform"
    })
    expect(result.outcome).toBe("coalesced")

    await vi.advanceTimersByTimeAsync(5)
    expect(enqueueParameter).toHaveBeenCalledTimes(2)
  })

  it("resets connection state including pending flushes", async () => {
    vi.useFakeTimers()
    const enqueueParameter = vi.fn(() => ({ outcome: "full", sequence: "1" }))
    const { client, request } = createClient({ client: { enqueueParameter } })
    request.mockResolvedValue({
      result: { type: "plugin-loaded", runtime_handle: 1, latency_samples: 0, tail_samples: null }
    })
    await client.loadPlugin(plugin, 48_000)
    await client.enqueuePluginParameter({
      plugin: { kind: "plugin-instance", id: "plugin-1", epoch: "e", generation: 1 },
      helperEpoch: "e",
      pluginGeneration: 1,
      sequence: "1",
      parameterId: 1,
      normalized: 0.1,
      gesture: "perform"
    })

    client.resetConnection()
    expect(client.loadedInstanceIds()).toEqual([])
    await vi.advanceTimersByTimeAsync(10)
    expect(enqueueParameter).toHaveBeenCalledTimes(1)
  })

  it("saves plugin state bytes", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({
      result: {
        type: "plugin-state",
        component_state: { storage: "inline", bytes: new Uint8Array([1]) },
        controller_state: { storage: "inline", bytes: new Uint8Array([2]) },
        ara_document_state: { storage: "inline", bytes: new Uint8Array([3]) }
      }
    })

    const state = await client.savePluginState("plugin-1")
    expect(state.componentState).toEqual(new Uint8Array([1]))
    expect(state.controllerState).toEqual(new Uint8Array([2]))
    expect(state.araDocumentState).toEqual(new Uint8Array([3]))
  })
})
