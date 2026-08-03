import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type {
  MidiClipState,
  MidiEventKind,
  MidiImportCommitResult,
  MidiImportPlan,
  MidiImportPreview,
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  ProjectCommand,
  ProjectGraphRef,
  RpcRequestMeta,
  TempoMapSnapshot
} from "@yadaw/contracts"
import { DEFAULT_INSTRUMENT_COLOR, MUSICAL_TICKS_PER_QUARTER } from "@yadaw/contracts"
import { parseMidiFile } from "@yadaw/dsp-node"
import type { NativeNormalizedSmf } from "@yadaw/dsp-node"
import type { PluginCatalogService } from "./plugin-catalog-service"
import type { ProjectCommandService } from "./project-command-service"
import type { ProjectGraphService } from "./project-graph-service"

interface PreparedImport {
  projectGraph: ProjectGraphRef
  preview: MidiImportPreview
  parsed: NativeNormalizedSmf
  rawBytes: Uint8Array
}

function tempoMapFromNative(parsed: NativeNormalizedSmf): TempoMapSnapshot {
  return {
    ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
    tempoEvents: parsed.tempoEvents.map((event) => ({
      tick: event.tick,
      beatsPerMinute: event.beatsPerMinute
    })),
    timeSignatureEvents: parsed.timeSignatureEvents.map((event) => ({
      tick: event.tick,
      numerator: event.numerator,
      denominator: event.denominator
    }))
  }
}

export class MidiImportService {
  private readonly prepared = new Map<string, PreparedImport>()

  constructor(
    private readonly graphs: ProjectGraphService,
    private readonly commands: ProjectCommandService,
    private readonly plugins: PluginCatalogService
  ) {}

  async prepare(path: string, projectGraph: ProjectGraphRef): Promise<MidiImportPreview> {
    const graph = await this.graphs.snapshot()
    const parsed = await parseMidiFile(path, {
      tempoEvents: graph.tempoMap.tempoEvents,
      timeSignatureEvents: graph.tempoMap.timeSignatureEvents
    })
    if (parsed.format !== 0 && parsed.format !== 1 && parsed.format !== 2) {
      throw new Error("Unsupported Standard MIDI File format")
    }
    const rawBytes = await readFile(path)
    const token = randomUUID()
    const preview: MidiImportPreview = {
      token,
      path,
      format: parsed.format,
      sourceTiming: parsed.sourceTiming,
      tracks: parsed.tracks.map((track) => ({
        sourceTrack: track.sourceTrack,
        sequence: track.sequence,
        name: track.name || `MIDI Track ${track.sourceTrack + 1}`,
        noteCount: track.notes.length,
        eventCount: track.events.length,
        lengthTicks: track.lengthTicks,
        tempoMap: {
          ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
          tempoEvents: track.tempoEvents.map((event) => ({
            tick: event.tick,
            beatsPerMinute: event.beatsPerMinute
          })),
          timeSignatureEvents: track.timeSignatureEvents.map((event) => ({
            tick: event.tick,
            numerator: event.numerator,
            denominator: event.denominator
          }))
        },
        warnings: track.warnings
      })),
      tempoMap: tempoMapFromNative(parsed),
      warnings: parsed.warnings
    }
    this.prepared.clear()
    this.prepared.set(token, {
      preview,
      parsed,
      rawBytes,
      projectGraph: structuredClone(projectGraph)
    })
    return structuredClone(preview)
  }

