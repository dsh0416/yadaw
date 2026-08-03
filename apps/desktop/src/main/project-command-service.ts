import { randomUUID } from "node:crypto"
import { rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  MixerParameterPreview,
  MidiImportCommitResult,
  ProjectCommand,
  ProjectCommandResult,
  ProjectWorkspaceSnapshot,
  RpcError,
  RpcRequestMeta,
  RpcResult,
  RpcWarning
} from "@heron/contracts"
import {
  applyToGraph,
  deletedChannelIds,
  inverseFor,
  onlyRealtimeParameters,
  validateGraph
} from "@heron/project-model"
import type { PreparedProjectGraph } from "./audio-graph-publisher"
import type { AudioHostService } from "./audio-host-service"
import type { LifecycleCoordinator } from "./lifecycle-coordinator"
import type { OperationService } from "./operation-service"
import type { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"

export interface MidiSourceImport {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

function sameRef(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  return (
    (left as { kind?: unknown }).kind === (right as { kind?: unknown }).kind &&
    (left as { id?: unknown }).id === (right as { id?: unknown }).id &&
    (left as { epoch?: unknown }).epoch === (right as { epoch?: unknown }).epoch &&
    (left as { generation?: unknown }).generation === (right as { generation?: unknown }).generation
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

function conflictError(meta: RpcRequestMeta, actualRevision: number): RpcError {
  return {
    code: "revision-conflict",
    category: "conflict",
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.revisionConflict",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "revision-conflict",
      expectedRevision: meta.expectedRevision ?? -1,
      actualRevision
    }
  }
}

function staleError(meta: RpcRequestMeta): RpcError {
  return {
    code: "stale-resource",
    category: "stale-resource",
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.staleResource",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "stale-resource", reason: "generation-mismatch" }
  }
}

function unavailableError(meta: RpcRequestMeta, dispatched: boolean): RpcError {
  if (dispatched) {
    return {
      code: "operation-timeout-unknown",
      category: "timeout-unknown",
      outcome: "unknown",
      retry: "after-reconcile",
      correlationId: randomUUID(),
      userMessageKey: "errors.operationOutcomeUnknown",
      ...(meta.target ? { resource: meta.target } : {}),
      details: { type: "operation-timeout-unknown", dispatched: true }
    }
  }
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.operationFailed",
    ...(meta.target ? { resource: meta.target } : {}),
    details: {
      type: "resource-unavailable",
      component: "project-worker",
      dispatched: false
    }
  }
}

export class ProjectCommandService {
  private lifecycle: LifecycleCoordinator | null = null
  private operations: OperationService | null = null

  constructor(
    private readonly graphs: ProjectGraphService,
    private readonly projects: ProjectService,
    private readonly audioHost: AudioHostService | null
  ) {}

  attachKernel(lifecycle: LifecycleCoordinator, operations: OperationService): void {
    this.lifecycle = lifecycle
    this.operations = operations
  }

  execute(meta: RpcRequestMeta, command: ProjectCommand): Promise<RpcResult<ProjectCommandResult>> {
    return this.graphs.enqueue(() => this.executeNow(meta, command))
  }

  executeMidiImport(
    meta: RpcRequestMeta,
    source: MidiSourceImport,
    command: ProjectCommand
  ): Promise<MidiImportCommitResult> {
    return this.graphs.enqueue(async () => {
      const workspace = this.requireWorkspace()
      if (
        !meta.mutation ||
        !sameRef(meta.target, workspace.projectGraph) ||
        meta.expectedRevision !== workspace.revision
      ) {
        throw new Error("stale-midi-import")
      }
      const projectId = this.graphs.currentProjectId()
      const before = this.graphs.snapshotNow()
      const inverse = inverseFor(before, command)
      const candidate = applyToGraph(before, command)
      validateGraph(candidate)
      const fallbackOutput = before.channels.find((channel) => channel.kind === "output")
      if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
      const prepared = await this.graphs.prepareMutation(meta, workspace.projectGraph, candidate)
      if (!prepared.ok) throw new Error(prepared.error.code)
      try {
        await this.projects.importMidi(source, command, fallbackOutput.id)
      } catch (error) {
        await this.graphs.abortMutation(prepared.value).catch(() => undefined)
        throw error
      }
      if (prepared.value.native) await this.audioHost?.commitDesiredGraph(prepared.value.native)
      const updated = this.lifecycle!.applicationState.resources.update(
        workspace.projectGraph,
        workspace.revision,
        {
          graph: candidate,
          nativeRevision: prepared.value.revision,
          deployment: "pending-midi-import"
        }
      )
      if (!updated.ok) {
        this.lifecycle!.applicationState.resources.quarantine(workspace.projectGraph)
        throw new Error("Committed MIDI import resource could not advance")
      }
      this.graphs.commit(projectId, candidate)
      let nextWorkspace: ProjectWorkspaceSnapshot = {
        ...workspace,
        revision: updated.value.revision,
        session: this.projects.current ?? workspace.session,
        graph: this.graphs.snapshotNow()
      }
      this.lifecycle!.applicationState.setWorkspace(nextWorkspace)
      this.lifecycle!.syncProject(nextWorkspace.session)

      const activated = await this.graphs.activateMutation(meta, prepared.value).catch(() => null)
      if (!activated?.ok) {
        const degraded = this.lifecycle!.applicationState.resources.update(
          workspace.projectGraph,
          nextWorkspace.revision,
          {
            graph: nextWorkspace.graph,
            nativeRevision: prepared.value.revision,
            deployment: "degraded-midi-import"
          }
        )
        if (degraded.ok) {
          nextWorkspace = { ...nextWorkspace, revision: degraded.value.revision }
          this.lifecycle!.applicationState.setWorkspace(nextWorkspace)
        }
      }
      return {
        command: { graph: structuredClone(nextWorkspace.graph), inverse },
        workspace: structuredClone(nextWorkspace)
      }
    })
  }

  private async executeNow(
    meta: RpcRequestMeta,
    command: ProjectCommand
  ): Promise<RpcResult<ProjectCommandResult>> {
    const validation = this.validate(meta)
    if (!validation.ok) return validation
    const { workspace, revision } = validation.value
    const begun = this.operations!.registry.begin({
      operationId: meta.mutation!.operationId,
      idempotencyKey: meta.mutation!.idempotencyKey,
      target: workspace.projectGraph
    })
    if (!begun.ok) return rpcFailure(meta, validationError(meta, "operation"))
    if (begun.value.disposition !== "started") {
      const existing = begun.value.operation
      if (existing.result) return existing.result as RpcResult<ProjectCommandResult>
      return rpcFailure(meta, validationError(meta, "operation"))
    }

    let workerPrepared: Awaited<ReturnType<ProjectService["prepareProjectCommand"]>> | null = null
    let nativePrepared: PreparedProjectGraph | null = null
    let commitDispatched = false
    try {
      const projectId = this.graphs.currentProjectId()
      const before = this.graphs.snapshotNow()
      const inverse = inverseFor(before, command)
      const candidate = applyToGraph(before, command)
      validateGraph(candidate)
      const deletedIds = deletedChannelIds(before, command)
      const fallbackOutput = before.channels.find(
        (channel) => channel.kind === "output" && !deletedIds.has(channel.id)
      )
      if (!fallbackOutput) {
        const result = rpcFailure(meta, validationError(meta, "fallbackOutput"))
        this.finish(meta, "not-committed", result)
        return result
      }

      workerPrepared = await this.projects.prepareProjectCommand(
        meta.mutation!.operationId,
        revision,
        command,
        fallbackOutput.id
      )
      if (!onlyRealtimeParameters(command)) {
        const prepared = await this.graphs.prepareMutation(
          meta,
          workspace.projectGraph,
          workerPrepared.graph
        )
        if (!prepared.ok) {
          await this.projects.abortProjectCommand(workerPrepared.token)
          this.finish(meta, "not-committed", prepared)
          return prepared
        }
        nativePrepared = prepared.value
      }

      commitDispatched = true
      let committed
      try {
        committed = await this.projects.commitProjectCommand(workerPrepared.token, command)
      } catch (error) {
        const status = await this.projects.projectCommandStatus(meta.mutation!.operationId)
        if (status.state !== "committed") throw error
        committed = status.result
      }
      if (nativePrepared?.native) await this.audioHost?.commitDesiredGraph(nativePrepared.native)
      const updated = this.lifecycle!.applicationState.resources.update(
        workspace.projectGraph,
        revision,
        {
          graph: committed.graph,
          nativeRevision: nativePrepared?.revision ?? null,
          deployment: nativePrepared ? "pending" : "parameter-only"
        }
      )
      if (!updated.ok) {
        throw new Error("Committed project graph resource could not advance")
      }
      this.graphs.commit(projectId, committed.graph)
      const nextWorkspace: ProjectWorkspaceSnapshot = {
        ...workspace,
        revision: updated.value.revision,
        session: this.projects.current ?? workspace.session,
        graph: committed.graph
      }
      this.lifecycle!.applicationState.setWorkspace(nextWorkspace)
      this.lifecycle!.syncProject(nextWorkspace.session)

      const warnings: RpcWarning[] = []
      if (nativePrepared) {
        const activated = await this.graphs.activateMutation(meta, nativePrepared)
        if (!activated.ok) {
          warnings.push({
            code: "audio-deployment-degraded",
            userMessageKey: "warnings.audioDeploymentDegraded",
            resource: workspace.projectGraph
          })
        }
      } else {
        try {
          await this.previewCommitted(command)
        } catch {
          warnings.push({
            code: "audio-parameter-degraded",
            userMessageKey: "warnings.audioParameterDegraded",
            resource: workspace.projectGraph
          })
        }
      }
      const result = rpcSuccess(
        meta,
        { graph: structuredClone(committed.graph), inverse },
        { resourceRevision: updated.value.revision, warnings }
      )
      this.finish(meta, "committed", result)
      return result
    } catch (error) {
      if (!commitDispatched && workerPrepared) {
        await this.projects.abortProjectCommand(workerPrepared.token).catch(() => undefined)
      }
      if (nativePrepared) await this.graphs.abortMutation(nativePrepared).catch(() => undefined)
      const failure = rpcFailure(meta, unavailableError(meta, commitDispatched))
      console.error(
        `[project-command] ${failure.error.correlationId} command transaction failed`,
        error
      )
      this.finish(meta, commitDispatched ? "quarantined" : "not-committed", failure)
      return failure
    }
  }

  private validate(
    meta: RpcRequestMeta
  ): RpcResult<{ workspace: ProjectWorkspaceSnapshot; revision: number }> {
    if (!meta.mutation || meta.expectedRevision === undefined) {
      return rpcFailure(meta, validationError(meta, "mutation"))
    }
    const workspace = this.currentWorkspace()
    if (!workspace || !sameRef(meta.target, workspace.projectGraph)) {
      return rpcFailure(meta, staleError(meta))
    }
    const resolved = this.lifecycle!.applicationState.resources.resolve(workspace.projectGraph)
    if (!resolved.ok) return rpcFailure(meta, staleError(meta))
    if (resolved.value.revision !== meta.expectedRevision) {
      return rpcFailure(meta, conflictError(meta, resolved.value.revision))
    }
    return rpcSuccess(meta, { workspace, revision: resolved.value.revision })
  }

  currentWorkspace(): ProjectWorkspaceSnapshot | null {
    return this.lifecycle?.applicationState.workspaceSnapshot() ?? null
  }

  private requireWorkspace(): ProjectWorkspaceSnapshot {
    const workspace = this.currentWorkspace()
    if (!workspace) throw new Error("No project workspace is committed")
    return workspace
  }

  private finish(
    meta: RpcRequestMeta,
    outcome: "committed" | "not-committed" | "quarantined",
    result: RpcResult<unknown>
  ): void {
    this.operations!.registry.finish(meta.mutation!.operationId, outcome, result)
  }

  private async previewCommitted(command: ProjectCommand): Promise<void> {
    if (command.type === "batch") {
      for (const nested of command.commands) await this.previewCommitted(nested)
      return
    }
    let preview: MixerParameterPreview | null = null
    if (command.type === "update-channel" && command.patch.gainDb !== undefined) {
      preview = {
        target: "channel",
        id: command.channelId,
        parameter: "gainDb",
        value: command.patch.gainDb
      }
    }
    if (preview) await this.audioHost?.previewMixerParameter(preview)
    if (command.type === "update-channel" && command.patch.pan !== undefined) {
      await this.audioHost?.previewMixerParameter({
        target: "channel",
        id: command.channelId,
        parameter: "pan",
        value: command.patch.pan
      })
    } else if (command.type === "update-send" && command.patch.levelDb !== undefined) {
      await this.audioHost?.previewMixerParameter({
        target: "send",
        id: command.sendId,
        parameter: "levelDb",
        value: command.patch.levelDb
      })
    }
  }
}
