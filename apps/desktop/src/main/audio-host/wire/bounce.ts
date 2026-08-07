import type { AudioHostGraph } from "./graph"

export interface AudioHostBounceRequest {
  operation_id: string
  graph_revision: number
  graph: AudioHostGraph
  output_channel_id: string
  start_frame: number
  end_frame: number
  target_sample_rate: number
  channel_mode: "stereo" | "mono"
  include_tail: boolean
  encoding:
    | { type: "wav-pcm"; bits: number; dither: "off" | "tpdf" }
    | { type: "wav-float" }
    | { type: "flac"; bits: number; compression: number; dither: "off" | "tpdf" }
    | { type: "mp3-cbr"; kbps: number }
    | { type: "mp3-vbr"; quality: number }
  normalization:
    | { mode: "off" }
    | { mode: "overload-protection" }
    | { mode: "true-peak"; target_dbtp: number }
  scratch_path: string
  encoded_path: string
}

export interface AudioHostBounceStatus {
  operation_id: string
  state: "running" | "completed" | "failed" | "cancelled"
  phase: "preparing" | "rendering" | "analyzing" | "encoding"
  completed_units: number
  total_units: number
  sample_peak?: number
  true_peak?: number
  normalization_gain?: number
  warnings: string[]
  error?: string
}