  async commit(meta: RpcRequestMeta, plan: MidiImportPlan): Promise<MidiImportCommitResult> {
    const prepared = this.prepared.get(plan.token)
    if (!prepared) throw new Error("MIDI import preview has expired; choose the file again")
    if (
      meta.target?.kind !== "project-graph" ||
      meta.target.id !== prepared.projectGraph.id ||
      meta.target.epoch !== prepared.projectGraph.epoch ||
      meta.target.generation !== prepared.projectGraph.generation
    ) {
      throw new Error("MIDI import preview belongs to a stale project graph")
    }
    if (!Number.isSafeInteger(plan.insertionTick) || plan.insertionTick < 0) {
      throw new TypeError("MIDI insertion tick must be a non-negative integer")
    }
    const selectedPlans = plan.tracks.filter((mapping) => mapping.target.type !== "ignore")
    if (selectedPlans.length === 0) throw new Error("Select at least one MIDI track to import")
    if (
      prepared.preview.format === 2 &&
      new Set(selectedPlans.map((mapping) => mapping.sequence)).size > 1
    ) {
      throw new Error("Import one Format 2 sequence at a time")
    }

    const graph = await this.graphs.snapshot()
    const defaultOutput = graph.channels.find((channel) => channel.kind === "output")
    if (!defaultOutput) throw new Error("Project has no hardware Output")
    const sourceId = randomUUID()
    const commands: ProjectCommand[] = []
    if (plan.importTempoMap) {
      const selectedSequenceMap =
        prepared.preview.format === 2
          ? prepared.preview.tracks.find((track) =>
              selectedPlans.some(
                (mapping) =>
                  mapping.sourceTrack === track.sourceTrack && mapping.sequence === track.sequence
              )
            )?.tempoMap
          : undefined
      commands.push({
        type: "replace-tempo-map",
        tempoMap: structuredClone(selectedSequenceMap ?? prepared.preview.tempoMap)
      })
    }
    let nextInstrumentOrder = graph.tracks.filter((track) => {
      const channel = graph.channels.find((candidate) => candidate.id === track.channelId)
      return channel?.kind === "instrument" && channel.systemRole === null
    }).length
    for (const mapping of selectedPlans) {
      const targetPlan = mapping.target
      if (targetPlan.type === "ignore") continue
      const parsedTrack = prepared.parsed.tracks.find(
        (track) => track.sourceTrack === mapping.sourceTrack && track.sequence === mapping.sequence
      )
      if (!parsedTrack) throw new Error(`MIDI source track ${mapping.sourceTrack} was not found`)
      let channelId: string
      let trackId: string
      if (targetPlan.type === "new") {
        channelId = randomUUID()
        trackId = randomUUID()
        const channel: MixerChannelState = {
          id: channelId,
          kind: "instrument",
          systemRole: null,
          name:
            targetPlan.name?.trim() || parsedTrack.name || `Instrument ${nextInstrumentOrder + 1}`,
          color: DEFAULT_INSTRUMENT_COLOR,
          sortOrder: nextInstrumentOrder++,
          inputSource: null,
          inputFormat: null,
          midiInput: { portId: null, portName: null, channel: null },
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: defaultOutput.id,
          outputBus: null,
          recordArmed: false,
          inputMonitoring: true,
          inputChannels: [],
          hardwareOutputChannels: []
        }
        commands.push({
          type: "create-track",
          track: { id: trackId, channelId, sortOrder: channel.sortOrder },
          channel
        })
      } else {
        const track = graph.tracks.find((candidate) => candidate.id === targetPlan.trackId)
        const target = graph.channels.find((channel) => channel.id === track?.channelId)
        if (!track || !target || target.kind !== "instrument" || target.systemRole !== null) {
          throw new Error("MIDI clips can only be imported to Instrument tracks")
        }
        trackId = track.id
        channelId = target.id
      }

      const instrumentClassId = targetPlan.instrumentClassId
      if (instrumentClassId) {
        commands.push(...this.instrumentCommands(graph.plugins, channelId, instrumentClassId))
      }
      const clip: MidiClipState = {
        id: randomUUID(),
        sourceId,
        trackId,
        name: parsedTrack.name || `MIDI Track ${parsedTrack.sourceTrack + 1}`,
        startTick: plan.importTempoMap ? 0 : plan.insertionTick,
        lengthTicks: Math.max(1, parsedTrack.lengthTicks),
        sourceOffsetTicks: 0,
        sourceLengthTicks: Math.max(1, parsedTrack.lengthTicks),
        notes: parsedTrack.notes.map((note) => ({
          id: randomUUID(),
          startTick: note.startTick,
          durationTicks: note.durationTicks,
          channel: note.channel,
          key: note.key,
          velocity: note.velocity,
          releaseVelocity: note.releaseVelocity
        })),
        events: parsedTrack.events.map((event) => ({
          id: randomUUID(),
          tick: event.tick,
          channel: event.channel ?? null,
          kind: event.kind as MidiEventKind,
          data: new Uint8Array(event.data)
        }))
      }
      commands.push({ type: "create-midi-clip", clip })
    }
    const result = await this.commands.executeMidiImport(
      meta,
      {
        id: sourceId,
        name: basename(prepared.preview.path),
        contentHash: createHash("sha256").update(prepared.rawBytes).digest("hex"),
        rawBytes: prepared.rawBytes
      },
      { type: "batch", commands }
    )
    this.prepared.delete(plan.token)
    return result
  }

  private instrumentCommands(
    existingPlugins: PluginInstanceState[],
    channelId: string,
    classId: string
  ): ProjectCommand[] {
    const descriptor = this.plugins.list().plugins.find((plugin) => plugin.classId === classId)
    this.validateInstrument(descriptor)
    const existing = existingPlugins.find(
      (plugin) => plugin.channelId === channelId && plugin.role === "instrument"
    )
    const plugin: PluginInstanceState = {
      id: existing?.id ?? randomUUID(),
      channelId,
      role: "instrument",
      slotOrder: 0,
      classId,
      descriptor: structuredClone(descriptor),
      audioMode: descriptor.supportedAudioModes.includes("stereo") ? "stereo" : "mono",
      enabled: true,
      sidechainInputs: [],
      componentState: new Uint8Array(),
      controllerState: new Uint8Array()
    }
    return existing
      ? [{ type: "replace-plugin", pluginId: existing.id, plugin }]
      : [{ type: "create-plugin", plugin }]
  }

  private validateInstrument(
    descriptor: PluginDescriptor | undefined
  ): asserts descriptor is PluginDescriptor {
    if (
      !descriptor ||
      descriptor.kind !== "instrument" ||
      descriptor.compatibility !== "compatible"
    ) {
      throw new Error("Selected VST3 instrument is not available or compatible")
    }
  }
}
