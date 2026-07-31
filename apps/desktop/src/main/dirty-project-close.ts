import type { ApplicationCommandId, ProjectSession, RpcEvent } from "@yadaw/contracts"
import { sendApplicationCommand } from "./application-command-events"

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
    send(channel: string, event: RpcEvent<ApplicationCommandId>): void
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
  sendApplicationCommand(window, command)
  return true
}
