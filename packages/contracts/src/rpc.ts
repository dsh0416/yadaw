export const IPC_PROTOCOL_VERSION = 2 as const

export const RESOURCE_KINDS = [
  "desktop-session",
  "application-settings",
  "project-session",
  "project-graph",
  "plugin-instance",
  "asset",
  "recording-session",
  "audio-host",
  "audio-engine",
  "graph-deployment",
  "transport",
  "midi-runtime",
  "project-worker",
  "offline-worker"
] as const

export type ResourceKind = (typeof RESOURCE_KINDS)[number]

export interface ResourceRef<K extends ResourceKind = ResourceKind> {
  kind: K
  id: string
  epoch: string
  generation: number
}

export type DesktopSessionRef = ResourceRef<"desktop-session">
export type ApplicationSettingsRef = ResourceRef<"application-settings">
export type ProjectSessionRef = ResourceRef<"project-session">
export type ProjectGraphRef = ResourceRef<"project-graph">
export type PluginInstanceRef = ResourceRef<"plugin-instance">
export type AssetRef = ResourceRef<"asset">
export type RecordingSessionRef = ResourceRef<"recording-session">
export type AudioHostRef = ResourceRef<"audio-host">
export type AudioEngineRef = ResourceRef<"audio-engine">
export type ProjectWorkerRef = ResourceRef<"project-worker">
export type OfflineWorkerRef = ResourceRef<"offline-worker">
export type GraphDeploymentRef = ResourceRef<"graph-deployment">
export type TransportRef = ResourceRef<"transport">
export type MidiRuntimeRef = ResourceRef<"midi-runtime">

export interface RpcMutationMeta {
  operationId: string
  idempotencyKey: string
}

export interface RpcRequestMeta {
  protocolVersion: typeof IPC_PROTOCOL_VERSION
  requestId: string
  target?: ResourceRef
  expectedRevision?: number
  mutation?: RpcMutationMeta
}

export const RPC_ERROR_CODES = [
  "validation-failed",
  "protocol-mismatch",
  "revision-conflict",
  "stale-resource",
  "resource-busy",
  "operation-cancelled",
  "resource-unavailable",
  "transport-unavailable",
  "operation-timeout-unknown",
  "dependency-failed",
  "invariant-violation"
] as const

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number]
export type RpcErrorCategory =
  | "validation"
  | "conflict"
  | "stale-resource"
  | "busy"
  | "cancelled"
  | "unavailable"
  | "timeout-unknown"
  | "dependency-failed"
  | "invariant-violation"
export type RpcMutationOutcome = "not-committed" | "unknown" | "quarantined"
export type RpcRetry = "never" | "safe" | "after-reconcile"

export interface RpcValidationErrorDetails {
  type: "validation-failed"
  field?: string
}

export interface RpcProtocolMismatchDetails {
  type: "protocol-mismatch"
  expectedVersion: number
  receivedVersion?: number
}

export interface RpcRevisionConflictDetails {
  type: "revision-conflict"
  expectedRevision: number
  actualRevision: number
}

export interface RpcStaleResourceDetails {
  type: "stale-resource"
  reason: "missing" | "epoch-mismatch" | "generation-mismatch" | "parent-invalid"
}

export interface RpcBusyDetails {
  type: "resource-busy"
  activeOperationId?: string
}

export interface RpcCancelledDetails {
  type: "operation-cancelled"
  committed: boolean
}

export interface RpcUnavailableDetails {
  type: "resource-unavailable" | "transport-unavailable"
  component: "main" | "preload" | "project-worker" | "audio-host" | "offline-worker"
  dispatched: boolean
}

export interface RpcTimeoutUnknownDetails {
  type: "operation-timeout-unknown"
  dispatched: true
}

export interface RpcDependencyFailedDetails {
  type: "dependency-failed"
  dependency: ResourceRef
}

export interface RpcInvariantViolationDetails {
  type: "invariant-violation"
  component: "main" | "project-worker" | "audio-host" | "offline-worker"
}

export type RpcErrorDetails =
  | RpcValidationErrorDetails
  | RpcProtocolMismatchDetails
  | RpcRevisionConflictDetails
  | RpcStaleResourceDetails
  | RpcBusyDetails
  | RpcCancelledDetails
  | RpcUnavailableDetails
  | RpcTimeoutUnknownDetails
  | RpcDependencyFailedDetails
  | RpcInvariantViolationDetails

interface RpcErrorBase<
  C extends RpcErrorCode,
  Category extends RpcErrorCategory,
  Outcome extends RpcMutationOutcome,
  Retry extends RpcRetry,
  Details extends RpcErrorDetails
