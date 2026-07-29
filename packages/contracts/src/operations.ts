export type OperationPhase =
  | "closing-recording"
  | "repairing-header"
  | "hashing"
  | "resampling"
  | "quantizing"
  | "writing-large-object"
  | "committing-database"
  | "saving-archive"
  | "loading-project-archive"
  | "loading-project-database"
  | "restoring-project-state"
  | "loading-mixer"
  | "loading-project-assets"
  | "preparing-waveforms"
  | "cleaning-up"

export type OperationState = "running" | "completed" | "failed" | "cancelled"

export interface OperationSnapshot {
  id: string
  title: string
  description?: string | null
  phase: OperationPhase
  state: OperationState
  completedUnits: number | null
  totalUnits: number | null
  cancellable: boolean
  message: string | null
  dropoutFrames: number
}

export interface OperationEvent {
  type: "upsert" | "remove"
  operation: OperationSnapshot
}
