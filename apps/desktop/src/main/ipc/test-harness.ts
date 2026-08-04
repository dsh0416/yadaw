import type { IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { vi } from "vitest"
import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type {
  ApplicationSettings,
  ProjectGraphSnapshot,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  ResourceRef,
  RpcRequestMeta
} from "@heron/contracts"
import { LifecycleCoordinator } from "../kernel"
import { OperationRegistry } from "../kernel"
import { OperationService } from "../kernel"
import { rendererDirectory } from "../app"
import type { IpcHandlerContext } from "./context"
import type { ElectronMocks } from "./electron-test-mock"

export const projectSession: ProjectSession = {
  id: "project",
  path: "/projects/demo.heron",
  configuration: {
    name: "Demo",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

export const emptyGraph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [],
  channels: [
    {
      id: "master",
      kind: "master",
      systemRole: null,
      name: "Master",
      color: "#8C83FF",
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
    }
  ],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: []
}

export const defaultSettings: ApplicationSettings = {
  swapDirectory: "/swap",
  recordingBitDepth: "float32",
  theme: "system",
  locale: "en-US",
  meterPeakHold: "2s",
  meterReturnRate: "iec-type-i",
  midiCenterCStandard: "roland-c4",
  softwareMonitoringEnabled: false,
  audioHostRuntime: {
    workerThreads: "auto",
    maxBlockingThreads: "auto",
    egressConcurrency: "auto"
  },
  shortcuts: { keyboard: {}, midi: {} },
  midiSync: {
    enabled: false,
    sourcePortId: null,
    sourcePortName: null,
    inputOffsetsMs: {}
  },
  pluginEditors: {},
  recentProjects: []
}

export function ref<Kind extends ResourceRef["kind"]>(
  kind: Kind,
  id: string,
  epoch = "epoch-1",
  generation = 1
): ResourceRef<Kind> {
  return { kind, id, epoch, generation }
}

export function meta(overrides: Partial<RpcRequestMeta> = {}): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "request-1",
    ...overrides
  }
}

export function mutationMeta(
  target: ResourceRef,
  overrides: Partial<RpcRequestMeta> = {}
): RpcRequestMeta {
  return meta({
    target,
    expectedRevision: 1,
    mutation: { operationId: "op-1", idempotencyKey: "idem-1" },
    ...overrides
  })
}

export function registeredHandler(mocks: ElectronMocks, channel: string) {
  const call = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!call) throw new Error(`Handler for ${channel} was not registered`)
  return call[1] as (
    event: IpcMainInvokeEvent,
    meta: unknown,
    ...args: unknown[]
  ) => Promise<unknown>
}

export function trustedEvent(): IpcMainInvokeEvent {
  const rendererUrl = pathToFileURL(join(rendererDirectory, "index.html")).href
  return {
    senderFrame: { url: rendererUrl },
    sender: {
      undo: vi.fn(),
      redo: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn()
    }
  } as unknown as IpcMainInvokeEvent
}

export async function invoke(
  mocks: ElectronMocks,
  channel: string,
  requestMeta: RpcRequestMeta,
  ...args: unknown[]
): Promise<unknown> {
  return registeredHandler(mocks, channel)(trustedEvent(), requestMeta, ...args)
}

export function createWorkspace(
  overrides: Partial<ProjectWorkspaceSnapshot> = {}
): ProjectWorkspaceSnapshot {
  const project = ref("project-session", "project")
  const projectGraph = ref("project-graph", "project:graph")
  return {
    project,
    projectGraph,
    revision: 1,
    session: projectSession,
    graph: emptyGraph,
    assets: [],
    ...overrides
  }
}

