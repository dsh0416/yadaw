import { decode } from "@msgpack/msgpack"
import type { AudioHostRuntime } from "@heron/dsp-node"
import type { AraCallbackEvent, PluginEditorPreference } from "@heron/contracts"

export interface AraHostCallback {
  helperEpoch: string
  instanceId: string
  sequence: number
  event: AraCallbackEvent
}

export interface PluginHostNotification {
  instanceId: string
  kind: string
  value: string
}

export interface PluginSidechainRouteRequest {
  requestId: number
  instanceId: string
  inputPortKey: string
  sourceChannelId: string | null
}

export class AraCallbackSequenceTracker {
  private epoch: string | null = null
  private sequence = 0

  accept(epoch: string, sequence: number): boolean {
    this.selectEpoch(epoch)
    if (sequence <= this.sequence) return false
    this.sequence = sequence
    return true
  }

  clear(): void {
    this.epoch = null
    this.sequence = 0
  }

  private selectEpoch(epoch: string): void {
    if (epoch === this.epoch) return
    this.epoch = epoch
    this.sequence = 0
  }
}

const objectKinds = new Set([
  "audio-source",
  "audio-modification",
  "playback-region",
  "document"
] as const)
const analysisStates = new Set(["started", "updated", "completed"] as const)
const quarantineCategories = new Set([
  "invalid-reference",
  "queue-overflow",
  "provider-panic",
  "host-state"
] as const)

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function decodeAraCallbackEvent(value: unknown): AraCallbackEvent | null {
  if (typeof value !== "object" || value === null) return null
  const event = value as Record<string, unknown>
  if (event.kind === "analysis-progress") {
    if (
      typeof event.object_id !== "string" ||
      event.object_id.length === 0 ||
      typeof event.state !== "string" ||
      !analysisStates.has(event.state as "started" | "updated" | "completed") ||
      !finiteNumber(event.progress) ||
      event.progress < 0 ||
      event.progress > 1
    ) {
      return null
    }
    return {
      kind: event.kind,
      objectId: event.object_id,
      state: event.state as "started" | "updated" | "completed",
      progress: event.progress
    }
  }
  if (event.kind === "content-changed") {
    const hasStart = event.start_seconds !== undefined
    const hasDuration = event.duration_seconds !== undefined
    if (
      typeof event.object_kind !== "string" ||
      !objectKinds.has(
        event.object_kind as "audio-source" | "audio-modification" | "playback-region" | "document"
      ) ||
      typeof event.object_id !== "string" ||
      event.object_id.length === 0 ||
      hasStart !== hasDuration ||
      (hasStart && !finiteNumber(event.start_seconds)) ||
      (hasDuration && (!finiteNumber(event.duration_seconds) || event.duration_seconds < 0)) ||
      !Number.isSafeInteger(event.scopes) ||
      (event.scopes as number) < 0 ||
      (event.scopes as number) > 0xffff_ffff
    ) {
      return null
    }
    return {
      kind: event.kind,
      objectKind: event.object_kind as
        | "audio-source"
        | "audio-modification"
        | "playback-region"
        | "document",
      objectId: event.object_id,
      ...(hasStart
        ? {
            startSeconds: event.start_seconds as number,
            durationSeconds: event.duration_seconds as number
          }
        : {}),
      scopes: event.scopes as number
    }
  }
  if (event.kind === "document-data-changed") return { kind: event.kind }
  if (event.kind === "archive-progress") {
    if (
      (event.direction !== "store" && event.direction !== "restore") ||
      !finiteNumber(event.progress) ||
      event.progress < 0 ||
      event.progress > 1
    ) {
      return null
    }
    return { kind: event.kind, direction: event.direction, progress: event.progress }
  }
  if (event.kind === "quarantined") {
    if (
      typeof event.category !== "string" ||
      !quarantineCategories.has(
        event.category as "invalid-reference" | "queue-overflow" | "provider-panic" | "host-state"
      ) ||
      typeof event.recoverable !== "boolean"
    ) {
      return null
    }
    return {
      kind: event.kind,
      category: event.category as
        | "invalid-reference"
        | "queue-overflow"
        | "provider-panic"
        | "host-state",
      recoverable: event.recoverable
    }
  }
  return null
}

