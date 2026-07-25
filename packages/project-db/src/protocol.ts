import type {
  MixerGraphSnapshot,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"

export interface MidiSourceInput {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

export interface PluginStateInput {
  id: string
  componentState: Uint8Array
  controllerState: Uint8Array
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

export type WorkerRequest =
  | {
      id: number
      type: "create"
      dataDir: string
      name: string
      sampleRate: number
      numerator: number
      denominator: number
      waveformDisplayMode: "separate" | "aggregate"
    }
  | { id: number; type: "open"; dataDir: string; archivePath?: string }
  | { id: number; type: "get-configuration" }
  | { id: number; type: "update-configuration"; configuration: ProjectConfiguration }
  | { id: number; type: "list-assets" }
  | { id: number; type: "mixer-snapshot" }
  | {
      id: number
      type: "apply-project-command"
      command: ProjectCommand
      fallbackOutputId: string
    }
  | {
      id: number
      type: "import-midi"
      source: MidiSourceInput
      command: ProjectCommand
      fallbackOutputId: string
    }
  | {
      id: number
      type: "rollback-midi"
      sourceId: string
      command: ProjectCommand
      fallbackOutputId: string
    }
  | { id: number; type: "save-plugin-states"; states: PluginStateInput[] }
  | { id: number; type: "asset-content-hashes"; ids: string[] }
  | { id: number; type: "default-recording-track" }
  | { id: number; type: "assets-missing-waveform"; cacheVersion: number }
  | { id: number; type: "delete-assets"; ids: string[] }
  | { id: number; type: "dump"; outputPath: string }
  | {
      id: number
      type: "import-large-object"
      filePath: string
      operationId: string
      asset: LargeObjectAssetInput
    }
  | { id: number; type: "read-large-object"; assetId: string }
  | {
      id: number
      type: "read-waveform"
      assetId: string
      startFrame: number
      endFrame: number
      maxBuckets: number
    }
  | {
      id: number
      type: "store-waveform"
      assetId: string
      waveform: WaveformAssetInput
    }
  | { id: number; type: "cancel"; operationId: string }
  | { id: number; type: "close" }

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string; code?: string } }

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

export interface WorkerProgress {
  type: "progress"
  operationId: string
  completed: number
  total: number
}

export type ProjectWorkerConfiguration = ProjectConfiguration
export type ProjectWorkerAssetSummary = ProjectAssetSummary
export type ProjectWorkerMixerSnapshot = MixerGraphSnapshot
