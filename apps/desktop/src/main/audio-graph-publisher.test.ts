import { describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type { ProjectGraphSnapshot } from "@yadaw/contracts"
import { AudioGraphPublisher } from "./audio-graph-publisher"
import type { PreparedProjectGraph } from "./audio-graph-publisher"

describe("AudioGraphPublisher.activate", () => {
  it("fails when a native preparation exists without an audio host", async () => {
    const publisher = new AudioGraphPublisher(
      { compile: vi.fn() },
      { materialize: vi.fn() } as never,
      null,
      null,
      null
    ) // host intentionally absent
    const graph = {
      sampleRate: 48_000,
      tracks: [],
      channels: [],
      audioClips: [],
      sends: [],
      plugins: [],
      midiClips: [],
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      },
      keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
    } as ProjectGraphSnapshot
    const prepared: PreparedProjectGraph = {
      graph,
      revision: 1,
      native: {
        meta: {
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: "activate-1",
          mutation: { operationId: "activate-1", idempotencyKey: "activate-1" }
        },
        projectGraph: {
          kind: "project-graph",
          id: "project:graph",
          epoch: "main",
          generation: 1
        },
        baseRevision: 0,
        graphRevision: 1,
        project: graph,
        runtime: {} as never
      }
    }
    const result = await publisher.activate(prepared.native!.meta, prepared)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "resource-unavailable",
        details: { component: "audio-host", dispatched: false }
      }
    })
  })
})
