export const BOUNCE_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000] as const
export const MP3_BOUNCE_SAMPLE_RATES = [44_100, 48_000] as const

export type BounceFormat = "wav" | "flac" | "mp3"
export type BounceSampleRate = "project" | (typeof BOUNCE_SAMPLE_RATES)[number]
export type BounceChannelMode = "stereo" | "mono"
export type BounceDither = "off" | "tpdf"

export type BounceFormatSettings =
  | {
      format: "wav"
      bitDepth: "pcm16" | "pcm24" | "float32"
      dither: BounceDither
    }
  | {
      format: "flac"
      bitDepth: "pcm16" | "pcm24"
      compressionLevel: number
      dither: BounceDither
    }
  | {
      format: "mp3"
      bitrate: { mode: "cbr"; kbps: 128 | 192 | 256 | 320 } | { mode: "vbr"; quality: number }
    }

export type BounceNormalization =
  | { mode: "off" }
  | { mode: "overload-protection" }
  | { mode: "true-peak"; targetDbtp: number }

export interface BounceOutputRequest {
  outputChannelId: string
  sampleRate: BounceSampleRate
  channelMode: BounceChannelMode
  format: BounceFormatSettings
  normalization: BounceNormalization
  startBar: number
  endBar: number
  includeTail: boolean
}

export interface BounceStartResult {
  operationId: string
  filePath: string
}
