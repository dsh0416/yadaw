import { readFileSync } from "node:fs"
import type { AudioHostGraph } from "./wire"

export function graphDiff(
  previous: AudioHostGraph,
  next: AudioHostGraph
): Array<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = []
  const diffCollection = <T>(
    before: T[],
    after: T[],
    id: (value: T) => string,
    upsertType: string,
    removeType: string
  ): void => {
    const beforeById = new Map(before.map((value) => [id(value), value]))
    const afterById = new Map(after.map((value) => [id(value), value]))
    for (const [key, value] of afterById) {
      if (JSON.stringify(beforeById.get(key)) !== JSON.stringify(value)) {
        operations.push({ type: upsertType, value })
      }
    }
    for (const key of beforeById.keys()) {
      if (!afterById.has(key)) operations.push({ type: removeType, id: key })
    }
  }
  diffCollection(
    previous.channels,
    next.channels,
    (value) => value.id,
    "upsert-channel",
    "remove-channel"
  )
  diffCollection(previous.sends, next.sends, (value) => value.id, "upsert-send", "remove-send")
  diffCollection(previous.clips, next.clips, (value) => value.id, "upsert-clip", "remove-clip")
  diffCollection(
    previous.plugins,
    next.plugins,
    (value) => value.instance_id,
    "upsert-plugin",
    "remove-plugin"
  )
  diffCollection(
    previous.midi_clips,
    next.midi_clips,
    (value) => value.id,
    "upsert-midi-clip",
    "remove-midi-clip"
  )
  if (
    JSON.stringify(previous.tempo_events) !== JSON.stringify(next.tempo_events) ||
    JSON.stringify(previous.time_signature_events) !== JSON.stringify(next.time_signature_events)
  ) {
    operations.push({
      type: "replace-tempo-map",
      tempo_events: next.tempo_events,
      time_signature_events: next.time_signature_events
    })
  }
  return operations
}

export function readCrashMarker(
  path: string,
  revision: number | undefined,
  graph: AudioHostGraph | undefined
): string | null {
  try {
    const marker = readFileSync(path)
    if (marker.length < 40) return null
    const magic = marker.readBigUInt64LE(0)
    const generation = marker.readBigUInt64LE(8)
    const pluginIndex = marker.readBigUInt64LE(16)
    const stage = marker.readBigUInt64LE(24)
    const checksum = marker.readBigUInt64LE(32)
    const salt = 0x43524153484d4152n
    if (
      magic !== 0x5941444157565354n ||
      checksum !== (magic ^ generation ^ pluginIndex ^ stage ^ salt) ||
      stage === 0n ||
      generation !== BigInt(revision ?? -1)
    ) {
      return null
    }
    const plugins = [...(graph?.plugins ?? [])].sort(
      (left, right) =>
        left.channel_id.localeCompare(right.channel_id) ||
        Number(left.role !== "instrument") - Number(right.role !== "instrument") ||
        left.slot_order - right.slot_order
    )
    return plugins[Number(pluginIndex)]?.instance_id ?? null
  } catch {
    return null
  }
}
