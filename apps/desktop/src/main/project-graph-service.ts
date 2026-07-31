import type { ProjectGraphSnapshot } from "@yadaw/contracts"
import type { PluginStateInput } from "@yadaw/project-db/protocol"
import { cloneGraph, validateGraph } from "@yadaw/project-model"
import type { AudioGraphPublisher } from "./audio-graph-publisher"
import type { ProjectService } from "./project-service"

export class ProjectGraphService {
  private mutationTail: Promise<void> = Promise.resolve()
  private cachedProject: { projectId: string; graph: ProjectGraphSnapshot } | null = null

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
  }

  async snapshot(): Promise<ProjectGraphSnapshot> {
    await this.mutationTail
    return this.snapshotNow()
  }

  load(): Promise<ProjectGraphSnapshot> {
    return this.refreshFromDatabase(true)
  }

  refreshFromDatabase(publish: boolean): Promise<ProjectGraphSnapshot> {
    return this.enqueue(async () => {
      const projectId = this.currentProjectId()
      const graph = await this.projects.mixerSnapshot()
      const resolved = publish
        ? await this.publisher.publish(graph)
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
      return Promise.resolve()
    })
  }

  setSoftwareMonitoringEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.publisher.publish(this.snapshotNow(), enabled, true)
    })
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
        plugin.componentState = new Uint8Array(state.componentState)
        plugin.controllerState = new Uint8Array(state.controllerState)
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
