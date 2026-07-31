import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  ProjectCommand,
  ProjectCommandResult,
  TransportCommand,
  TransportSnapshot
} from "@yadaw/contracts"
import type { PluginStateInput } from "@yadaw/project-db/protocol"
import {
  applyToGraph,
  cloneGraph,
  deletedChannelIds,
  finiteRange,
  inverseFor,
  onlyRealtimeParameters,
  validateGraph
} from "@yadaw/project-model"
import { type AudioHostGraph, AudioHostService } from "./audio-host-service"
import { ApplicationSettingsStore } from "./application-settings"
import type { PluginCatalogService } from "./plugin-catalog-service"
import type { ProjectService } from "./project-service"

export interface MidiSourceImport {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

export class MixerService {
  private readonly cacheDirectory: string
  private mutationTail: Promise<void> = Promise.resolve()
  private cachedProject: { projectId: string; graph: MixerGraphSnapshot } | null = null
  private graphRevision = 0
  private testTransport: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 48_000
  }

  constructor(
    userData: string,
    private readonly projects: ProjectService,
    private readonly audioHost: AudioHostService | null = null,
    private readonly plugins: PluginCatalogService | null = null,
    private readonly settings: ApplicationSettingsStore | null = null
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private currentProjectId(): string {
    const current = this.projects.current
    if (!current) throw new Error("No project is open")
    return current.id
  }

  private resolveGraph(graph: MixerGraphSnapshot): MixerGraphSnapshot {
    const resolved = cloneGraph(graph)
    resolved.plugins = resolved.plugins.map((plugin) => ({
      ...plugin,
      descriptor: this.plugins?.resolveDescriptor(plugin.descriptor) ?? plugin.descriptor
    }))
    return resolved
  }

  private snapshotNow(): MixerGraphSnapshot {
    const projectId = this.currentProjectId()
    if (!this.cachedProject || this.cachedProject.projectId !== projectId) {
      this.cachedProject = null
      throw new Error("Mixer graph is not loaded")
    }
    return this.resolveGraph(this.cachedProject.graph)
  }

  private commitGraph(projectId: string, graph: MixerGraphSnapshot): void {
    if (this.currentProjectId() !== projectId) {
      throw new Error("Project changed while updating the mixer graph")
    }
    this.cachedProject = { projectId, graph }
  }

  async snapshot(): Promise<MixerGraphSnapshot> {
    await this.mutationTail
    return this.snapshotNow()
  }

  private async cacheAssets(graph: MixerGraphSnapshot): Promise<Map<string, string>> {
    await mkdir(this.cacheDirectory, { recursive: true })
    const ids = [...new Set(graph.clips.map((clip) => clip.assetId))]
    const contentHashes = new Map(
      (await this.projects.assetContentHashes(ids)).map((asset) => [asset.id, asset.contentHash])
    )
    const result = new Map<string, string>()
    for (const id of ids) {
      const contentHash = contentHashes.get(id) ?? "unknown"
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_")
      const path = join(this.cacheDirectory, `${safeId}-${contentHash}.bwf`)
      try {
        await access(path)
      } catch {
        const temporary = `${path}.${process.pid}.tmp`
        try {
          await writeFile(temporary, await this.projects.readAssetAudio(id))
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      result.set(id, path)
    }
    return result
  }

  load(): Promise<MixerGraphSnapshot> {
    return this.refreshFromDatabase(true)
  }

  refreshFromDatabase(publish: boolean): Promise<MixerGraphSnapshot> {
    return this.enqueueMutation(async () => {
      const projectId = this.currentProjectId()
      const graph = await this.projects.mixerSnapshot()
      const resolved = publish
        ? await this.publishGraph(graph)
        : (() => {
            const value = this.resolveGraph(graph)
            validateGraph(value)
            return value
          })()
      this.commitGraph(projectId, graph)
      return cloneGraph(resolved)
    })
  }

  clearProject(): Promise<void> {
    return this.enqueueMutation(() => {
      this.cachedProject = null
      return Promise.resolve()
    })
  }

  private async publishGraph(
    source: MixerGraphSnapshot,
    softwareMonitoringOverride?: boolean,
    awaitPublication = false
  ): Promise<MixerGraphSnapshot> {
    const graph = this.resolveGraph(source)
    const softwareMonitoringEnabled =
      softwareMonitoringOverride ?? (await this.settings?.get())?.softwareMonitoringEnabled ?? false
    if (process.env.YADAW_TEST_CAPTURE_SOURCE === "1") {
      this.testTransport.sampleRate = graph.sampleRate
    }
    validateGraph(graph)
    const paths = await this.cacheAssets(graph)
    const runtimeGraph: AudioHostGraph = {
      sample_rate: graph.sampleRate,
      channels: graph.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        system_role: channel.systemRole ?? undefined,
        gain_db: channel.gainDb,
        pan: channel.pan,
        muted: channel.muted,
        soloed: channel.soloed,
        record_armed: channel.recordArmed,
        input_monitoring:
          channel.kind === "instrument" && channel.systemRole === null
            ? channel.inputMonitoring
            : softwareMonitoringEnabled &&
              channel.kind === "audio" &&
              channel.inputMonitoring &&
              channel.inputSource === "hardware",
        midi_input_port_id: channel.midiInput?.portId ?? undefined,
        midi_input_port_name: channel.midiInput?.portName ?? undefined,
        midi_input_channel: channel.midiInput?.channel ?? undefined,
        input_source: channel.inputSource ?? undefined,
        input_channels: channel.inputChannels,
        hardware_output_channels: channel.hardwareOutputChannels,
        output_channel_id: channel.outputChannelId ?? undefined,
        output_bus: channel.outputBus ?? undefined
      })),
      sends: graph.sends.map((send) => ({
        id: send.id,
        source_channel_id: send.sourceChannelId,
        target_channel_id: send.targetChannelId ?? undefined,
        target_bus: send.targetBus ?? undefined,
        enabled: send.enabled,
        tap: send.tap,
        level_db: send.levelDb
      })),
      clips: graph.clips.map((clip) => ({
        id: clip.id,
        channel_id: clip.trackId,
        start_frame: clip.startFrame,
        source_offset_frames: clip.sourceOffsetFrames,
        length_frames: clip.lengthFrames,
        path: paths.get(clip.assetId)!
      })),
      plugins: graph.plugins.map((plugin) => ({
        instance_id: plugin.id,
        channel_id: plugin.channelId,
        role: plugin.role,
        slot_order: plugin.slotOrder,
        audio_mode: plugin.audioMode,
        enabled: plugin.enabled,
        latency_samples: 0,
        tail_samples: 0
      })),
      midi_clips: graph.midiClips.map((clip) => ({
        id: clip.id,
        channel_id: clip.trackId,
        start_tick: clip.startTick,
        source_offset_ticks: clip.sourceOffsetTicks,
        length_ticks: clip.lengthTicks,
        notes: {
          storage: "inline",
          notes: clip.notes.map((note) => ({
            start_tick: note.startTick,
            duration_ticks: note.durationTicks,
            channel: note.channel,
            key: note.key,
            velocity: note.velocity,
            release_velocity: note.releaseVelocity
          }))
        },
        events: {
          storage: "inline",
          events: clip.events.map((event) => ({
            tick: event.tick,
            channel: event.channel,
            kind: event.kind,
            data: {
              storage: "inline",
              bytes: event.data
            }
          }))
        }
      })),
      tempo_events: graph.tempoMap.tempoEvents.map((event) => ({
        tick: event.tick,
        beats_per_minute: event.beatsPerMinute
      })),
      time_signature_events: graph.tempoMap.timeSignatureEvents.map((event) => ({
        tick: event.tick,
        numerator: event.numerator,
        denominator: event.denominator
      }))
    }
    this.graphRevision += 1
    await this.audioHost?.loadGraph(this.graphRevision, graph, runtimeGraph, awaitPublication)
    return graph
  }

