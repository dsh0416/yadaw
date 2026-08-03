import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  ApplicationBootstrapSnapshot,
  CreateProjectRequest,
  ProjectCloseDisposition,
  ProjectCloseResult,
  ProjectSession,
  ProjectSessionRef,
  ProjectGraphRef,
  ProjectWorkspaceSnapshot,
  OperationPhase,
  ResourceRef,
  RpcError,
  RpcRequestMeta,
  RpcResult
} from "@heron/contracts"
import type { PreparedProjectGraph } from "./audio-graph-publisher"
import type { LifecycleCoordinator } from "./lifecycle-coordinator"
import type { OperationService } from "./operation-service"
import type { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"
import type { ApplicationSettingsStore } from "./application-settings"
import type { WaveformService } from "./waveform-service"
import { t } from "./i18n"

interface ProjectCandidateResources {
  project: ProjectSessionRef
  graph: ProjectGraphRef
}

interface ProjectLoadProgress {
  phase: OperationPhase
  completedUnits: number
}

type PrepareProject = (
  onProgress: (progress: ProjectLoadProgress) => void
) => Promise<ProjectSession>

const PROJECT_LOAD_TOTAL_UNITS = 5

function sameRef(left: ResourceRef | undefined, right: ResourceRef): boolean {
  return (
    left?.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function validationError(meta: RpcRequestMeta, field: string): RpcError {
  return {
    code: "validation-failed",
    category: "validation",
    outcome: "not-committed",
    retry: "never",
    correlationId: randomUUID(),
    userMessageKey: "errors.invalidRpcRequest",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "validation-failed", field }
  }
}

function staleError(resource: ResourceRef): RpcError {
  return {
    code: "stale-resource",
    category: "stale-resource",
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.staleResource",
    resource,
    details: { type: "stale-resource", reason: "generation-mismatch" }
  }
}

function busyError(meta: RpcRequestMeta, operationId?: string): RpcError {
  return {
    code: "resource-busy",
    category: "busy",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.resourceBusy",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "resource-busy",
      ...(operationId ? { activeOperationId: operationId } : {})
    }
  }
}

function unavailableError(
  meta: RpcRequestMeta,
  component: "main" | "project-worker" | "audio-host",
  quarantined: boolean
): RpcError {
  if (quarantined) {
    return {
      code: "invariant-violation",
      category: "invariant-violation",
      outcome: "quarantined",
      retry: "after-reconcile",
      correlationId: randomUUID(),
      userMessageKey: "errors.projectQuarantined",
      ...(meta.target ? { resource: meta.target } : {}),
      details: { type: "invariant-violation", component }
    }
  }
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.projectUnavailable",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "resource-unavailable", component, dispatched: true }
  }
}

export class ProjectLifecycleService {
  constructor(
    private readonly projects: ProjectService,
    private readonly projectGraph: ProjectGraphService,
    private readonly lifecycle: LifecycleCoordinator,
    private readonly operations: OperationService,
    private readonly settings: ApplicationSettingsStore,
    private readonly waveforms: WaveformService
  ) {}

  async bootstrap(): Promise<ApplicationBootstrapSnapshot> {
    const state = this.lifecycle.applicationState
    const settings = state.synchronizeApplicationSettings(await this.settings.get())
    const offlineTools = state.offlineToolsSnapshot()
    const snapshot = state.snapshot(this.operations.registry)
    return {
      protocolVersion: snapshot.protocolVersion,
      mainEpoch: snapshot.mainEpoch,
      desktopSession: snapshot.desktopSession,
      applicationSettings: snapshot.applicationSettings,
      revision: snapshot.revision,
      offlineTools,
      lifecycle: snapshot.lifecycle,
      audioResources: state.audioResourceSnapshot(),
      recordingResource: state.recordingResourceSnapshot(),
      settings,
      workspace: state.workspaceSnapshot()
    }
  }

  validateDesktopRead(meta: RpcRequestMeta): RpcResult<never> | null {
    const desktop = this.lifecycle.applicationState.desktopSession
    if (!sameRef(meta.target, desktop)) {
      return rpcFailure(meta, staleError(meta.target ?? desktop))
    }
    return null
  }

