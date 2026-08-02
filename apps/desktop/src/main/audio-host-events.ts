import { decode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type { PluginEditorPreference } from "@yadaw/contracts"

export interface AraHostCallback {
  instanceId: string
  sequence: number
  event: {
    kind: string
    [key: string]: unknown
  }
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
      typeof decoded.event === "object" &&
      decoded.event !== null &&
      typeof (decoded.event as { kind?: unknown }).kind === "string"
    ) {
      onAraCallback?.({
        instanceId: decoded.instance_id,
        sequence: decoded.sequence as number,
        event: decoded.event as AraHostCallback["event"]
      })
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
