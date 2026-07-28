import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ApplicationCommandId, ProjectSession } from "@yadaw/contracts"

export type DirtyProjectCloseCommand = Extract<
  ApplicationCommandId,
  "application.quit" | "window.close"
>

interface PreventableCloseEvent {
  preventDefault(): void
}

interface CloseRequestWindow {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, command: DirtyProjectCloseCommand): void
  }
}

interface DeferDirtyProjectCloseOptions {
  command: DirtyProjectCloseCommand
  event: PreventableCloseEvent
  project: Pick<ProjectSession, "dirty"> | null
  window: CloseRequestWindow | null
}

export function deferDirtyProjectClose({
  command,
  event,
  project,
  window
}: DeferDirtyProjectCloseOptions): boolean {
  if (!project?.dirty || !window || window.isDestroyed()) return false
  event.preventDefault()
  window.webContents.send(IPC_CHANNELS.applicationCommandRequested, command)
  return true
}
