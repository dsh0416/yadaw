import type {
  ProjectGraphRef,
  ProjectGraphSnapshot,
  LowLatencyModeConfiguration,
  LowLatencyModeSnapshot,
  RpcRequestMeta,
  RpcResult
} from "@heron/contracts"
import type { PluginStateInput } from "@heron/project-db/protocol"
import { cloneGraph, validateGraph } from "@heron/project-model"
import type { AudioGraphPublisher } from "./audio-graph-publisher"
import type { PreparedProjectGraph } from "./audio-graph-publisher"
import type { ProjectService } from "./project-service"
import type { RuntimeLatencyPolicy } from "./audio-graph-compiler"

export class ProjectGraphService {
  private mutationTail: Promise<void> = Promise.resolve()
  private cachedProject: { projectId: string; graph: ProjectGraphSnapshot } | null = null
  private lowLatencyEnabled = false
  private lowLatencyTargetOutputChannelId: string | null = null
  private lowLatencyPluginBudgetMs = 5

  constructor(
    private readonly projects: ProjectService,
    private readonly publisher: AudioGraphPublisher
  ) {}

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  currentProjectId(): string {
    const current = this.projects.current
    if (!current) throw new Error("No project is open")
    return current.id
  }

  snapshotNow(): ProjectGraphSnapshot {
    const projectId = this.currentProjectId()
    if (!this.cachedProject || this.cachedProject.projectId !== projectId) {
      this.cachedProject = null
      throw new Error("Project graph is not loaded")
    }
    return this.publisher.resolve(this.cachedProject.graph)
  }

  commit(projectId: string, graph: ProjectGraphSnapshot): void {
    if (this.currentProjectId() !== projectId) {
      throw new Error("Project changed while updating the project graph")
    }
    this.cachedProject = { projectId, graph: cloneGraph(graph) }
    this.reconcileLowLatencyTarget(graph)
  }

  async snapshot(): Promise<ProjectGraphSnapshot> {
    await this.mutationTail
    return this.snapshotNow()
  }

  load(): Promise<ProjectGraphSnapshot> {
    return this.refreshFromDatabase(true)
  }

  prepareCandidate(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    graph: ProjectGraphSnapshot
  ): Promise<RpcResult<PreparedProjectGraph>> {
    const assets = this.projects.candidateAssetReader()
    return this.enqueue(() => this.publisher.prepare(meta, projectGraph, graph, assets))
  }

  prepareMutation(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    graph: ProjectGraphSnapshot
  ): Promise<RpcResult<PreparedProjectGraph>> {
    const assets = this.projects.activeAssetReader()
    return this.publisher.prepare(meta, projectGraph, graph, assets, {
      latencyPolicy: this.latencyPolicy(graph)
    })
  }

  activateMutation(
    meta: RpcRequestMeta,
    prepared: PreparedProjectGraph
  ): Promise<RpcResult<ProjectGraphSnapshot>> {
    return this.publisher.activate(meta, prepared)
  }

  abortMutation(prepared: PreparedProjectGraph): Promise<void> {
    return this.publisher.abort(prepared)
  }

  prepareSilentCandidate(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef
  ): Promise<RpcResult<PreparedProjectGraph>> {
    const current = this.snapshotNow()
    const silent: ProjectGraphSnapshot = {
      ...cloneGraph(current),
      tracks: [],
      channels: current.channels
        .filter((channel) => channel.kind === "master" || channel.kind === "output")
        .map((channel) => structuredClone(channel)),
      audioClips: [],
      sends: [],
      plugins: [],
      midiClips: []
    }
    const assets = this.projects.activeAssetReader()
    return this.enqueue(() => this.publisher.prepare(meta, projectGraph, silent, assets))
  }

  activateCandidate(
    meta: RpcRequestMeta,
    prepared: PreparedProjectGraph
  ): Promise<RpcResult<ProjectGraphSnapshot>> {
    return this.enqueue(() => this.publisher.activate(meta, prepared))
  }

  abortCandidate(prepared: PreparedProjectGraph): Promise<void> {
    return this.enqueue(() => this.publisher.abort(prepared))
  }

