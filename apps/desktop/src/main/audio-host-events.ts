import { decode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type { AraCallbackEvent, PluginEditorPreference } from "@yadaw/contracts"

export interface AraHostCallback {
  helperEpoch: string
  instanceId: string
  sequence: number
  event: AraCallbackEvent
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
  client: AudioHostIpcClient,
  onEditorPreferenceChanged: (classId: string, preference: PluginEditorPreference) => Promise<void>,
  pendingWrites: Set<Promise<void>>,
  onEditorClosed?: (instanceId: string) => void,
  onAraCallback?: (callback: AraHostCallback) => void
): void {
  const latestPreferences = new Map<string, PluginEditorPreference>()
  const closedEditors = new Set<string>()
  for (const event of client.drainEvents()) {
    const decoded = decode(event) as {
      type?: string
      revision?: number
      class_id?: string
      instance_id?: string
      preference?: {
        mode?: string
        zoom_percent?: number
      }
      sequence?: number
      event?: unknown
    }
    if (decoded.type === "graph-published" && decoded.revision !== undefined) {
      // Telemetry carries the same revision; draining avoids idle event buildup.
    } else if (
      decoded.type === "plugin-editor-preference-changed" &&
      typeof decoded.class_id === "string" &&
      (decoded.preference?.mode === "native" || decoded.preference?.mode === "parameters") &&
      Number.isInteger(decoded.preference.zoom_percent) &&
      (decoded.preference.zoom_percent as number) >= 50 &&
      (decoded.preference.zoom_percent as number) <= 400
    ) {
      latestPreferences.set(decoded.class_id, {
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
          helperEpoch: client.helperEpoch,
          instanceId: decoded.instance_id,
          sequence: decoded.sequence as number,
          event: araEvent
        })
      }
    }
  }
  for (const [classId, preference] of latestPreferences) {
    const write = onEditorPreferenceChanged(classId, preference).finally(() => {
      pendingWrites.delete(write)
    })
    pendingWrites.add(write)
  }
  if (onEditorClosed) {
    for (const instanceId of closedEditors) {
      onEditorClosed(instanceId)
    }
  }
}