> {
  code: C
  category: Category
  outcome: Outcome
  retry: Retry
  correlationId: string
  userMessageKey: string
  resource?: ResourceRef
  details?: Details
}

export type RpcError =
  | RpcErrorBase<
      "validation-failed",
      "validation",
      "not-committed",
      "never",
      RpcValidationErrorDetails
    >
  | RpcErrorBase<
      "protocol-mismatch",
      "validation",
      "not-committed",
      "never",
      RpcProtocolMismatchDetails
    >
  | RpcErrorBase<
      "revision-conflict",
      "conflict",
      "not-committed",
      "after-reconcile",
      RpcRevisionConflictDetails
    >
  | RpcErrorBase<
      "stale-resource",
      "stale-resource",
      "not-committed",
      "after-reconcile",
      RpcStaleResourceDetails
    >
  | RpcErrorBase<"resource-busy", "busy", "not-committed", "safe", RpcBusyDetails>
  | RpcErrorBase<"operation-cancelled", "cancelled", "not-committed", "never", RpcCancelledDetails>
  | RpcErrorBase<
      "resource-unavailable",
      "unavailable",
      "not-committed",
      "safe",
      RpcUnavailableDetails
    >
  | RpcErrorBase<
      "transport-unavailable",
      "unavailable",
      "not-committed",
      "safe",
      RpcUnavailableDetails
    >
  | RpcErrorBase<
      "operation-timeout-unknown",
      "timeout-unknown",
      "unknown",
      "after-reconcile",
      RpcTimeoutUnknownDetails
    >
  | RpcErrorBase<
      "dependency-failed",
      "dependency-failed",
      "not-committed",
      "after-reconcile",
      RpcDependencyFailedDetails
    >
  | RpcErrorBase<
      "invariant-violation",
      "invariant-violation",
      "quarantined",
      "after-reconcile",
      RpcInvariantViolationDetails
    >

export interface RpcWarning {
  code: string
  userMessageKey: string
  resource?: ResourceRef
}

export interface RpcSuccess<T> {
  ok: true
  requestId: string
  operationId?: string
  resourceRevision?: number
  value: T
  warnings: RpcWarning[]
}

export interface RpcFailure {
  ok: false
  requestId: string
  operationId?: string
  error: RpcError
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure

export interface RpcEvent<T> {
  protocolVersion: typeof IPC_PROTOCOL_VERSION
  sourceEpoch: string
  sequence: number
  resourceRevision: number
  operationId?: string
  payload: T
}

export function isResourceRef(value: unknown): value is ResourceRef {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<ResourceRef>
  return (
    RESOURCE_KINDS.includes(candidate.kind as ResourceKind) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.epoch === "string" &&
    candidate.epoch.length > 0 &&
    Number.isSafeInteger(candidate.generation) &&
    (candidate.generation ?? 0) >= 0
  )
}

export function isRpcRequestMeta(value: unknown): value is RpcRequestMeta {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<RpcRequestMeta>
  if (
    candidate.protocolVersion !== IPC_PROTOCOL_VERSION ||
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length === 0 ||
    (candidate.target !== undefined && !isResourceRef(candidate.target)) ||
    (candidate.expectedRevision !== undefined &&
      (!Number.isSafeInteger(candidate.expectedRevision) || candidate.expectedRevision < 0))
  ) {
    return false
  }
  if (candidate.mutation === undefined) return true
  return (
    typeof candidate.mutation === "object" &&
    candidate.mutation !== null &&
    typeof candidate.mutation.operationId === "string" &&
    candidate.mutation.operationId.length > 0 &&
    typeof candidate.mutation.idempotencyKey === "string" &&
    candidate.mutation.idempotencyKey.length > 0
  )
}

export function rpcSuccess<T>(
  meta: Pick<RpcRequestMeta, "requestId" | "mutation">,
  value: T,
  options: { resourceRevision?: number; warnings?: RpcWarning[] } = {}
): RpcSuccess<T> {
  return {
    ok: true,
    requestId: meta.requestId,
    ...(meta.mutation ? { operationId: meta.mutation.operationId } : {}),
    ...(options.resourceRevision === undefined
      ? {}
      : { resourceRevision: options.resourceRevision }),
    value,
    warnings: options.warnings ?? []
  }
}

export function rpcFailure(
  meta: Pick<RpcRequestMeta, "requestId" | "mutation">,
  error: RpcError
): RpcFailure {
  return {
    ok: false,
    requestId: meta.requestId,
    ...(meta.mutation ? { operationId: meta.mutation.operationId } : {}),
    error
  }
}
