import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type {
  ApplicationSettingsPatch,
  AudioBackend,
  AudioPreferences,
  CreateProjectRequest,
  ProcessGainRequest,
  ProjectCloseDisposition,
  ProjectQueryRequest,
  ProjectTransactionRequest,
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
  systemPerformanceSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.systemPerformanceSnapshot),
  createProject: (request: CreateProjectRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectCreate, request),
  openProject: (path?: string) => ipcRenderer.invoke(IPC_CHANNELS.projectOpen, path),
  saveProject: (path?: string) => ipcRenderer.invoke(IPC_CHANNELS.projectSave, path),
  closeProject: (disposition?: ProjectCloseDisposition) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectClose, disposition),
  projectQuery: (request: ProjectQueryRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectQuery, request),
  projectTransaction: (request: ProjectTransactionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectTransaction, request),
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
  subscribeOperations: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, operation: Parameters<typeof listener>[0]) => listener(operation)
    ipcRenderer.on(IPC_CHANNELS.operationEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.operationEvent, handler)
  },
  cancelOperation: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.operationCancel, id)
}

contextBridge.exposeInMainWorld("yadaw", api)
