import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { recoverMidiJournalTake } from "@heron/dsp-node"
import { MidiJournalWriter } from "./midi-recording-commit.fixture"

describe("recoverMidiJournalTake", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it("rejects a negative start tick and a missing journal", () => {
    expect(() => recoverMidiJournalTake("/missing.midijournal", -1)).toThrow(
      /non-negative|not found/i
    )
    expect(() => recoverMidiJournalTake("/definitely-missing.midijournal", 0)).toThrow(/not found/i)
  })

  it("maps notes and non-note event kinds from a journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-midi-recover-napi-"))
    directories.push(directory)
    const journalPath = join(directory, "take.midijournal")
    await MidiJournalWriter.write(journalPath, {
      sourceId: "source-1",
      clipId: "clip-1",
      trackId: "track-1",
      records: [
        { tick: 0, bytes: [0x90, 60, 100] },
        { tick: 480, bytes: [0x80, 60, 40] },
        { tick: 480, bytes: [0xb0, 7, 64] },
        { tick: 480, bytes: [0xe0, 0x00, 0x40] },
        { tick: 480, bytes: [0xc0, 12] },
        { tick: 480, bytes: [0xd0, 70] },
        { tick: 480, bytes: [0xa0, 61, 30] },
        { tick: 480, bytes: [0xf0, 1, 2, 0xf7] }
      ]
    })

    const take = recoverMidiJournalTake(journalPath, 0)
    expect(take).toMatchObject({
      sourceId: "source-1",
      clipId: "clip-1",
      trackId: "track-1",
      // Notes end at 480; non-note events at tick 480 extend length to tick+1.
      lengthTicks: 481,
      ignoredCorruptTail: false
    })
    expect(take.notes).toHaveLength(1)
    expect(take.notes[0]).toMatchObject({
      startTick: 0,
      durationTicks: 480,
      key: 60,
      velocity: 100,
      releaseVelocity: 40
    })
    expect(take.events.map((event) => event.kind).sort()).toEqual(
      [
        "channel-pressure",
        "control-change",
        "pitch-bend",
        "poly-pressure",
        "program-change",
        "sysex"
      ].sort()
    )
  })

  it("propagates a corrupt journal tail flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-midi-recover-tail-"))
    directories.push(directory)
    const journalPath = join(directory, "take.midijournal")
    await MidiJournalWriter.write(journalPath, {
      sourceId: "source-1",
      clipId: "clip-1",
      trackId: "track-1",
      records: [{ tick: 0, bytes: [0xb0, 1, 2] }]
    })
    await writeFile(journalPath, Buffer.from([1, 2, 3]), { flag: "a" })
    const take = recoverMidiJournalTake(journalPath, 0)
    expect(take.ignoredCorruptTail).toBe(true)
    expect(take.events).toHaveLength(1)
  })
})