  async create(
    meta: RpcRequestMeta,
    request: CreateProjectRequest & { path: string }
  ): Promise<RpcResult<ProjectWorkspaceSnapshot>> {
    return this.openCandidate(meta, "creating", request.name, (progress) =>
      this.projects.prepareCreate(request, progress)
    )
  }

  async open(
    meta: RpcRequestMeta,
    path: string,
    recover: boolean
  ): Promise<RpcResult<ProjectWorkspaceSnapshot>> {
    return this.openCandidate(meta, "opening", basename(path), (progress) =>
      this.projects.prepareOpen(path, recover, progress)
    )
  }

  private async openCandidate(
    meta: RpcRequestMeta,
    transition: "creating" | "opening",
    description: string,
    prepareProject: PrepareProject
  ): Promise<RpcResult<ProjectWorkspaceSnapshot>> {
    const targetFailure = this.validateMutationTarget(
      meta,
      this.lifecycle.applicationState.desktopSession
    )
    if (targetFailure) return targetFailure
    const begin = this.beginOperation(meta)
    if (!begin.ok) return begin
    if (begin.value) return begin.value as RpcResult<ProjectWorkspaceSnapshot>

    const operationId = meta.mutation!.operationId
    this.operations.upsert(
      {
        id: operationId,
        title: t(
          transition === "creating" ? "operation.creatingProject" : "operation.openingProject"
        ),
        description,
        phase: transition === "creating" ? "committing-database" : "preparing-project",
        state: "running",
        completedUnits: 0,
        totalUnits: PROJECT_LOAD_TOTAL_UNITS,
        cancellable: false,
        error: null,
        dropoutFrames: 0
      },
      true
    )
    const reportProgress = (progress: ProjectLoadProgress): void => {
      this.operations.patch(
        operationId,
        {
          phase: progress.phase,
          completedUnits: Math.min(PROJECT_LOAD_TOTAL_UNITS, progress.completedUnits),
          totalUnits: PROJECT_LOAD_TOTAL_UNITS
        },
        true
      )
    }

    this.lifecycle.beginProject(transition)
    let resources: ProjectCandidateResources | null = null
    let preparedGraph: PreparedProjectGraph | null = null
    let nativeActivated = false
    try {
      const session = await prepareProject(reportProgress)
      reportProgress({ phase: "loading-mixer", completedUnits: 2 })
      const graph = await this.projects.candidateMixerSnapshot()
      reportProgress({ phase: "loading-project-assets", completedUnits: 3 })
      const assets = await this.projects.candidateAssets()
      reportProgress({ phase: "preparing-project-graph", completedUnits: 4 })
      resources = this.createCandidateResources(session)
      const prepared = await this.projectGraph.prepareCandidate(meta, resources.graph, graph)
      if (!prepared.ok) {
        await this.rollbackOpen(resources, null, false)
        this.lifecycle.failProject(prepared.error.userMessageKey)
        this.finishPublishedOperation(meta, "not-committed", prepared)
        return prepared
      }
      preparedGraph = prepared.value
      const activated = await this.projectGraph.activateCandidate(meta, preparedGraph)
      if (!activated.ok) {
        await this.rollbackOpen(resources, preparedGraph, false)
        this.lifecycle.failProject(activated.error.userMessageKey)
        this.finishPublishedOperation(
          meta,
          activated.error.outcome === "quarantined" ? "quarantined" : "not-committed",
          activated
        )
        return activated
      }
      nativeActivated = true

      const committedSession = this.projects.commitCandidate()
      const state = this.lifecycle.applicationState
      const projectCommit = state.resources.commit(resources.project, committedSession)
      if (!projectCommit.ok) throw new Error("Project resource commit failed")
      const graphCommit = state.resources.commit(resources.graph, {
        revision: preparedGraph.revision,
        graph: activated.value
      })
      if (!graphCommit.ok) throw new Error("Project graph resource commit failed")
      this.projectGraph.commitCandidate(committedSession.id, preparedGraph)
      const workspace: ProjectWorkspaceSnapshot = {
        project: resources.project,
        projectGraph: resources.graph,
        revision: graphCommit.value.revision,
        session: committedSession,
        graph: activated.value,
        assets
      }
      state.setWorkspace(workspace)
      this.lifecycle.completeProject(committedSession)
      const result = rpcSuccess(meta, workspace, {
        resourceRevision: projectCommit.value.revision
      })
      this.finishPublishedOperation(meta, "committed", result)
      this.startPostCommitWork()
      return result
    } catch (error) {
      await this.rollbackOpen(resources, preparedGraph, nativeActivated)
      const rpcError = unavailableError(meta, "project-worker", nativeActivated)
      console.error(`[project-lifecycle] ${rpcError.correlationId} open candidate failed`, error)
      const result = rpcFailure(meta, rpcError)
      this.lifecycle.failProject(rpcError.userMessageKey)
      this.finishPublishedOperation(meta, nativeActivated ? "quarantined" : "not-committed", result)
      return result
    }
  }

