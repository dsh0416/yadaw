import { describe, expect, it } from "vitest"
import type {
  OperationEvent,
  OperationSnapshot,
  OperationStatusSnapshot,
  PendingRecording,
  RecordingLifecycleState,
  RecordingStopResult
} from "@yadaw/contracts"
import { IPC_PROTOCOL_VERSION } from "./rpc"

function wireRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("recording and operation contract serialization", () => {
  it("keeps recording lifecycle unions and pending takes lossless over JSON", () => {
    const lifecycle: RecordingLifecycleState = {
      status: "recording",
      session: {
        id: "take-1",
        startedAt: 1_700_000_000_000,
        swapPath: "/swap/take-1.bwf",
        startFrame: 960,
        startTick: 1_920,
        trackIds: ["track:audio", "track:midi"],
        audioTrackIds: ["track:audio"],
        midiTrackIds: ["track:midi"],
        waitingForSync: false
      },
      error: null
    }
    const pending: PendingRecording = {
      id: "pending-1",
      state: "ready",
      audioPath: "/swap/pending-1.bwf",
      sidecarPath: "/swap/pending-1.json",
      projectPath: "/projects/demo.yadaw",
      sampleRate: 48_000,
      channels: 2,
      startedAt: 1_700_000_000_000,
      startFrame: 960,
      startTick: 1_920,
      audioTrackIds: ["track:audio"],
      midiTrackIds: ["track:midi"],
      dropoutFrames: 2,
      assetExists: true,
      recordedTracks: [
        {
          assetId: "asset-1",
          trackId: "track:audio",
          name: "Audio 1",
          sampleRate: 48_000,
          channels: 2,
          frameCount: 192_000
        }
      ],
      midiTakes: [
        {
          trackId: "track:midi",
          sourceId: "source-1",
          clipId: "clip-1",
          journalPath: "/swap/clip-1.midijournal",
          eventCount: 42,
          droppedEvents: 0
        }
      ]
    }
    const stopResult: RecordingStopResult = {
      recording: {
        kind: "recording-session",
        id: "take-1",
        epoch: "18446744073709551615",
        generation: 2
      },
      pending,
      recoverableMedia: true,
      workspace: {
        project: {
          kind: "project-session",
          id: "project",
          epoch: "epoch-1",
          generation: 1
        },
        projectGraph: {
          kind: "project-graph",
          id: "graph",
          epoch: "epoch-1",
          generation: 1
        },
        revision: 4,
        session: {
          id: "project",
          path: "/projects/demo.yadaw",
          configuration: {
            name: "Demo",
            sampleRate: 48_000,
            timeSignatureNumerator: 4,
            timeSignatureDenominator: 4,
            waveformDisplayMode: "separate"
          },
          dirty: true,
          recoveredWorkingCopy: false
        },
        graph: {
          sampleRate: 48_000,
          tracks: [],
          channels: [],
          audioClips: [],
          sends: [],
          plugins: [],
          midiClips: [],
          keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
          tempoMap: {
            ticksPerQuarter: 960,
            tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
            timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
          }
        },
        assets: []
      }
    }

    expect(wireRoundTrip(lifecycle)).toEqual(lifecycle)
    expect(wireRoundTrip(stopResult)).toEqual(stopResult)
    expect(wireRoundTrip(stopResult).recording.epoch).toBe("18446744073709551615")
  })

  it("keeps operation snapshots and status unions aligned with IPC v2", () => {
    const operation: OperationSnapshot = {
      id: "operation-1",
      title: "Saving project",
      description: "Writing archive",
      phase: "saving-archive",
      state: "running",
      completedUnits: 3,
      totalUnits: 10,
      cancellable: true,
      error: null,
      dropoutFrames: 0
    }
    const event: OperationEvent = { type: "upsert", operation }
    const status: OperationStatusSnapshot = {
      operationId: "operation-1",
      state: "running",
      outcome: "committed",
      target: {
        kind: "desktop-session",
        id: "desktop",
        epoch: "18446744073709551615",
        generation: 1
      },
      cancellable: true,
      acknowledged: false
    }

    expect(wireRoundTrip(event)).toEqual(event)
    expect(wireRoundTrip(status)).toEqual(status)
    expect(wireRoundTrip(status).target.epoch).toBe("18446744073709551615")
    expect(IPC_PROTOCOL_VERSION).toBe(2)
  })
})
