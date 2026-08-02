import { encode } from "@msgpack/msgpack"
import { describe, expect, it, vi } from "vitest"
import { drainHostEvents } from "./audio-host-events"

function clientWithEvents(events: unknown[]) {
  return {
    drainEvents: () => events.map((event) => Buffer.from(encode(event)))
  }
}

describe("drainHostEvents", () => {
  it("persists the latest valid editor preference and ignores invalid zoom", async () => {
    const writes: Array<{ classId: string; preference: { mode: string; zoomPercent: number } }> =
      []
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
      ]) as never,
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
      ]) as never,
      async () => {},
      new Set(),
      (instanceId) => closed.push(instanceId)
    )
    expect(closed).toEqual(["fx-1"])
  })
})