export function drainHostEvents(
  client: AudioHostRuntime,
  onEditorPreferenceChanged: (
    pluginTypeKey: string,
    preference: PluginEditorPreference
  ) => Promise<void>,
  pendingWrites: Set<Promise<void>>,
  onEditorClosed?: (instanceId: string) => void,
  onAraCallback?: (callback: AraHostCallback) => void,
  onPluginHostNotification?: (notification: PluginHostNotification) => void,
  onPluginSidechainRouteRequested?: (request: PluginSidechainRouteRequest) => void
): void {
  const latestPreferences = new Map<string, PluginEditorPreference>()
  const closedEditors = new Set<string>()
  const pluginNotifications: PluginHostNotification[] = []
  const sidechainRequests: PluginSidechainRouteRequest[] = []
  for (const event of client.drainEvents()) {
    const decoded = decode(event) as {
      type?: string
      revision?: number
      plugin_type_key?: string
      instance_id?: string
      preference?: {
        mode?: string
        zoom_percent?: number
      }
      sequence?: number
      event?: unknown
      kind?: string
      value?: string
      request_id?: number
      input_port_key?: string
      source_channel_id?: string | null
    }
    if (decoded.type === "graph-published" && decoded.revision !== undefined) {
      // Telemetry carries the same revision; draining avoids idle event buildup.
    } else if (
      decoded.type === "plugin-editor-preference-changed" &&
      typeof decoded.plugin_type_key === "string" &&
      (decoded.preference?.mode === "native" || decoded.preference?.mode === "parameters") &&
      Number.isInteger(decoded.preference.zoom_percent) &&
      (decoded.preference.zoom_percent as number) >= 50 &&
      (decoded.preference.zoom_percent as number) <= 400
    ) {
      latestPreferences.set(decoded.plugin_type_key, {
        mode: decoded.preference.mode,
        zoomPercent: decoded.preference.zoom_percent as number
      })
    } else if (
      decoded.type === "plugin-editor-closed" &&
      typeof decoded.instance_id === "string" &&
      decoded.instance_id.length > 0
    ) {
      closedEditors.add(decoded.instance_id)
    } else if (
      decoded.type === "plugin-sidechain-route-requested" &&
      Number.isSafeInteger(decoded.request_id) &&
      (decoded.request_id as number) > 0 &&
      typeof decoded.instance_id === "string" &&
      decoded.instance_id.length > 0 &&
      typeof decoded.input_port_key === "string" &&
      decoded.input_port_key.length > 0 &&
      (decoded.source_channel_id === null || typeof decoded.source_channel_id === "string")
    ) {
      sidechainRequests.push({
        requestId: decoded.request_id as number,
        instanceId: decoded.instance_id,
        inputPortKey: decoded.input_port_key,
        sourceChannelId: decoded.source_channel_id ?? null
      })
    } else if (
      decoded.type === "plugin-runtime" &&
      typeof decoded.instance_id === "string" &&
      decoded.instance_id.length > 0 &&
      typeof decoded.kind === "string" &&
      decoded.kind.length > 0 &&
      typeof decoded.value === "string"
    ) {
      pluginNotifications.push({
        instanceId: decoded.instance_id,
        kind: decoded.kind,
        value: decoded.value
      })
    } else if (
      decoded.type === "ara-callback" &&
      typeof decoded.instance_id === "string" &&
      decoded.instance_id.length > 0 &&
      Number.isSafeInteger(decoded.sequence) &&
      (decoded.sequence as number) > 0 &&
      decoded.event !== undefined
    ) {
      const araEvent = decodeAraCallbackEvent(decoded.event)
      if (araEvent) {
        onAraCallback?.({
          helperEpoch: client.runtimeEpoch,
          instanceId: decoded.instance_id,
          sequence: decoded.sequence as number,
          event: araEvent
        })
      }
    }
  }
  for (const [pluginTypeKey, preference] of latestPreferences) {
    const write = onEditorPreferenceChanged(pluginTypeKey, preference).finally(() => {
      pendingWrites.delete(write)
    })
    pendingWrites.add(write)
  }
  if (onEditorClosed) {
    for (const instanceId of closedEditors) {
      onEditorClosed(instanceId)
    }
  }
  if (onPluginHostNotification) {
    for (const notification of pluginNotifications) {
      onPluginHostNotification(notification)
    }
  }
  if (onPluginSidechainRouteRequested) {
    for (const request of sidechainRequests) onPluginSidechainRouteRequested(request)
  }
}
