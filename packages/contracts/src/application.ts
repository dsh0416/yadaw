import type { OfflineWorkerRef } from "./rpc"

export interface OfflineToolsResourceSnapshot {
  worker: OfflineWorkerRef
  revision: number
}

export const APPLICATION_COMMAND_IDS = [
  "project.new",
  "project.open",
  "project.save",
  "project.close",
  "project.settings",
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.select-all",
  "application.preferences",
  "application.quit",
  "window.close",
  "view.toggle-full-screen",
  "view.toggle-mixer-dock",
  "transport.toggle-playback",
  "transport.go-to-start",
  "recording.toggle",
  "help.audio-benchmark",
  "help.effect-chain-graph",
  "application.about"
] as const

export type ApplicationCommandId = (typeof APPLICATION_COMMAND_IDS)[number]
export type DesktopPlatform = "darwin" | "win32" | "linux"

export const APPLICATION_WINDOW_COMMAND_IDS = [
  "edit.undo",
  "edit.redo",
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.select-all",
  "window.minimize",
  "window.toggle-maximize",
  "window.close",
  "application.quit",
  "view.toggle-full-screen",
  "application.about"
] as const

export type ApplicationWindowCommandId = (typeof APPLICATION_WINDOW_COMMAND_IDS)[number]

export interface NativeEngineInfo {
  backend: string
  version: string
  nodeApi: number
}

export interface ProcessGainRequest {
  samples: number[]
  gain: number
}

export interface ProcessGainResult {
  samples: number[]
  peak: number
}
