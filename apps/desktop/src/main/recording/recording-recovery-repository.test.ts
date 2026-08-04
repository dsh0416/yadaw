import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RecordingRecoveryRepository } from "./recording-recovery-repository"

describe("RecordingRecoveryRepository", () => {
  let directory: string
  const repository = new RecordingRecoveryRepository()

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("writes sidecars atomically and reads them back", async () => {
    directory = await mkdtemp(join(tmpdir(), "recording-recovery-"))
    const record = {
      id: "rec-1",
      audioPath: join(directory, "rec-1.partial.bwf"),
      sidecarPath: join(directory, "rec-1.recording.json"),
      finalPath: null
    }

    await repository.write(record)

    await expect(repository.read(directory, "rec-1")).resolves.toEqual(record)
    await expect(readFile(record.sidecarPath, "utf8")).resolves.toContain('"id": "rec-1"')
  })

  it("lists recoverable sidecars and skips malformed ones", async () => {
    directory = await mkdtemp(join(tmpdir(), "recording-recovery-"))
    const good = {
      id: "good",
      audioPath: join(directory, "good.partial.bwf"),
      sidecarPath: join(directory, "good.recording.json"),
      finalPath: null
    }
    await repository.write(good)
    await writeFile(join(directory, "bad.recording.json"), "{broken", "utf8")
    await writeFile(join(directory, "notes.txt"), "ignore", "utf8")

    await expect(repository.list(directory)).resolves.toEqual([good])
  })

  it("returns an empty list when the swap directory is missing", async () => {
    await expect(repository.list(join(tmpdir(), "missing-swap-dir"))).resolves.toEqual([])
  })

  it("removes audio, finals, track finals, and the sidecar", async () => {
    directory = await mkdtemp(join(tmpdir(), "recording-recovery-"))
    const audioPath = join(directory, "audio.bwf")
    const finalPath = join(directory, "final.bwf")
    const trackFinal = join(directory, "track.bwf")
    const sidecarPath = join(directory, "rec.recording.json")
    await writeFile(audioPath, "a")
    await writeFile(finalPath, "f")
    await writeFile(trackFinal, "t")
    await writeFile(sidecarPath, "{}")

    await repository.remove({
      id: "rec",
      audioPath,
      sidecarPath,
      finalPath,
      tracks: [{ finalPath: trackFinal }, { finalPath }]
    })

    await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(trackFinal)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("propagates unexpected directory read errors", async () => {
    directory = await mkdtemp(join(tmpdir(), "recording-recovery-"))
    const filePath = join(directory, "not-a-directory")
    await writeFile(filePath, "x")

    await expect(repository.list(filePath)).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  it("removes MIDI journals alongside audio artifacts", async () => {
    directory = await mkdtemp(join(tmpdir(), "recording-recovery-midi-"))
    const audioPath = join(directory, "audio.bwf")
    const journalPath = join(directory, "take.midijournal")
    const missingJournal = join(directory, "missing.midijournal")
    const sidecarPath = join(directory, "rec.recording.json")
    await writeFile(audioPath, "a")
    await writeFile(journalPath, "j")
    await writeFile(sidecarPath, "{}")

    await repository.remove({
      id: "rec",
      audioPath,
      sidecarPath,
      finalPath: null,
      midiTakes: [{ journalPath }, { journalPath: missingJournal }]
    })

    await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(journalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
