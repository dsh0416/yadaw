import { encode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import { describe, expect, it } from "vitest"
import { AraCallbackSequenceTracker, drainHostEvents } from "./audio-host-events"

function clientWithEvents(events: unknown[]): AudioHostIpcClient {
  return {
    helperEpoch: "test-epoch",
    drainEvents: () => events.map((event) => Buffer.from(encode(event)))
  } as AudioHostIpcClient
}

describe("drainHostEvents", () => {
  it("persists the latest valid editor preference and ignores invalid zoom", async () => {
    const writes: Array<{ classId: string; preference: { mode: string; zoomPercent: number } }> = []
    const pending = new Set<Promise<void>>()
    drainHostEvents(
      clientWithEvents([
        {
          type: "plugin-editor-preference-changed",
          class_id: "AAAABBBBCCCCDDDDEEEEFFFF00001111",
          preference: { mode: "native", zoom_percent: 49 }
        },
        {
          type: "plugin-editor-preference-changed",
          class_id: "AAAABBBBCCCCDDDDEEEEFFFF00001111",
          preference: { mode: "parameters", zoom_percent: 150 }
        }
      ]),
      async (classId, preference) => {
        writes.push({ classId, preference })
      },
      pending
    )
    await Promise.all([...pending])
    expect(writes).toEqual([
      {
        classId: "AAAABBBBCCCCDDDDEEEEFFFF00001111",
        preference: { mode: "parameters", zoomPercent: 150 }
      }
    ])
  })

  it("notifies when native editors close without a ClosePluginEditor RPC", () => {
    const closed: string[] = []
    drainHostEvents(
      clientWithEvents([
        { type: "graph-published", revision: 3 },
        { type: "plugin-editor-closed", instance_id: "fx-1" },
        { type: "plugin-editor-closed", instance_id: "fx-1" },
        { type: "plugin-editor-closed", instance_id: "" }
      ]),
      async () => {},
      new Set(),
      (instanceId) => closed.push(instanceId)
    )
    expect(closed).toEqual(["fx-1"])
  })

  it("forwards valid typed ARA callback events", () => {
    const callbacks: Array<{ instanceId: string; sequence: number; event: { kind: string } }> = []
    drainHostEvents(
      clientWithEvents([
        {
          type: "ara-callback",
          instance_id: "ara-1",
          sequence: 7,
          event: {
            kind: "analysis-progress",
            object_id: "source-1",
            state: "updated",
            progress: 0.5
          }
        },
        { type: "ara-callback", instance_id: "ara-1", sequence: 0, event: { kind: "bad" } }
      ]),
      async () => {},
      new Set(),
      undefined,
      (callback) => callbacks.push(callback)
    )
    expect(callbacks).toEqual([
      {
        helperEpoch: "test-epoch",
        instanceId: "ara-1",
        sequence: 7,
        event: {
          kind: "analysis-progress",
          objectId: "source-1",
          state: "updated",
          progress: 0.5
        }
      }
    ])
  })

  it("rejects malformed ARA callback payloads at the helper boundary", () => {
    const callbacks: unknown[] = []
    drainHostEvents(
      clientWithEvents([
        {
          type: "ara-callback",
          instance_id: "ara-1",
          sequence: 1,
          event: { kind: "content-changed", object_id: "clip-1", scopes: -1 }
        },
        {
          type: "ara-callback",
          instance_id: "ara-1",
          sequence: 2,
          event: {
            kind: "content-changed",
            object_kind: "playback-region",
            object_id: "clip-1",
            start_seconds: 1,
            scopes: 1
          }
        }
      ]),
      async () => {},
      new Set(),
      undefined,
      (callback) => callbacks.push(callback)
    )
    expect(callbacks).toEqual([])
  })
})

describe("AraCallbackSequenceTracker", () => {
  it("deduplicates within an epoch and accepts a reset after helper replacement", () => {
    const tracker = new AraCallbackSequenceTracker()
    expect(tracker.accept("epoch-1", 7)).toBe(true)
    expect(tracker.accept("epoch-1", 7)).toBe(false)
    expect(tracker.accept("epoch-1", 6)).toBe(false)
    expect(tracker.accept("epoch-2", 1)).toBe(true)
  })

  it("uses one bounded sequence per helper instead of retaining instance ids", () => {
    const tracker = new AraCallbackSequenceTracker()
    expect(tracker.accept("epoch-1", 7)).toBe(true)
    expect(tracker.accept("epoch-1", 6)).toBe(false)
    tracker.clear()
    expect(tracker.accept("epoch-1", 1)).toBe(true)
  })
})