export function createContext(
  customize?: (context: IpcHandlerContext, lifecycle: LifecycleCoordinator) => void
): IpcHandlerContext {
  const registry = new OperationRegistry()
  const lifecycle = new LifecycleCoordinator(projectSession)
  const desktopSession = lifecycle.applicationState.desktopSession
  const operations = new OperationService(registry, desktopSession)
  const context = {
    settings: {
      get: vi.fn(async () => structuredClone(defaultSettings)),
      update: vi.fn(async (patch: Partial<ApplicationSettings>) => ({
        ...defaultSettings,
        ...patch
      })),
      setSoftwareMonitoringEnabled: vi.fn(async (value: boolean) => ({
        ...defaultSettings,
        softwareMonitoringEnabled: value
      })),
      configureAudioHostRuntime: vi.fn(async (preferences: unknown) => ({
        ...defaultSettings,
        audioHostRuntime: preferences
      })),
      configureShortcuts: vi.fn(async (shortcuts: unknown) => ({
        ...defaultSettings,
        shortcuts
      })),
      configureMidiInput: vi.fn(async (midiSync: unknown) => ({
        ...defaultSettings,
        midiSync
      }))
    },
    projects: {
      current: projectSession,
      listAssets: vi.fn(async () => []),
      hasRecoverableWorkingCopy: vi.fn(async () => false),
      save: vi.fn(async () => projectSession),
      updateConfiguration: vi.fn(async (configuration: ProjectSession["configuration"]) => ({
        ...projectSession,
        configuration,
        dirty: true
      })),
      cleanupCommittedForProject: vi.fn()
    },
    recordings: {
      current: null,
      start: vi.fn(),
      stop: vi.fn(),
      abortStart: vi.fn(async () => undefined),
      listPending: vi.fn(async () => []),
      recover: vi.fn(),
      deletePending: vi.fn(async () => undefined),
      waveformSnapshot: vi.fn(),
      cleanupCommittedForProject: vi.fn(async () => undefined)
    },
    operations,
    waveforms: {},
    projectGraph: {
      snapshot: vi.fn(async () => emptyGraph),
      load: vi.fn(async () => emptyGraph),
      refreshFromDatabase: vi.fn(async () => undefined),
      setSoftwareMonitoringEnabled: vi.fn(async () => undefined)
    },
    projectCommands: {
      execute: vi.fn(async () => ({ ok: true }))
    },
    mixerRuntime: {
      preview: vi.fn(async () => undefined),
      runtimeSnapshot: vi.fn(async () => ({ meters: [], capturedAt: 1 })),
      clearMeterClips: vi.fn(async () => undefined)
    },
    transport: {
      command: vi.fn(async () => ({
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: 48_000
      })),
      snapshot: vi.fn(async () => ({
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: 48_000
      }))
    },
    plugins: {
      list: vi.fn(() => []),
      scan: vi.fn(async () => ({ plugins: [], scannedAt: 1 })),
      openEditor: vi.fn(async () => ({ editorMode: "native" as const, open: true })),
      closeEditor: vi.fn(async () => undefined),
      parameters: vi.fn(async () => [])
    },
    midiImport: {
      prepare: vi.fn(async () => ({ token: "token", tracks: [] })),
      commit: vi.fn(async () => ({
        workspace: createWorkspace({ revision: 2 })
      }))
    },
    lifecycle,
    audioHost: {
      helperEpoch: vi.fn(() => lifecycle.applicationState.audioHost.epoch),
      configurationRestarting: false,
      listAudioBackends: vi.fn(async () => ["mock"]),
      listAudioDevices: vi.fn(async () => ({ inputs: [], outputs: [] })),
      startAudioEngine: vi.fn(),
      stopAudioEngine: vi.fn(),
      audioEngineSnapshot: vi.fn(),
      restoreAudioEngine: vi.fn(),
      startRoundTripLatencyMeasurement: vi.fn(async () => ({ started: true })),
      roundTripLatencyMeasurementSnapshot: vi.fn(async () => ({ state: "idle" })),
      midiInputSnapshot: vi.fn(async () => ({
        capturedAt: 1,
        ports: [],
        sync: {
          state: "idle" as const,
          sourcePortId: null,
          sourcePortName: null,
          effectiveBpm: null,
          jitterMicroseconds: null,
          lastClockAgeMs: null,
          droppedEvents: 0,
          ignoredSystemMessages: 0,
          error: null
        },
        controlEvents: []
      })),
      configureMidiInput: vi.fn(async () => undefined),
      pluginEditorAppearanceSnapshot: vi.fn(() => ({ theme: "dark", locale: "en-US" })),
      configurePluginEditorAppearance: vi.fn(async () => undefined),
      setMidiControlLearning: vi.fn(async () => undefined),
      configureRuntime: vi.fn(async () => undefined),
      enqueuePluginParameter: vi.fn(async (command: unknown) => command)
    },
    isShuttingDown: vi.fn(() => false),
    projectLifecycle: {
      bootstrap: vi.fn(() => ({ ok: true, value: {} })),
      create: vi.fn(async () => ({ ok: true, value: createWorkspace() })),
      open: vi.fn(async () => ({ ok: true, value: createWorkspace() })),
      close: vi.fn(async () => ({ ok: true, value: { closed: true } })),
      validateDesktopRead: vi.fn(() => null)
    },
    synchronizePluginStates: vi.fn(async () => undefined),
    sampleSystemPerformance: vi.fn(async () => ({ capturedAt: 1 }))
  } as unknown as IpcHandlerContext

  customize?.(context, lifecycle)
  return context
}

export function installWorkspace(
  lifecycle: LifecycleCoordinator,
  workspace: ProjectWorkspaceSnapshot = createWorkspace()
): ProjectWorkspaceSnapshot {
  const projectCandidate = lifecycle.applicationState.resources.create({
    kind: "project-session",
    id: workspace.project.id,
    epoch: workspace.project.epoch
  })
  if (!projectCandidate.ok) throw new Error(projectCandidate.error.code)
  const project = lifecycle.applicationState.resources.commit(projectCandidate.value.ref, {
    session: workspace.session
  })
  if (!project.ok) throw new Error(project.error.code)
  const graphCandidate = lifecycle.applicationState.resources.create({
    kind: "project-graph",
    id: workspace.projectGraph.id,
    epoch: workspace.projectGraph.epoch,
    parent: project.value.ref
  })
  if (!graphCandidate.ok) throw new Error(graphCandidate.error.code)
  const graph = lifecycle.applicationState.resources.commit(graphCandidate.value.ref, {
    graph: workspace.graph
  })
  if (!graph.ok) throw new Error(graph.error.code)
  const installed: ProjectWorkspaceSnapshot = {
    ...workspace,
    project: project.value.ref as ProjectWorkspaceSnapshot["project"],
    projectGraph: graph.value.ref as ProjectWorkspaceSnapshot["projectGraph"],
    revision: graph.value.revision
  }
  lifecycle.applicationState.setWorkspace(installed)
  return installed
}
