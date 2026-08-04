import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MidiJournalWriter } from "./midi-recording-commit.fixture"
import { commitMidiRecordingTakes } from "./midi-recording-commit"

describe("commitMidiRecordingTakes", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it("converts a journal into a MIDI source and clip commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-midi-commit-"))
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
      session: { path: "/tmp/project.heron" }
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

  it("returns the workspace unchanged for an empty take list", async () => {
    const workspace = {
      projectGraph: { kind: "project-graph" as const, id: "g", epoch: "1", generation: 1 },
      revision: 4,
      graph: { midiClips: [] }
    }
    const executeMidiImport = vi.fn()
    const next = await commitMidiRecordingTakes(
      { executeMidiImport } as never,
      workspace as never,
      "recording:1",
      0,
      [],
      new Map()
    )
    expect(next).toBe(workspace)
    expect(executeMidiImport).not.toHaveBeenCalled()
  })

  it("commits non-note events and defaults the track name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-midi-commit-events-"))
    directories.push(directory)
    const journalPath = join(directory, "take.midijournal")
    await MidiJournalWriter.write(journalPath, {
      sourceId: "source-2",
      clipId: "clip-2",
      trackId: "track-2",
      records: [{ tick: 0, bytes: [0xb0, 7, 64] }]
    })
    const executeMidiImport = vi.fn(async (_meta, _source, _command) => ({
      workspace: {
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 3,
        graph: { midiClips: [{ id: "clip-2" }] }
      }
    }))
    await commitMidiRecordingTakes(
      { executeMidiImport } as never,
      {
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 2,
        graph: { midiClips: [] }
      } as never,
      "recording:2",
      0,
      [
        {
          trackId: "track-2",
          sourceId: "source-2",
          clipId: "clip-2",
          journalPath,
          eventCount: 1,
          droppedEvents: 0
        }
      ],
      new Map()
    )
    const [, source, command] = executeMidiImport.mock.calls[0]!
    expect(source).toMatchObject({
      id: "source-2",
      name: "Recording Instrument.midijournal"
    })
    expect(command).toMatchObject({
      type: "batch",
      commands: [
        {
          type: "create-midi-clip",
          clip: {
            name: "Recording Instrument",
            lengthTicks: 1,
            events: [expect.objectContaining({ kind: "control-change", tick: 0 })]
          }
        }
      ]
    })
  })

  it("chains revisions across multiple takes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-midi-commit-multi-"))
    directories.push(directory)
    const firstPath = join(directory, "a.midijournal")
    const secondPath = join(directory, "b.midijournal")
    await MidiJournalWriter.write(firstPath, {
      sourceId: "source-a",
      clipId: "clip-a",
      trackId: "track-a",
      records: [{ tick: 0, bytes: [0x90, 60, 1] }]
    })
    await MidiJournalWriter.write(secondPath, {
      sourceId: "source-b",
      clipId: "clip-b",
      trackId: "track-b",
      records: [{ tick: 0, bytes: [0x90, 61, 1] }]
    })
    const executeMidiImport = vi
      .fn()
      .mockResolvedValueOnce({
        workspace: {
          projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
          revision: 2,
          graph: { midiClips: [{ id: "clip-a" }] }
        }
      })
      .mockResolvedValueOnce({
        workspace: {
          projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
          revision: 3,
          graph: { midiClips: [{ id: "clip-a" }, { id: "clip-b" }] }
        }
      })
    const next = await commitMidiRecordingTakes(
      { executeMidiImport } as never,
      {
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 1,
        graph: { midiClips: [] }
      } as never,
      "recording:multi",
      0,
      [
        {
          trackId: "track-a",
          sourceId: "source-a",
          clipId: "clip-a",
          journalPath: firstPath,
          eventCount: 1,
          droppedEvents: 0
        },
        {
          trackId: "track-b",
          sourceId: "source-b",
          clipId: "clip-b",
          journalPath: secondPath,
          eventCount: 1,
          droppedEvents: 0
        }
      ],
      new Map([
        ["track-a", "A"],
        ["track-b", "B"]
      ])
    )
    expect(executeMidiImport).toHaveBeenCalledTimes(2)
    expect(executeMidiImport.mock.calls[0]![0]).toMatchObject({ expectedRevision: 1 })
    expect(executeMidiImport.mock.calls[1]![0]).toMatchObject({ expectedRevision: 2 })
    expect(next.revision).toBe(3)
  })
})
