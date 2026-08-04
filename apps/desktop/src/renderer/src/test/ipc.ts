import { INITIAL_AUDIO_RUNTIME_SNAPSHOT, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type {
  ApplicationBootstrapSnapshot,
  ApplicationSettings,
  ApplicationSettingsResourceSnapshot,
  RpcError,
  RpcEvent,
  RpcResult
} from "@heron/contracts"

export const TEST_MAIN_EPOCH = "test-main-epoch"

export const TEST_DESKTOP_REF = {
  kind: "desktop-session",
  id: "desktop-session",
  epoch: TEST_MAIN_EPOCH,
  generation: 1
} as const

export const TEST_SETTINGS_REF = {
  kind: "application-settings",
  id: "application-settings",
  epoch: TEST_MAIN_EPOCH,
  generation: 1
} as const

export const TEST_OFFLINE_WORKER_REF = {
  kind: "offline-worker",
  id: "offline-worker",
  epoch: "test-offline-epoch",
  generation: 1
} as const

export const TEST_AUDIO_HOST_REF = {
  kind: "audio-host",
  id: "audio-host",
  epoch: "test-audio-epoch",
  generation: 1
} as const

export const TEST_MIDI_RUNTIME_REF = {
  kind: "midi-runtime",
  id: "midi-runtime",
  epoch: "test-audio-epoch",
  generation: 1
} as const

export function rpcSuccess<T>(value: T, resourceRevision = 1): RpcResult<T> {
  return {
    ok: true,
    requestId: "test-request",
    resourceRevision,
    value,
    warnings: []
  }
}

export function rpcFailure(
  userMessageKey: string,
  overrides: Partial<RpcError> = {}
): RpcResult<never> {
  return {
    ok: false,
    requestId: "test-request",
    error: {
      code: "resource-unavailable",
      category: "unavailable",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "test-correlation",
      userMessageKey,
      details: {
        type: "resource-unavailable",
        component: "main",
        dispatched: true
      },
      ...overrides
    } as RpcError
  }
}

export function rpcEvent<T>(payload: T, sequence = 1, sourceEpoch = TEST_MAIN_EPOCH): RpcEvent<T> {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    sourceEpoch,
    sequence,
    resourceRevision: sequence,
    payload
  }
}

export function testSettings(overrides: Partial<ApplicationSettings> = {}): ApplicationSettings {
  return {
    swapDirectory: "/swap",
    recordingBitDepth: "pcm24",
    theme: "system",
    locale: "en-US",
    meterPeakHold: "800ms",
    meterReturnRate: "iec-type-i",
    midiCenterCStandard: "yamaha-c3",
    softwareMonitoringEnabled: false,
    midiSync: { enabled: false, sourcePortId: null, sourcePortName: null, inputOffsetsMs: {} },
    audioHostRuntime: {
      workerThreads: "auto",
      maxBlockingThreads: "auto"
    },
    pluginEditors: {},
    shortcuts: { keyboard: {}, midi: {} },
    recentProjects: [],
    ...overrides
  }
}

export function settingsSnapshot(
  value: ApplicationSettings = testSettings(),
  revision = 1
): ApplicationSettingsResourceSnapshot {
  return {
    settings: TEST_SETTINGS_REF,
    revision,
    value
  }
}

export function testBootstrap(
  overrides: Partial<ApplicationBootstrapSnapshot> = {}
): ApplicationBootstrapSnapshot {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    mainEpoch: TEST_MAIN_EPOCH,
    desktopSession: TEST_DESKTOP_REF,
    applicationSettings: TEST_SETTINGS_REF,
    revision: 1,
    offlineTools: { worker: TEST_OFFLINE_WORKER_REF, revision: 0 },
    lifecycle: {
      revision: 1,
      project: { status: "closed", error: null },
      audio: { status: "stopped", runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT }, error: null },
      recording: { status: "idle", error: null }
    },
    audioResources: {
      host: TEST_AUDIO_HOST_REF,
      engine: null,
      transport: null,
      midiRuntime: TEST_MIDI_RUNTIME_REF,
      revision: 0
    },
    recordingResource: null,
    settings: settingsSnapshot(),
    workspace: null,
    ...overrides
  }
}
