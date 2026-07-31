import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
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
  YadawDesktopApi
} from "@yadaw/contracts"
import { invokeRpc } from "./rpc"

const api: YadawDesktopApi = {
  platform: process.platform as YadawDesktopApi["platform"],
  bootstrap: (meta) => invokeRpc(IPC_CHANNELS.bootstrap, meta),
  engineInfo: () => ipcRenderer.invoke(IPC_CHANNELS.engineInfo),
  processGain: (request: ProcessGainRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.processGain, request),
  listAudioBackends: () => ipcRenderer.invoke(IPC_CHANNELS.audioBackends),
  listAudioDevices: (backend: AudioBackend) =>
    ipcRenderer.invoke(IPC_CHANNELS.audioDevices, backend),
  startAudioEngine: (meta, preferences: AudioPreferences) =>
    invokeRpc(IPC_CHANNELS.audioStart, meta, preferences),
  stopAudioEngine: (meta) => invokeRpc(IPC_CHANNELS.audioStop, meta),
  audioEngineSnapshot: (meta) => invokeRpc(IPC_CHANNELS.audioSnapshot, meta),
  startRoundTripLatencyMeasurement: (request: RoundTripLatencyMeasurementRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.audioRoundTripLatencyStart, request),
  roundTripLatencyMeasurementSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.audioRoundTripLatencySnapshot),
  loadProjectGraph: (meta) => invokeRpc(IPC_CHANNELS.projectGraphLoad, meta),
  reloadProjectGraph: (meta) => invokeRpc(IPC_CHANNELS.projectGraphReload, meta),
  executeProjectCommand: (meta, command) =>
    invokeRpc(IPC_CHANNELS.projectCommandExecute, meta, command),
  previewMixerParameter: (preview) => ipcRenderer.invoke(IPC_CHANNELS.mixerPreview, preview),
  mixerSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.mixerSnapshot),
  clearMixerMeterClips: () => ipcRenderer.invoke(IPC_CHANNELS.mixerClearMeterClips),
  transportCommand: (meta, command) => invokeRpc(IPC_CHANNELS.transportCommand, meta, command),
  transportSnapshot: (meta) => invokeRpc(IPC_CHANNELS.transportSnapshot, meta),
  lifecycleSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.lifecycleSnapshot),
  subscribeLifecycle: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      lifecycleEvent: Parameters<typeof listener>[0]
    ) => listener(lifecycleEvent)
    ipcRenderer.on(IPC_CHANNELS.lifecycleEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.lifecycleEvent, handler)
  },
  startupProgressSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.startupProgressSnapshot),
  subscribeStartupProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.startupProgressEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.startupProgressEvent, handler)
  },
  systemPerformanceSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.systemPerformanceSnapshot),
  runAudioBenchmark: () => ipcRenderer.invoke(IPC_CHANNELS.audioBenchmarkRun),
  compiledAudioGraphSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.compiledAudioGraphSnapshot),
  subscribeApplicationCommands: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: Parameters<typeof listener>[0]) =>
      listener(command)
    ipcRenderer.on(IPC_CHANNELS.applicationCommandRequested, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.applicationCommandRequested, handler)
  },
  executeApplicationWindowCommand: (command: ApplicationWindowCommandId) =>
    ipcRenderer.invoke(IPC_CHANNELS.applicationWindowCommand, command),
  setApplicationWindowTheme: (theme) =>
    ipcRenderer.invoke(IPC_CHANNELS.applicationWindowTheme, theme),
  createProject: (meta, request: CreateProjectRequest) =>
    invokeRpc(IPC_CHANNELS.projectCreate, meta, request),
  prepareOpenProject: (meta, path?: string) =>
    invokeRpc(IPC_CHANNELS.projectPrepareOpen, meta, path),
  openProject: (meta, path: string, recover?: boolean) =>
    invokeRpc(IPC_CHANNELS.projectOpen, meta, path, recover),
  saveProject: (meta, path?: string) => invokeRpc(IPC_CHANNELS.projectSave, meta, path),
  closeProject: (meta, disposition?: ProjectCloseDisposition) =>
    invokeRpc(IPC_CHANNELS.projectClose, meta, disposition),
  listProjectAssets: () => ipcRenderer.invoke(IPC_CHANNELS.projectAssetsList),
  updateProjectConfiguration: (configuration: ProjectConfiguration) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectConfigurationUpdate, configuration),
  getApplicationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateApplicationSettings: (patch: ApplicationSettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  setSoftwareMonitoringEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSetSoftwareMonitoring, enabled),
  configureAudioHostRuntime: (preferences: AudioHostRuntimePreferences) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsConfigureAudioHostRuntime, preferences),
  configureShortcuts: (preferences: ShortcutPreferences) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsConfigureShortcuts, preferences),
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
  chooseSwapDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsChooseSwap),
  openSwapDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsOpenSwap),
  startRecording: (meta, request) => invokeRpc(IPC_CHANNELS.recordingStart, meta, request),
  stopRecording: (meta) => invokeRpc(IPC_CHANNELS.recordingStop, meta),
  listPendingRecordings: (meta) => invokeRpc(IPC_CHANNELS.recordingPendingList, meta),
  recoverRecording: (meta, id: string) => invokeRpc(IPC_CHANNELS.recordingRecover, meta, id),
  deletePendingRecording: (meta, id: string) =>
    invokeRpc(IPC_CHANNELS.recordingDeletePending, meta, id),
  readAssetAudio: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.assetAudioRead, id),
  readAssetWaveform: (request: WaveformWindowRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.assetWaveformRead, request),
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
  cancelOperation: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.operationCancel, id)
}

contextBridge.exposeInMainWorld("yadaw", api)
