import { describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION, rpcFailure, rpcSuccess } from "@heron/contracts"
import type { PluginDescriptor, ProjectGraphSnapshot, RpcRequestMeta } from "@heron/contracts"
import { AudioGraphPublisher } from "./audio-graph-publisher"

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

const graph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [],
  channels: [
    {
      id: "master",
      kind: "master",
      systemRole: null,
      name: "Master",
      color: "#fff",
      sortOrder: 0,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      outputBus: null,
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
      color: "#000",
      sortOrder: 1,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: [1, 2]
    }
  ],
  audioClips: [],
  sends: [],
  plugins: [
    {
      id: "plugin-1",
      channelId: "master",
      role: "insert",
      slotOrder: 0,
      locator: descriptor.locator,
      descriptor: { ...descriptor, name: "Stale" },
      audioMode: "stereo",
      enabled: true,
      sidechainInputs: [],
      state: { version: 1, chunks: [] }
    }
  ],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
}

const meta: RpcRequestMeta = {
  protocolVersion: IPC_PROTOCOL_VERSION,
  requestId: "request-1"
}

const projectGraph = {
  kind: "project-graph" as const,
  id: "project:graph",
  epoch: "epoch-1",
  generation: 1
}

describe("AudioGraphPublisher", () => {
  it("resolves plugin descriptors through the catalog", () => {
    const relocatedDescriptor: PluginDescriptor = {
      ...descriptor,
      locator: { ...descriptor.locator, artifactPath: "/current/Effect.vst3" }
    }
    const plugins = {
      resolveDescriptor: vi.fn(() => relocatedDescriptor)
    }
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn(() => ({ sample_rate: 48_000 })) } as never,
      { materialize: vi.fn(async () => new Map()) } as never,
      null,
      plugins as never,
      null
    )

    const resolved = publisher.resolve(graph)
    expect(resolved.plugins[0]?.locator).toEqual(relocatedDescriptor.locator)
    expect(resolved.plugins[0]?.descriptor).toEqual(relocatedDescriptor)
    expect(plugins.resolveDescriptor).toHaveBeenCalled()
  })

  it("prepares a graph without an audio host", async () => {
    const compiler = { compile: vi.fn(() => ({ sample_rate: 48_000, channels: [] })) }
    const assets = { materialize: vi.fn(async () => new Map()) }
    const settings = { get: vi.fn(async () => ({ softwareMonitoringEnabled: true })) }
    const publisher = new AudioGraphPublisher(
      compiler as never,
      assets as never,
      null,
      null,
      settings as never
    )

    const result = await publisher.prepare(meta, projectGraph, graph)

    expect(result).toMatchObject({
      ok: true,
      value: { revision: 1, native: null }
    })
    expect(compiler.compile).toHaveBeenCalledWith(expect.anything(), expect.any(Map), {
      softwareMonitoringEnabled: true,
      latencyPolicy: { type: "normal" }
    })
  })

  it("deep-resolves descriptors before compiling a used plug-in", async () => {
    const sidechainDescriptor: PluginDescriptor = {
      ...descriptor,
      locator: { ...descriptor.locator, artifactPath: "/current/Effect.vst3" },
      buses: [
        {
          portKey: "vst3:audio:input:1",
          direction: "input",
          kind: "aux",
          name: "Stereo Side Chain",
          channels: 2,
          defaultActive: true
        }
      ]
    }
    const plugins = {
      resolveDescriptorForRuntime: vi.fn(async () => sidechainDescriptor)
    }
    const compiler = { compile: vi.fn(() => ({ sample_rate: 48_000, channels: [] })) }
    const publisher = new AudioGraphPublisher(
      compiler as never,
      { materialize: vi.fn(async () => new Map()) } as never,
      null,
      plugins as never,
      null
    )

    const result = await publisher.prepare(meta, projectGraph, graph)

    expect(result).toMatchObject({
      ok: true,
      value: {
        graph: {
          plugins: [
            {
              locator: sidechainDescriptor.locator,
              descriptor: {
                buses: [
                  expect.objectContaining({
                    portKey: "vst3:audio:input:1",
                    kind: "aux",
                    channels: 2
                  })
                ]
              }
            }
          ]
        }
      }
    })
    expect(compiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [expect.objectContaining({ descriptor: sidechainDescriptor })]
      }),
      expect.any(Map),
      {
        softwareMonitoringEnabled: false,
        latencyPolicy: { type: "normal" }
      }
    )
  })

  it("propagates prepare failures from the audio host", async () => {
    const failure = rpcFailure(meta, {
      code: "resource-unavailable",
      category: "unavailable",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "c",
      userMessageKey: "errors.operationFailed",
      details: { type: "resource-unavailable", component: "audio-host", dispatched: true }
    })
    const audioHost = {
      prepareGraphDeployment: vi.fn(async () => failure)
    }
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn(() => ({ sample_rate: 48_000 })) } as never,
      { materialize: vi.fn(async () => new Map()) } as never,
      audioHost as never,
      null,
      null
    )

    await expect(publisher.prepare(meta, projectGraph, graph)).resolves.toBe(failure)
  })

  it("activates a prepared native deployment", async () => {
    const activated = rpcSuccess(meta, { ready: true })
    const audioHost = {
      activateGraphDeployment: vi.fn(async () => activated)
    }
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn() },
      { materialize: vi.fn() } as never,
      audioHost as never,
      null,
      null
    )
    const prepared = {
      graph,
      revision: 3,
      native: {
        meta,
        projectGraph,
        baseRevision: 2,
        graphRevision: 3,
        project: graph,
        runtime: {} as never
      }
    }

    const result = await publisher.activate(meta, prepared)
    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({ sampleRate: 48_000 })
    })
    expect(audioHost.activateGraphDeployment).toHaveBeenCalledWith(prepared.native)
  })

  it("fails when a native preparation exists without an audio host", async () => {
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn() },
      { materialize: vi.fn() } as never,
      null,
      null,
      null
    )
    const prepared = {
      graph,
      revision: 1,
      native: {
        meta,
        projectGraph,
        baseRevision: 0,
        graphRevision: 1,
        project: graph,
        runtime: {} as never
      }
    }

    const result = await publisher.activate(meta, prepared)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "resource-unavailable",
        details: { component: "audio-host", dispatched: false }
      }
    })
  })

  it("aborts native deployments through the audio host", async () => {
    const audioHost = {
      abortGraphDeployment: vi.fn(async () => undefined)
    }
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn() },
      { materialize: vi.fn() } as never,
      audioHost as never,
      null,
      null
    )

    await publisher.abort({
      graph,
      revision: 1,
      native: {
        meta,
        projectGraph,
        baseRevision: 0,
        graphRevision: 1,
        project: graph,
        runtime: {} as never
      }
    })
    expect(audioHost.abortGraphDeployment).toHaveBeenCalled()
  })

  it("publishes a graph through loadGraph", async () => {
    const audioHost = {
      loadGraph: vi.fn(async () => undefined)
    }
    const compiler = { compile: vi.fn(() => ({ sample_rate: 48_000 })) }
    const assets = { materialize: vi.fn(async () => new Map()) }
    const publisher = new AudioGraphPublisher(
      compiler as never,
      assets as never,
      audioHost as never,
      null,
      null
    )

    const published = await publisher.publish(graph, false, true)
    expect(published.sampleRate).toBe(48_000)
    expect(audioHost.loadGraph).toHaveBeenCalledWith(1, expect.anything(), expect.anything(), true)
  })
})
