import { decode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type { PluginEditorPreference } from "@yadaw/contracts"

export function drainHostEvents(
  client: AudioHostIpcClient,
  onEditorPreferenceChanged: (classId: string, preference: PluginEditorPreference) => Promise<void>,
  pendingWrites: Set<Promise<void>>
): void {
  const latestPreferences = new Map<string, PluginEditorPreference>()
  for (const event of client.drainEvents()) {
    const decoded = decode(event) as {
      type?: string
      revision?: number
      class_id?: string
      preference?: {
        mode?: string
        zoom_percent?: number
      }
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
    }
  }
  for (const [classId, preference] of latestPreferences) {
    const write = onEditorPreferenceChanged(classId, preference).finally(() => {
      pendingWrites.delete(write)
    })
    pendingWrites.add(write)
  }
}