  setSoftwareMonitoringEnabled(enabled: boolean): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.publishGraph(this.snapshotNow(), enabled, true)
    })
  }

  savePluginStates(states: PluginStateInput[]): Promise<void> {
    if (states.length === 0) return Promise.resolve()
    return this.enqueueMutation(async () => {
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
      this.commitGraph(projectId, next)
    })
  }

  deleteUnusedAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    return this.enqueueMutation(async () => {
      const projectId = this.currentProjectId()
      if (!this.cachedProject || this.cachedProject.projectId !== projectId) {
        this.cachedProject = null
        throw new Error("Mixer graph is not loaded")
      }
      const referenced = new Set(this.cachedProject.graph.clips.map((clip) => clip.assetId))
      const used = ids.find((id) => referenced.has(id))
      if (used) throw new Error(`Audio asset '${used}' is still used by a timeline clip`)
      await this.projects.deleteAssets(ids)
    })
  }

  execute(command: ProjectCommand): Promise<ProjectCommandResult> {
    return this.enqueueMutation(() => this.executeNow(command))
  }

  executeMidiImport(
    source: MidiSourceImport,
    command: ProjectCommand
  ): Promise<ProjectCommandResult> {
    return this.enqueueMutation(async () => {
      const projectId = this.currentProjectId()
      const before = this.snapshotNow()
      const inverse = inverseFor(before, command)
      const candidate = applyToGraph(before, command)
      validateGraph(candidate)
      const fallbackOutput = before.channels.find((channel) => channel.kind === "output")
      if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
      await this.projects.importMidi(source, command, fallbackOutput.id)
      try {
        await this.publishGraph(candidate)
      } catch (error) {
        await this.projects.rollbackMidi(source.id, inverse, fallbackOutput.id)
        throw error
      }
      this.commitGraph(projectId, candidate)
      return { graph: this.snapshotNow(), inverse }
    })
  }

  private async executeNow(command: ProjectCommand): Promise<ProjectCommandResult> {
    const projectId = this.currentProjectId()
    const before = this.snapshotNow()
    const inverse = inverseFor(before, command)
    const candidate = applyToGraph(before, command)
    validateGraph(candidate)
    const deletedIds = deletedChannelIds(command)
    const fallbackOutput = before.channels.find(
      (channel) => channel.kind === "output" && !deletedIds.has(channel.id)
    )
    if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
    await this.projects.applyProjectCommand(command, fallbackOutput.id)
    try {
      if (onlyRealtimeParameters(command)) {
        await this.previewCommitted(command)
      } else {
        await this.publishGraph(candidate)
      }
    } catch (error) {
      await this.projects.applyProjectCommand(inverse, fallbackOutput.id)
      throw error
    }
    this.commitGraph(projectId, candidate)
    return { graph: this.snapshotNow(), inverse }
  }
  private async previewCommitted(command: ProjectCommand): Promise<void> {
    if (command.type === "batch") {
      for (const nested of command.commands) await this.previewCommitted(nested)
      return
    }
    if (command.type === "update-channel") {
      if (command.patch.gainDb !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "channel",
          id: command.channelId,
          parameter: "gainDb",
          value: command.patch.gainDb
        })
      }
      if (command.patch.pan !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "channel",
          id: command.channelId,
          parameter: "pan",
          value: command.patch.pan
        })
      }
    } else if (command.type === "update-send") {
      if (command.patch.levelDb !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "send",
          id: command.sendId,
          parameter: "levelDb",
          value: command.patch.levelDb
        })
      }
    }
  }

  async preview(preview: MixerParameterPreview): Promise<void> {
    finiteRange(
      preview.value,
      preview.parameter === "pan" ? -1 : -90,
      preview.parameter === "pan" ? 1 : 12,
      "Mixer preview"
    )
    await this.audioHost?.previewMixerParameter(preview)
  }

  async runtimeSnapshot(): Promise<MixerRuntimeSnapshot> {
    return this.audioHost?.mixerSnapshot() ?? { meters: [], capturedAt: Date.now() }
  }

  async clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    return this.audioHost?.clearMeterClips() ?? { meters: [], capturedAt: Date.now() }
  }

  async transport(command: TransportCommand): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_MOCK_AUDIO !== "1"
    ) {
      if (command.type === "seek") {
        this.testTransport.positionFrames = command.positionFrames
      } else if (command.type === "stop") {
        this.testTransport.state = "stopped"
        this.testTransport.positionFrames = 0
      } else if (command.type === "pause") {
        this.testTransport.state = "stopped"
      } else if (command.type === "play") {
        this.testTransport.state = "playing"
      } else if (command.type === "record") {
        this.testTransport.state = "recording"
      }
      return { ...this.testTransport }
    }
    if (!this.audioHost) throw new Error("Audio host is not running")
    try {
      return await this.audioHost.transport(command)
    } catch (error) {
      if (
        (command.type === "stop" || command.type === "pause") &&
        error instanceof Error &&
        error.message.includes("audio engine must be running before transport")
      ) {
        return {
          state: "stopped",
          positionFrames: 0,
          sampleRate:
            this.projects.current?.configuration.sampleRate ?? this.testTransport.sampleRate
        }
      }
      throw error
    }
  }

  async transportSnapshot(): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_MOCK_AUDIO !== "1"
    ) {
      return { ...this.testTransport }
    }
    if (!this.audioHost) {
      return { state: "stopped", positionFrames: 0, sampleRate: 0 }
    }
    return this.audioHost.transportSnapshot()
  }
}
