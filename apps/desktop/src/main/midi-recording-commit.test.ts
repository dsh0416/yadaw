import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MidiJournalWriter } from "./midi-recording-commit.fixture"
import { commitMidiRecordingTakes } from "./midi-recording-commit"

describe("commitMidiRecordingTakes", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it("converts a journal into a MIDI source and clip commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yadaw-midi-commit-"))
    directories.push(directory)
    const journalPath = join(directory, "take.partial.midijournal")
    await MidiJournalWriter.write(journalPath, {
      sourceId: "source-1",
      clipId: "clip-1",
      trackId: "track-1",
      records: [
        { tick: 960, bytes: [0x90, 60, 100] },
        { tick: 1_920, bytes: [0x80, 60, 40] }
      ]
    })

    const executeMidiImport = vi.fn(async (_meta, _source, _command) => ({
      workspace: {
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 2,
        graph: { midiClips: [{ id: "clip-1" }] }
      }
    }))
    const workspace = {
      projectGraph: { kind: "project-graph" as const, id: "g", epoch: "1", generation: 1 },
      revision: 1,
      graph: {
        midiClips: [],
        tracks: [{ id: "track-1", channelId: "channel-1" }],
        channels: [{ id: "channel-1", name: "Keys" }]
      },
      session: { path: "/tmp/project.yadaw" }
    }

    const next = await commitMidiRecordingTakes(
      { executeMidiImport } as never,
      workspace as never,
      "recording:1",
      960,
      [
        {
          trackId: "track-1",
          sourceId: "source-1",
          clipId: "clip-1",
          journalPath,
          eventCount: 2,
          droppedEvents: 0
        }
      ],
      new Map([["track-1", "Keys"]])
    )

    expect(executeMidiImport).toHaveBeenCalledOnce()
    const [, source, command] = executeMidiImport.mock.calls[0]!
    expect(source).toMatchObject({ id: "source-1" })
    expect(command).toMatchObject({
      type: "batch",
      commands: [
        {
          type: "create-midi-clip",
          clip: {
            id: "clip-1",
            sourceId: "source-1",
            trackId: "track-1",
            startTick: 960,
            notes: [
              expect.objectContaining({
                startTick: 0,
                durationTicks: 960,
                key: 60,
                velocity: 100,
                releaseVelocity: 40
              })
            ]
          }
        }
      ]
    })
    expect(next.revision).toBe(2)
  })

  it("skips takes whose clip ids are already present", async () => {
    const executeMidiImport = vi.fn()
    await commitMidiRecordingTakes(
      { executeMidiImport } as never,
      {
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 1,
        graph: { midiClips: [{ id: "clip-1" }] }
      } as never,
      "recording:1",
      0,
      [
        {
          trackId: "track-1",
          sourceId: "source-1",
          clipId: "clip-1",
          journalPath: "/missing.midijournal",
          eventCount: 0,
          droppedEvents: 0
        }
      ],
      new Map()
    )
    expect(executeMidiImport).not.toHaveBeenCalled()
  })
})
