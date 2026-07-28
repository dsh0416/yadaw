import { createReadStream } from "node:fs"
import { open, readFile, rm, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { and, asc, eq, inArray, ne, notExists, or } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import { migrate as runMigrations } from "drizzle-orm/pglite/migrator"
import type {
  MixerChannelPatch,
  MixerGraphSnapshot,
  MixerSendPatch,
  PluginDescriptor,
  PluginInstancePatch,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"
import {
  closeLargeObject,
  createLargeObject,
  openLargeObject,
  readLargeObject as readLargeObjectData,
  unlinkLargeObject,
  writeLargeObject
} from "./large-object"
import { listLargeObjectOids, vacuumAndAnalyze } from "./maintenance"
import type {
  AssetContentHash,
  DefaultRecordingTrack,
  LargeObjectAssetInput,
  MidiSourceInput,
  PluginStateInput,
  StoredWaveformWindow,
  WaveformAssetInput
} from "./protocol"
import {
  PROJECT_ID,
  PROJECT_SAMPLE_RATES,
  WAVEFORM_CACHE_VERSION,
  assets,
  assetWaveformLevels,
  keySignatureEvents,
  midiClips,
  midiEvents,
  midiNotes,
  midiSources,
  mixerChannels,
  mixerSends,
  pluginInstances,
  project,
  tempoEvents,
  timelineClips,
  timeSignatureEvents
} from "./schema"
import * as schema from "./schema"

const DEFAULT_INITIAL_TEMPO = 120
const MIGRATIONS_FOLDER = fileURLToPath(new URL(/* @vite-ignore */ "../drizzle", import.meta.url))

type ProjectDb = PgliteDatabase<typeof schema>
type ProjectTransaction = Parameters<Parameters<ProjectDb["transaction"]>[0]>[0]

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
}

function pluginDescriptor(snapshot: string): PluginDescriptor {
  const descriptor = JSON.parse(snapshot) as PluginDescriptor
  return Array.isArray(descriptor.supportedAudioModes)
    ? descriptor
    : { ...descriptor, supportedAudioModes: ["stereo"] }
}

function channelPatch(patch: MixerChannelPatch): Partial<typeof mixerChannels.$inferInsert> {
  const result: Partial<typeof mixerChannels.$inferInsert> = {}
  if (patch.name !== undefined) result.name = patch.name
  if (patch.color !== undefined) result.color = patch.color
  if (patch.sortOrder !== undefined) result.sortOrder = patch.sortOrder
  if (patch.inputSource !== undefined) result.inputSource = patch.inputSource
  if (patch.inputFormat !== undefined) result.inputFormat = patch.inputFormat
  if (patch.gainDb !== undefined) result.gainDb = patch.gainDb
  if (patch.pan !== undefined) result.pan = patch.pan
  if (patch.muted !== undefined) result.muted = patch.muted
  if (patch.soloed !== undefined) result.soloed = patch.soloed
  if (patch.outputChannelId !== undefined) result.outputChannelId = patch.outputChannelId
  if (patch.outputBus !== undefined) result.outputBus = patch.outputBus
  if (patch.recordArmed !== undefined) result.recordArmed = patch.recordArmed
  if (patch.inputMonitoring !== undefined) result.inputMonitoring = patch.inputMonitoring
  if (patch.inputChannels !== undefined) result.inputChannels = patch.inputChannels
  if (patch.hardwareOutputChannels !== undefined) {
    result.hardwareOutputChannels = patch.hardwareOutputChannels
  }
  return result
}

function sendPatch(patch: MixerSendPatch): Partial<typeof mixerSends.$inferInsert> {
  const result: Partial<typeof mixerSends.$inferInsert> = {}
  if (patch.targetChannelId !== undefined) result.targetChannelId = patch.targetChannelId
  if (patch.targetBus !== undefined) result.targetBus = patch.targetBus
  if (patch.sortOrder !== undefined) result.sortOrder = patch.sortOrder
  if (patch.enabled !== undefined) result.enabled = patch.enabled
  if (patch.tap !== undefined) result.tap = patch.tap
  if (patch.levelDb !== undefined) result.levelDb = patch.levelDb
  return result
}

function pluginPatch(patch: PluginInstancePatch): Partial<typeof pluginInstances.$inferInsert> {
  const result: Partial<typeof pluginInstances.$inferInsert> = {}
  if (patch.slotOrder !== undefined) result.slotOrder = patch.slotOrder
  if (patch.enabled !== undefined) result.enabled = patch.enabled
  if (patch.componentState !== undefined) result.componentState = patch.componentState
  if (patch.controllerState !== undefined) result.controllerState = patch.controllerState
  return result
}

function channelValue(
  channel: Extract<ProjectCommand, { type: "create-channel" }>["channel"]
): typeof mixerChannels.$inferInsert {
  return {
    id: channel.id,
    kind: channel.kind,
    systemRole: channel.systemRole,
    name: channel.name,
    color: channel.color,
    sortOrder: channel.sortOrder,
    inputSource: channel.inputSource,
    inputFormat: channel.inputFormat,
    gainDb: channel.gainDb,
    pan: channel.pan,
    muted: channel.muted,
    soloed: channel.soloed,
    outputChannelId: channel.outputChannelId,
    outputBus: channel.outputBus ?? null,
    recordArmed: channel.recordArmed,
    inputMonitoring: channel.inputMonitoring,
    inputChannels: channel.inputChannels,
    hardwareOutputChannels: channel.hardwareOutputChannels
  }
}

function sendValue(
  send: Extract<ProjectCommand, { type: "create-send" }>["send"]
): typeof mixerSends.$inferInsert {
  return {
    id: send.id,
    sourceChannelId: send.sourceChannelId,
    targetChannelId: send.targetChannelId ?? null,
    targetBus: send.targetBus,
    sortOrder: send.sortOrder,
    enabled: send.enabled,
    tap: send.tap,
    levelDb: send.levelDb
  }
}

function clipValue(
  clip: Extract<ProjectCommand, { type: "create-clip" }>["clip"]
): typeof timelineClips.$inferInsert {
  return {
    id: clip.id,
    assetId: clip.assetId,
    trackId: clip.trackId,
    name: clip.name,
    startFrame: BigInt(clip.startFrame),
    sourceOffsetFrames: BigInt(clip.sourceOffsetFrames),
    lengthFrames: BigInt(clip.lengthFrames)
  }
}

function pluginValue(
  plugin: Extract<ProjectCommand, { type: "create-plugin" }>["plugin"]
): typeof pluginInstances.$inferInsert {
  return {
    id: plugin.id,
    channelId: plugin.channelId,
    role: plugin.role,
    slotOrder: plugin.slotOrder,
    classId: plugin.classId,
    descriptorSnapshot: JSON.stringify(plugin.descriptor),
    audioMode: plugin.audioMode,
    enabled: plugin.enabled,
    componentState: plugin.componentState,
    controllerState: plugin.controllerState
  }
}

async function insertMidiClip(
  tx: ProjectTransaction,
  clip: Extract<ProjectCommand, { type: "create-midi-clip" }>["clip"]
): Promise<void> {
  await tx.insert(midiClips).values({
    id: clip.id,
    sourceId: clip.sourceId,
    trackId: clip.trackId,
    name: clip.name,
    startTick: clip.startTick,
    lengthTicks: clip.lengthTicks,
    sourceOffsetTicks: clip.sourceOffsetTicks
  })
  if (clip.notes.length > 0) {
    await tx.insert(midiNotes).values(
      clip.notes.map((note) => ({
        id: note.id,
        clipId: clip.id,
        startTick: note.startTick,
        durationTicks: note.durationTicks,
        channel: note.channel,
        key: note.key,
        velocity: note.velocity,
        releaseVelocity: note.releaseVelocity
      }))
    )
  }
  if (clip.events.length > 0) {
    await tx.insert(midiEvents).values(
      clip.events.map((event) => ({
        id: event.id,
        clipId: clip.id,
        tick: event.tick,
        channel: event.channel,
        kind: event.kind,
        data: event.data
      }))
    )
  }
}

async function applyProjectCommand(
  tx: ProjectTransaction,
  command: ProjectCommand,
  fallbackOutputId: string
): Promise<void> {
  switch (command.type) {
    case "create-channel":
      await tx.insert(mixerChannels).values(channelValue(command.channel))
      return
    case "delete-channel":
      await tx
        .update(mixerChannels)
        .set({ outputChannelId: fallbackOutputId, outputBus: null })
        .where(eq(mixerChannels.outputChannelId, command.channelId))
      await tx.delete(mixerChannels).where(eq(mixerChannels.id, command.channelId))
      return
    case "update-channel": {
      const patch = channelPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(mixerChannels).set(patch).where(eq(mixerChannels.id, command.channelId))
      }
      return
    }
    case "create-send":
      await tx.insert(mixerSends).values(sendValue(command.send))
      return
    case "delete-send":
      await tx.delete(mixerSends).where(eq(mixerSends.id, command.sendId))
      return
    case "update-send": {
      const patch = sendPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(mixerSends).set(patch).where(eq(mixerSends.id, command.sendId))
      }
      return
    }
    case "create-clip":
      await tx.insert(timelineClips).values(clipValue(command.clip))
      return
    case "delete-clip":
      await tx.delete(timelineClips).where(eq(timelineClips.id, command.clipId))
      return
    case "move-clip":
      await tx
        .update(timelineClips)
        .set({ trackId: command.trackId, startFrame: BigInt(command.startFrame) })
        .where(eq(timelineClips.id, command.clipId))
      return
    case "create-plugin":
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      return
    case "delete-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      return
    case "update-plugin": {
      const patch = pluginPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(pluginInstances).set(patch).where(eq(pluginInstances.id, command.pluginId))
      }
      return
    }
    case "move-plugin":
      {
        const rows = await tx
          .select({
            id: pluginInstances.id,
            channelId: pluginInstances.channelId,
            role: pluginInstances.role,
            slotOrder: pluginInstances.slotOrder
          })
          .from(pluginInstances)
        const moving = rows.find((plugin) => plugin.id === command.pluginId)
        if (!moving) throw new Error(`Plugin instance '${command.pluginId}' was not found`)
        const source = rows
          .filter(
            (plugin) =>
              plugin.id !== moving.id &&
              plugin.channelId === moving.channelId &&
              plugin.role === moving.role
          )
          .sort((left, right) => left.slotOrder - right.slotOrder)
        const destination = rows
          .filter(
            (plugin) =>
              plugin.id !== moving.id &&
              plugin.channelId === command.channelId &&
              plugin.role === command.role
          )
          .sort((left, right) => left.slotOrder - right.slotOrder)
        if (command.role === "instrument" && destination.length > 0) {
          throw new Error("Replace the assigned instrument instead of moving into an occupied slot")
        }
        const insertionIndex =
          command.role === "instrument"
            ? 0
            : Math.max(0, Math.min(command.slotOrder, destination.length))
        destination.splice(insertionIndex, 0, {
          ...moving,
          channelId: command.channelId,
          role: command.role,
          slotOrder: insertionIndex
        })

        // Vacate every affected unique slot before assigning compact final positions.
        const affected = new Set([
          moving.id,
          ...source.map((plugin) => plugin.id),
          ...destination.map((plugin) => plugin.id)
        ])
        let temporarySlot = 1_000_000
        for (const id of affected) {
          await tx
            .update(pluginInstances)
            .set({ slotOrder: temporarySlot++ })
            .where(eq(pluginInstances.id, id))
        }
        for (const [index, plugin] of source.entries()) {
          await tx
            .update(pluginInstances)
            .set({
              channelId: moving.channelId,
              role: moving.role,
              slotOrder: moving.role === "instrument" ? 0 : index
            })
            .where(eq(pluginInstances.id, plugin.id))
        }
        for (const [index, plugin] of destination.entries()) {
          await tx
            .update(pluginInstances)
            .set({
              channelId: command.channelId,
              role: command.role,
              slotOrder: command.role === "instrument" ? 0 : index
            })
            .where(eq(pluginInstances.id, plugin.id))
        }
      }
      return
    case "replace-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      return
    case "create-midi-clip":
      await insertMidiClip(tx, command.clip)
      return
    case "delete-midi-clip":
      await tx.delete(midiClips).where(eq(midiClips.id, command.clipId))
      return
    case "move-midi-clip":
      await tx
        .update(midiClips)
        .set({ trackId: command.trackId, startTick: command.startTick })
        .where(eq(midiClips.id, command.clipId))
      return
    case "replace-tempo-map": {
      const initialTempo = command.tempoMap.tempoEvents[0]
      const initialSignature = command.tempoMap.timeSignatureEvents[0]
      if (
        !initialTempo ||
        initialTempo.tick !== 0 ||
        !initialSignature ||
        initialSignature.tick !== 0
      ) {
        throw new Error("Tempo map requires tick 0 events")
      }
      await tx
        .update(tempoEvents)
        .set({ beatsPerMinute: initialTempo.beatsPerMinute })
        .where(eq(tempoEvents.tick, 0))
      await tx.delete(tempoEvents).where(ne(tempoEvents.tick, 0))
      if (command.tempoMap.tempoEvents.length > 1) {
        await tx.insert(tempoEvents).values(
          command.tempoMap.tempoEvents.slice(1).map((event) => ({
            tick: event.tick,
            beatsPerMinute: event.beatsPerMinute
          }))
        )
      }
      await tx
        .update(timeSignatureEvents)
        .set({
          numerator: initialSignature.numerator,
          denominator: initialSignature.denominator
        })
        .where(eq(timeSignatureEvents.tick, 0))
      await tx.delete(timeSignatureEvents).where(ne(timeSignatureEvents.tick, 0))
      if (command.tempoMap.timeSignatureEvents.length > 1) {
        await tx.insert(timeSignatureEvents).values(
          command.tempoMap.timeSignatureEvents.slice(1).map((event) => ({
            tick: event.tick,
            numerator: event.numerator,
            denominator: event.denominator
          }))
        )
      }
      return
    }
    case "replace-key-signature-map": {
      const initialKey = command.events[0]
      if (!initialKey || initialKey.tick !== 0) {
        throw new Error("Key-signature map requires a tick 0 event")
      }
      await tx
        .update(keySignatureEvents)
        .set({ fifths: initialKey.fifths, mode: initialKey.mode })
        .where(eq(keySignatureEvents.tick, 0))
      await tx.delete(keySignatureEvents).where(ne(keySignatureEvents.tick, 0))
      if (command.events.length > 1) {
        await tx.insert(keySignatureEvents).values(command.events.slice(1))
      }
      return
    }
    case "batch":
      for (const nested of command.commands) {
        await applyProjectCommand(tx, nested, fallbackOutputId)
      }
  }
}