  commitCandidate(projectId: string, prepared: PreparedProjectGraph): void {
    this.lowLatencyEnabled = false
    this.lowLatencyTargetOutputChannelId = null
    this.commit(projectId, prepared.graph)
  }

  refreshFromDatabase(publish: boolean): Promise<ProjectGraphSnapshot> {
    return this.enqueue(async () => {
      const projectId = this.currentProjectId()
      const graph = await this.projects.mixerSnapshot()
      const resolved = publish
        ? await this.publisher.publish(graph, { latencyPolicy: this.latencyPolicy(graph) })
        : (() => {
            const value = this.publisher.resolve(graph)
            validateGraph(value)
            return value
          })()
      this.commit(projectId, graph)
      return cloneGraph(resolved)
    })
  }

  clearProject(): Promise<void> {
    return this.enqueue(() => {
      this.cachedProject = null
      this.lowLatencyEnabled = false
      this.lowLatencyTargetOutputChannelId = null
      return Promise.resolve()
    })
  }

  setSoftwareMonitoringEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.publisher.publish(this.snapshotNow(), {
        softwareMonitoringOverride: enabled,
        latencyPolicy: this.latencyPolicy(this.snapshotNow()),
        awaitPublication: true
      })
    })
  }

  async lowLatencySnapshot(): Promise<LowLatencyModeSnapshot> {
    await this.mutationTail
    const graph = this.snapshotNow()
    const pluginBudgetMs = await this.publisher.lowLatencyPluginBudgetMs()
    this.lowLatencyPluginBudgetMs = pluginBudgetMs
    const effectiveBudgetSamples = Math.floor((pluginBudgetMs * graph.sampleRate) / 1_000)
    const compiled = await this.publisher.compiledAudioGraphSnapshot()
    const sensitivePlugins =
      compiled?.nodes.filter((node) => node.latencySensitive && node.pluginInstanceId) ?? []
    return {
      enabled: this.lowLatencyEnabled,
      targetOutputChannelId: this.lowLatencyTargetOutputChannelId,
      pluginBudgetMs,
      effectiveBudgetSamples,
      bypassedPluginInstanceIds: sensitivePlugins
        .filter((node) => node.lowLatencyBypassed)
        .map((node) => node.pluginInstanceId!),
      unavoidableLatencySamples: compiled?.lowLatencyUnavoidableLatencySamples ?? 0,
      hasMonitoringPath: this.lowLatencyEnabled && (compiled?.hasLowLatencyMonitoringPath ?? false)
    }
  }

  configureLowLatencyMode(
    configuration: LowLatencyModeConfiguration
  ): Promise<LowLatencyModeSnapshot> {
    return this.enqueue(async () => {
      const graph = this.snapshotNow()
      const oldEnabled = this.lowLatencyEnabled
      const oldTarget = this.lowLatencyTargetOutputChannelId
      const oldBudgetMs = await this.publisher.lowLatencyPluginBudgetMs()
      const nextEnabled = configuration.enabled ?? oldEnabled
      const nextTarget = configuration.targetOutputChannelId ?? oldTarget
      const nextBudgetMs = configuration.pluginBudgetMs ?? oldBudgetMs
      if (!Number.isInteger(nextBudgetMs) || nextBudgetMs < 0 || nextBudgetMs > 50) {
        throw new TypeError("invalid-low-latency-budget")
      }
      if (
        !nextTarget ||
        !graph.channels.some((channel) => channel.id === nextTarget && channel.kind === "output")
      ) {
        throw new TypeError("invalid-low-latency-output")
      }
      const nextPolicy: RuntimeLatencyPolicy = nextEnabled
        ? {
            type: "low-latency",
            targetOutputChannelId: nextTarget,
            pluginBudgetSamples: Math.floor((nextBudgetMs * graph.sampleRate) / 1_000)
          }
        : { type: "normal" }
      const policyPublished = nextEnabled || oldEnabled || nextTarget !== oldTarget
      if (policyPublished) {
        await this.publisher.publish(graph, { latencyPolicy: nextPolicy, awaitPublication: true })
      }
      if (nextBudgetMs !== oldBudgetMs) {
        try {
          await this.publisher.setLowLatencyPluginBudgetMs(nextBudgetMs)
        } catch (error) {
          if (policyPublished) {
            const oldPolicy: RuntimeLatencyPolicy =
              oldEnabled && oldTarget
                ? {
                    type: "low-latency",
                    targetOutputChannelId: oldTarget,
                    pluginBudgetSamples: Math.floor((oldBudgetMs * graph.sampleRate) / 1_000)
                  }
                : { type: "normal" }
            await this.publisher.publish(graph, {
              latencyPolicy: oldPolicy,
              awaitPublication: true
            })
          }
          throw error
        }
      }
      this.lowLatencyEnabled = nextEnabled
      this.lowLatencyTargetOutputChannelId = nextTarget
      this.lowLatencyPluginBudgetMs = nextBudgetMs
      return this.lowLatencySnapshotUnlocked(graph, nextBudgetMs)
    })
  }

  private async lowLatencySnapshotUnlocked(
    graph: ProjectGraphSnapshot,
    pluginBudgetMs: number
  ): Promise<LowLatencyModeSnapshot> {
    const compiled = await this.publisher.compiledAudioGraphSnapshot()
    const plugins =
      compiled?.nodes.filter((node) => node.latencySensitive && node.pluginInstanceId) ?? []
    return {
      enabled: this.lowLatencyEnabled,
      targetOutputChannelId: this.lowLatencyTargetOutputChannelId,
      pluginBudgetMs,
      effectiveBudgetSamples: Math.floor((pluginBudgetMs * graph.sampleRate) / 1_000),
      bypassedPluginInstanceIds: plugins
        .filter((node) => node.lowLatencyBypassed)
        .map((node) => node.pluginInstanceId!),
      unavoidableLatencySamples: compiled?.lowLatencyUnavoidableLatencySamples ?? 0,
      hasMonitoringPath: this.lowLatencyEnabled && (compiled?.hasLowLatencyMonitoringPath ?? false)
    }
  }

  private latencyPolicy(graph: ProjectGraphSnapshot): RuntimeLatencyPolicy {
    const target = this.lowLatencyTargetOutputChannelId
    if (
      !this.lowLatencyEnabled ||
      !target ||
      !graph.channels.some((channel) => channel.id === target && channel.kind === "output")
    ) {
      return { type: "normal" }
    }
    return {
      type: "low-latency",
      targetOutputChannelId: target,
      pluginBudgetSamples: Math.floor((this.lowLatencyPluginBudgetMs * graph.sampleRate) / 1_000)
    }
  }

  private reconcileLowLatencyTarget(graph: ProjectGraphSnapshot): void {
    const outputs = graph.channels
      .filter((channel) => channel.kind === "output")
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    if (!outputs.some((output) => output.id === this.lowLatencyTargetOutputChannelId)) {
      this.lowLatencyEnabled = false
      this.lowLatencyTargetOutputChannelId = outputs[0]?.id ?? null
    }
  }

  savePluginStates(states: PluginStateInput[]): Promise<void> {
    if (states.length === 0) return Promise.resolve()
    return this.enqueue(async () => {
      const projectId = this.currentProjectId()
      const next = this.snapshotNow()
      await this.projects.savePluginStates(states)
      const byId = new Map(states.map((state) => [state.id, state]))
      for (const plugin of next.plugins) {
        const state = byId.get(plugin.id)
        if (!state) continue
        plugin.state = structuredClone(state.state)
      }
      this.commit(projectId, next)
    })
  }

  deleteUnusedAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    return this.enqueue(async () => {
      const graph = this.snapshotNow()
      const referenced = new Set(graph.audioClips.map((clip) => clip.assetId))
      const used = ids.find((id) => referenced.has(id))
      if (used) throw new Error(`Audio asset '${used}' is still used by an audio clip`)
      await this.projects.deleteAssets(ids)
    })
  }
}
