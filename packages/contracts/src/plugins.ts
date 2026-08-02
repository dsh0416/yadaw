import type { PluginEditorMode } from "./settings"
import type { PluginInstanceRef, ProjectGraphRef } from "./rpc"

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
  /** VST3 `subCategories` (and host fallbacks), split into individual tags. */
  categories: string[]
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

/** Split a VST3 pipe-separated subcategory string, or normalize an array. */
export function parsePluginCategories(
  value: string | readonly string[] | null | undefined
): string[] {
  if (typeof value === "string") {
    return value
      .split("|")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (value == null) {
    return []
  }
  // Array.isArray narrows to any[]; keep the readonly string[] branch explicit.
  return value.map((item) => item.trim()).filter((item) => item.length > 0)
}

export function defaultPluginCategories(kind: PluginKind): string[] {
  return kind === "instrument" ? ["Instrument", "Synth"] : ["Fx"]
}

export function pluginCategoriesLabel(categories: readonly string[], separator = " · "): string {
  return categories.join(separator)
}

export function pluginLooksLikeInstrument(categories: readonly string[]): boolean {
  return categories.some((category) => {
    const normalized = category.toLocaleLowerCase()
    return normalized.includes("instrument") || normalized.includes("synth")
  })
}

/**
 * Normalize a descriptor loaded from older project/catalog snapshots that used
 * a single pipe-separated `category` string.
 */
export function normalizePluginDescriptor(
  value: PluginDescriptor & { category?: string }
): PluginDescriptor {
  const supportedAudioModes = (
    Array.isArray(value.supportedAudioModes)
      ? value.supportedAudioModes
      : (["stereo"] as PluginAudioMode[])
  ).filter((mode) => mode !== "dual-mono" || value.ara === undefined)
  const categories = parsePluginCategories(value.categories ?? value.category)
  const { category: _legacyCategory, ...rest } = value
  return {
    ...rest,
    supportedAudioModes,
    categories: categories.length > 0 ? categories : defaultPluginCategories(value.kind ?? "effect")
  }
}

export interface PluginCatalogSnapshot {
  scannerVersion: number
  scanning: boolean
  scannedAt: number | null
  plugins: PluginDescriptor[]
}

export interface PluginScanRequest {
  paths?: string[]
  /** Re-discover quarantined bundles even when their fingerprint is unchanged. */
  retryQuarantined?: boolean
  /**
   * Bypass the on-disk fingerprint cache and rediscover every found bundle.
   * Manual "Rescan VST3" sets this; startup scans leave it unset so unchanged
   * plugins are reused from `plugin-catalog.json`. Discovery stays lightweight
   * (moduleinfo.json / soft factory enum) and does not instantiate processors.
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
  | "unloaded"
  | "loading"
  | "active"
  | "bypassed"
  | "missing"
  | "quarantined"
  | "failed"

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
  formatted?: string
  flags: number
}

export interface PluginParameterChange {
  instanceId: string
  parameterId: number
  normalized: number
  gesture: "begin" | "perform" | "end"
}

export interface PluginInstanceResourceSnapshot {
  plugin: PluginInstanceRef
  projectGraph: ProjectGraphRef
  revision: number
  instance: PluginInstanceState
}

export interface PluginEditorOpenResult {
  resource: PluginInstanceResourceSnapshot
  status: PluginRuntimeStatus
}

export interface PluginParameterCommand {
  plugin: PluginInstanceRef
  helperEpoch: string
  pluginGeneration: number
  sequence: string
  parameterId: number
  normalized: number
  gesture: "begin" | "perform" | "end"
}

export type PluginParameterEnqueueOutcome = "queued" | "coalesced" | "fallback" | "full" | "stale"

export interface PluginParameterEnqueueResult {
  plugin: PluginInstanceRef
  helperEpoch: string
  sequence: string
  outcome: PluginParameterEnqueueOutcome
}
export type AraCallbackEvent =
  | {
      kind: "analysis-progress"
      object_id: string
      state: "started" | "updated" | "completed"
      progress: number
    }
  | {
      kind: "content-changed"
      object_kind: "audio-source" | "audio-modification" | "playback-region" | "document"
      object_id: string
      start_seconds?: number
      duration_seconds?: number
      scopes: number
    }
  | { kind: "document-data-changed" }
  | { kind: "archive-progress"; direction: "store" | "restore"; progress: number }
  | {
      kind: "quarantined"
      category: "invalid-reference" | "queue-overflow" | "provider-panic" | "host-state"
      recoverable: boolean
    }

export interface AraCallbackNotification {
  instanceId: string
  callbackSequence: number
  event: AraCallbackEvent
}
