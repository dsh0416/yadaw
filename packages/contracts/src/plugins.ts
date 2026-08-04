import type { PluginEditorMode } from "./settings"
import type { PluginInstanceRef, ProjectGraphRef } from "./rpc"

export type PluginKind = "effect" | "instrument"
export type PluginFormat = "vst3" | "clap"
export interface PluginLocator {
  format: PluginFormat
  artifactPath: string
  nativeId: string
}
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
  /** Persistable format-neutral port identity. */
  portKey: string
  direction: "input" | "output"
  kind: "main" | "aux"
  name: string
  channels: number
  defaultActive: boolean
}

export interface PluginSidechainRoute {
  /** Persistable audio input port key. */
  inputPortKey: string
  /** Mixer channel whose post-pan signal feeds this bus. */
  sourceChannelId: string
}

export interface PluginNotePortInfo {
  portKey: string
  direction: "input" | "output"
  name: string
  dialects: Array<"clap" | "midi1" | "midi2">
  preferredDialect: "clap" | "midi1" | "midi2" | null
}

export interface PluginCapabilities {
  editor: boolean
  parameters: boolean
  state: boolean
  latency: boolean
  tail: boolean
  audioPortConfigurations: boolean
  noteInput: boolean
  noteOutput: boolean
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
  /** Stable format, artifact, and native type identity. */
  locator: PluginLocator
  name: string
  vendor: string
  version: string
  /** VST3 `subCategories` (and host fallbacks), split into individual tags. */
  categories: string[]
  kind: PluginKind
  supportedAudioModes: PluginAudioMode[]
  architecture: string
  buses: PluginAudioBusInfo[]
  notePorts?: PluginNotePortInfo[]
  capabilities?: PluginCapabilities
  hasEditor: boolean
  ara?: PluginAraCapability
  compatibility: PluginCompatibility
  compatibilityReason: string | null
}

export function vst3AudioPortKey(direction: "input" | "output", index: number): string {
  return `vst3:audio:${direction}:${index}`
}

export function pluginLocator(descriptor: PluginDescriptor): PluginLocator {
  return descriptor.locator
}

export function pluginTypeKey(value: PluginDescriptor | PluginLocator): string {
  const locator = "name" in value ? pluginLocator(value) : value
  return `${locator.format}:${locator.nativeId}`
}

