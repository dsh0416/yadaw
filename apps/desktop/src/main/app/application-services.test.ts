import { describe, expect, it, vi } from "vitest"

const fakes = vi.hoisted(() => ({
  graph: {
    sampleRate: 48_000,
    channels: [{ id: "channel", name: "Track", color: "#fff" }],
    plugins: [
      {
        id: "plugin",
        channelId: "channel",
        descriptor: { name: "Gain", locator: { format: "vst3" } }
      }
    ]
  },
  snapshot: vi.fn(),
  attachKernel: vi.fn(),
  applicationDispose: vi.fn(),
  commitAudioEngine: vi.fn(async () => undefined),
  applicationState: { desktopSession: { kind: "desktop-session" }, commitAudioEngine: vi.fn() }
}))

vi.mock("../project", () => ({
  AssetMaterializer: class {},
  AssetAuditionService: class {},
  AudioImportService: class {},
  AudioGraphCompiler: class {},
  AudioGraphPublisher: class {},
  ProjectGraphService: class {
    snapshot = fakes.snapshot
  },
  ProjectCommandService: class {
    attachKernel = fakes.attachKernel
  },
  MidiImportService: class {},
  WaveformService: class {},
  commitExternalProjectDirty: vi.fn()
}))
vi.mock("../audio", () => ({
  MixerRuntimeService: class {},
  TransportService: class {
    snapshot = vi.fn()
  }
}))
vi.mock("../kernel", () => ({
  LifecycleCoordinator: class {
    applicationState = {
      desktopSession: { kind: "desktop-session" },
      commitAudioEngine: fakes.commitAudioEngine
    }
  },
  OperationRegistry: class {},
  OperationService: class {}
}))
vi.mock("../recording", () => ({ RecordingService: class {} }))
vi.mock("./audio-host-application-events", () => ({
  bindAudioHostApplicationEvents: vi.fn(() => ({ dispose: fakes.applicationDispose }))
}))
vi.mock("../ipc", () => ({ normalizeAudioRuntime: vi.fn((runtime) => runtime) }))
vi.mock("@heron/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heron/contracts")>()),
  pluginTypeKey: vi.fn(() => "vst3:gain")
}))

import { createApplicationServices } from "./application-services"

interface AttachedRuntime {
  resolveInstance(id: string): Promise<unknown>
  load(plugin: unknown, sampleRate: number): Promise<unknown>
  parameters(id: string): Promise<unknown>
  setParameter(change: unknown): Promise<unknown>
  openEditor(id: string): Promise<unknown>
  closeEditor(id: string): Promise<unknown>
}

describe("createApplicationServices", () => {
  it("wires runtime adapters and delegates plug-in editor context", async () => {
    fakes.snapshot.mockResolvedValue(fakes.graph)
    const attached: AttachedRuntime[] = []
    const plugins = { attachRuntime: vi.fn((runtime: AttachedRuntime) => attached.push(runtime)) }
    const audioHost = {
      loadPlugin: vi.fn(async () => undefined),
      pluginParameters: vi.fn(async () => []),
      setPluginParameter: vi.fn(async () => undefined),
      openPluginEditor: vi.fn(async () => undefined),
      closePluginEditor: vi.fn(async () => undefined),
      pluginEditorAppearanceSnapshot: vi.fn(() => ({ theme: "dark", locale: "en-US" })),
      audioEngineSnapshot: vi.fn(async () => ({ state: "running" })),
      helperEpoch: vi.fn(() => "audio-epoch")
    }
    const settings = {
      pluginEditorPreference: vi.fn(async () => ({ mode: "native", zoomPercent: 100 }))
    }
    const services = await createApplicationServices({
      userDataPath: "/data",
      sourceEpoch: "main-epoch",
      settings,
      projectService: { current: null },
      audioHost,
      plugins,
      eventTargets: () => [],
      allowRecordingWithoutAudio: false
    } as never)

    expect(plugins.attachRuntime).toHaveBeenCalledOnce()
    expect(fakes.commitAudioEngine).toHaveBeenCalledWith({ state: "running" })
    expect(fakes.attachKernel).toHaveBeenCalledOnce()
    const runtime = attached[0]!
    await expect(runtime.resolveInstance("plugin")).resolves.toMatchObject({ sampleRate: 48_000 })
    await expect(runtime.resolveInstance("missing")).rejects.toThrow("was not found")
    await runtime.load({ id: "plugin" }, 48_000)
    await runtime.parameters("plugin")
    await runtime.setParameter({})
    await runtime.openEditor("plugin")
    await runtime.closeEditor("plugin")
    expect(audioHost.openPluginEditor).toHaveBeenCalledWith(
      "plugin",
      { mode: "native", zoomPercent: 100 },
      expect.objectContaining({ channelName: "Track", pluginName: "Gain" })
    )

    fakes.snapshot.mockResolvedValueOnce({ ...fakes.graph, channels: [] })
    await expect(runtime.openEditor("plugin")).rejects.toThrow("channel")
    services.dispose()
    expect(fakes.applicationDispose).toHaveBeenCalledOnce()
  })
})
