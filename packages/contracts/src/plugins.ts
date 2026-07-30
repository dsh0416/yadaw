import type { PluginEditorMode } from "./settings"

export type PluginKind = "effect" | "instrument"
export type PluginAudioMode = "mono" | "mono-to-stereo" | "stereo" | "dual-mono"
export type PluginInstanceRole = "instrument" | "insert"
export type PluginSource = { kind: "builtin"; id: string } | { kind: "external" }
export type PluginCompatibility =
  | "compatible"
  | "unsupported-architecture"
  | "unsupported-buses"
  | "unsupported-sample-format"
  | "quarantined"
  | "load-error"

export interface PluginAudioBusInfo {
  direction: "input" | "output"
  kind: "main" | "aux"
  name: string
  channels: number
  defaultActive: boolean
}

export interface PluginAraCapability {
  apiGeneration: 2
  factoryClassId: string
  factoryId: string
  documentArchiveId: string
  lowestApiGeneration: number
  highestApiGeneration: number
  playbackTransformationFlags: number
  supportsStoringAudioFileChunks: boolean
}

export interface PluginDescriptor {
  source: PluginSource
  classId: string
  modulePath: string
  name: string
  vendor: string
  version: string
  category: string
  kind: PluginKind
  supportedAudioModes: PluginAudioMode[]
  architecture: string
  buses: PluginAudioBusInfo[]
  hasEditor: boolean
  ara?: PluginAraCapability
  compatibility: PluginCompatibility
  compatibilityReason: string | null
}

export function pluginDescriptorKey(descriptor: PluginDescriptor): string {
  return descriptor.source.kind === "builtin"
    ? `${descriptor.source.id}:${descriptor.classId}`
    : `${descriptor.modulePath}:${descriptor.classId}`
}

export interface PluginCatalogSnapshot {
  scannerVersion: number
  scanning: boolean
  scannedAt: number | null
  plugins: PluginDescriptor[]
}

export interface PluginScanRequest {
  paths?: string[]
  /** Re-probe quarantined bundles even when their fingerprint is unchanged. */
  retryQuarantined?: boolean
  /**
   * Bypass the on-disk fingerprint cache and re-probe every discovered bundle.
   * Manual "Rescan VST3" sets this; startup scans leave it unset so unchanged
   * plugins are reused from `plugin-catalog.json`.
   */
  force?: boolean
}

export type PluginScanEvent =
  | { type: "started"; total: number }
  | { type: "progress"; completed: number; total: number; path: string }
  | { type: "quarantined"; path: string; reason: string }
  | { type: "completed"; catalog: PluginCatalogSnapshot }

export interface PluginInstanceState {
  id: string
  channelId: string
  role: PluginInstanceRole
  slotOrder: number
  classId: string
  descriptor: PluginDescriptor
  audioMode: PluginAudioMode
  enabled: boolean
  componentState: Uint8Array
  controllerState: Uint8Array
  /** Opaque ARA document archive. The plug-in owns its contents. */
  araDocumentState?: Uint8Array
}

export type PluginRuntimeState =
  "unloaded" | "loading" | "active" | "bypassed" | "missing" | "quarantined" | "failed"

export interface PluginRuntimeStatus {
  instanceId: string
  state: PluginRuntimeState
  editorOpen: boolean
  editorMode?: PluginEditorMode
  recoveryState?: "none" | "recovered-bypassed"
  failureStage?: "initialize" | "restore" | "process" | "editor" | "state-save" | null
  latencySamples: number
  tailSamples: number | null
  error: string | null
}

export interface PluginParameterInfo {
  id: number
  title: string
  shortTitle: string
  units: string
  stepCount: number
  defaultNormalized: number
  normalized: number
  flags: number
}

export interface PluginParameterChange {
  instanceId: string
  parameterId: number
  normalized: number
  gesture: "begin" | "perform" | "end"
}
