import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

type ArchiveCommitStage = "preparing" | "dumped" | "backup-created" | "committed"

interface ArchiveCommitRecord {
  version: 1
  operationId: string
  stage: ArchiveCommitStage
  target: string
  temporary: string
  backup: string
  targetExisted: boolean
}

export interface ArchiveCommitRequest {
  operationId: string
  target: string
  temporary: string
  backup: string
  dump(path: string): Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function isRecord(value: unknown): value is ArchiveCommitRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<ArchiveCommitRecord>
  return (
    record.version === 1 &&
    typeof record.operationId === "string" &&
    ["preparing", "dumped", "backup-created", "committed"].includes(record.stage ?? "") &&
    typeof record.target === "string" &&
    typeof record.temporary === "string" &&
    typeof record.backup === "string" &&
    typeof record.targetExisted === "boolean"
  )
}

export class ProjectArchiveJournal {
  private readonly directory: string
  private recovery: Promise<void> | null = null

  constructor(userData: string) {
    this.directory = join(userData, "project-operation-journal")
  }

  recover(): Promise<void> {
    this.recovery ??= this.recoverNow()
    return this.recovery
  }

  async commit(request: ArchiveCommitRequest): Promise<void> {
    await this.recover()
    await mkdir(this.directory, { recursive: true })
    const journalPath = this.journalPath(request.operationId)
    let record: ArchiveCommitRecord = {
      version: 1,
      operationId: request.operationId,
      stage: "preparing",
      target: request.target,
      temporary: request.temporary,
      backup: request.backup,
      targetExisted: await exists(request.target)
    }
    await this.write(journalPath, record)
    try {
      await request.dump(record.temporary)
      record = { ...record, stage: "dumped" }
      await this.write(journalPath, record)
      if (record.targetExisted) {
        await rm(record.backup, { force: true })
        await rename(record.target, record.backup)
        record = { ...record, stage: "backup-created" }
        await this.write(journalPath, record)
      }
      await rename(record.temporary, record.target)
      record = { ...record, stage: "committed" }
      await this.write(journalPath, record)
      await rm(journalPath, { force: true })
    } catch (error) {
      const committed =
        (record.stage === "backup-created" || record.stage === "committed") &&
        (await exists(record.target)) &&
        !(await exists(record.temporary))
      if (committed) {
        await rm(journalPath, { force: true })
        return
      }
      await this.rollback(record)
      await rm(journalPath, { force: true })
      throw error
    }
  }

  private async recoverNow(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const path = join(this.directory, name)
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"))
        if (!isRecord(value)) {
          await rm(path, { force: true })
          continue
        }
        const committed =
          (value.stage === "backup-created" || value.stage === "committed") &&
          (await exists(value.target)) &&
          !(await exists(value.temporary))
        if (!committed) await this.rollback(value)
        await rm(path, { force: true })
      } catch (error) {
        console.error(`Could not recover project archive journal '${path}'`, error)
      }
    }
  }

  private async rollback(record: ArchiveCommitRecord): Promise<void> {
    await rm(record.temporary, { force: true })
    if (record.targetExisted && !(await exists(record.target)) && (await exists(record.backup))) {
      await rename(record.backup, record.target)
    }
  }

  private journalPath(operationId: string): string {
    const safeId = operationId.replace(/[^a-zA-Z0-9_-]/g, "_")
    return join(this.directory, `${safeId}.json`)
  }

  private async write(path: string, record: ArchiveCommitRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.${basename(path)}.tmp`)
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await rename(temporary, path)
  }
}
