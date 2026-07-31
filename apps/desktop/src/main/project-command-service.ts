import type { MixerParameterPreview, ProjectCommand, ProjectCommandResult } from "@yadaw/contracts"
import {
  applyToGraph,
  deletedChannelIds,
  inverseFor,
  onlyRealtimeParameters,
  validateGraph
} from "@yadaw/project-model"
import type { AudioGraphPublisher } from "./audio-graph-publisher"
import type { AudioHostService } from "./audio-host-service"
import type { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"

export interface MidiSourceImport {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

export class ProjectCommandService {
  constructor(
    private readonly graphs: ProjectGraphService,
    private readonly projects: ProjectService,
    private readonly publisher: AudioGraphPublisher,
    private readonly audioHost: AudioHostService | null
  ) {}

  execute(command: ProjectCommand): Promise<ProjectCommandResult> {
    return this.graphs.enqueue(() => this.executeNow(command))
  }

  executeMidiImport(
    source: MidiSourceImport,
    command: ProjectCommand
  ): Promise<ProjectCommandResult> {
    return this.graphs.enqueue(async () => {
      const projectId = this.graphs.currentProjectId()
      const before = this.graphs.snapshotNow()
      const inverse = inverseFor(before, command)
      const candidate = applyToGraph(before, command)
      validateGraph(candidate)
      const fallbackOutput = before.channels.find((channel) => channel.kind === "output")
      if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
      await this.projects.importMidi(source, command, fallbackOutput.id)
      try {
        await this.publisher.publish(candidate)
      } catch (error) {
        await this.projects.rollbackMidi(source.id, inverse, fallbackOutput.id)
        throw error
      }
      this.graphs.commit(projectId, candidate)
      return { graph: this.graphs.snapshotNow(), inverse }
    })
  }

  private async executeNow(command: ProjectCommand): Promise<ProjectCommandResult> {
    const projectId = this.graphs.currentProjectId()
    const before = this.graphs.snapshotNow()
    const inverse = inverseFor(before, command)
    const candidate = applyToGraph(before, command)
    validateGraph(candidate)
    const deletedIds = deletedChannelIds(before, command)
    const fallbackOutput = before.channels.find(
      (channel) => channel.kind === "output" && !deletedIds.has(channel.id)
    )
    if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
    await this.projects.applyProjectCommand(command, fallbackOutput.id)
    try {
      if (onlyRealtimeParameters(command)) await this.previewCommitted(command)
      else await this.publisher.publish(candidate)
    } catch (error) {
      await this.projects.applyProjectCommand(inverse, fallbackOutput.id)
      throw error
    }
    this.graphs.commit(projectId, candidate)
    return { graph: this.graphs.snapshotNow(), inverse }
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
