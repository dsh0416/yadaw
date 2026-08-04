import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@heron/contracts"
import type {
  ApplicationWindowCommandId,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences,
  AudioBackend,
  AudioPreferences,
  RoundTripLatencyMeasurementRequest,
  CreateProjectRequest,
  ProcessGainRequest,
  ProjectCloseDisposition,
  ProjectConfiguration,
  ShortcutPreferences,
  WaveformWindowRequest,
  HeronDesktopApi,
  HeronSplashApi
} from "@heron/contracts"
import { invokeRpc } from "./rpc"
import { classifyRendererEntrypoint } from "../shared/renderer-security"

const api: HeronDesktopApi = {
  platform: process.platform as HeronDesktopApi["platform"],
  bootstrap: (meta) => invokeRpc(IPC_CHANNELS.bootstrap, meta),
  engineInfo: (meta) => invokeRpc(IPC_CHANNELS.engineInfo, meta),
  processGain: (meta, request: ProcessGainRequest) =>
    invokeRpc(IPC_CHANNELS.processGain, meta, request),
  listAudioBackends: (meta) => invokeRpc(IPC_CHANNELS.audioBackends, meta),
  listAudioDevices: (meta, backend: AudioBackend) =>
    invokeRpc(IPC_CHANNELS.audioDevices, meta, backend),
  startAudioEngine: (meta, preferences: AudioPreferences) =>
    invokeRpc(IPC_CHANNELS.audioStart, meta, preferences),
  stopAudioEngine: (meta) => invokeRpc(IPC_CHANNELS.audioStop, meta),
  audioEngineSnapshot: (meta) => invokeRpc(IPC_CHANNELS.audioSnapshot, meta),
  startRoundTripLatencyMeasurement: (meta, request: RoundTripLatencyMeasurementRequest) =>
    invokeRpc(IPC_CHANNELS.audioRoundTripLatencyStart, meta, request),
  roundTripLatencyMeasurementSnapshot: (meta) =>
    invokeRpc(IPC_CHANNELS.audioRoundTripLatencySnapshot, meta),
  loadProjectGraph: (meta) => invokeRpc(IPC_CHANNELS.projectGraphLoad, meta),
  reloadProjectGraph: (meta) => invokeRpc(IPC_CHANNELS.projectGraphReload, meta),
  executeProjectCommand: (meta, command) =>
    invokeRpc(IPC_CHANNELS.projectCommandExecute, meta, command),
  subscribeExternalProjectCommands: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: Parameters<typeof listener>[0]) =>
      listener(command)
    ipcRenderer.on(IPC_CHANNELS.projectCommandExternalEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectCommandExternalEvent, handler)
  },
  previewMixerParameter: (meta, preview) => invokeRpc(IPC_CHANNELS.mixerPreview, meta, preview),
  mixerSnapshot: (meta) => invokeRpc(IPC_CHANNELS.mixerSnapshot, meta),
  clearMixerMeterClips: (meta) => invokeRpc(IPC_CHANNELS.mixerClearMeterClips, meta),
  transportCommand: (meta, command) => invokeRpc(IPC_CHANNELS.transportCommand, meta, command),
  transportSnapshot: (meta) => invokeRpc(IPC_CHANNELS.transportSnapshot, meta),
  lifecycleSnapshot: (meta) => invokeRpc(IPC_CHANNELS.lifecycleSnapshot, meta),
  subscribeLifecycle: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      lifecycleEvent: Parameters<typeof listener>[0]
    ) => listener(lifecycleEvent)
    ipcRenderer.on(IPC_CHANNELS.lifecycleEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.lifecycleEvent, handler)
  },
  systemPerformanceSnapshot: (meta) => invokeRpc(IPC_CHANNELS.systemPerformanceSnapshot, meta),
  runAudioBenchmark: (meta) => invokeRpc(IPC_CHANNELS.audioBenchmarkRun, meta),
  compiledAudioGraphSnapshot: (meta) => invokeRpc(IPC_CHANNELS.compiledAudioGraphSnapshot, meta),
  lowLatencyModeSnapshot: (meta) => invokeRpc(IPC_CHANNELS.lowLatencyModeSnapshot, meta),
  configureLowLatencyMode: (meta, configuration) =>
    invokeRpc(IPC_CHANNELS.lowLatencyModeConfigure, meta, configuration),
  subscribeApplicationCommands: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: Parameters<typeof listener>[0]) =>
      listener(command)
    ipcRenderer.on(IPC_CHANNELS.applicationCommandRequested, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.applicationCommandRequested, handler)
  },
  executeApplicationWindowCommand: (meta, command: ApplicationWindowCommandId) =>
    invokeRpc(IPC_CHANNELS.applicationWindowCommand, meta, command),
  setApplicationWindowTheme: (meta, theme) =>
    invokeRpc(IPC_CHANNELS.applicationWindowTheme, meta, theme),
  createProject: (meta, request: CreateProjectRequest) =>
    invokeRpc(IPC_CHANNELS.projectCreate, meta, request),
  prepareOpenProject: (meta, path?: string) =>
    invokeRpc(IPC_CHANNELS.projectPrepareOpen, meta, path),
  openProject: (meta, path: string, recover?: boolean) =>
    invokeRpc(IPC_CHANNELS.projectOpen, meta, path, recover),
  saveProject: (meta, path?: string) => invokeRpc(IPC_CHANNELS.projectSave, meta, path),
  closeProject: (meta, disposition?: ProjectCloseDisposition) =>
    invokeRpc(IPC_CHANNELS.projectClose, meta, disposition),
  listProjectAssets: (meta) => invokeRpc(IPC_CHANNELS.projectAssetsList, meta),
  updateProjectConfiguration: (meta, configuration: ProjectConfiguration) =>
    invokeRpc(IPC_CHANNELS.projectConfigurationUpdate, meta, configuration),
  getApplicationSettings: (meta) => invokeRpc(IPC_CHANNELS.settingsGet, meta),
  updateApplicationSettings: (meta, patch: ApplicationSettingsPatch) =>
    invokeRpc(IPC_CHANNELS.settingsUpdate, meta, patch),
  setSoftwareMonitoringEnabled: (meta, enabled: boolean) =>
    invokeRpc(IPC_CHANNELS.settingsSetSoftwareMonitoring, meta, enabled),
  configureAudioHostRuntime: (meta, preferences: AudioHostRuntimePreferences) =>
    invokeRpc(IPC_CHANNELS.settingsConfigureAudioHostRuntime, meta, preferences),
  configureShortcuts: (meta, preferences: ShortcutPreferences) =>
    invokeRpc(IPC_CHANNELS.settingsConfigureShortcuts, meta, preferences),
  midiInputSnapshot: (meta) => invokeRpc(IPC_CHANNELS.midiInputSnapshot, meta),
  subscribeMidiInput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) =>
      listener(snapshot)
    ipcRenderer.on(IPC_CHANNELS.midiInputEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.midiInputEvent, handler)
  },
  configureMidiInput: (meta, preferences) =>
    invokeRpc(IPC_CHANNELS.midiInputConfigure, meta, preferences),
  setMidiControlLearning: (meta, enabled) =>
    invokeRpc(IPC_CHANNELS.midiControlLearning, meta, enabled),
  chooseSwapDirectory: (meta) => invokeRpc(IPC_CHANNELS.settingsChooseSwap, meta),
  openSwapDirectory: (meta) => invokeRpc(IPC_CHANNELS.settingsOpenSwap, meta),
  startRecording: (meta, request) => invokeRpc(IPC_CHANNELS.recordingStart, meta, request),
  stopRecording: (meta) => invokeRpc(IPC_CHANNELS.recordingStop, meta),
  listPendingRecordings: (meta) => invokeRpc(IPC_CHANNELS.recordingPendingList, meta),
  recoverRecording: (meta, id: string) => invokeRpc(IPC_CHANNELS.recordingRecover, meta, id),
  deletePendingRecording: (meta, id: string) =>
    invokeRpc(IPC_CHANNELS.recordingDeletePending, meta, id),
  readAssetAudio: (meta, id: string) => invokeRpc(IPC_CHANNELS.assetAudioRead, meta, id),
  readAssetWaveform: (meta, request: WaveformWindowRequest) =>
    invokeRpc(IPC_CHANNELS.assetWaveformRead, meta, request),
  recordingWaveformSnapshot: (meta, request: WaveformWindowRequest) =>
    invokeRpc(IPC_CHANNELS.recordingWaveformSnapshot, meta, request),
  listPlugins: (meta) => invokeRpc(IPC_CHANNELS.pluginsList, meta),
  scanPlugins: (meta, request) => invokeRpc(IPC_CHANNELS.pluginsScan, meta, request),
  subscribePluginScan: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      scanEvent: Parameters<typeof listener>[0]
    ) => listener(scanEvent)
    ipcRenderer.on(IPC_CHANNELS.pluginsScanEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pluginsScanEvent, handler)
  },
  openPluginEditor: (meta, instanceId) =>
    invokeRpc(IPC_CHANNELS.pluginEditorOpen, meta, instanceId),
  closePluginEditor: (meta) => invokeRpc(IPC_CHANNELS.pluginEditorClose, meta),
  subscribePluginEditorClosed: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      closedEvent: Parameters<typeof listener>[0]
    ) => listener(closedEvent)
    ipcRenderer.on(IPC_CHANNELS.pluginEditorClosedEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pluginEditorClosedEvent, handler)
  },
  subscribeAraCallbacks: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      callbackEvent: Parameters<typeof listener>[0]
    ) => listener(callbackEvent)
    ipcRenderer.on(IPC_CHANNELS.araCallbackEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.araCallbackEvent, handler)
  },
  getPluginParameters: (meta) => invokeRpc(IPC_CHANNELS.pluginParametersGet, meta),
  setPluginParameter: (meta, request) => invokeRpc(IPC_CHANNELS.pluginParameterSet, meta, request),
  prepareMidiImport: (meta, path) => invokeRpc(IPC_CHANNELS.midiImportPrepare, meta, path),
  commitMidiImport: (meta, plan) => invokeRpc(IPC_CHANNELS.midiImportCommit, meta, plan),
  subscribeOperations: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      operation: Parameters<typeof listener>[0]
    ) => listener(operation)
    ipcRenderer.on(IPC_CHANNELS.operationEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.operationEvent, handler)
  },
  operationStatus: (meta, id) => invokeRpc(IPC_CHANNELS.operationStatus, meta, id),
  cancelOperation: (meta, id) => invokeRpc(IPC_CHANNELS.operationCancel, meta, id),
  acknowledgeOperation: (meta, id) => invokeRpc(IPC_CHANNELS.operationAcknowledge, meta, id)
}

const splashApi: HeronSplashApi = {
  subscribeStartupProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.startupProgressEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.startupProgressEvent, handler)
  }
}

const entrypoint = classifyRendererEntrypoint(globalThis.location.href)
if (entrypoint === "splash") {
  contextBridge.exposeInMainWorld("heronSplash", splashApi)
} else if (entrypoint === "main") {
  contextBridge.exposeInMainWorld("heron", api)
}
