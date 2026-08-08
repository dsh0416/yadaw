import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  PluginDescriptor,
  PluginInstanceState,
  PluginParameterCommand
} from "@heron/contracts"
import { AudioHostPluginClient } from "./audio-host-plugin-client"
import type { ControlResponse } from "./wire"

type HostRequest = (command: Record<string, unknown>) => Promise<ControlResponse>

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  locator: {
    format: "vst3",
    artifactPath: "/plugins/Effect.vst3",
    nativeId: "ABCDEF0123456789ABCDEF0123456789"
  },
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
  locator: descriptor.locator,
  descriptor,
  audioMode: "stereo",
  enabled: true,
  sidechainInputs: [],
  state: {
    version: 1,
    chunks: [
      { key: "component", bytes: new Uint8Array([1, 2]) },
      { key: "controller", bytes: new Uint8Array([3, 4]) }
    ]
  }
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
      typeKey: "vst3:ABCDEF0123456789ABCDEF0123456789",
      runtimeHandle: 7,
      latencySamples: 32,
      tailSamples: 64
    })
    await expect(client.loadPlugin(plugin, 48_000)).resolves.toEqual({
      typeKey: "vst3:ABCDEF0123456789ABCDEF0123456789",
      runtimeHandle: 7,
      latencySamples: 32,
      tailSamples: 64
    })
    expect(request).toHaveBeenCalledOnce()
    expect(client.has("plugin-1")).toBe(true)
    expect(client.status("plugin-1")).toMatchObject({ runtimeHandle: 7 })
    expect(client.loadedInstanceIds()).toEqual(["plugin-1"])
  })

  it("loads a hosted mono-to-stereo effect with its native mono processor layout", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({
      result: { type: "plugin-loaded", runtime_handle: 8, latency_samples: 0, tail_samples: 0 }
    })
    const monoToStereo: PluginInstanceState = {
      ...plugin,
      descriptor: { ...descriptor, supportedAudioModes: ["mono"] },
      audioMode: "mono-to-stereo"
    }

    await client.loadPlugin(monoToStereo, 48_000)

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ audio_mode: "mono" }))
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
            parameter_key: "vst3:1",
            runtime_token: 1,
            title: "Gain",
            units: "dB",
            step_count: 0,
            default_normalized: 0.5,
            normalized: 0.25,
            min_value: -60,
            max_value: 12,
            default_value: 0,
            value: -12,
            normalized_value: 0.25,
            module_path: "Dynamics",
            read_only: false,
            hidden: false,
            stepped: false,
            automatable: true,
            bypass: false
          }
        ]
      }
    })

    await expect(client.pluginParameters("plugin-1")).resolves.toEqual([
      {
        parameterKey: "vst3:1",
        runtimeToken: 1,
        title: "Gain",
        shortTitle: "Gain",
        units: "dB",
        stepCount: 0,
        defaultNormalized: 0.5,
        normalized: 0.25,
        minValue: -60,
        maxValue: 12,
        defaultValue: 0,
        value: -12,
        normalizedValue: 0.25,
        modulePath: "Dynamics",
        readOnly: false,
        hidden: false,
        stepped: false,
        automatable: true,
        bypass: false
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

  it("routes editor toolbar actions through the async control request", async () => {
    const { client, request } = createClient()
    request.mockResolvedValue({
      result: {
        type: "plugin-editor-toolbar",
        state: {
          active_mode: "parameters",
          zoom_percent: 125,
          compare_slot: "b",
          can_compare: true,
          can_paste: true,
          can_undo: false,
          can_redo: true,
          sidechain_buses: [
            {
              input_port_key: "vst3:audio:input:1",
              name: "Side-chain",
              source_channel_id: "audio-2"
            }
          ],
          sidechain_sources: [{ id: "audio-2", name: "Audio 2", kind: "audio" }],
          sidechain_pending: false
        }
      }
    })

    await expect(
      client.applyPluginEditorAction("plugin-1", { type: "zoom", zoom_percent: 125 })
    ).resolves.toEqual({
      activeMode: "parameters",
      zoomPercent: 125,
      compareSlot: "b",
      canCompare: true,
      canPaste: true,
      canUndo: false,
      canRedo: true,
      sidechainBuses: [
        {
          inputPortKey: "vst3:audio:input:1",
          name: "Side-chain",
          sourceChannelId: "audio-2"
        }
      ],
      sidechainSources: [{ id: "audio-2", name: "Audio 2", kind: "audio" }],
      sidechainPending: false
    })
    expect(request).toHaveBeenCalledWith({
      type: "apply-plugin-editor-action",
      instance_id: "plugin-1",
      action: { type: "zoom", zoom_percent: 125 }
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
      parameterKey: "vst3:1",
      runtimeToken: 1,
      value: 0.5,
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
      parameterKey: "vst3:2",
      runtimeToken: 2,
      value: 0.8,
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
      parameterKey: "vst3:1",
      runtimeToken: 1,
      value: 0.1,
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
        state: {
          version: 1,
          chunks: [
            { key: "component", bytes: { storage: "inline", bytes: new Uint8Array([1]) } },
            { key: "controller", bytes: { storage: "inline", bytes: new Uint8Array([2]) } },
            { key: "ara-document", bytes: { storage: "inline", bytes: new Uint8Array([3]) } }
          ]
        }
      }
    })

    const state = await client.savePluginState("plugin-1")
    expect(state.chunks).toEqual([
      { key: "component", bytes: new Uint8Array([1]) },
      { key: "controller", bytes: new Uint8Array([2]) },
      { key: "ara-document", bytes: new Uint8Array([3]) }
    ])
  })
})
