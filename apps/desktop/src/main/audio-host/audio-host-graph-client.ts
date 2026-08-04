import type { AudioHostGraph } from "./wire"

export function graphDiff(
  previous: AudioHostGraph,
  next: AudioHostGraph
): Array<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = []
  if (previous.project_end_tick !== next.project_end_tick) {
    operations.push({ type: "set-project-end", project_end_tick: next.project_end_tick })
  }
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
