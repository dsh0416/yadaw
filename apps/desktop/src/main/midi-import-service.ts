import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type {
  MidiClipState,
  MidiEventKind,
  MidiImportPlan,
  MidiImportPreview,
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  ProjectCommand,
  ProjectCommandResult,
  TempoMapSnapshot
} from "@yadaw/contracts"
import { DEFAULT_INSTRUMENT_COLOR, MUSICAL_TICKS_PER_QUARTER } from "@yadaw/contracts"
import { parseMidiFile } from "@yadaw/dsp-node"
import type { NativeNormalizedSmf } from "@yadaw/dsp-node"
import type { MixerService } from "./mixer-service"
import type { PluginCatalogService } from "./plugin-catalog-service"

interface PreparedImport {
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
    private readonly mixer: MixerService,
    private readonly plugins: PluginCatalogService
  ) {}

  async prepare(path: string): Promise<MidiImportPreview> {
    const graph = await this.mixer.snapshot()
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
    this.prepared.set(token, { preview, parsed, rawBytes })
    return structuredClone(preview)
  }

  async commit(plan: MidiImportPlan): Promise<ProjectCommandResult> {
    const prepared = this.prepared.get(plan.token)
    if (!prepared) throw new Error("MIDI import preview has expired; choose the file again")
    if (!Number.isSafeInteger(plan.insertionTick) || plan.insertionTick < 0) {
      throw new TypeError("MIDI insertion tick must be a non-negative integer")
    }
    const selectedPlans = plan.tracks.filter((mapping) => mapping.target.type !== "ignore")
    if (selectedPlans.length === 0) throw new Error("Select at least one MIDI track to import")
    if (prepared.preview.format === 2 &&
        new Set(selectedPlans.map((mapping) => mapping.sequence)).size > 1) {
      throw new Error("Import one Format 2 sequence at a time")
    }

    const graph = await this.mixer.snapshot()
    const defaultOutput = graph.channels.find((channel) => channel.kind === "output")
    if (!defaultOutput) throw new Error("Project has no hardware Output")
    const sourceId = randomUUID()
    const commands: ProjectCommand[] = []
    if (plan.importTempoMap) {
      const selectedSequenceMap = prepared.preview.format === 2
        ? prepared.preview.tracks.find((track) =>
            selectedPlans.some((mapping) =>
              mapping.sourceTrack === track.sourceTrack && mapping.sequence === track.sequence
            )
          )?.tempoMap
        : undefined
      commands.push({
        type: "replace-tempo-map",
        tempoMap: structuredClone(selectedSequenceMap ?? prepared.preview.tempoMap)
      })
    }
    let nextInstrumentOrder = graph.channels.filter((channel) =>
      channel.kind === "instrument"
    ).length
    for (const mapping of selectedPlans) {
      const targetPlan = mapping.target
      if (targetPlan.type === "ignore") continue
      const parsedTrack = prepared.parsed.tracks.find((track) =>
        track.sourceTrack === mapping.sourceTrack && track.sequence === mapping.sequence
      )
      if (!parsedTrack) throw new Error(`MIDI source track ${mapping.sourceTrack} was not found`)
      let channelId: string
      if (targetPlan.type === "new") {
        channelId = randomUUID()
        const channel: MixerChannelState = {
          id: channelId,
          kind: "instrument",
          name: targetPlan.name?.trim() ||
            parsedTrack.name ||
            `Instrument ${nextInstrumentOrder + 1}`,
          color: DEFAULT_INSTRUMENT_COLOR,
          sortOrder: nextInstrumentOrder++,
          inputFormat: null,
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: defaultOutput.id,
          recordArmed: false,
          inputChannels: [],
          hardwareOutputChannels: []
        }
        commands.push({ type: "create-channel", channel })
      } else {
        const target = graph.channels.find((channel) => channel.id === targetPlan.channelId)
        if (!target || target.kind !== "instrument") {
          throw new Error("MIDI clips can only be imported to Instrument tracks")
        }
        channelId = target.id
      }

      const instrumentClassId = targetPlan.instrumentClassId
      if (instrumentClassId) {
        commands.push(...this.instrumentCommands(graph.plugins, channelId, instrumentClassId))
      }
      const clip: MidiClipState = {
        id: randomUUID(),
        sourceId,
        trackId: channelId,
        name: parsedTrack.name || `MIDI Track ${parsedTrack.sourceTrack + 1}`,
        startTick: plan.importTempoMap ? 0 : plan.insertionTick,
        lengthTicks: Math.max(1, parsedTrack.lengthTicks),
        sourceOffsetTicks: 0,
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
    const result = await this.mixer.executeMidiImport({
      id: sourceId,
      name: basename(prepared.preview.path),
      contentHash: createHash("sha256").update(prepared.rawBytes).digest("hex"),
      rawBytes: prepared.rawBytes
    }, { type: "batch", commands })
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
    const existing = existingPlugins.find((plugin) =>
      plugin.channelId === channelId && plugin.role === "instrument"
    )
    const plugin: PluginInstanceState = {
      id: existing?.id ?? randomUUID(),
      channelId,
      role: "instrument",
      slotOrder: 0,
      classId,
      descriptor: structuredClone(descriptor),
      enabled: true,
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
    if (!descriptor || descriptor.kind !== "instrument" ||
        descriptor.compatibility !== "compatible") {
      throw new Error("Selected VST3 instrument is not available or compatible")
    }
  }
}
