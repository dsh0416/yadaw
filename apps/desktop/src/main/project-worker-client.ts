import { Worker } from "node:worker_threads"
import type {
  MixerGraphSnapshot,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"
import type {
  AssetContentHash,
  DefaultRecordingTrack,
  LargeObjectAssetInput,
  MidiSourceInput,
  PluginStateInput,
  StoredWaveformWindow,
  WaveformAssetInput,
  WorkerProgress,
  WorkerRequest,
  WorkerResponse
} from "@yadaw/project-db/protocol"

type RequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class ProjectWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
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
      if (message.ok) call.resolve(message.value)
      else {
        const error = new Error(message.error.message)
        error.stack = message.error.stack
        if (message.error.code) Object.assign(error, { code: message.error.code })
        call.reject(error)
      }
    })
    this.worker.on("error", (error: unknown) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)))
    })
    this.worker.on("exit", (code) => {
      if (code !== 0) this.rejectAll(new Error(`Project worker exited with code ${code}`))
    })
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
  }

  private call<T>(request: RequestWithoutId): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject })
      this.worker.postMessage({ id, ...request } satisfies WorkerRequest)
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
    return this.call({ type: "create", dataDir, ...configuration })
  }

  open(dataDir: string, archivePath?: string): Promise<void> {
    return this.call({ type: "open", dataDir, archivePath })
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

  mixerSnapshot(): Promise<MixerGraphSnapshot> {
    return this.call({ type: "mixer-snapshot" })
  }

  applyProjectCommand(command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    return this.call({ type: "apply-project-command", command, fallbackOutputId })
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

  close(): Promise<void> {
    return this.call({ type: "close" })
  }

  async terminate(): Promise<void> {
    try {
      await this.close()
    } finally {
      await this.worker.terminate()
    }
  }
}