async function assertProjectCommandAllowed(
  tx: ProjectTransaction,
  command: ProjectCommand
): Promise<void> {
  switch (command.type) {
    case "delete-channel": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.channelId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot be deleted")
      }
      return
    }
    case "create-clip":
    case "create-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.clip.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot contain clips")
      }
      return
    }
    case "move-clip":
    case "move-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot contain clips")
      }
      return
    }
    case "batch":
      for (const nested of command.commands) {
        await assertProjectCommandAllowed(tx, nested)
      }
      return
    default:
      return
  }
}

export class ProjectDatabase {
  private readonly db: ProjectDb

  private constructor(private readonly client: PGlite) {
    this.db = drizzle(client, { schema })
  }

  static async create(
    dataDir: string,
    configuration: {
      name: string
      sampleRate: number
      numerator: number
      denominator: number
      waveformDisplayMode: "separate" | "aggregate"
    }
  ): Promise<ProjectDatabase> {
    if (
      !PROJECT_SAMPLE_RATES.includes(
        configuration.sampleRate as (typeof PROJECT_SAMPLE_RATES)[number]
      )
    ) {
      throw new RangeError("Unsupported project sample rate")
    }
    const instance = new ProjectDatabase(new PGlite(dataDir))
    try {
      await instance.migrate()
      await instance.db.transaction(async (tx) => {
        await tx.insert(project).values({
          id: PROJECT_ID,
          name: configuration.name,
          sampleRate: configuration.sampleRate,
          waveformDisplayMode: configuration.waveformDisplayMode
        })
        await tx.insert(tempoEvents).values({
          tick: 0,
          beatsPerMinute: DEFAULT_INITIAL_TEMPO
        })
        await tx.insert(timeSignatureEvents).values({
          tick: 0,
          numerator: configuration.numerator,
          denominator: configuration.denominator
        })
        await tx.insert(keySignatureEvents).values({
          tick: 0,
          fifths: 0,
          mode: "major"
        })
        await tx.insert(mixerChannels).values([
          {
            id: "master",
            kind: "master",
            systemRole: null,
            name: "Master",
            color: "#8C83FF",
            sortOrder: 0,
            inputSource: null,
            inputFormat: null,
            gainDb: 0,
            pan: 0,
            muted: false,
            soloed: false,
            outputChannelId: null,
            outputBus: null,
            recordArmed: false,
            inputMonitoring: false,
            inputChannels: [],
            hardwareOutputChannels: []
          },
          {
            id: "output-1-2",
            kind: "output",
            systemRole: null,
            name: "Output 1–2",
            color: "#EF7C95",
            sortOrder: 0,
            inputSource: null,
            inputFormat: null,
            gainDb: 0,
            pan: 0,
            muted: false,
            soloed: false,
            outputChannelId: null,
            outputBus: null,
            recordArmed: false,
            inputMonitoring: false,
            inputChannels: [],
            hardwareOutputChannels: [1, 2]
          },
          {
            id: "audio-1",
            kind: "audio",
            systemRole: null,
            name: "Audio 1",
            color: "#4F8CFF",
            sortOrder: 0,
            inputSource: "hardware",
            inputFormat: "stereo",
            gainDb: 0,
            pan: 0,
            muted: false,
            soloed: false,
            outputChannelId: "output-1-2",
            outputBus: null,
            recordArmed: false,
            inputMonitoring: false,
            inputChannels: [1, 2],
            hardwareOutputChannels: []
          },
          {
            id: "metronome",
            kind: "instrument",
            systemRole: "metronome",
            name: "Metronome",
            color: "#AD8CFF",
            sortOrder: 0,
            inputSource: null,
            inputFormat: null,
            gainDb: 0,
            pan: 0,
            muted: true,
            soloed: false,
            outputChannelId: "output-1-2",
            outputBus: null,
            recordArmed: false,
            inputMonitoring: false,
            inputChannels: [],
            hardwareOutputChannels: []
          }
        ])
        await tx.insert(pluginInstances).values({
          id: "metronome-instrument",
          channelId: "metronome",
          role: "instrument",
          slotOrder: 0,
          classId: "F310A5DEDA34820C9E068A5753F83ADE",
          descriptorSnapshot: JSON.stringify({
            source: { kind: "builtin", id: "dev.yadaw.metronome" },
            classId: "F310A5DEDA34820C9E068A5753F83ADE",
            modulePath: "YADAW Metronome.vst3",
            name: "YADAW Metronome",
            vendor: "YADAW",
            version: "",
            category: "Instrument|Synth",
            kind: "instrument",
            architecture: process.arch,
            buses: [
              {
                direction: "output",
                kind: "main",
                name: "Stereo Out",
                channels: 2,
                defaultActive: true
              }
            ],
            supportedAudioModes: ["mono", "stereo"],
            hasEditor: true,
            compatibility: "compatible",
            compatibilityReason: null
          }),
          audioMode: "stereo",
          enabled: true,
          componentState: new Uint8Array(),
          controllerState: new Uint8Array()
        })
      })
      return instance
    } catch (error) {
      await instance.close()
      throw error
    }
  }

