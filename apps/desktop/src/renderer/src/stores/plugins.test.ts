import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import type {
  ProjectGraphSnapshot,
  PluginDescriptor,
  ProjectWorkspaceSnapshot,
  RpcEvent,
  RpcResult
} from "@heron/contracts"
import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import { applyToGraph } from "@heron/project-model"
import { useMixerStore } from "./mixer"
import { useAudioRuntimeStore } from "./audioRuntime"
import { usePluginStore } from "./plugins"
import { useProjectStore } from "./project"

const effectDescriptor: PluginDescriptor = {
  source: { kind: "external" },
  locator: { format: "vst3", artifactPath: "effect.vst3", nativeId: "effect" },
  name: "Effect",
  vendor: "Heron Studio",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["mono", "mono-to-stereo", "stereo", "dual-mono"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const instrumentDescriptor: PluginDescriptor = {
  ...effectDescriptor,
  locator: { format: "vst3", artifactPath: "instrument.vst3", nativeId: "instrument" },
  name: "Instrument",
  categories: ["Instrument"],
  kind: "instrument",
  supportedAudioModes: ["mono", "stereo"]
}

const replacementInstrumentDescriptor: PluginDescriptor = {
  ...instrumentDescriptor,
  locator: {
    format: "vst3",
    artifactPath: "replacement-instrument.vst3",
    nativeId: "replacement-instrument"
  },
  name: "Replacement Instrument"
}

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [
      { id: "track:audio", channelId: "audio", sortOrder: 0 },
      { id: "track:instrument", channelId: "instrument", sortOrder: 0 }
    ],
    channels: [
      {
        id: "audio",
        kind: "audio",
        systemRole: null,
        name: "Audio",
        color: "#4F8CFF",
        sortOrder: 0,
        inputSource: "hardware",
        inputFormat: "stereo",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "instrument",
        kind: "instrument",
        systemRole: null,
        name: "Instrument",
        color: "#9B7CF6",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output",
        color: "#EF7C95",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    audioClips: [],
    sends: [],
    plugins: [],
    midiClips: [],
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  }
}

function workspace(value: ProjectGraphSnapshot): ProjectWorkspaceSnapshot {
  return {
    project: {
      kind: "project-session",
      id: "project",
      epoch: "test-main",
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: "project:graph",
      epoch: "test-main",
      generation: 1
    },
    revision: 1,
    session: {
      id: "project",
      path: "project.heron",
      configuration: {
        name: "Plugin test",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    },
    graph: structuredClone(value),
    assets: []
  }
}

function success<T>(value: T): RpcResult<T> {
  return {
    ok: true,
    requestId: "test-request",
    operationId: "test-operation",
    resourceRevision: 2,
    value,
    warnings: []
  }
}

function editorOpenResult() {
  return success({
    resource: {
      plugin: {
        kind: "plugin-instance" as const,
        id: "plugin-1",
        epoch: "test-main",
        generation: 1
      },
      projectGraph: workspace(graph()).projectGraph,
      revision: 1,
      instance: {
        id: "plugin-1",
        channelId: "audio",
        role: "insert" as const,
        slotOrder: 0,
        locator: effectDescriptor.locator,
        descriptor: effectDescriptor,
        audioMode: "stereo" as const,
        enabled: true,
        sidechainInputs: [],
        state: { version: 1, chunks: [] }
      }
    },
    status: {
      instanceId: "plugin-1",
      state: "active" as const,
      editorOpen: true,
      editorMode: "parameters" as const,
      latencySamples: 64,
      tailSamples: 0,
      error: null
    }
  })
}

describe("plugin store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().applyWorkspace(workspace(graph()))
    useProjectStore().applyDesktopSession({
      kind: "desktop-session",
      id: "desktop",
      epoch: "test-main",
      generation: 1
    })
    useAudioRuntimeStore().applyResources({
      host: { kind: "audio-host", id: "audio-host", epoch: "helper-epoch", generation: 1 },
      engine: null,
      transport: null,
      midiRuntime: {
        kind: "midi-runtime",
        id: "midi-runtime",
        epoch: "helper-epoch",
        generation: 1
      },
      revision: 0
    })
  })

  it("forces lightweight rediscovery when the user requests a manual rescan", async () => {
    const catalog = {
      scannerVersion: 7,
      scanning: false,
      scannedAt: 1,
      plugins: [effectDescriptor]
    }
    window.heron.scanPlugins = vi.fn().mockResolvedValue(success(catalog))
    const store = usePluginStore()

    await store.scan(true)

    expect(window.heron.scanPlugins).toHaveBeenCalledWith(expect.any(Object), {
      force: true,
      retryQuarantined: true
    })
    expect(store.catalog.plugins).toEqual([effectDescriptor])
  })

  it("reports the helper editor state without creating an Electron parameter panel", async () => {
    window.heron.getPluginParameters = vi.fn()
    window.heron.openPluginEditor = vi.fn().mockResolvedValue(editorOpenResult())
    const store = usePluginStore()

    await store.openEditor("plugin-1")

    expect(store.runtime["plugin-1"]).toMatchObject({
      editorOpen: true,
      editorMode: "parameters"
    })
    expect(window.heron.getPluginParameters).not.toHaveBeenCalled()
  })

  it("waits for project mutations and coalesces repeated editor clicks", async () => {
    window.heron.openPluginEditor = vi.fn().mockResolvedValue(editorOpenResult())
    const projectStore = useProjectStore()
    const finishMutation = projectStore.beginProjectMutation()
    const store = usePluginStore()

    const first = store.openEditor("plugin-1")
    const repeated = store.openEditor("plugin-1")
    await nextTick()

    expect(window.heron.openPluginEditor).not.toHaveBeenCalled()

    finishMutation()
    await Promise.all([first, repeated])

    expect(window.heron.openPluginEditor).toHaveBeenCalledOnce()
  })

  it("reconciles editor open state when the helper reports a native close", async () => {
    const closedBridge: {
      listener: ((event: RpcEvent<{ instanceId: string }>) => void) | null
    } = { listener: null }
    window.heron.subscribePluginEditorClosed = vi.fn((listener) => {
      closedBridge.listener = listener
      return () => {
        closedBridge.listener = null
      }
    })
    window.heron.listPlugins = vi.fn().mockResolvedValue(
      success({
        scannerVersion: 7,
        scanning: false,
        scannedAt: null,
        plugins: [effectDescriptor]
      })
    )
    window.heron.openPluginEditor = vi.fn().mockResolvedValue(
      success({
        resource: {
          plugin: {
            kind: "plugin-instance",
            id: "plugin-1",
            epoch: "test-main",
            generation: 1
          },
          projectGraph: workspace(graph()).projectGraph,
          revision: 1,
          instance: {
            id: "plugin-1",
            channelId: "audio",
            role: "insert",
            slotOrder: 0,
            locator: effectDescriptor.locator,
            descriptor: effectDescriptor,
            audioMode: "stereo",
            enabled: true,
            sidechainInputs: [],
            state: { version: 1, chunks: [] }
          }
        },
        status: {
          instanceId: "plugin-1",
          state: "active",
          editorOpen: true,
          editorMode: "native",
          latencySamples: 0,
          tailSamples: 0,
          error: null
        }
      })
    )
    const store = usePluginStore()
    await store.load()
    await store.openEditor("plugin-1")
    expect(store.resources["plugin-1"]).toBeTruthy()
    expect(closedBridge.listener).toEqual(expect.any(Function))

    closedBridge.listener?.({
      protocolVersion: IPC_PROTOCOL_VERSION,
      sourceEpoch: "helper-epoch",
      sequence: 1,
      resourceRevision: 1,
      payload: { instanceId: "plugin-1" }
    })

    expect(store.resources["plugin-1"]).toBeUndefined()
    expect(store.runtime["plugin-1"]).toMatchObject({ editorOpen: false })
  })

  it("updates parameter feedback while preserving gesture boundaries", async () => {
    window.heron.setPluginParameter = vi.fn().mockResolvedValue(
      success({
        plugin: {
          kind: "plugin-instance",
          id: "plugin-1",
          epoch: "test-main",
          generation: 1
        },
        helperEpoch: "helper-epoch",
        sequence: "1",
        outcome: "queued" as const
      })
    )
    const store = usePluginStore()
    store.parameters = {
      "plugin-1": [
        {
          parameterKey: "vst3:7",
          runtimeToken: 7,
          title: "Mix",
          shortTitle: "Mix",
          units: "%",
          stepCount: 0,
          defaultNormalized: 1,
          normalized: 0.5,
          minValue: 0,
          maxValue: 1,
          defaultValue: 1,
          value: 0.5,
          normalizedValue: 0.5
        }
      ]
    }
    store.resources = {
      "plugin-1": {
        plugin: {
          kind: "plugin-instance",
          id: "plugin-1",
          epoch: "test-main",
          generation: 1
        },
        projectGraph: workspace(graph()).projectGraph,
        revision: 1,
        instance: {
          id: "plugin-1",
          channelId: "audio",
          role: "insert",
          slotOrder: 0,
          locator: effectDescriptor.locator,
          descriptor: effectDescriptor,
          audioMode: "stereo",
          enabled: true,
          sidechainInputs: [],
          state: { version: 1, chunks: [] }
        }
      }
    }

    await store.setParameter({
      instanceId: "plugin-1",
      parameterKey: "vst3:7",
      value: 0.75,
      gesture: "perform"
    })

    expect(store.parameters["plugin-1"]?.[0]?.normalized).toBe(0.75)
    expect(window.heron.setPluginParameter).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        plugin: expect.objectContaining({ id: "plugin-1", generation: 1 }),
        helperEpoch: "helper-epoch",
        pluginGeneration: 1,
        sequence: "1",
        parameterKey: "vst3:7",
        runtimeToken: 7,
        value: 0.75,
        gesture: "perform"
      })
    )
  })

  it("adds selected effects and instruments through project commands", async () => {
    const mixerStore = useMixerStore()
    let canonicalGraph = graph()
    mixerStore.graph = canonicalGraph
    window.heron.executeProjectCommand = vi.fn().mockImplementation(async (_meta, command) => {
      if (command.type !== "create-plugin") throw new Error("Unexpected project command")
      canonicalGraph = applyToGraph(canonicalGraph, command)
      return success({
        graph: canonicalGraph,
        inverse: { type: "delete-plugin" as const, pluginId: command.plugin.id }
      })
    })
    const pluginStore = usePluginStore()

    expect(
      await pluginStore.addEffectAt(
        { descriptor: effectDescriptor, audioMode: "dual-mono" },
        "audio",
        0
      )
    ).toBe(true)
    expect(
      await pluginStore.assignInstrument(
        { descriptor: instrumentDescriptor, audioMode: "mono" },
        "instrument"
      )
    ).toBe(true)

    const commands = vi
      .mocked(window.heron.executeProjectCommand)
      .mock.calls.map(([, command]) => command)
    expect(commands[0]).toMatchObject({
      type: "create-plugin",
      plugin: {
        channelId: "audio",
        role: "insert",
        slotOrder: 0,
        descriptor: effectDescriptor,
        audioMode: "dual-mono"
      }
    })
    expect(commands[1]).toMatchObject({
      type: "create-plugin",
      plugin: {
        channelId: "instrument",
        role: "instrument",
        slotOrder: 0,
        descriptor: instrumentDescriptor,
        audioMode: "mono"
      }
    })
    expect(mixerStore.graph.plugins).toHaveLength(2)
  })

  it("clears a stale catalog failure when an instrument instance is replaced", async () => {
    const mixerStore = useMixerStore()
    const initialGraph = graph()
    initialGraph.plugins.push({
      id: "instrument-instance",
      channelId: "instrument",
      role: "instrument",
      slotOrder: 0,
      locator: instrumentDescriptor.locator,
      descriptor: instrumentDescriptor,
      audioMode: "stereo",
      enabled: true,
      sidechainInputs: [],
      state: { version: 1, chunks: [] }
    })
    mixerStore.graph = initialGraph
    window.heron.listPlugins = vi.fn().mockResolvedValue(
      success({
        scannerVersion: 4,
        scanning: false,
        scannedAt: 1,
        plugins: [replacementInstrumentDescriptor]
      })
    )
    window.heron.subscribePluginScan = vi.fn().mockReturnValue(vi.fn())
    window.heron.executeProjectCommand = vi.fn().mockImplementation(async (_meta, command) => {
      if (command.type !== "replace-plugin") throw new Error("Unexpected project command")
      const next = structuredClone(mixerStore.graph)
      const index = next.plugins.findIndex((plugin) => plugin.id === command.pluginId)
      next.plugins[index] = structuredClone(command.plugin)
      return success({
        graph: next,
        inverse: {
          type: "replace-plugin" as const,
          pluginId: command.plugin.id,
          plugin: initialGraph.plugins[0]!
        }
      })
    })
    const pluginStore = usePluginStore()
    await pluginStore.load()
    expect(pluginStore.runtime["instrument-instance"]?.state).toBe("missing")

    expect(
      await pluginStore.assignInstrument(
        { descriptor: replacementInstrumentDescriptor, audioMode: "stereo" },
        "instrument"
      )
    ).toBe(true)
    await nextTick()

    expect(pluginStore.runtime["instrument-instance"]).toBeUndefined()
  })

  it("rejects effect modes whose native input width does not match the insert point", async () => {
    const mixerStore = useMixerStore()
    mixerStore.graph = graph()
    mixerStore.graph.channels[0] = {
      ...mixerStore.graph.channels[0]!,
      inputFormat: "mono",
      inputChannels: [1]
    }
    window.heron.executeProjectCommand = vi.fn()
    const pluginStore = usePluginStore()

    expect(pluginStore.effectInputWidth("audio", 0)).toBe("mono")
    expect(
      await pluginStore.addEffectAt(
        { descriptor: effectDescriptor, audioMode: "stereo" },
        "audio",
        0
      )
    ).toBe(false)
    expect(window.heron.executeProjectCommand).not.toHaveBeenCalled()
    expect(pluginStore.error).toContain("mono-input")

    mixerStore.graph.plugins.push({
      id: "widener",
      channelId: "audio",
      role: "insert",
      slotOrder: 0,
      locator: effectDescriptor.locator,
      descriptor: effectDescriptor,
      audioMode: "mono-to-stereo",
      enabled: true,
      sidechainInputs: [],
      state: { version: 1, chunks: [] }
    })
    expect(pluginStore.effectInputWidth("audio", 1)).toBe("stereo")
  })
})
