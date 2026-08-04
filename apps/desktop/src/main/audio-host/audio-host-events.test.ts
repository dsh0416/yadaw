import { encode } from "@msgpack/msgpack"
import type { AudioHostRuntime } from "@heron/dsp-node"
import { describe, expect, it } from "vitest"
import { AraCallbackSequenceTracker, drainHostEvents } from "./audio-host-events"

function clientWithEvents(events: unknown[]): AudioHostRuntime {
  return {
    runtimeEpoch: "test-epoch",
    drainEvents: () => events.map((event) => Buffer.from(encode(event)))
  } as AudioHostRuntime
}

describe("drainHostEvents", () => {
  it("persists the latest valid editor preference and ignores invalid zoom", async () => {
    const writes: Array<{ typeKey: string; preference: { mode: string; zoomPercent: number } }> = []
    const pending = new Set<Promise<void>>()
    drainHostEvents(
      clientWithEvents([
        {
          type: "plugin-editor-preference-changed",
          plugin_type_key: "vst3:AAAABBBBCCCCDDDDEEEEFFFF00001111",
          preference: { mode: "native", zoom_percent: 49 }
        },
        {
          type: "plugin-editor-preference-changed",
          plugin_type_key: "vst3:AAAABBBBCCCCDDDDEEEEFFFF00001111",
          preference: { mode: "parameters", zoom_percent: 150 }
        }
      ]),
      async (typeKey, preference) => {
        writes.push({ typeKey, preference })
      },
      pending
    )
    await Promise.all([...pending])
    expect(writes).toEqual([
      {
        typeKey: "vst3:AAAABBBBCCCCDDDDEEEEFFFF00001111",
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

  it("forwards valid VST3 host notifications instead of dropping them", () => {
    const notifications: Array<{ instanceId: string; kind: string; value: string }> = []
    drainHostEvents(
      clientWithEvents([
        {
          type: "plugin-runtime",
          instance_id: "fx-1",
          kind: "dirty-changed",
          value: "true"
        },
        { type: "plugin-runtime", instance_id: "", kind: "open-editor", value: "editor" },
        { type: "plugin-runtime", instance_id: "fx-2", kind: "", value: "editor" }
      ]),
      async () => {},
      new Set(),
      undefined,
      undefined,
      (notification) => notifications.push(notification)
    )
    expect(notifications).toEqual([{ instanceId: "fx-1", kind: "dirty-changed", value: "true" }])
  })

  it("forwards only well-formed native side-chain route intents", () => {
    const requests: Array<{
      requestId: number
      instanceId: string
      inputPortKey: string
      sourceChannelId: string | null
    }> = []
    drainHostEvents(
      clientWithEvents([
        {
          type: "plugin-sidechain-route-requested",
          request_id: 4,
          instance_id: "fx-1",
          input_port_key: "vst3:audio:input:1",
          source_channel_id: "audio-1"
        },
        {
          type: "plugin-sidechain-route-requested",
          request_id: 5,
          instance_id: "fx-1",
          input_port_key: "vst3:audio:input:2",
          source_channel_id: null
        },
        {
          type: "plugin-sidechain-route-requested",
          request_id: 0,
          instance_id: "fx-1",
          input_port_key: "vst3:audio:input:2",
          source_channel_id: null
        }
      ]),
      async () => {},
      new Set(),
      undefined,
      undefined,
      undefined,
      (request) => requests.push(request)
    )
    expect(requests).toEqual([
      {
        requestId: 4,
        instanceId: "fx-1",
        inputPortKey: "vst3:audio:input:1",
        sourceChannelId: "audio-1"
      },
      {
        requestId: 5,
        instanceId: "fx-1",
        inputPortKey: "vst3:audio:input:2",
        sourceChannelId: null
      }
    ])
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
