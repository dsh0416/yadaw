import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import type {
  CreateProjectRequest,
  ProjectGraphSnapshot,
  ProjectAssetSummary,
  ProjectCloseDisposition,
  ProjectCommand,
  ProjectConfiguration,
  ProjectSession
} from "@heron/contracts"
import { PROJECT_SAMPLE_RATES } from "@heron/contracts"
import type {
  AssetContentHash,
  CommittedProjectCommand,
  DefaultRecordingTrack,
  LargeObjectAssetInput,
  MidiSourceInput,
  PluginStateInput,
  PreparedProjectCommand,
  ProjectCommandTransactionToken,
  ProjectCommandTransactionStatus,
  StoredWaveformWindow,
  WaveformAssetInput
} from "@heron/project-db/protocol"
import type { ApplicationSettingsStore } from "./application-settings"
import type { ProjectAssetReader } from "./asset-materializer"
import { ProjectArchiveJournal } from "./project-archive-journal"
import { ProjectWorkerClient } from "./project-worker-client"

interface WorkingCopyState {
  id: string
  projectPath: string
  configuration: ProjectConfiguration
  dirty: boolean
  archiveMtimeMs: number | null
  updatedAt: number
}

interface ProjectLoadProgress {
  phase:
    | "committing-database"
    | "saving-archive"
    | "loading-project-archive"
    | "loading-project-database"
    | "restoring-project-state"
  completedUnits: number
}

interface ProjectContext {
  worker: ProjectWorkerClient
  session: ProjectSession
  workingRoot: string
}

export const PROJECT_FILE_EXTENSION = ".heron"
export const PROJECT_FILE_FILTER_EXTENSION = "heron"

export function isProjectFilePath(path: string): boolean {
  return extname(path).toLowerCase() === PROJECT_FILE_EXTENSION
}