  static async open(dataDir: string, archivePath?: string): Promise<ProjectDatabase> {
    const client = archivePath
      ? await PGlite.create({
          dataDir,
          loadDataDir: new Blob([await readFile(archivePath)])
        })
      : new PGlite(dataDir)
    const instance = new ProjectDatabase(client)
    try {
      await instance.migrate()
      return instance
    } catch (error) {
      await instance.close()
      throw error
    }
  }

  async migrate(): Promise<void> {
    await runMigrations(this.db, { migrationsFolder: MIGRATIONS_FOLDER })
  }

  async getConfiguration(): Promise<ProjectConfiguration> {
    const [projectRows, signatureRows] = await Promise.all([
      this.db
        .select({
          name: project.name,
          sampleRate: project.sampleRate,
          waveformDisplayMode: project.waveformDisplayMode
        })
        .from(project)
        .where(eq(project.id, PROJECT_ID))
        .limit(1),
      this.db
        .select({
          numerator: timeSignatureEvents.numerator,
          denominator: timeSignatureEvents.denominator
        })
        .from(timeSignatureEvents)
        .where(eq(timeSignatureEvents.tick, 0))
        .limit(1)
    ])
    const projectRow = projectRows[0]
    const signature = signatureRows[0]
    if (!projectRow || !signature) throw new Error("Project configuration is missing")
    return {
      name: projectRow.name,
      sampleRate: projectRow.sampleRate as ProjectConfiguration["sampleRate"],
      timeSignatureNumerator: signature.numerator,
      timeSignatureDenominator: signature.denominator,
      waveformDisplayMode: projectRow.waveformDisplayMode
    }
  }

