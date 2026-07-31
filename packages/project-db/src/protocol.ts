import type {
  ProjectGraphSnapshot,
  MidiSourceState,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"

export type MidiSourceInput = MidiSourceState

export interface PluginStateInput {
  id: string
  componentState: Uint8Array
  controllerState: Uint8Array
  araDocumentState?: Uint8Array
}

export interface AssetContentHash {
  id: string
  contentHash: string
}

export interface DefaultRecordingTrack {
  id: string
  name: string
  inputChannels: number[]
}

export interface LargeObjectAssetInput {
  id: string
  name: string
  mimeType: "audio/x-bwf"
  contentHash: string
  sampleRate: number
  channels: number
  bitDepth: "float32" | "pcm24" | "pcm16"
  frameCount: bigint
  bwfTimeReference: bigint
  waveformLevels?: WaveformLevelInput[]
}

export interface WaveformLevelInput {
  framesPerBucket: number
  bucketCount: number
  peaks: Uint8Array
}

export interface WaveformAssetInput {
  sampleRate: number
  channels: number
  frameCount: bigint
  levels: WaveformLevelInput[]
}

export interface StoredWaveformWindow {
  sampleRate: number
  channels: number
  frameCount: number
  startFrame: number
  endFrame: number
  framesPerBucket: number
  bucketCount: number
  peaks: Uint8Array
}

export interface WorkerRequestMap {
  create: {
    dataDir: string
    name: string
    sampleRate: number
    numerator: number
    denominator: number
    waveformDisplayMode: "separate" | "aggregate"
  }
  open: { dataDir: string; archivePath?: string }
  "get-configuration": Record<never, never>
  "update-configuration": { configuration: ProjectConfiguration }
  "list-assets": Record<never, never>
  "mixer-snapshot": Record<never, never>
  "apply-project-command": { command: ProjectCommand; fallbackOutputId: string }
  "import-midi": {
    source: MidiSourceInput
    command: ProjectCommand
    fallbackOutputId: string
  }
  "rollback-midi": {
    sourceId: string
    command: ProjectCommand
    fallbackOutputId: string
  }
  "save-plugin-states": { states: PluginStateInput[] }
  "asset-content-hashes": { ids: string[] }
  "default-recording-track": Record<never, never>
  "assets-missing-waveform": { cacheVersion: number }
  "delete-assets": { ids: string[] }
  dump: { outputPath: string }
  "import-large-object": {
    filePath: string
    operationId: string
    asset: LargeObjectAssetInput
  }
  "read-large-object": { assetId: string }
  "read-waveform": {
    assetId: string
    startFrame: number
    endFrame: number
    maxBuckets: number
  }
  "store-waveform": { assetId: string; waveform: WaveformAssetInput }
  cancel: { operationId: string }
  close: Record<never, never>
}

export interface WorkerResultMap {
  create: void
  open: void
  "get-configuration": ProjectConfiguration
  "update-configuration": ProjectConfiguration
  "list-assets": ProjectAssetSummary[]
  "mixer-snapshot": ProjectGraphSnapshot
  "apply-project-command": void
  "import-midi": void
  "rollback-midi": void
  "save-plugin-states": void
  "asset-content-hashes": AssetContentHash[]
  "default-recording-track": DefaultRecordingTrack | null
  "assets-missing-waveform": string[]
  "delete-assets": void
  dump: void
  "import-large-object": number
  "read-large-object": Uint8Array
  "read-waveform": StoredWaveformWindow | null
  "store-waveform": void
  cancel: void
  close: void
}

export type WorkerOperation = keyof WorkerRequestMap

export type WorkerRequest<K extends WorkerOperation = WorkerOperation> = K extends WorkerOperation
  ? { id: number; type: K } & WorkerRequestMap[K]
  : never

export type WorkerRequestInput<K extends WorkerOperation> = K extends WorkerOperation
  ? { type: K } & WorkerRequestMap[K]
  : never

export type WorkerResult = WorkerResultMap[WorkerOperation]

export type WorkerResponseFor<K extends WorkerOperation> =
  | { id: number; type: K; ok: true; value: WorkerResultMap[K] }
  | {
      id: number
      type: K
      ok: false
      error: { message: string; stack?: string; code?: string }
    }

export type WorkerResponse = {
  [K in WorkerOperation]: WorkerResponseFor<K>
}[WorkerOperation]

export interface WorkerProgress {
  type: "progress"
  operationId: string
  completed: number
  total: number
}

export type ProjectWorkerConfiguration = ProjectConfiguration
export type ProjectWorkerAssetSummary = ProjectAssetSummary
export type ProjectWorkerMixerSnapshot = ProjectGraphSnapshot