  async close(
    meta: RpcRequestMeta,
    disposition: ProjectCloseDisposition
  ): Promise<RpcResult<ProjectCloseResult>> {
    const workspace = this.lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) {
      return rpcFailure(
        meta,
        staleError(meta.target ?? this.lifecycle.applicationState.desktopSession)
      )
    }
    const targetFailure = this.validateMutationTarget(meta, workspace.project)
    if (targetFailure) return targetFailure
    const begin = this.beginOperation(meta)
    if (!begin.ok) return begin
    if (begin.value) return begin.value as RpcResult<ProjectCloseResult>

    this.lifecycle.beginProject("closing")
    let preparedGraph: PreparedProjectGraph | null = null
    let workerClosed = false
    try {
      const prepared = await this.projectGraph.prepareSilentCandidate(meta, workspace.projectGraph)
      if (!prepared.ok) {
        this.lifecycle.failProject(prepared.error.userMessageKey)
        this.finishOperation(meta, "not-committed", prepared)
        return prepared
      }
      preparedGraph = prepared.value
      const canClose = await this.projects.prepareClose(disposition)
      if (!canClose) {
        await this.projectGraph.abortCandidate(preparedGraph)
        this.lifecycle.cancelProject()
        const cancelled = rpcFailure(meta, {
          code: "operation-cancelled",
          category: "cancelled",
          outcome: "not-committed",
          retry: "never",
          correlationId: randomUUID(),
          userMessageKey: "errors.operationCancelled",
          resource: workspace.project,
          details: { type: "operation-cancelled", committed: false }
        })
        this.finishOperation(meta, "not-committed", cancelled)
        return cancelled
      }
      workerClosed = true
      const activated = await this.projectGraph.activateCandidate(meta, preparedGraph)
      if (!activated.ok) {
        await this.projects.abortPreparedClose()
        workerClosed = false
        await this.projectGraph.abortCandidate(preparedGraph)
        this.lifecycle.failProject(activated.error.userMessageKey)
        this.finishOperation(meta, "not-committed", activated)
        return activated
      }

      const cleanupSucceeded = await this.projects.commitClose(disposition)
      workerClosed = false
      await this.projectGraph.clearProject()
      if (cleanupSucceeded) {
        await this.lifecycle.applicationState.resources.drop(workspace.project)
      } else {
        this.lifecycle.applicationState.resources.quarantine(workspace.project)
      }
      this.lifecycle.applicationState.setWorkspace(null)
      this.lifecycle.completeProject(null)
      const snapshot = await this.bootstrap()
      const result = rpcSuccess(
        meta,
        { closed: true, snapshot },
        {
          warnings: cleanupSucceeded
            ? []
            : [
                {
                  code: "project-cleanup-quarantined",
                  userMessageKey: "warnings.projectCleanupQuarantined",
                  resource: workspace.project
                }
              ]
        }
      )
      this.finishOperation(meta, "committed", result)
      return result
    } catch (error) {
      if (workerClosed) {
        await this.projects.abortPreparedClose().catch(() => undefined)
      }
      if (preparedGraph) {
        await this.projectGraph.abortCandidate(preparedGraph).catch(() => undefined)
      }
      const rpcError = unavailableError(meta, "main", false)
      console.error(`[project-lifecycle] ${rpcError.correlationId} close failed`, error)
      const result = rpcFailure(meta, rpcError)
      this.lifecycle.failProject(rpcError.userMessageKey)
      this.finishOperation(meta, "not-committed", result)
      return result
    }
  }

  private validateMutationTarget(
    meta: RpcRequestMeta,
    expected: ResourceRef
  ): RpcResult<never> | null {
    if (!meta.mutation) return rpcFailure(meta, validationError(meta, "mutation"))
    if (!sameRef(meta.target, expected)) {
      return rpcFailure(meta, staleError(meta.target ?? expected))
    }
    const resolved = this.lifecycle.applicationState.resources.resolve(expected)
    if (!resolved.ok) return rpcFailure(meta, staleError(expected))
    return null
  }

  private beginOperation(meta: RpcRequestMeta): RpcResult<RpcResult<unknown> | null> {
    if (!meta.target || !meta.mutation) {
      return rpcFailure(meta, validationError(meta, "mutation"))
    }
    const begun = this.operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: meta.target
    })
    if (!begun.ok) {
      return rpcFailure(meta, busyError(meta, meta.mutation.operationId))
    }
    if (begun.value.disposition === "started") return rpcSuccess(meta, null)
    const existing = begun.value.operation
    if (existing.result) return rpcSuccess(meta, existing.result)
    return rpcFailure(meta, busyError(meta, existing.operationId))
  }

  private finishOperation(
    meta: RpcRequestMeta,
    outcome: "committed" | "not-committed" | "quarantined",
    result: RpcResult<unknown>
  ): void {
    if (meta.mutation) {
      this.operations.registry.finish(meta.mutation.operationId, outcome, result)
    }
  }

  private finishPublishedOperation(
    meta: RpcRequestMeta,
    outcome: "committed" | "not-committed" | "quarantined",
    result: RpcResult<unknown>
  ): void {
    this.finishOperation(meta, outcome, result)
    if (!meta.mutation) return
    this.operations.patch(
      meta.mutation.operationId,
      result.ok
        ? {
            state: "completed",
            completedUnits: PROJECT_LOAD_TOTAL_UNITS,
            totalUnits: PROJECT_LOAD_TOTAL_UNITS,
            error: null
          }
        : {
            state: result.error.category === "cancelled" ? "cancelled" : "failed",
            error: result.error
          },
      true
    )
  }

  private createCandidateResources(session: ProjectSession): ProjectCandidateResources {
    const registry = this.lifecycle.applicationState.resources
    const project = registry.create({
      kind: "project-session",
      id: session.id,
      parent: this.lifecycle.applicationState.desktopSession
    })
    if (!project.ok) throw new Error("Could not allocate project resource")
    const graph = registry.create({
      kind: "project-graph",
      id: `${session.id}:graph`,
      parent: project.value.ref
    })
    if (!graph.ok) throw new Error("Could not allocate project graph resource")
    return {
      project: project.value.ref as ProjectSessionRef,
      graph: graph.value.ref as ProjectGraphRef
    }
  }

  private async rollbackOpen(
    resources: ProjectCandidateResources | null,
    preparedGraph: PreparedProjectGraph | null,
    quarantined: boolean
  ): Promise<void> {
    if (preparedGraph) {
      await this.projectGraph.abortCandidate(preparedGraph).catch(() => undefined)
    }
    await this.projects.abortCandidate().catch(() => undefined)
    if (quarantined) {
      await this.projects.quarantineActiveCandidate().catch(() => undefined)
    }
    if (resources) {
      if (quarantined) {
        this.lifecycle.applicationState.resources.quarantine(resources.project)
      } else {
        await this.lifecycle.applicationState.resources.drop(resources.project)
      }
    }
  }

  private startPostCommitWork(): void {
    void this.projects
      .recordCurrentAsRecent()
      .catch((error: unknown) => console.error("Could not update recent projects", error))
    void this.waveforms
      .prepareMissing()
      .catch((error: unknown) => console.error("Could not prepare project waveforms", error))
  }
}
