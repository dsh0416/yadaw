export type ProjectQueryMethod = "all" | "execute"

export type SerializableSqlParameter = string | number | bigint | boolean | null | Date | Uint8Array

export interface ProjectQueryRequest {
  sql: string
  params: SerializableSqlParameter[]
  method: ProjectQueryMethod
}

export interface ProjectQueryResult {
  rows: unknown[][]
  rowCount: number
}

export interface ProjectTransactionRequest {
  queries: ProjectQueryRequest[]
}

export type WorkerRequest =
  | { id: number; type: "create"; dataDir: string; name: string; sampleRate: number; tempo: number; numerator: number; denominator: number; waveformDisplayMode: "separate" | "aggregate" }
  | { id: number; type: "open"; dataDir: string; archivePath?: string }
  | { id: number; type: "query"; query: ProjectQueryRequest }
  | { id: number; type: "transaction"; request: ProjectTransactionRequest }
  | { id: number; type: "dump"; outputPath: string }
  | { id: number; type: "import-large-object"; filePath: string; operationId: string; asset: LargeObjectAssetInput }
  | { id: number; type: "read-large-object"; assetId: string }
  | { id: number; type: "read-waveform"; assetId: string; startFrame: number; endFrame: number; maxBuckets: number }
  | { id: number; type: "store-waveform"; assetId: string; waveform: WaveformAssetInput }
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
