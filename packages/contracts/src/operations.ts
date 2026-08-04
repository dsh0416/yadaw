import type { ResourceRef, RpcError } from "./rpc"

export type OperationPhase =
  | "closing-recording"
  | "repairing-header"
  | "hashing"
  | "resampling"
  | "quantizing"
  | "writing-large-object"
  | "committing-database"
  | "saving-archive"
  | "preparing-project"
  | "loading-project-archive"
  | "loading-project-database"
  | "restoring-project-state"
  | "loading-mixer"
  | "loading-project-assets"
  | "preparing-project-graph"
  | "preparing-waveforms"
  | "synchronizing-plugin-state"
  | "stopping-playback"
  | "closing-project-database"
  | "releasing-project-graph"
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
  error: RpcError | null
  dropoutFrames: number
}

export interface OperationEvent {
  type: "upsert" | "remove"
  operation: OperationSnapshot
}

export interface OperationStatusSnapshot {
  operationId: string
  state: "running" | "cancel-requested" | "terminal"
  outcome?: "committed" | "not-committed" | "quarantined"
  target: ResourceRef
  cancellable: boolean
  acknowledged: boolean
}
