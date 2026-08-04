import { randomUUID } from "node:crypto"
import type { AudioHostIpcClient } from "@heron/audio-host-client"
import { IPC_PROTOCOL_VERSION, rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  AudioEngineRef,
  PluginInstanceState,
  ProjectGraphRef,
  ProjectGraphSnapshot,
  RpcRequestMeta,
  RpcResult
} from "@heron/contracts"
import type { AudioHostGraph, ControlResponse, GraphTransactionValue } from "./wire"

export interface PreparedGraphDeployment {
  meta: RpcRequestMeta
  projectGraph: ProjectGraphRef
  baseRevision: number
  graphRevision: number
  project: ProjectGraphSnapshot
  runtime: AudioHostGraph
}

interface PluginRuntimeStatus {
  latencySamples: number
  tailSamples: number | null
}

interface AudioHostGraphTransactionDependencies {
  client(): AudioHostIpcClient | null
  request(command: Record<string, unknown>): Promise<ControlResponse>
  loadPlugin(plugin: PluginInstanceState, sampleRate: number): Promise<unknown>
  pluginStatus(instanceId: string): PluginRuntimeStatus | undefined
  isPluginBypassed(instanceId: string): boolean
  commit(deployment: PreparedGraphDeployment): Promise<void>
}

export class AudioHostGraphTransactions {
  constructor(private readonly dependencies: AudioHostGraphTransactionDependencies) {}

  async prepare(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    graphRevision: number,
    project: ProjectGraphSnapshot,
    runtimeInput: AudioHostGraph
  ): Promise<RpcResult<PreparedGraphDeployment>> {
    const client = this.requireClient()
    const snapshotResult = await this.snapshot(meta)
    if (!snapshotResult.ok) return snapshotResult
    const baseRevision = snapshotResult.value.snapshot.committedRevision
    const loaded = await Promise.allSettled(
      project.plugins.map((plugin) => this.dependencies.loadPlugin(plugin, project.sampleRate))
    )
    for (const [index, result] of loaded.entries()) {
      if (result.status === "rejected") {
        const plugin = project.plugins[index]
        const reason: unknown = result.reason
        console.error(`Could not prepare VST3 instance ${plugin?.id}:`, {
          request: plugin
            ? {
                classId: plugin.classId,
                modulePath: plugin.descriptor.modulePath,
                kind: plugin.descriptor.kind,
                audioMode: plugin.audioMode,
                sampleRate: project.sampleRate,
                araFactoryClassId: plugin.descriptor.ara?.factoryClassId ?? null,
                componentStateBytes: plugin.componentState.byteLength,
                controllerStateBytes: plugin.controllerState.byteLength,
                araDocumentStateBytes: plugin.araDocumentState?.byteLength ?? 0
              }
            : null,
          reason
        })
        return rpcFailure(meta, {
          code: "dependency-failed",
          category: "dependency-failed",
          outcome: "not-committed",
          retry: "after-reconcile",
          correlationId: randomUUID(),
          userMessageKey: "errors.graphDependencyFailed",
          resource: projectGraph,
          details: {
            type: "dependency-failed",
            dependency: {
              kind: "plugin-instance",
              id: plugin?.id ?? `plugin:${index}`,
              epoch: projectGraph.epoch,
              generation: projectGraph.generation
            }
          }
        })
      }
    }
    const runtime = structuredClone(runtimeInput)
    runtime.plugins = runtime.plugins.map((plugin) => {
      const status = this.dependencies.pluginStatus(plugin.instance_id)
      return {
        ...plugin,
        enabled: plugin.enabled && !this.dependencies.isPluginBypassed(plugin.instance_id),
        latency_samples: status?.latencySamples ?? 0,
        tail_samples: status?.tailSamples ?? 0
      }
    })
    const nativeMeta = this.meta(meta, client.helperEpoch, baseRevision)
    const prepared = await this.transaction({
      type: "prepare-graph",
      meta: nativeMeta,
      request: {
        helperEpoch: client.helperEpoch,
        projectGraph,
        baseRevision,
        graphRevision,
        graph: runtime
      }
    })
    if (!prepared.ok) return prepared
    return rpcSuccess(meta, {
      meta: nativeMeta,
      projectGraph: structuredClone(projectGraph),
      baseRevision,
      graphRevision,
      project: structuredClone(project),
      runtime
    })
  }

  async activate(deployment: PreparedGraphDeployment): Promise<RpcResult<GraphTransactionValue>> {
    const client = this.requireClient()
    const request = {
      helperEpoch: client.helperEpoch,
      projectGraph: deployment.projectGraph,
      baseRevision: deployment.baseRevision
    }
    let result = await this.transaction({
      type: "activate-graph",
      meta: deployment.meta,
      request
    })
    if (
      !result.ok &&
      result.error.code === "operation-timeout-unknown" &&
      deployment.meta.mutation
    ) {
      const { mutation: _mutation, ...readMeta } = deployment.meta
      const reconciled = await this.snapshot(readMeta)
      if (
        reconciled.ok &&
        reconciled.value.snapshot.lastOperation?.operationId ===
          deployment.meta.mutation.operationId &&
        reconciled.value.snapshot.lastOperation.outcome === "committed"
      ) {
        result = rpcSuccess(deployment.meta, {
          type: "activated",
          snapshot: reconciled.value.snapshot
        })
      }
    }
    if (result.ok) await this.dependencies.commit(deployment)
    return result
  }

  async abort(deployment: PreparedGraphDeployment): Promise<RpcResult<GraphTransactionValue>> {
    const client = this.requireClient()
    return this.transaction({
      type: "abort-graph",
      meta: deployment.meta,
      request: {
        helperEpoch: client.helperEpoch,
        projectGraph: deployment.projectGraph,
        baseRevision: deployment.baseRevision
      }
    })
  }

  private meta(
    meta: RpcRequestMeta,
    helperEpoch: string,
    expectedRevision?: number
  ): RpcRequestMeta {
    const target: AudioEngineRef = {
      kind: "audio-engine",
      id: "engine",
      epoch: helperEpoch,
      generation: 1
    }
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: meta.requestId,
      target,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(meta.mutation ? { mutation: structuredClone(meta.mutation) } : {})
    }
  }

  private async snapshot(meta: RpcRequestMeta): Promise<RpcResult<GraphTransactionValue>> {
    const client = this.requireClient()
    return this.transaction({
      type: "graph-deployment-snapshot",
      meta: this.meta(meta, client.helperEpoch)
    })
  }

  private async transaction(
    command: Record<string, unknown>
  ): Promise<RpcResult<GraphTransactionValue>> {
    const response = await this.dependencies.request(command)
    if (response.result.type !== "graph-transaction" || !response.result.result) {
      throw new Error("audio host returned an invalid graph transaction response")
    }
    return response.result.result
  }

  private requireClient(): AudioHostIpcClient {
    const client = this.dependencies.client()
    if (!client) throw new Error("audio host is not running")
    return client
  }
}
