import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type {
  CreateProjectRequest,
  MixerGraphSnapshot,
  ProjectAssetSummary,
  ProjectCloseDisposition,
  ProjectCommand,
  ProjectConfiguration,
  ProjectSession
} from "@yadaw/contracts"
import { PROJECT_SAMPLE_RATES } from "@yadaw/contracts"
import type {
  AssetContentHash,
  DefaultRecordingTrack,
  LargeObjectAssetInput,
  MidiSourceInput,
  PluginStateInput,
  StoredWaveformWindow,
  WaveformAssetInput
} from "@yadaw/project-db/protocol"
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

interface ProjectOpenProgress {
  phase: "loading-project-archive" | "loading-project-database" | "restoring-project-state"
  completedUnits: number
}

function workspaceId(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath).toLowerCase()).digest("hex").slice(0, 24)
}

function commandChangesConfiguration(command: ProjectCommand): boolean {
  if (command.type === "replace-tempo-map") return true
  return command.type === "batch" && command.commands.some(commandChangesConfiguration)
}

function validateConfiguration(value: CreateProjectRequest): ProjectConfiguration {
  if (!value.name.trim()) throw new TypeError("Project name cannot be empty")
  if (!PROJECT_SAMPLE_RATES.includes(value.sampleRate))
    throw new TypeError("Unsupported sample rate")
  if (
    !Number.isInteger(value.timeSignatureNumerator) ||
    value.timeSignatureNumerator < 1 ||
    value.timeSignatureNumerator > 32
  ) {
    throw new TypeError("Invalid time signature numerator")
  }
  if (![1, 2, 4, 8, 16, 32].includes(value.timeSignatureDenominator)) {
    throw new TypeError("Invalid time signature denominator")
  }
  if (value.waveformDisplayMode !== "separate" && value.waveformDisplayMode !== "aggregate") {
    throw new TypeError("Invalid waveform display mode")
  }
  return {
    name: value.name.trim(),
    sampleRate: value.sampleRate,
    timeSignatureNumerator: value.timeSignatureNumerator,
    timeSignatureDenominator: value.timeSignatureDenominator,
    waveformDisplayMode: value.waveformDisplayMode
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
  private readonly worker = new ProjectWorkerClient(
    new URL(/* @vite-ignore */ "./project-worker.mjs", import.meta.url)
  )
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

  private async stateFromDatabase(
    id: string,
    projectPath: string,
    recoveredWorkingCopy: boolean
  ): Promise<ProjectSession> {
    return {
      id,
      path: projectPath,
      configuration: await this.worker.getConfiguration(),
      dirty: recoveredWorkingCopy,
      recoveredWorkingCopy
    }
  }

  async create(request: CreateProjectRequest & { path: string }): Promise<ProjectSession> {
    if (this.session) throw new Error("Close the current project before creating another")
    const configuration = validateConfiguration(request)
    const projectPath = resolve(
      request.path.endsWith(".yadaw") ? request.path : `${request.path}.yadaw`
    )
    const id = workspaceId(projectPath)
    this.workingRoot = join(this.userData, "workspaces", id)
    await rm(this.workingRoot, { recursive: true, force: true })
    await mkdir(this.workingRoot, { recursive: true })
    await this.worker.create(join(this.workingRoot, "pgdata"), {
      name: configuration.name,
      sampleRate: configuration.sampleRate,
      numerator: configuration.timeSignatureNumerator,
      denominator: configuration.timeSignatureDenominator,
      waveformDisplayMode: configuration.waveformDisplayMode
    })
    this.session = {
      id,
      path: projectPath,
      configuration,
      dirty: true,
      recoveredWorkingCopy: false
    }
    await this.persistCurrentState()
    // Initialize the .yadaw archive immediately so closing or discarding the
    // session still leaves a loadable project file on disk.
    return this.save()
  }

  async hasRecoverableWorkingCopy(projectPathValue: string): Promise<boolean> {
    const projectPath = resolve(projectPathValue)
    const id = workspaceId(projectPath)
    try {
      const previous = JSON.parse(
        await readFile(join(this.userData, "workspaces", id, "session.json"), "utf8")
      ) as WorkingCopyState
      return (
        previous.dirty &&
        previous.projectPath === projectPath &&
        previous.archiveMtimeMs === (await fileMtime(projectPath))
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async open(
    projectPathValue: string,
    recoverWorkingCopy = true,
    onProgress?: (progress: ProjectOpenProgress) => void
  ): Promise<ProjectSession> {
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
    const recover =
      recoverWorkingCopy &&
      Boolean(
        previous?.dirty &&
        previous.projectPath === projectPath &&
        previous.archiveMtimeMs === archiveMtimeMs
      )
    onProgress?.({
      phase: recover ? "loading-project-database" : "loading-project-archive",
      completedUnits: 0
    })
    if (recover) {
      await this.worker.open(join(this.workingRoot, "pgdata"))
    } else {
      await rm(this.workingRoot, { recursive: true, force: true })
      await mkdir(this.workingRoot, { recursive: true })
      await this.worker.open(join(this.workingRoot, "pgdata"), projectPath)
    }
    onProgress?.({ phase: "restoring-project-state", completedUnits: 1 })
    this.session = await this.stateFromDatabase(id, projectPath, recover)
    await this.persistCurrentState()
    await this.settings.addRecent(projectPath, this.session.configuration.name)
    return structuredClone(this.session)
  }

  listAssets(): Promise<ProjectAssetSummary[]> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.listAssets()
  }

  async updateConfiguration(configuration: ProjectConfiguration): Promise<ProjectSession> {
    if (!this.session) throw new Error("No project is open")
    this.session.configuration = await this.worker.updateConfiguration(
      validateConfiguration(configuration)
    )
    await this.completeMutation(true)
    return structuredClone(this.session)
  }

  mixerSnapshot(): Promise<MixerGraphSnapshot> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.mixerSnapshot()
  }

  async applyProjectCommand(command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    await this.worker.applyProjectCommand(command, fallbackOutputId)
    await this.completeMutation(commandChangesConfiguration(command))
  }

  async importMidi(
    source: MidiSourceInput,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    await this.worker.importMidi(source, command, fallbackOutputId)
    await this.completeMutation(commandChangesConfiguration(command))
  }

  async rollbackMidi(
    sourceId: string,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    await this.worker.rollbackMidi(sourceId, command, fallbackOutputId)
    await this.completeMutation(commandChangesConfiguration(command))
  }

  async savePluginStates(states: PluginStateInput[]): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    if (states.length === 0) return
    await this.worker.savePluginStates(states)
    await this.completeMutation(false)
  }

  assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.assetContentHashes(ids)
  }

  defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.defaultRecordingTrack()
  }

  assetsMissingWaveform(cacheVersion = 1): Promise<string[]> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.assetsMissingWaveform(cacheVersion)
  }

  async deleteAssets(ids: string[]): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    if (ids.length === 0) return
    await this.worker.deleteAssets(ids)
    await this.completeMutation(false)
  }

  private async refreshSessionConfiguration(): Promise<void> {
    if (!this.session) return
    const refreshed = await this.stateFromDatabase(
      this.session.id,
      this.session.path,
      this.session.recoveredWorkingCopy
    )
    this.session.configuration = refreshed.configuration
  }

  private async completeMutation(refreshConfiguration: boolean): Promise<void> {
    if (!this.session) return
    if (refreshConfiguration) await this.refreshSessionConfiguration()
    const wasDirty = this.session.dirty
    this.session.dirty = true
    if (!wasDirty || refreshConfiguration) await this.persistCurrentState()
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

  readAssetWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.readWaveform(assetId, startFrame, endFrame, maxBuckets)
  }

  storeAssetWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    if (!this.session) throw new Error("No project is open")
    return this.worker.storeWaveform(assetId, waveform).then(() => this.markDirty())
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
    const originalPath = this.session.path
    if (path) this.session.path = resolve(path.endsWith(".yadaw") ? path : `${path}.yadaw`)
    const target = this.session.path
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    const backup = `${target}.bak`
    await this.worker.dump(temporary)
    const targetExists = (await fileMtime(target)) !== null
    try {
      if (targetExists) {
        await rm(backup, { force: true })
        await rename(target, backup)
      }
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      if (
        targetExists &&
        (await fileMtime(target)) === null &&
        (await fileMtime(backup)) !== null
      ) {
        await rename(backup, target)
      }
      this.session.path = originalPath
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

  async abortOpen(): Promise<void> {
    if (!this.session) return
    await this.worker.close()
    this.session = null
    this.workingRoot = null
  }

  async shutdown(): Promise<void> {
    await this.worker.terminate()
  }
}
