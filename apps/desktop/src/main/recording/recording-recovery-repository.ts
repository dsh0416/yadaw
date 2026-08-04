import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RecordingSidecarRecord {
  id: string
  audioPath: string
  sidecarPath: string
  finalPath: string | null
  tracks?: { finalPath: string | null }[]
  midiTakes?: { journalPath: string }[]
}

export class RecordingRecoveryRepository {
  async write(recording: RecordingSidecarRecord): Promise<void> {
    const temporary = `${recording.sidecarPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(recording, null, 2)}\n`, "utf8")
    await rename(temporary, recording.sidecarPath)
  }

  async read<T extends RecordingSidecarRecord>(swapDirectory: string, id: string): Promise<T> {
    const path = join(swapDirectory, `${id}.recording.json`)
    return JSON.parse(await readFile(path, "utf8")) as T
  }

  async list<T extends RecordingSidecarRecord>(swapDirectory: string): Promise<T[]> {
    let files: string[]
    try {
      files = await readdir(swapDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const records: T[] = []
    for (const file of files.filter((name) => name.endsWith(".recording.json"))) {
      try {
        records.push(JSON.parse(await readFile(join(swapDirectory, file), "utf8")) as T)
      } catch {
        // Preserve malformed sidecars for explicit manual inspection.
      }
    }
    return records
  }

  async remove(recording: RecordingSidecarRecord): Promise<void> {
    await Promise.all([
      recording.audioPath ? rm(recording.audioPath, { force: true }) : Promise.resolve(),
      recording.finalPath ? rm(recording.finalPath, { force: true }) : Promise.resolve(),
      ...(recording.tracks ?? [])
        .filter((track) => track.finalPath && track.finalPath !== recording.finalPath)
        .map((track) => rm(track.finalPath!, { force: true })),
      ...(recording.midiTakes ?? []).map((take) => rm(take.journalPath, { force: true })),
      rm(recording.sidecarPath, { force: true })
    ])
  }
}
