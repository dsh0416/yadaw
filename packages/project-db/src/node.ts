import { readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { asc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import { migrate as runMigrations } from "drizzle-orm/pglite/migrator"
import type {
  MixerGraphSnapshot,
  ProjectAssetSummary,
  ProjectCommand,
  ProjectConfiguration
} from "@yadaw/contracts"
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
  keySignatureEvents,
  mixerChannels,
  pluginInstances,
  project,
  tempoEvents,
  timeSignatureEvents
} from "./schema"
import * as schema from "./schema"
import { applyProjectCommand, assertProjectCommandAllowed } from "./internal/command-persistence"
import { readMixerSnapshot } from "./internal/mixer-reads"
import { ProjectAssetRepository } from "./internal/assets"
import { dumpProjectArchive } from "./internal/archive"
import { importMidiSource, rollbackMidiSource } from "./internal/midi"

const DEFAULT_INITIAL_TEMPO = 120
const MIGRATIONS_FOLDER = fileURLToPath(new URL(/* @vite-ignore */ "../drizzle", import.meta.url))

type ProjectDb = PgliteDatabase<typeof schema>

export class ProjectDatabase {
  private readonly db: ProjectDb
  private readonly assetRepository: ProjectAssetRepository

  private constructor(private readonly client: PGlite) {
    this.db = drizzle(client, { schema })
    this.assetRepository = new ProjectAssetRepository(this.db)
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
    return readMixerSnapshot(this.db, await this.getConfiguration())
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
    return importMidiSource(this.db, source, command, fallbackOutputId)
  }

  rollbackMidi(sourceId: string, command: ProjectCommand, fallbackOutputId: string): Promise<void> {
    return rollbackMidiSource(this.db, sourceId, command, fallbackOutputId)
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

  assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    return this.assetRepository.assetContentHashes(ids)
  }

  defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    return this.assetRepository.defaultRecordingTrack()
  }

  assetsMissingWaveform(cacheVersion = WAVEFORM_CACHE_VERSION): Promise<string[]> {
    return this.assetRepository.assetsMissingWaveform(cacheVersion)
  }

  deleteAssets(ids: string[]): Promise<void> {
    return this.assetRepository.deleteAssets(ids)
  }

  importLargeObject(
    filePath: string,
    asset: LargeObjectAssetInput,
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean
  ): Promise<number> {
    return this.assetRepository.importLargeObject(filePath, asset, onProgress, isCancelled)
  }

  readLargeObject(assetId: string): Promise<Uint8Array> {
    return this.assetRepository.readLargeObject(assetId)
  }

  storeWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    return this.assetRepository.storeWaveform(assetId, waveform)
  }

  readWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    return this.assetRepository.readWaveform(assetId, startFrame, endFrame, maxBuckets)
  }

  dumpTo(outputPath: string): Promise<void> {
    return dumpProjectArchive(this.db, this.client, outputPath)
  }

  close(): Promise<void> {
    return this.client.close()
  }

  static async discardWorkingCopy(dataDir: string): Promise<void> {
    await rm(dataDir, { recursive: true, force: true })
  }
}
