import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  MixerChannelState,
  ProjectGraphSnapshot,
  PluginDescriptor,
  ProjectCommand,
  ProjectCommandResult,
  ProjectSession
} from "@yadaw/contracts"
import { IPC_PROTOCOL_VERSION, rpcSuccess } from "@yadaw/contracts"
import { applyToGraph } from "@yadaw/project-model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AssetMaterializer } from "./asset-materializer"
import { AudioGraphCompiler } from "./audio-graph-compiler"
import { AudioGraphPublisher } from "./audio-graph-publisher"
import type { AudioHostService } from "./audio-host-service"
import { ProjectCommandService } from "./project-command-service"
import { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"
import { LifecycleCoordinator } from "./lifecycle-coordinator"
import { OperationRegistry } from "./kernel/operation-registry"
import { OperationService } from "./operation-service"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

const effectDescriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "effect",
  modulePath: "effect.vst3",
  name: "Effect",
  vendor: "YADAW",
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

function channel(id: string, kind: MixerChannelState["kind"], sortOrder = 0): MixerChannelState {
  return {
    id,
    kind,
    systemRole: null,
    name: id,
    color: "#4F8CFF",
    sortOrder,
    inputSource: kind === "audio" ? "hardware" : null,
    inputFormat: kind === "audio" ? "stereo" : null,
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    outputChannelId: kind === "audio" || kind === "instrument" ? "output" : null,
    outputBus: null,
    recordArmed: false,
    inputMonitoring: false,
    inputChannels: kind === "audio" ? [1, 2] : [],
    hardwareOutputChannels: kind === "output" ? [1, 2] : []
  }
}

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [
      { id: "track:audio", channelId: "audio", sortOrder: 0 },
      { id: "track:instrument", channelId: "instrument", sortOrder: 0 }
    ],
    channels: [
      channel("audio", "audio"),
      channel("instrument", "instrument"),
      channel("master", "master"),
      channel("output", "output")
    ],
    audioClips: [],
    sends: [],
    plugins: [
      {
        id: "effect-1",
        channelId: "audio",
        role: "insert",
        slotOrder: 0,
        classId: effectDescriptor.classId,
        descriptor: effectDescriptor,
        audioMode: "stereo",
        enabled: true,
        componentState: new Uint8Array([1]),
        controllerState: new Uint8Array([2])
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
}

interface ProjectMock {
  service: ProjectService
  session: ProjectSession | null
  initialGraph: ProjectGraphSnapshot
  mixerSnapshot: ReturnType<typeof vi.fn>
  prepareProjectCommand: ReturnType<typeof vi.fn>
  commitProjectCommand: ReturnType<typeof vi.fn>
  abortProjectCommand: ReturnType<typeof vi.fn>
  projectCommandStatus: ReturnType<typeof vi.fn>
  importMidi: ReturnType<typeof vi.fn>
  rollbackMidi: ReturnType<typeof vi.fn>
  savePluginStates: ReturnType<typeof vi.fn>
  deleteAssets: ReturnType<typeof vi.fn>
}

function projectMock(initialGraph = graph()): ProjectMock {
  let authority = structuredClone(initialGraph)
  const prepared = new Map<
    string,
    { command: ProjectCommand; graph: ProjectGraphSnapshot; baseRevision: number }
  >()
  const mock: ProjectMock = {
    service: null as unknown as ProjectService,
    initialGraph: structuredClone(initialGraph),
    session: {
      id: "project-1",
      path: "project-1.yadaw",
      configuration: {
        name: "Project",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    },
    mixerSnapshot: vi.fn(async () => structuredClone(authority)),
    prepareProjectCommand: vi.fn(
      async (
        operationId: string,
        baseRevision: number,
        command: ProjectCommand,
        _fallbackOutputId: string
      ) => {
        const candidate = applyToGraph(authority, command)
        const token = { id: `token:${operationId}`, operationId, baseRevision }
        prepared.set(token.id, { command, graph: candidate, baseRevision })
        return { token, graph: structuredClone(candidate) }
      }
    ),
    commitProjectCommand: vi.fn(async (token, _command: ProjectCommand) => {
      const candidate = prepared.get(token.id)
      if (!candidate) throw new Error("missing prepared command")
      authority = structuredClone(candidate.graph)
      prepared.delete(token.id)
      return { token, graph: structuredClone(authority) }
    }),
    abortProjectCommand: vi.fn(async (token) => {
      prepared.delete(token.id)
    }),
    projectCommandStatus: vi.fn(async () => ({ state: "absent" as const })),
    importMidi: vi.fn().mockResolvedValue(undefined),
    rollbackMidi: vi.fn().mockResolvedValue(undefined),
    savePluginStates: vi.fn().mockResolvedValue(undefined),
    deleteAssets: vi.fn().mockResolvedValue(undefined)
  }
  mock.service = {
    get current() {
      return mock.session ? structuredClone(mock.session) : null
    },
    mixerSnapshot: mock.mixerSnapshot,
    assetContentHashes: vi.fn().mockResolvedValue([]),
    readAssetAudio: vi.fn().mockResolvedValue(new Uint8Array()),
    activeAssetReader: vi.fn(() => ({
      assetContentHashes: vi.fn().mockResolvedValue([]),
      readAssetAudio: vi.fn().mockResolvedValue(new Uint8Array())
    })),
    prepareProjectCommand: mock.prepareProjectCommand,
    commitProjectCommand: mock.commitProjectCommand,
    abortProjectCommand: mock.abortProjectCommand,
    projectCommandStatus: mock.projectCommandStatus,
    importMidi: mock.importMidi,
    rollbackMidi: mock.rollbackMidi,
    savePluginStates: mock.savePluginStates,
    deleteAssets: mock.deleteAssets
  } as unknown as ProjectService
  return mock
}

const directories: string[] = []

interface ProjectHarness {
  load: ProjectGraphService["load"]
  snapshot: ProjectGraphService["snapshot"]
  savePluginStates: ProjectGraphService["savePluginStates"]
  refreshFromDatabase: ProjectGraphService["refreshFromDatabase"]
  clearProject: ProjectGraphService["clearProject"]
  deleteUnusedAssets: ProjectGraphService["deleteUnusedAssets"]
  execute(command: ProjectCommand): Promise<ProjectCommandResult>
  executeMidiImport(
    source: Parameters<ProjectCommandService["executeMidiImport"]>[1],
    command: ProjectCommand
  ): ReturnType<ProjectCommandService["executeMidiImport"]>
}

async function mixer(
  projects: ProjectMock,
  audioHost?: Partial<AudioHostService>
): Promise<ProjectHarness> {
  const directory = await mkdtemp(join(tmpdir(), "yadaw-mixer-service-"))
  directories.push(directory)
  const initialGraph = structuredClone(projects.initialGraph)
  const host = audioHost
    ? ({
        loadGraph: vi.fn().mockResolvedValue(undefined),
        prepareGraphDeployment: vi.fn(async (meta, projectGraph, graphRevision, project, runtime) =>
          rpcSuccess(meta, {
            meta,
            projectGraph,
            baseRevision: Math.max(0, graphRevision - 1),
            graphRevision,
            project,
            runtime
          })
        ),
        activateGraphDeployment: vi.fn(async (deployment) =>
          rpcSuccess(deployment.meta, { type: "activated", snapshot: {} as never })
        ),
        abortGraphDeployment: vi.fn(async (deployment) =>
          rpcSuccess(deployment.meta, { type: "aborted", snapshot: {} as never })
        ),
        commitDesiredGraph: vi.fn(),
        ...audioHost
      } as AudioHostService)
    : null
  const publisher = new AudioGraphPublisher(
    new AudioGraphCompiler(),
    new AssetMaterializer(directory, projects.service),
    host,
    null,
    null
  )
  const graphs = new ProjectGraphService(projects.service, publisher)
  const commands = new ProjectCommandService(graphs, projects.service, host)
  const lifecycle = new LifecycleCoordinator(projects.session)
  const resources = lifecycle.applicationState.resources
  const projectCandidate = resources.create({
    kind: "project-session",
    id: projects.session!.id,
    parent: lifecycle.applicationState.desktopSession
  })
  if (!projectCandidate.ok) throw new Error("project test resource failed")
  const project = resources.commit(projectCandidate.value.ref, projects.session)
  if (!project.ok) throw new Error("project test commit failed")
  const graphCandidate = resources.create({
    kind: "project-graph",
    id: `${projects.session!.id}:graph`,
    parent: project.value.ref
  })
  if (!graphCandidate.ok) throw new Error("graph test resource failed")
  const graphResource = resources.commit(graphCandidate.value.ref, initialGraph)
  if (!graphResource.ok) throw new Error("graph test commit failed")
  lifecycle.applicationState.setWorkspace({
    project: project.value.ref as never,
    projectGraph: graphResource.value.ref as never,
    revision: graphResource.value.revision,
    session: projects.session!,
    graph: initialGraph,
    assets: []
  })
  const operations = new OperationService(
    new OperationRegistry(),
    lifecycle.applicationState.desktopSession
  )
  commands.attachKernel(lifecycle, operations)
  const execute = async (command: ProjectCommand): Promise<ProjectCommandResult> => {
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) throw new Error("missing workspace")
    const result = await commands.execute(
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: `request:${crypto.randomUUID()}`,
        target: workspace.projectGraph,
        expectedRevision: workspace.revision,
        mutation: {
          operationId: `operation:${crypto.randomUUID()}`,
          idempotencyKey: `idempotency:${crypto.randomUUID()}`
        }
      },
      command
    )
    if (!result.ok) throw new Error(result.error.code)
    return result.value
  }
  return {
    load: graphs.load.bind(graphs),
    snapshot: graphs.snapshot.bind(graphs),
    savePluginStates: graphs.savePluginStates.bind(graphs),
    refreshFromDatabase: graphs.refreshFromDatabase.bind(graphs),
    clearProject: graphs.clearProject.bind(graphs),
    deleteUnusedAssets: graphs.deleteUnusedAssets.bind(graphs),
    execute,
    executeMidiImport: (
      source: Parameters<ProjectCommandService["executeMidiImport"]>[1],
      command: ProjectCommand
    ) => {
      const workspace = lifecycle.applicationState.workspaceSnapshot()
      if (!workspace) throw new Error("missing workspace")
      return commands.executeMidiImport(
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: `midi-import-request:${crypto.randomUUID()}`,
          target: workspace.projectGraph,
          expectedRevision: workspace.revision,
          mutation: {
            operationId: `midi-import-operation:${crypto.randomUUID()}`,
            idempotencyKey: `midi-import-idempotency:${crypto.randomUUID()}`
          }
        },
        source,
        command
      )
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("project graph and command services", () => {
  it("loads once and returns defensive cached snapshots", async () => {
    const projects = projectMock()
    const service = await mixer(projects)

    await service.load()
    const first = await service.snapshot()
    first.channels[0]!.name = "mutated"
    first.plugins[0]!.componentState[0] = 99
    const second = await service.snapshot()

    expect(projects.mixerSnapshot).toHaveBeenCalledTimes(1)
    expect(second.channels[0]!.name).toBe("audio")
    expect(second.plugins[0]!.componentState).toEqual(new Uint8Array([1]))
  })

  it("commits realtime and structural candidates without rebuilding the database graph", async () => {
    const projects = projectMock()
    const loadGraph = vi.fn().mockResolvedValue(undefined)
    const previewMixerParameter = vi.fn().mockResolvedValue(undefined)
    const service = await mixer(projects, {
      loadGraph,
      previewMixerParameter
    })
    await service.load()

    const realtime = await service.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -6 }
    })
    const created = channel("instrument-2", "instrument", 1)
    const structural = await service.execute({
      type: "create-track",
      track: { id: "track:instrument-2", channelId: created.id, sortOrder: 1 },
      channel: created
    })

    expect(realtime.graph.channels.find(({ id }) => id === "audio")?.gainDb).toBe(-6)
    expect(structural.graph.channels).toContainEqual(created)
    expect(projects.mixerSnapshot).toHaveBeenCalledTimes(1)
    expect(projects.prepareProjectCommand).toHaveBeenCalledTimes(2)
    expect(projects.commitProjectCommand).toHaveBeenCalledTimes(2)
    expect(previewMixerParameter).toHaveBeenCalledTimes(1)
    expect(loadGraph).toHaveBeenCalledTimes(1)
  })

  it("keeps the DB commit authoritative when native activation fails", async () => {
    const projects = projectMock()
    const activateGraphDeployment = vi.fn(async (deployment) => ({
      ok: false as const,
      requestId: deployment.meta.requestId,
      operationId: deployment.meta.mutation?.operationId,
      error: {
        code: "dependency-failed" as const,
        category: "dependency-failed" as const,
        outcome: "not-committed" as const,
        retry: "after-reconcile" as const,
        correlationId: "activation-failed",
        userMessageKey: "errors.graphDependencyFailed",
        details: {
          type: "dependency-failed" as const,
          dependency: deployment.projectGraph
        }
      }
    }))
    const service = await mixer(projects, {
      loadGraph: vi.fn().mockResolvedValue(undefined),
      activateGraphDeployment
    })
    await service.load()
    const command: ProjectCommand = {
      type: "create-track",
      track: { id: "track:instrument-2", channelId: "instrument-2", sortOrder: 1 },
      channel: channel("instrument-2", "instrument", 1)
    }

    await expect(service.execute(command)).resolves.toMatchObject({
      graph: { channels: expect.arrayContaining([expect.objectContaining({ id: "instrument-2" })]) }
    })

    expect(projects.commitProjectCommand).toHaveBeenCalledOnce()
    expect((await service.snapshot()).channels.some(({ id }) => id === "instrument-2")).toBe(true)
    expect(projects.mixerSnapshot).toHaveBeenCalledTimes(1)
  })

  it("reports an unknown outcome and retains the cache when the DB commit response fails", async () => {
    const projects = projectMock()
    projects.commitProjectCommand.mockRejectedValueOnce(new Error("database response lost"))
    const loadGraph = vi.fn().mockResolvedValue(undefined)
    const previewMixerParameter = vi.fn().mockResolvedValue(undefined)
    const service = await mixer(projects, {
      loadGraph,
      previewMixerParameter
    })
    await service.load()

    await expect(
      service.execute({
        type: "update-channel",
        channelId: "audio",
        patch: { gainDb: -12 }
      })
    ).rejects.toThrow("operation-timeout-unknown")

    expect((await service.snapshot()).channels.find(({ id }) => id === "audio")?.gainDb).toBe(0)
    expect(previewMixerParameter).not.toHaveBeenCalled()
  })

  it("recovers the committed result by operation ID when the DB response is lost", async () => {
    const projects = projectMock()
    projects.commitProjectCommand.mockRejectedValueOnce(new Error("database response lost"))
    const committedGraph = graph()
    committedGraph.channels[0]!.gainDb = -9
    projects.projectCommandStatus.mockImplementationOnce((operationId: string) => ({
      state: "committed" as const,
      result: {
        token: { id: "committed-token", operationId, baseRevision: 1 },
        graph: committedGraph
      }
    }))
    const service = await mixer(projects, {
      previewMixerParameter: vi.fn().mockResolvedValue(undefined)
    })
    await service.load()

    const result = await service.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -9 }
    })

    expect(result.graph.channels.find(({ id }) => id === "audio")?.gainDb).toBe(-9)
    expect((await service.snapshot()).channels.find(({ id }) => id === "audio")?.gainDb).toBe(-9)
    expect(projects.projectCommandStatus).toHaveBeenCalledOnce()
  })

  it("does not commit MIDI data when native staging fails", async () => {
    const projects = projectMock()
    const service = await mixer(projects, {
      loadGraph: vi.fn().mockResolvedValue(undefined),
      prepareGraphDeployment: vi.fn().mockRejectedValueOnce(new Error("MIDI publication failed"))
    })
    await service.load()
    const command: ProjectCommand = {
      type: "create-midi-clip",
      clip: {
        id: "midi-1",
        sourceId: "source-1",
        trackId: "track:instrument",
        name: "MIDI",
        startTick: 0,
        lengthTicks: 960,
        sourceOffsetTicks: 0,
        sourceLengthTicks: Number.MAX_SAFE_INTEGER,
        notes: [],
        events: []
      }
    }

    await expect(
      service.executeMidiImport(
        {
          id: "source-1",
          name: "MIDI",
          contentHash: "source-hash",
          rawBytes: new Uint8Array([1])
        },
        command
      )
    ).rejects.toThrow("MIDI publication failed")

    expect(projects.importMidi).not.toHaveBeenCalled()
    expect(projects.rollbackMidi).not.toHaveBeenCalled()
    expect((await service.snapshot()).midiClips).toEqual([])
  })

  it("synchronizes plugin states, configuration refreshes, and project invalidation", async () => {
    const projects = projectMock()
    const loadGraph = vi.fn().mockResolvedValue(undefined)
    const service = await mixer(projects, { loadGraph })
    await service.load()

    await service.savePluginStates([
      {
        id: "effect-1",
        componentState: new Uint8Array([3, 4]),
        controllerState: new Uint8Array([5, 6]),
        araDocumentState: new Uint8Array([7, 8])
      }
    ])
    expect((await service.snapshot()).plugins[0]).toMatchObject({
      componentState: new Uint8Array([3, 4]),
      controllerState: new Uint8Array([5, 6]),
      araDocumentState: new Uint8Array([7, 8])
    })

    const refreshed = graph()
    refreshed.sampleRate = 96_000
    projects.mixerSnapshot.mockResolvedValueOnce(refreshed)
    await service.refreshFromDatabase(false)
    expect((await service.snapshot()).sampleRate).toBe(96_000)
    expect(loadGraph).toHaveBeenCalledTimes(1)

    const rejectedRefresh = graph()
    rejectedRefresh.sampleRate = 44_100
    projects.mixerSnapshot.mockResolvedValueOnce(rejectedRefresh)
    loadGraph.mockRejectedValueOnce(new Error("configuration publication failed"))
    await expect(service.refreshFromDatabase(true)).rejects.toThrow(
      "configuration publication failed"
    )
    expect((await service.snapshot()).sampleRate).toBe(96_000)

    projects.session = { ...projects.session!, id: "project-2" }
    await expect(service.snapshot()).rejects.toThrow("Project graph is not loaded")
    projects.mixerSnapshot.mockResolvedValueOnce(graph())
    await service.load()
    await service.clearProject()
    await expect(service.snapshot()).rejects.toThrow("Project graph is not loaded")
  })

  it("deletes only assets that are not referenced by the cached graph", async () => {
    const initial = graph()
    initial.audioClips.push({
      id: "clip-1",
      assetId: "used-asset",
      trackId: "track:audio",
      name: "Clip",
      startFrame: 0,
      sourceOffsetFrames: 0,
      sourceLengthFrames: Number.MAX_SAFE_INTEGER,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      lengthFrames: 100,
      assetSampleRate: 48_000,
      assetChannels: 2
    })
    const projects = projectMock(initial)
    ;(projects.service.assetContentHashes as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ id: "used-asset", contentHash: "hash" }]
    )
    const service = await mixer(projects)
    await service.load()

    await expect(service.deleteUnusedAssets(["used-asset"])).rejects.toThrow(
      "is still used by an audio clip"
    )
    await service.deleteUnusedAssets(["unused-asset"])

    expect(projects.deleteAssets).toHaveBeenCalledOnce()
    expect(projects.deleteAssets).toHaveBeenCalledWith(["unused-asset"])
  })
})
