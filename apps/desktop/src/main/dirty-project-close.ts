import type { ApplicationCommandId, ProjectSession, RpcEvent } from "@yadaw/contracts"
import { sendApplicationCommand } from "./application-command-events"

export type ProjectCloseCommand = Extract<ApplicationCommandId, "application.quit" | "window.close">

interface PreventableCloseEvent {
  preventDefault(): void
}

interface CloseRequestWindow {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, event: RpcEvent<ApplicationCommandId>): void
  }
}

interface DeferProjectCloseOptions {
  command: ProjectCloseCommand
  event: PreventableCloseEvent
  project: Pick<ProjectSession, "dirty"> | null
  window: CloseRequestWindow | null
}

export function deferProjectClose({
  command,
  event,
  project,
  window
}: DeferProjectCloseOptions): boolean {
  // The renderer also tracks pending mutations that may not have reached the
  // main-process project session yet. Route every open project through its
  // close workflow so clean projects are released and unsaved state is checked.
  if (!project || !window || window.isDestroyed()) return false
  event.preventDefault()
  sendApplicationCommand(window, command)
  return true
}
