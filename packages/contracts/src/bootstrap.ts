import type { DesktopLifecycleSnapshot } from "./audio"
import type { ProjectWorkspaceSnapshot } from "./project"
import type { ApplicationSettingsRef, DesktopSessionRef } from "./rpc"
import type { ApplicationSettings } from "./settings"
import { IPC_PROTOCOL_VERSION } from "./rpc"

export interface ApplicationBootstrapSnapshot {
  protocolVersion: typeof IPC_PROTOCOL_VERSION
  mainEpoch: string
  desktopSession: DesktopSessionRef
  applicationSettings: ApplicationSettingsRef
  revision: number
  lifecycle: DesktopLifecycleSnapshot
  settings: ApplicationSettings
  workspace: ProjectWorkspaceSnapshot | null
}

export interface ProjectCloseResult {
  closed: boolean
  snapshot: ApplicationBootstrapSnapshot
}