  async updateConfiguration(configuration: ProjectConfiguration): Promise<ProjectConfiguration> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(project)
        .set({
          name: configuration.name,
          sampleRate: configuration.sampleRate,
          waveformDisplayMode: configuration.waveformDisplayMode
        })
        .where(eq(project.id, PROJECT_ID))
      await tx
        .update(timeSignatureEvents)
        .set({
          numerator: configuration.timeSignatureNumerator,
          denominator: configuration.timeSignatureDenominator
        })
        .where(eq(timeSignatureEvents.tick, 0))
    })
    return this.getConfiguration()
  }

  listAssets(): Promise<ProjectAssetSummary[]> {
    return this.db
      .select({
        id: assets.id,
        name: assets.name,
        sampleRate: assets.sampleRate,
        channels: assets.channels,
        bitDepth: assets.bitDepth,
        frameCount: assets.frameCount
      })
      .from(assets)
      .orderBy(asc(assets.createdAt), asc(assets.id))
  }

  async mixerSnapshot(): Promise<MixerGraphSnapshot> {
    const configuration = await this.getConfiguration()
    const [
      channelRows,
      clipRows,
      sendRows,
      pluginRows,
      midiClipRows,
      midiNoteRows,
      midiEventRows,
      tempoRows,
      signatureRows,
      keySignatureRows
    ] = await Promise.all([
      this.db
        .select()
        .from(mixerChannels)
        .orderBy(asc(mixerChannels.sortOrder), asc(mixerChannels.id)),
      this.db
        .select({
          id: timelineClips.id,
          assetId: timelineClips.assetId,
          trackId: timelineClips.trackId,
          name: timelineClips.name,
          startFrame: timelineClips.startFrame,
          sourceOffsetFrames: timelineClips.sourceOffsetFrames,
          lengthFrames: timelineClips.lengthFrames,
          assetSampleRate: assets.sampleRate,
          assetChannels: assets.channels
        })
        .from(timelineClips)
        .innerJoin(assets, eq(assets.id, timelineClips.assetId))
        .orderBy(asc(timelineClips.startFrame), asc(timelineClips.id)),
      this.db
        .select()
        .from(mixerSends)
        .orderBy(asc(mixerSends.sourceChannelId), asc(mixerSends.sortOrder), asc(mixerSends.id)),
      this.db
        .select()
        .from(pluginInstances)
        .orderBy(
          asc(pluginInstances.channelId),
          asc(pluginInstances.role),
          asc(pluginInstances.slotOrder),
          asc(pluginInstances.id)
        ),
      this.db.select().from(midiClips).orderBy(asc(midiClips.startTick), asc(midiClips.id)),
      this.db
        .select()
        .from(midiNotes)
        .orderBy(asc(midiNotes.clipId), asc(midiNotes.startTick), asc(midiNotes.id)),
      this.db
        .select()
        .from(midiEvents)
        .orderBy(asc(midiEvents.clipId), asc(midiEvents.tick), asc(midiEvents.id)),
      this.db.select().from(tempoEvents).orderBy(asc(tempoEvents.tick)),
      this.db.select().from(timeSignatureEvents).orderBy(asc(timeSignatureEvents.tick)),
      this.db.select().from(keySignatureEvents).orderBy(asc(keySignatureEvents.tick))
    ])

    const kindOrder = new Map([
      ["audio", 0],
      ["instrument", 1],
      ["aux", 2],
      ["master", 3],
      ["output", 4]
    ])
    channelRows.sort(
      (left, right) =>
        (kindOrder.get(left.kind) ?? 5) - (kindOrder.get(right.kind) ?? 5) ||
        left.sortOrder - right.sortOrder ||
        left.id.localeCompare(right.id)
    )

    const notesByClip = new Map<string, MixerGraphSnapshot["midiClips"][number]["notes"]>()
    for (const note of midiNoteRows) {
      const notes = notesByClip.get(note.clipId) ?? []
      notes.push({
        id: note.id,
        startTick: note.startTick,
        durationTicks: note.durationTicks,
        channel: note.channel,
        key: note.key,
        velocity: note.velocity,
        releaseVelocity: note.releaseVelocity
      })
      notesByClip.set(note.clipId, notes)
    }
    const eventsByClip = new Map<string, MixerGraphSnapshot["midiClips"][number]["events"]>()
    for (const event of midiEventRows) {
      const events = eventsByClip.get(event.clipId) ?? []
      events.push({
        id: event.id,
        tick: event.tick,
        channel: event.channel,
        kind: event.kind,
        data: bytes(event.data)
      })
      eventsByClip.set(event.clipId, events)
    }

    return {
      sampleRate: configuration.sampleRate,
      channels: channelRows.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        systemRole: channel.systemRole,
        name: channel.name,
        color: channel.color,
        sortOrder: channel.sortOrder,
        inputSource: channel.inputSource,
        inputFormat: channel.inputFormat,
        gainDb: channel.gainDb,
        pan: channel.pan,
        muted: channel.muted,
        soloed: channel.soloed,
        outputChannelId: channel.outputChannelId,
        outputBus: channel.outputBus,
        recordArmed: channel.recordArmed,
        inputMonitoring: channel.inputMonitoring,
        inputChannels: channel.inputChannels,
        hardwareOutputChannels: channel.hardwareOutputChannels
      })),
      clips: clipRows.map((clip) => ({
        ...clip,
        startFrame: Number(clip.startFrame),
        sourceOffsetFrames: Number(clip.sourceOffsetFrames),
        lengthFrames: Number(clip.lengthFrames)
      })),
      sends: sendRows,
      plugins: pluginRows.map((plugin) => ({
        id: plugin.id,
        channelId: plugin.channelId,
        role: plugin.role,
        slotOrder: plugin.slotOrder,
        classId: plugin.classId,
        descriptor: pluginDescriptor(plugin.descriptorSnapshot),
        audioMode: plugin.audioMode,
        enabled: plugin.enabled,
        componentState: bytes(plugin.componentState),
        controllerState: bytes(plugin.controllerState)
      })),
      midiClips: midiClipRows.map((clip) => ({
        id: clip.id,
        sourceId: clip.sourceId,
        trackId: clip.trackId,
        name: clip.name,
        startTick: clip.startTick,
        lengthTicks: clip.lengthTicks,
        sourceOffsetTicks: clip.sourceOffsetTicks,
        notes: notesByClip.get(clip.id) ?? [],
        events: eventsByClip.get(clip.id) ?? []
      })),
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: tempoRows.map((event) => ({
          tick: event.tick,
          beatsPerMinute: event.beatsPerMinute
        })),
        timeSignatureEvents: signatureRows
      },
      keySignatureEvents: keySignatureRows.map((event) => ({
        ...event,
        mode: event.mode === "minor" ? "minor" : "major"
      }))
    }
  }

  applyCommand(command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      await assertProjectCommandAllowed(tx, command)
      await applyProjectCommand(tx, command, fallbackOutputId)
    })
  }

  importMidi(
    source: MidiSourceInput,
    command: ProjectCommand,
    fallbackOutputId: string
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await assertProjectCommandAllowed(tx, command)
      await tx.insert(midiSources).values(source)
      await applyProjectCommand(tx, command, fallbackOutputId)
    })
  }

  rollbackMidi(sourceId: string, command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      await assertProjectCommandAllowed(tx, command)
      await applyProjectCommand(tx, command, fallbackOutputId)
      await tx.delete(midiSources).where(eq(midiSources.id, sourceId))
    })
  }

  savePluginStates(states: PluginStateInput[]): Promise<void> {
    if (states.length === 0) return Promise.resolve()
    return this.db.transaction(async (tx) => {
      for (const state of states) {
        await tx
          .update(pluginInstances)
          .set({
            componentState: state.componentState,
            controllerState: state.controllerState
          })
          .where(eq(pluginInstances.id, state.id))
      }
    })
  }

  async assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: assets.id,
        contentHash: assets.contentHash
      })
      .from(assets)
      .where(inArray(assets.id, ids))
  }

  async defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    const rows = await this.db
      .select({
        id: mixerChannels.id,
        name: mixerChannels.name,
        inputChannels: mixerChannels.inputChannels
      })
      .from(mixerChannels)
      .where(eq(mixerChannels.kind, "audio"))
      .orderBy(asc(mixerChannels.sortOrder), asc(mixerChannels.id))
      .limit(1)
    return rows[0] ?? null
  }

  assetsMissingWaveform(cacheVersion = WAVEFORM_CACHE_VERSION): Promise<string[]> {
    return this.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        notExists(
          this.db
            .select({ assetId: assetWaveformLevels.assetId })
            .from(assetWaveformLevels)
            .where(
              and(
                eq(assetWaveformLevels.assetId, assets.id),
                eq(assetWaveformLevels.cacheVersion, cacheVersion)
              )
            )
        )
      )
      .orderBy(asc(assets.createdAt), asc(assets.id))
      .then((rows) => rows.map((row) => row.id))
  }

  async deleteAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: assets.id,
          oid: assets.largeObjectOid
        })
        .from(assets)
        .where(inArray(assets.id, ids))
      await tx.delete(assets).where(inArray(assets.id, ids))
      for (const row of rows) await unlinkLargeObject(tx, row.oid)
    })
  }

  async importLargeObject(
    filePath: string,
    asset: LargeObjectAssetInput,
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean
  ): Promise<number> {
    const file = await stat(filePath)
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: assets.id,
          contentHash: assets.contentHash,
          largeObjectOid: assets.largeObjectOid
        })
        .from(assets)
        .where(or(eq(assets.id, asset.id), eq(assets.contentHash, asset.contentHash)))
        .limit(1)
      const existingAsset = existing[0]
      if (existingAsset) {
        if (existingAsset.id === asset.id && existingAsset.contentHash === asset.contentHash) {
          return existingAsset.largeObjectOid
        }
        throw new Error(`Audio asset conflicts with existing asset ${existingAsset.id}`)
      }

      const oid = await createLargeObject(tx)
      const descriptor = await openLargeObject(tx, oid)
      let completed = 0
      for await (const value of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
        if (isCancelled?.()) throw new Error("Operation cancelled")
        const chunk = value as Buffer
        await writeLargeObject(tx, descriptor, chunk)
        completed += chunk.byteLength
        onProgress?.(completed, file.size)
      }
      await closeLargeObject(tx, descriptor)

      await tx.insert(assets).values({
        id: asset.id,
        name: asset.name,
        mimeType: asset.mimeType,
        contentHash: asset.contentHash,
        byteLength: BigInt(file.size),
        sampleRate: asset.sampleRate,
        channels: asset.channels,
        bitDepth: asset.bitDepth,
        frameCount: asset.frameCount,
        bwfTimeReference: asset.bwfTimeReference,
        largeObjectOid: oid
      })
      if (asset.waveformLevels?.length) {
        await tx.insert(assetWaveformLevels).values(
          asset.waveformLevels.map((waveform, level) => ({
            assetId: asset.id,
            cacheVersion: WAVEFORM_CACHE_VERSION,
            level,
            framesPerBucket: waveform.framesPerBucket,
            bucketCount: waveform.bucketCount,
            channels: asset.channels,
            sampleRate: asset.sampleRate,
            frameCount: asset.frameCount,
            peaks: waveform.peaks
          }))
        )
      }
      return oid
    })
  }

  async readLargeObject(assetId: string): Promise<Uint8Array> {
    const rows = await this.db
      .select({
        oid: assets.largeObjectOid
      })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1)
    const row = rows[0]
    if (!row) throw new Error(`Audio asset '${assetId}' was not found`)
    return readLargeObjectData(this.db, row.oid)
  }

  async storeWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(assetWaveformLevels).where(eq(assetWaveformLevels.assetId, assetId))
      if (waveform.levels.length > 0) {
        await tx.insert(assetWaveformLevels).values(
          waveform.levels.map((value, level) => ({
            assetId,
            cacheVersion: WAVEFORM_CACHE_VERSION,
            level,
            framesPerBucket: value.framesPerBucket,
            bucketCount: value.bucketCount,
            channels: waveform.channels,
            sampleRate: waveform.sampleRate,
            frameCount: waveform.frameCount,
            peaks: value.peaks
          }))
        )
      }
    })
  }

  async readWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    const rows = await this.db
      .select({
        framesPerBucket: assetWaveformLevels.framesPerBucket,
        bucketCount: assetWaveformLevels.bucketCount,
        channels: assetWaveformLevels.channels,
        sampleRate: assetWaveformLevels.sampleRate,
        frameCount: assetWaveformLevels.frameCount,
        peaks: assetWaveformLevels.peaks
      })
      .from(assetWaveformLevels)
      .where(
        and(
          eq(assetWaveformLevels.assetId, assetId),
          eq(assetWaveformLevels.cacheVersion, WAVEFORM_CACHE_VERSION)
        )
      )
      .orderBy(asc(assetWaveformLevels.framesPerBucket))
    if (rows.length === 0) return null
    const target = Math.max(1, Math.ceil((endFrame - startFrame) / Math.max(1, maxBuckets)))
    const selected =
      [...rows].reverse().find((level) => level.framesPerBucket <= target) ?? rows[0]!
    const frameCount = Number(selected.frameCount)
    const start = Math.max(0, Math.min(frameCount, startFrame))
    const end = Math.max(start, Math.min(frameCount, endFrame))
    const firstBucket = Math.floor(start / selected.framesPerBucket)
    const lastBucket = Math.min(selected.bucketCount, Math.ceil(end / selected.framesPerBucket))
    const bytesPerBucket = selected.channels * 8
    const peaks = bytes(selected.peaks).slice(
      firstBucket * bytesPerBucket,
      lastBucket * bytesPerBucket
    )
    return {
      sampleRate: selected.sampleRate,
      channels: selected.channels,
      frameCount,
      startFrame: firstBucket * selected.framesPerBucket,
      endFrame: Math.min(frameCount, lastBucket * selected.framesPerBucket),
      framesPerBucket: selected.framesPerBucket,
      bucketCount: lastBucket - firstBucket,
      peaks
    }
  }

  private async maintainForSave(): Promise<{ orphanedLargeObjectsRemoved: number }> {
    const orphanedLargeObjectsRemoved = await this.db.transaction(async (tx) => {
      const referencedRows = await tx
        .select({
          oid: assets.largeObjectOid
        })
        .from(assets)
      const referenced = new Set(referencedRows.map((row) => row.oid))
      const largeObjectOids = await listLargeObjectOids(tx)
      const orphaned = largeObjectOids.filter((oid) => !referenced.has(oid))
      for (const oid of orphaned) await unlinkLargeObject(tx, oid)
      return orphaned.length
    })

    await vacuumAndAnalyze(this.db)
    return { orphanedLargeObjectsRemoved }
  }

  async dumpTo(outputPath: string): Promise<void> {
    await this.maintainForSave()
    const dump = await this.client.dumpDataDir("none")
    const handle = await open(outputPath, "w")
    try {
      await handle.writeFile(Buffer.from(await dump.arrayBuffer()))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      const directory = await open(dirname(outputPath), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EPERM" && code !== "EINVAL") throw error
    }
  }

  close(): Promise<void> {
    return this.client.close()
  }

  static async discardWorkingCopy(dataDir: string): Promise<void> {
    await rm(dataDir, { recursive: true, force: true })
  }
}