function resolveProjectFilePath(path: string): string {
  const resolved = resolve(path)
  const extension = extname(resolved).toLowerCase()
  if (extension === "") return `${resolved}${PROJECT_FILE_EXTENSION}`
  if (extension !== PROJECT_FILE_EXTENSION) {
    throw new TypeError(`Project path must use the ${PROJECT_FILE_EXTENSION} extension`)
  }
  return resolved
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
  private readonly workerUrl = new URL(/* @vite-ignore */ "./project-worker.mjs", import.meta.url)
  private readonly archiveJournal: ProjectArchiveJournal
  private active: ProjectContext | null = null
  private candidate: ProjectContext | null = null

  constructor(
    private readonly userData: string,
    private readonly settings: ApplicationSettingsStore
  ) {
    this.archiveJournal = new ProjectArchiveJournal(userData)
  }

  get current(): ProjectSession | null {
    return this.active ? structuredClone(this.active.session) : null
  }

  private requireActive(): ProjectContext {
    if (!this.active) throw new Error("No project is open")
    return this.active
  }

  private requireCandidate(): ProjectContext {
    if (!this.candidate) throw new Error("No project candidate is prepared")
    return this.candidate
  }

  private async writeState(context: ProjectContext, state: WorkingCopyState): Promise<void> {
    const path = join(context.workingRoot, "session.json")
    await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(`${path}.tmp`, path)
  }

  private async stateFromDatabase(
    worker: ProjectWorkerClient,
    id: string,
    projectPath: string,
    recoveredWorkingCopy: boolean
  ): Promise<ProjectSession> {
    return {
      id,
      path: projectPath,
      configuration: await worker.getConfiguration(),
      dirty: recoveredWorkingCopy,
      recoveredWorkingCopy
    }
  }

  private assertCanPrepare(): void {
    if (this.active) throw new Error("Close the current project before opening another")
    if (this.candidate) throw new Error("A project candidate is already being prepared")
  }

  async prepareCreate(
    request: CreateProjectRequest & { path: string },
    onProgress?: (progress: ProjectLoadProgress) => void
  ): Promise<ProjectSession> {
    await this.archiveJournal.recover()
    this.assertCanPrepare()
    const configuration = validateConfiguration(request)
    const projectPath = resolveProjectFilePath(request.path)
    const id = workspaceId(projectPath)
    const context: ProjectContext = {
      worker: new ProjectWorkerClient(this.workerUrl),
      workingRoot: join(this.userData, "workspaces", id),
      session: {
        id,
        path: projectPath,
        configuration,
        dirty: true,
        recoveredWorkingCopy: false
      }
    }
    this.candidate = context
    try {
      onProgress?.({ phase: "committing-database", completedUnits: 0 })
      await rm(context.workingRoot, { recursive: true, force: true })
      await mkdir(context.workingRoot, { recursive: true })
      await context.worker.create(join(context.workingRoot, "pgdata"), {
        name: configuration.name,
        sampleRate: configuration.sampleRate,
        numerator: configuration.timeSignatureNumerator,
        denominator: configuration.timeSignatureDenominator,
        waveformDisplayMode: configuration.waveformDisplayMode
      })
      onProgress?.({ phase: "saving-archive", completedUnits: 1 })
      await this.persistContextState(context)
      // Initialize the .heron archive before commit so a successful create
      // always returns a durable, loadable project.
      await this.saveContext(context)
      return structuredClone(context.session)
    } catch (error) {
      await this.abortCandidate()
      throw error
    }
  }

  async create(
    request: CreateProjectRequest & { path: string },
    onProgress?: (progress: ProjectLoadProgress) => void
  ): Promise<ProjectSession> {
    await this.prepareCreate(request, onProgress)
    return this.commitCandidate()
  }

  async hasRecoverableWorkingCopy(projectPathValue: string): Promise<boolean> {
    if (!isProjectFilePath(projectPathValue)) {
      throw new TypeError(`Project path must use the ${PROJECT_FILE_EXTENSION} extension`)
    }
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

  async prepareOpen(
    projectPathValue: string,
    recoverWorkingCopy = true,
    onProgress?: (progress: ProjectLoadProgress) => void
  ): Promise<ProjectSession> {
    if (!isProjectFilePath(projectPathValue)) {
      throw new TypeError(`Project path must use the ${PROJECT_FILE_EXTENSION} extension`)
    }
    await this.archiveJournal.recover()
    this.assertCanPrepare()
    const projectPath = resolve(projectPathValue)
    const id = workspaceId(projectPath)
    const workingRoot = join(this.userData, "workspaces", id)
    const statePath = join(workingRoot, "session.json")
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
    const worker = new ProjectWorkerClient(this.workerUrl)
    try {
      if (recover) {
        await worker.open(join(workingRoot, "pgdata"))
      } else {
        await rm(workingRoot, { recursive: true, force: true })
        await mkdir(workingRoot, { recursive: true })
        await worker.open(join(workingRoot, "pgdata"), projectPath)
      }
      onProgress?.({ phase: "restoring-project-state", completedUnits: 1 })
      const session = await this.stateFromDatabase(worker, id, projectPath, recover)
      const context = { worker, session, workingRoot }
      this.candidate = context
      await this.persistContextState(context)
      onProgress?.({ phase: "restoring-project-state", completedUnits: 2 })
      return structuredClone(session)
    } catch (error) {
      await worker.terminate().catch(() => undefined)
      throw error
    }
  }

  async open(
    projectPathValue: string,
    recoverWorkingCopy = true,
    onProgress?: (progress: ProjectLoadProgress) => void
  ): Promise<ProjectSession> {
    await this.prepareOpen(projectPathValue, recoverWorkingCopy, onProgress)
    return this.commitCandidate()
  }

  commitCandidate(): ProjectSession {
    const candidate = this.requireCandidate()
    this.active = candidate
    this.candidate = null
    return structuredClone(candidate.session)
  }

  async abortCandidate(): Promise<void> {
    const candidate = this.candidate
    this.candidate = null
    if (candidate) await candidate.worker.terminate()
  }

  async quarantineActiveCandidate(): Promise<void> {
    const active = this.active
    this.active = null
    if (active) await active.worker.terminate()
  }

  candidateMixerSnapshot(): Promise<ProjectGraphSnapshot> {
    return this.requireCandidate().worker.mixerSnapshot()
  }

  candidateAssets(): Promise<ProjectAssetSummary[]> {
    return this.requireCandidate().worker.listAssets()
  }

  candidateAssetReader(): ProjectAssetReader {
    const worker = this.requireCandidate().worker
    return {
      assetContentHashes: (ids) => worker.assetContentHashes(ids),
      readAssetAudio: (assetId) => worker.readLargeObject(assetId)
    }
  }

  activeAssetReader(): ProjectAssetReader {
    const worker = this.requireActive().worker
    return {
      assetContentHashes: (ids) => worker.assetContentHashes(ids),
      readAssetAudio: (assetId) => worker.readLargeObject(assetId)
    }
  }

  listAssets(): Promise<ProjectAssetSummary[]> {
    return this.requireActive().worker.listAssets()
  }

  async updateConfiguration(configuration: ProjectConfiguration): Promise<ProjectSession> {
    const context = this.requireActive()
    context.session.configuration = await context.worker.updateConfiguration(
      validateConfiguration(configuration)
    )
    await this.completeMutation(true)
    return structuredClone(context.session)
  }

  mixerSnapshot(): Promise<ProjectGraphSnapshot> {
    return this.requireActive().worker.mixerSnapshot()
  }

  prepareProjectCommand(
    operationId: string,
    baseRevision: number,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<PreparedProjectCommand> {
    return this.requireActive().worker.prepareProjectCommand(
      operationId,
      baseRevision,
      command,
      fallbackOutputId
    )
  }

  async commitProjectCommand(
    token: ProjectCommandTransactionToken,
    command: ProjectCommand
  ): Promise<CommittedProjectCommand> {
    const committed = await this.requireActive().worker.commitProjectCommand(token)
    try {
      await this.completeMutation(commandChangesConfiguration(command))
    } catch (error) {
      console.error(
        "Project command committed but working-copy metadata could not be updated",
        error
      )
    }
    return committed
  }

  abortProjectCommand(token: ProjectCommandTransactionToken): Promise<void> {
    return this.requireActive().worker.abortProjectCommand(token)
  }

  projectCommandStatus(operationId: string): Promise<ProjectCommandTransactionStatus> {
    return this.requireActive().worker.projectCommandStatus(operationId)
  }

  async importMidi(
    source: MidiSourceInput,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    await this.requireActive().worker.importMidi(source, command, fallbackOutputId)
    await this.completeMutation(commandChangesConfiguration(command))
  }

  async rollbackMidi(
    sourceId: string,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    await this.requireActive().worker.rollbackMidi(sourceId, command, fallbackOutputId)
    await this.completeMutation(commandChangesConfiguration(command))
  }

  async savePluginStates(states: PluginStateInput[]): Promise<void> {
    if (states.length === 0) return
    await this.requireActive().worker.savePluginStates(states)
    await this.completeMutation(false)
  }

  assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    return this.requireActive().worker.assetContentHashes(ids)
  }

  defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    return this.requireActive().worker.defaultRecordingTrack()
  }

  assetsMissingWaveform(cacheVersion = 1): Promise<string[]> {
    return this.requireActive().worker.assetsMissingWaveform(cacheVersion)
  }

  async deleteAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.requireActive().worker.deleteAssets(ids)
    await this.completeMutation(false)
  }

  private async refreshSessionConfiguration(): Promise<void> {
    const context = this.active
    if (!context) return
    const refreshed = await this.stateFromDatabase(
      context.worker,
      context.session.id,
      context.session.path,
      context.session.recoveredWorkingCopy
    )
    context.session.configuration = refreshed.configuration
  }

  private async completeMutation(refreshConfiguration: boolean): Promise<void> {
    const context = this.active
    if (!context) return
    if (refreshConfiguration) await this.refreshSessionConfiguration()
    const wasDirty = context.session.dirty
    context.session.dirty = true
    if (!wasDirty || refreshConfiguration) await this.persistContextState(context)
  }

  async importLargeObject(
    filePath: string,
    operationId: string,
    asset: LargeObjectAssetInput,
    onProgress: (completed: number, total: number) => void
  ): Promise<number> {
    const context = this.requireActive()
    // Persist the dirty working-copy marker before starting the LO transaction.
    // This keeps the post-commit path free of filesystem work and guarantees that
    // a process exit immediately after commit will offer working-copy recovery.
    await this.markDirty()
    context.worker.onProgress = (progress) => {
      if (progress.operationId === operationId) onProgress(progress.completed, progress.total)
    }
    try {
      return await context.worker.importLargeObject(filePath, operationId, asset)
    } finally {
      context.worker.onProgress = null
    }
  }

  readAssetAudio(assetId: string): Promise<Uint8Array> {
    return this.requireActive().worker.readLargeObject(assetId)
  }

  readAssetWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    return this.requireActive().worker.readWaveform(assetId, startFrame, endFrame, maxBuckets)
  }

  storeAssetWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    return this.requireActive()
      .worker.storeWaveform(assetId, waveform)
      .then(() => this.markDirty())
  }

  cancelOperation(operationId: string): Promise<void> {
    return this.requireActive().worker.cancel(operationId)
  }

  async markExternalStateDirty(): Promise<boolean> {
    const context = this.active
    if (!context || context.session.dirty) return false
    await this.markDirty()
    return this.active === context && context.session.dirty
  }

  private async markDirty(): Promise<void> {
    const context = this.active
    if (!context || context.session.dirty) return
    context.session.dirty = true
    await this.persistContextState(context)
  }

  private async persistContextState(context: ProjectContext): Promise<void> {
    await this.writeState(context, {
      id: context.session.id,
      projectPath: context.session.path,
      configuration: context.session.configuration,
      dirty: context.session.dirty,
      archiveMtimeMs: await fileMtime(context.session.path),
      updatedAt: Date.now()
    })
  }

  private async saveContext(
    context: ProjectContext,
    path?: string,
    operationId = `project-save:${randomUUID()}`
  ): Promise<ProjectSession> {
    const target = path ? resolveProjectFilePath(path) : context.session.path
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    const backup = `${target}.bak`
    await this.archiveJournal.commit({
      operationId,
      target,
      temporary,
      backup,
      dump: (outputPath) => context.worker.dump(outputPath)
    })
    context.session.path = target
    context.session.dirty = false
    context.session.recoveredWorkingCopy = false
    await this.persistContextState(context)
    return structuredClone(context.session)
  }

  async save(path?: string, operationId?: string): Promise<ProjectSession> {
    const context = this.requireActive()
    const session = await this.saveContext(context, path, operationId)
    await this.settings.addRecent(session.path, session.configuration.name)
    return session
  }

  async recordCurrentAsRecent(): Promise<void> {
    const session = this.requireActive().session
    await this.settings.addRecent(session.path, session.configuration.name)
  }

  async prepareClose(disposition: ProjectCloseDisposition): Promise<boolean> {
    const context = this.active
    if (!context) return true
    if (context.session.dirty && disposition === "cancel") return false
    if (context.session.dirty && disposition === "save") await this.save()
    await context.worker.close()
    return true
  }

  async abortPreparedClose(): Promise<void> {
    const context = this.active
    if (!context) return
    await context.worker.open(join(context.workingRoot, "pgdata"))
  }

  async commitClose(disposition: ProjectCloseDisposition): Promise<boolean> {
    const context = this.requireActive()
    this.active = null
    let cleanupSucceeded = true
    try {
      await context.worker.terminate()
    } catch {
      cleanupSucceeded = false
    }
    if (disposition === "discard") {
      try {
        await rm(join(context.workingRoot, "pgdata"), { recursive: true, force: true })
        const statePath = join(context.workingRoot, "session.json")
        await rm(statePath, { force: true })
      } catch {
        cleanupSucceeded = false
      }
    }
    return cleanupSucceeded
  }

  async close(disposition: ProjectCloseDisposition): Promise<boolean> {
    if (!(await this.prepareClose(disposition))) return false
    if (!this.active) return true
    await this.commitClose(disposition)
    return true
  }

  async abortOpen(): Promise<void> {
    await this.abortCandidate()
  }

  async shutdown(): Promise<void> {
    const contexts = [this.candidate, this.active].filter(
      (context): context is ProjectContext => context !== null
    )
    this.candidate = null
    this.active = null
    await Promise.allSettled(contexts.map((context) => context.worker.terminate()))
  }
}