export function pluginDescriptorKey(descriptor: PluginDescriptor): string {
  const locator = pluginLocator(descriptor)
  return descriptor.source.kind === "builtin"
    ? `${descriptor.source.id}:${pluginTypeKey(locator)}`
    : `${locator.format}:${locator.artifactPath}:${locator.nativeId}`
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
type PluginDescriptorSnapshot = Omit<PluginDescriptor, "locator" | "buses"> & {
  locator?: PluginLocator
  category?: string
  buses?: Array<Omit<PluginAudioBusInfo, "portKey"> & { portKey?: string; index?: number }>
  [legacyField: string]: unknown
}

export function normalizePluginDescriptor(
  value: PluginDescriptor | PluginDescriptorSnapshot
): PluginDescriptor {
  const snapshot = value as PluginDescriptorSnapshot
  const legacyNativeIdField = ["class", "Id"].join("")
  const legacyArtifactPathField = ["module", "Path"].join("")
  const legacyNativeId = snapshot[legacyNativeIdField]
  const legacyArtifactPath = snapshot[legacyArtifactPathField]
  const locator =
    value.locator ??
    ({
      format: "vst3",
      artifactPath: typeof legacyArtifactPath === "string" ? legacyArtifactPath : "",
      nativeId: typeof legacyNativeId === "string" ? legacyNativeId : ""
    } satisfies PluginLocator)
  const supportedAudioModes = (
    Array.isArray(value.supportedAudioModes)
      ? value.supportedAudioModes
      : (["stereo"] as PluginAudioMode[])
  ).filter((mode) => mode !== "dual-mono" || value.ara === undefined)
  const categories = parsePluginCategories(snapshot.categories ?? snapshot.category)
  const nextBusIndex = new Map<PluginAudioBusInfo["direction"], number>([
    ["input", 0],
    ["output", 0]
  ])
  const buses = (snapshot.buses ?? []).map((bus) => {
    const fallbackIndex = nextBusIndex.get(bus.direction) ?? 0
    const nativeIndex = bus.index
    const index =
      typeof nativeIndex === "number" && Number.isSafeInteger(nativeIndex) && nativeIndex >= 0
        ? nativeIndex
        : fallbackIndex
    nextBusIndex.set(bus.direction, Math.max(fallbackIndex, index) + 1)
    const { index: _legacyIndex, ...restBus } = bus
    return {
      ...restBus,
      portKey: bus.portKey ?? vst3AudioPortKey(bus.direction, index)
    }
  })
  const { category: _legacyCategory, ...rest } = snapshot
  delete rest[legacyNativeIdField]
  delete rest[legacyArtifactPathField]
  return {
    ...rest,
    locator,
    supportedAudioModes,
    buses,
    categories:
      categories.length > 0 ? categories : defaultPluginCategories(value.kind ?? "effect"),
    notePorts: value.notePorts ?? [],
    capabilities: value.capabilities ?? {
      editor: value.hasEditor,
      parameters: true,
      state: true,
      latency: true,
      tail: true,
      audioPortConfigurations: false,
      noteInput: value.kind === "instrument",
      noteOutput: false
    }
  }
}

export interface PluginCatalogSnapshot {
  scannerVersion: number
  providerVersions?: Partial<Record<PluginFormat, number>>
  scanning: boolean
  scannedAt: number | null
  plugins: PluginDescriptor[]
}

export interface PluginScanRequest {
  paths?: string[]
  formats?: PluginFormat[]
  /** Re-discover quarantined bundles even when their fingerprint is unchanged. */
  retryQuarantined?: boolean
  /**
   * Bypass the on-disk fingerprint cache and rediscover every found bundle.
   * Manual "Rescan Audio Plugins" sets this; startup scans leave it unset so unchanged
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
  locator: PluginLocator
  descriptor: PluginDescriptor
  audioMode: PluginAudioMode
  enabled: boolean
  sidechainInputs: PluginSidechainRoute[]
  state: PluginStateEnvelope
}

export interface PluginStateChunk {
  key: string
  bytes: Uint8Array
}

export interface PluginStateEnvelope {
  version: 1
  chunks: PluginStateChunk[]
}

export function vst3StateEnvelope(
  component: Uint8Array,
  controller: Uint8Array,
  araDocument?: Uint8Array
): PluginStateEnvelope {
  const chunks: PluginStateChunk[] = [
    { key: "component", bytes: component },
    { key: "controller", bytes: controller }
  ]
  if (araDocument && araDocument.byteLength > 0) {
    chunks.push({ key: "ara-document", bytes: araDocument })
  }
  return { version: 1, chunks }
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
  parameterKey: string
  runtimeToken: number
  title: string
  shortTitle: string
  units: string
  stepCount: number
  defaultNormalized: number
  normalized: number
  formatted?: string
  minValue: number
  maxValue: number
  defaultValue: number
  value: number
  normalizedValue: number
  modulePath?: string
  readOnly?: boolean
  hidden?: boolean
  stepped?: boolean
  automatable?: boolean
  bypass?: boolean
}

export interface PluginParameterChange {
  instanceId: string
  parameterKey: string
  value: number
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
  parameterKey: string
  runtimeToken: number
  value: number
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
      objectId: string
      state: "started" | "updated" | "completed"
      progress: number
    }
  | {
      kind: "content-changed"
      objectKind: "audio-source" | "audio-modification" | "playback-region" | "document"
      objectId: string
      startSeconds?: number
      durationSeconds?: number
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
