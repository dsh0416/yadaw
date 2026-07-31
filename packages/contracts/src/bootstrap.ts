import type { AudioResourceSnapshot, DesktopLifecycleSnapshot } from "./audio"
import type { OfflineToolsResourceSnapshot } from "./application"
import type { ProjectWorkspaceSnapshot } from "./project"
import type { RecordingResourceSnapshot } from "./recording"
import type { ApplicationSettingsRef, DesktopSessionRef } from "./rpc"
import type { ApplicationSettingsResourceSnapshot } from "./settings"
import { IPC_PROTOCOL_VERSION } from "./rpc"

export interface ApplicationBootstrapSnapshot {
  protocolVersion: typeof IPC_PROTOCOL_VERSION
  mainEpoch: string
  desktopSession: DesktopSessionRef
  applicationSettings: ApplicationSettingsRef
  revision: number
  offlineTools: OfflineToolsResourceSnapshot
  lifecycle: DesktopLifecycleSnapshot
  audioResources: AudioResourceSnapshot
  recordingResource: RecordingResourceSnapshot | null
  settings: ApplicationSettingsResourceSnapshot
  workspace: ProjectWorkspaceSnapshot | null
}

export interface ProjectCloseResult {
  closed: boolean
  snapshot: ApplicationBootstrapSnapshot
}
