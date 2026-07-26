import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type {
  ApplicationSettingsPatch,
  AudioBackend,
  AudioPreferences,
  CreateProjectRequest,
  ProcessGainRequest,
  ProjectCloseDisposition,
  ProjectConfiguration,
  WaveformWindowRequest,
  YadawDesktopApi
} from "@yadaw/contracts"

const api: YadawDesktopApi = {
  engineInfo: () => ipcRenderer.invoke(IPC_CHANNELS.engineInfo),
  processGain: (request: ProcessGainRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.processGain, request),
  listAudioBackends: () => ipcRenderer.invoke(IPC_CHANNELS.audioBackends),
  listAudioDevices: (backend: AudioBackend) =>
    ipcRenderer.invoke(IPC_CHANNELS.audioDevices, backend),
  startAudioEngine: (preferences: AudioPreferences) =>
    ipcRenderer.invoke(IPC_CHANNELS.audioStart, preferences),
  stopAudioEngine: () => ipcRenderer.invoke(IPC_CHANNELS.audioStop),
  audioEngineSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.audioSnapshot),
  loadMixerGraph: () => ipcRenderer.invoke(IPC_CHANNELS.mixerLoad),
  executeProjectCommand: (command) => ipcRenderer.invoke(IPC_CHANNELS.mixerExecute, command),
  previewMixerParameter: (preview) => ipcRenderer.invoke(IPC_CHANNELS.mixerPreview, preview),
  mixerSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.mixerSnapshot),
  clearMixerMeterClips: () => ipcRenderer.invoke(IPC_CHANNELS.mixerClearMeterClips),
  transportCommand: (command) => ipcRenderer.invoke(IPC_CHANNELS.transportCommand, command),
  transportSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.transportSnapshot),
  lifecycleSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.lifecycleSnapshot),
  subscribeLifecycle: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      lifecycleEvent: Parameters<typeof listener>[0]
    ) => listener(lifecycleEvent)
    ipcRenderer.on(IPC_CHANNELS.lifecycleEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.lifecycleEvent, handler)
  },
  systemPerformanceSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.systemPerformanceSnapshot),
  runAudioBenchmark: () => ipcRenderer.invoke(IPC_CHANNELS.audioBenchmarkRun),
  subscribeAudioBenchmarkRequests: (listener) => {
    const handler = () => listener()
    ipcRenderer.on(IPC_CHANNELS.audioBenchmarkMenuOpen, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.audioBenchmarkMenuOpen, handler)
  },
  createProject: (request: CreateProjectRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectCreate, request),
  prepareOpenProject: (path?: string) => ipcRenderer.invoke(IPC_CHANNELS.projectPrepareOpen, path),
  openProject: (path: string, recover?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectOpen, path, recover),
  saveProject: (path?: string) => ipcRenderer.invoke(IPC_CHANNELS.projectSave, path),
  closeProject: (disposition?: ProjectCloseDisposition) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectClose, disposition),
  listProjectAssets: () => ipcRenderer.invoke(IPC_CHANNELS.projectAssetsList),
  updateProjectConfiguration: (configuration: ProjectConfiguration) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectConfigurationUpdate, configuration),
  getApplicationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateApplicationSettings: (patch: ApplicationSettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  chooseSwapDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsChooseSwap),
  openSwapDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.settingsOpenSwap),
  startRecording: () => ipcRenderer.invoke(IPC_CHANNELS.recordingStart),
  stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.recordingStop),
  listPendingRecordings: () => ipcRenderer.invoke(IPC_CHANNELS.recordingPendingList),
  recoverRecording: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.recordingRecover, id),
  deletePendingRecording: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.recordingDeletePending, id),
  readAssetAudio: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.assetAudioRead, id),
  readAssetWaveform: (request: WaveformWindowRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.assetWaveformRead, request),
  recordingWaveformSnapshot: (request: WaveformWindowRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.recordingWaveformSnapshot, request),
  listPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.pluginsList),
  scanPlugins: (request) => ipcRenderer.invoke(IPC_CHANNELS.pluginsScan, request),
  subscribePluginScan: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      scanEvent: Parameters<typeof listener>[0]
    ) => listener(scanEvent)
    ipcRenderer.on(IPC_CHANNELS.pluginsScanEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pluginsScanEvent, handler)
  },
  openPluginEditor: (instanceId) => ipcRenderer.invoke(IPC_CHANNELS.pluginEditorOpen, instanceId),
  closePluginEditor: (instanceId) => ipcRenderer.invoke(IPC_CHANNELS.pluginEditorClose, instanceId),
  getPluginParameters: (instanceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.pluginParametersGet, instanceId),
  setPluginParameter: (request) => ipcRenderer.invoke(IPC_CHANNELS.pluginParameterSet, request),
  prepareMidiImport: (path) => ipcRenderer.invoke(IPC_CHANNELS.midiImportPrepare, path),
  commitMidiImport: (plan) => ipcRenderer.invoke(IPC_CHANNELS.midiImportCommit, plan),
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
