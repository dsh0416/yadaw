import { Worker } from "node:worker_threads"
import type {
  ProjectGraphSnapshot,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"
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
  WaveformAssetInput,
  WorkerOperation,
  WorkerProgress,
  WorkerRequestInput,
  WorkerResponse,
  WorkerResult,
  WorkerResultMap
} from "@yadaw/project-db/protocol"

interface PendingCall {
  settle(message: WorkerResponse): void
  reject(error: Error): void
}

type WorkerState = "active" | "failed" | "terminating" | "terminated"

function workerError(response: Extract<WorkerResponse, { ok: false }>): Error {
  const error = new Error(response.error.message)
  error.stack = response.error.stack
  if (response.error.code) Object.assign(error, { code: response.error.code })
  return error
}

export class ProjectWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private state: WorkerState = "active"
  private termination: Promise<void> | null = null
  private databaseClosed = true
  onProgress: ((progress: WorkerProgress) => void) | null = null

  constructor(workerUrl: URL) {
    // Electron's Playwright/DevTools inspector flags are inherited by Node workers by
    // default and can leave an ESM worker paused before its module body executes.
    this.worker = new Worker(workerUrl, { execArgv: [] })
    this.worker.on("message", (message: WorkerResponse | WorkerProgress) => {
      if (!("id" in message)) {
        this.onProgress?.(message)
        return
      }
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      call.settle(message)
    })
    this.worker.on("error", (error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    })
    this.worker.on("exit", (code) => {
      if (this.state === "terminating" || this.state === "terminated") return
      this.fail(new Error(`Project worker exited with code ${code}`))
    })
  }

  private fail(error: Error): void {
    if (this.state !== "active") return
    this.state = "failed"
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
  }

  private call<K extends WorkerOperation>(
    request: WorkerRequestInput<K>
  ): Promise<WorkerResultMap[K]>
  private call(request: WorkerRequestInput<WorkerOperation>): Promise<WorkerResult> {
    if (this.state !== "active") {
      return Promise.reject(new Error(`Project worker is ${this.state}`))
    }
    const id = this.nextId++
    return new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, {
        settle: (message) => {
          if (message.type !== request.type) {
            reject(
              new Error(
                `Project worker response mismatch: expected '${request.type}', received '${message.type}'`
              )
            )
          } else if (message.ok) {
            resolve(message.value)
          } else {
            reject(workerError(message))
          }
        },
        reject
      })
      try {
        this.worker.postMessage({ id, ...request })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  create(
    dataDir: string,
    configuration: {
      name: string
      sampleRate: number
      numerator: number
      denominator: number
      waveformDisplayMode: "separate" | "aggregate"
    }
  ): Promise<void> {
    return this.call({ type: "create", dataDir, ...configuration }).then(() => {
      this.databaseClosed = false
    })
  }

  open(dataDir: string, archivePath?: string): Promise<void> {
    return this.call({ type: "open", dataDir, archivePath }).then(() => {
      this.databaseClosed = false
    })
  }

  getConfiguration(): Promise<ProjectConfiguration> {
    return this.call({ type: "get-configuration" })
  }

  updateConfiguration(configuration: ProjectConfiguration): Promise<ProjectConfiguration> {
    return this.call({ type: "update-configuration", configuration })
  }

  listAssets(): Promise<ProjectAssetSummary[]> {
    return this.call({ type: "list-assets" })
  }

  mixerSnapshot(): Promise<ProjectGraphSnapshot> {
    return this.call({ type: "mixer-snapshot" })
  }

  prepareProjectCommand(
    operationId: string,
    baseRevision: number,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<PreparedProjectCommand> {
    return this.call({
      type: "prepare-project-command",
      operationId,
      baseRevision,
      command,
      fallbackOutputId
    })
  }

  commitProjectCommand(token: ProjectCommandTransactionToken): Promise<CommittedProjectCommand> {
    return this.call({ type: "commit-project-command", token })
  }

  abortProjectCommand(token: ProjectCommandTransactionToken): Promise<void> {
    return this.call({ type: "abort-project-command", token })
  }

  projectCommandStatus(operationId: string): Promise<ProjectCommandTransactionStatus> {
    return this.call({ type: "project-command-status", operationId })
  }

  importMidi(
    source: MidiSourceInput,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    return this.call({ type: "import-midi", source, command, fallbackOutputId })
  }

  rollbackMidi(sourceId: string, command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    return this.call({
      type: "rollback-midi",
      sourceId,
      command,
      fallbackOutputId
    })
  }

  savePluginStates(states: PluginStateInput[]): Promise<void> {
    return this.call({ type: "save-plugin-states", states })
  }

  assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    return this.call({ type: "asset-content-hashes", ids })
  }

  defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    return this.call({ type: "default-recording-track" })
  }

  assetsMissingWaveform(cacheVersion: number): Promise<string[]> {
    return this.call({ type: "assets-missing-waveform", cacheVersion })
  }

  deleteAssets(ids: string[]): Promise<void> {
    return this.call({ type: "delete-assets", ids })
  }

  dump(outputPath: string): Promise<void> {
    return this.call({ type: "dump", outputPath })
  }

  importLargeObject(
    filePath: string,
    operationId: string,
    asset: LargeObjectAssetInput
  ): Promise<number> {
    return this.call({ type: "import-large-object", filePath, operationId, asset })
  }

  readLargeObject(assetId: string): Promise<Uint8Array> {
    return this.call({ type: "read-large-object", assetId })
  }

  readWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    return this.call({
      type: "read-waveform",
      assetId,
      startFrame,
      endFrame,
      maxBuckets
    })
  }

  storeWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    return this.call({ type: "store-waveform", assetId, waveform })
  }

  cancel(operationId: string): Promise<void> {
    return this.call({ type: "cancel", operationId })
  }

  async close(): Promise<void> {
    if (this.databaseClosed) return
    await this.call({ type: "close" })
    this.databaseClosed = true
  }

  async terminate(): Promise<void> {
    if (this.termination) return this.termination
    this.termination = (async () => {
      const shouldClose = this.state === "active" && !this.databaseClosed
      this.state = "terminating"
      try {
        if (shouldClose) {
          await new Promise<void>((resolve) => {
            const id = this.nextId++
            this.pending.set(id, {
              settle: () => resolve(),
              reject: () => resolve()
            })
            try {
              this.worker.postMessage({ id, type: "close" })
            } catch {
              this.pending.delete(id)
              resolve()
            }
          })
          this.databaseClosed = true
        }
      } finally {
        await this.worker.terminate()
        this.state = "terminated"
        this.rejectAll(new Error("Project worker terminated"))
      }
    })()
    return this.termination
  }
}
