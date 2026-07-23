import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type {
  CreateProjectRequest,
  ProjectCloseDisposition,
  ProjectConfiguration,
  ProjectQueryRequest,
  ProjectQueryResult,
  ProjectSession,
  ProjectTransactionRequest
} from "@yadaw/contracts"
import { PROJECT_SAMPLE_RATES } from "@yadaw/contracts"
import type { LargeObjectAssetInput } from "@yadaw/project-db/protocol"
import type { ApplicationSettingsStore } from "./application-settings"
import { ProjectWorkerClient } from "./project-worker-client"

interface WorkingCopyState {
  id: string
  projectPath: string
  configuration: ProjectConfiguration
  dirty: boolean
  archiveMtimeMs: number | null
  updatedAt: number
}

function workspaceId(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath).toLowerCase()).digest("hex").slice(0, 24)
}

function validateConfiguration(value: CreateProjectRequest): ProjectConfiguration {
  if (!value.name.trim()) throw new TypeError("Project name cannot be empty")
  if (!PROJECT_SAMPLE_RATES.includes(value.sampleRate)) throw new TypeError("Unsupported sample rate")
  if (!Number.isFinite(value.tempo) || value.tempo <= 0) throw new TypeError("Tempo must be positive")
  if (!Number.isInteger(value.timeSignatureNumerator) || value.timeSignatureNumerator < 1 || value.timeSignatureNumerator > 32) {
    throw new TypeError("Invalid time signature numerator")
  }
  if (![1, 2, 4, 8, 16, 32].includes(value.timeSignatureDenominator)) {
    throw new TypeError("Invalid time signature denominator")
  }
  return {
    name: value.name.trim(),
    sampleRate: value.sampleRate,
    tempo: value.tempo,
    timeSignatureNumerator: value.timeSignatureNumerator,
    timeSignatureDenominator: value.timeSignatureDenominator
  }
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export class ProjectService {
  private readonly worker = new ProjectWorkerClient(new URL(/* @vite-ignore */ "./project-worker.mjs", import.meta.url))
  private session: ProjectSession | null = null
  private workingRoot: string | null = null

  constructor(
    private readonly userData: string,
    private readonly settings: ApplicationSettingsStore
  ) {}

  get current(): ProjectSession | null {
    return this.session ? structuredClone(this.session) : null
  }

  private async writeState(state: WorkingCopyState): Promise<void> {
    if (!this.workingRoot) throw new Error("No project is open")
    const path = join(this.workingRoot, "session.json")
    await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(`${path}.tmp`, path)
  }

  private async stateFromDatabase(id: string, projectPath: string, recoveredWorkingCopy: boolean): Promise<ProjectSession> {
    const result = await this.worker.query({
      sql: `SELECT name, sample_rate, tempo, time_signature_numerator, time_signature_denominator
            FROM project WHERE id = 'project'`,
      params: [],
      method: "all"
    })
    const row = result.rows[0]
    if (!row) throw new Error("Project configuration is missing")
    return {
      id,
      path: projectPath,
      configuration: {
        name: String(row[0]),
        sampleRate: Number(row[1]) as ProjectConfiguration["sampleRate"],
        tempo: Number(row[2]),
        timeSignatureNumerator: Number(row[3]),
        timeSignatureDenominator: Number(row[4])
      },
      dirty: recoveredWorkingCopy,
      recoveredWorkingCopy
    }
  }

  async create(request: CreateProjectRequest & { path: string }): Promise<ProjectSession> {
    if (this.session) throw new Error("Close the current project before creating another")
    const configuration = validateConfiguration(request)
    const projectPath = resolve(request.path.endsWith(".yadaw") ? request.path : `${request.path}.yadaw`)
    const id = workspaceId(projectPath)
    this.workingRoot = join(this.userData, "workspaces", id)
    await rm(this.workingRoot, { recursive: true, force: true })
    await mkdir(this.workingRoot, { recursive: true })
    await this.worker.create(join(this.workingRoot, "pgdata"), {
      name: configuration.name,
      sampleRate: configuration.sampleRate,
      tempo: configuration.tempo,
      numerator: configuration.timeSignatureNumerator,
      denominator: configuration.timeSignatureDenominator
    })
    this.session = { id, path: projectPath, configuration, dirty: true, recoveredWorkingCopy: false }
    await this.persistCurrentState()
    await this.settings.addRecent(projectPath, configuration.name)
    return structuredClone(this.session)
  }

  async hasRecoverableWorkingCopy(projectPathValue: string): Promise<boolean> {
    const projectPath = resolve(projectPathValue)
    const id = workspaceId(projectPath)
    try {
      const previous = JSON.parse(
        await readFile(join(this.userData, "workspaces", id, "session.json"), "utf8")
      ) as WorkingCopyState
      return previous.dirty &&
        previous.projectPath === projectPath &&
        previous.archiveMtimeMs === await fileMtime(projectPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async open(projectPathValue: string, recoverWorkingCopy = true): Promise<ProjectSession> {
    if (this.session) throw new Error("Close the current project before opening another")
    const projectPath = resolve(projectPathValue)
    const id = workspaceId(projectPath)
    this.workingRoot = join(this.userData, "workspaces", id)
    const statePath = join(this.workingRoot, "session.json")
    let previous: WorkingCopyState | null = null
    try {
      previous = JSON.parse(await readFile(statePath, "utf8")) as WorkingCopyState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const archiveMtimeMs = await fileMtime(projectPath)
    const recover = recoverWorkingCopy && Boolean(
      previous?.dirty &&
      previous.projectPath === projectPath &&
      previous.archiveMtimeMs === archiveMtimeMs
    )
    if (recover) {
      await this.worker.open(join(this.workingRoot, "pgdata"))
    } else {
      await rm(this.workingRoot, { recursive: true, force: true })
      await mkdir(this.workingRoot, { recursive: true })
      await this.worker.open(join(this.workingRoot, "pgdata"), projectPath)
    }
    this.session = await this.stateFromDatabase(id, projectPath, recover)
    await this.persistCurrentState()
    await this.settings.addRecent(projectPath, this.session.configuration.name)
    return structuredClone(this.session)
  }

  async query(request: ProjectQueryRequest): Promise<ProjectQueryResult> {
    if (!this.session) throw new Error("No project is open")
    const result = await this.worker.query(request)
    if (request.method === "execute") {
      await this.refreshSessionConfiguration()
      await this.markDirty()
    }
    return result
  }

  async transaction(request: ProjectTransactionRequest): Promise<ProjectQueryResult[]> {
    if (!this.session) throw new Error("No project is open")
    const result = await this.worker.transaction(request)
    if (request.queries.some((query) => query.method === "execute")) {
      await this.refreshSessionConfiguration()
      await this.markDirty()
    }
    return result
  }

  private async refreshSessionConfiguration(): Promise<void> {
    if (!this.session) return
    const refreshed = await this.stateFromDatabase(this.session.id, this.session.path, this.session.recoveredWorkingCopy)
    this.session.configuration = refreshed.configuration
  }

  async importLargeObject(
    filePath: string,
    operationId: string,
    asset: LargeObjectAssetInput,
    onProgress: (completed: number, total: number) => void
  ): Promise<number> {
    if (!this.session) throw new Error("No project is open")
    // Persist the dirty working-copy marker before starting the LO transaction.
    // This keeps the post-commit path free of filesystem work and guarantees that
    // a process exit immediately after commit will offer working-copy recovery.
    await this.markDirty()
    this.worker.onProgress = (progress) => {
      if (progress.operationId === operationId) onProgress(progress.completed, progress.total)
    }
    try {
      return await this.worker.importLargeObject(filePath, operationId, asset)
    } finally {
      this.worker.onProgress = null
    }
  }

  readAssetAudio(assetId: string): Promise<Uint8Array> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.readLargeObject(assetId)
  }

  cancelOperation(operationId: string): Promise<void> {
    return this.worker.cancel(operationId)
  }

  private async markDirty(): Promise<void> {
    if (!this.session || this.session.dirty) return
    this.session.dirty = true
    await this.persistCurrentState()
  }

  private async persistCurrentState(): Promise<void> {
    if (!this.session) return
    await this.writeState({
      id: this.session.id,
      projectPath: this.session.path,
      configuration: this.session.configuration,
      dirty: this.session.dirty,
      archiveMtimeMs: await fileMtime(this.session.path),
      updatedAt: Date.now()
    })
  }

  async save(path?: string): Promise<ProjectSession> {
    if (!this.session) throw new Error("No project is open")
    if (path) this.session.path = resolve(path.endsWith(".yadaw") ? path : `${path}.yadaw`)
    const target = this.session.path
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    const backup = `${target}.bak`
    await this.worker.dump(temporary)
    const targetExists = await fileMtime(target) !== null
    try {
      if (targetExists) {
        await rm(backup, { force: true })
        await rename(target, backup)
      }
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      if (targetExists && await fileMtime(target) === null && await fileMtime(backup) !== null) {
        await rename(backup, target)
      }
      throw error
    }
    this.session.dirty = false
    this.session.recoveredWorkingCopy = false
    await this.persistCurrentState()
    await this.settings.addRecent(target, this.session.configuration.name)
    return structuredClone(this.session)
  }

  async close(disposition: ProjectCloseDisposition): Promise<boolean> {
    if (!this.session) return true
    if (this.session.dirty && disposition === "cancel") return false
    if (this.session.dirty && disposition === "save") await this.save()
    await this.worker.close()
    if (disposition === "discard" && this.workingRoot) {
      await rm(join(this.workingRoot, "pgdata"), { recursive: true, force: true })
      const statePath = join(this.workingRoot, "session.json")
      await rm(statePath, { force: true })
    }
    this.session = null
    this.workingRoot = null
    return true
  }

  async shutdown(): Promise<void> {
    await this.worker.terminate()
  }
}
