import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type {
  OperationSnapshot,
  PendingRecording,
  RecordedTrackAsset,
  RecordingSession,
  WaveformPeakWindow,
  WaveformWindowRequest
} from "@yadaw/contracts"
import {
  audioEngineSnapshot,
  finalizeRecording,
  repairRecordingHeader,
  startRecording as startNativeRecording,
  stopRecording as stopNativeRecording,
  writeDeterministicTestRecording
} from "@yadaw/dsp-node"
import { recordingWaveformSnapshot as nativeRecordingWaveformSnapshot } from "@yadaw/dsp-node"
import type { ApplicationSettingsStore } from "./application-settings"
import type { OperationService } from "./operation-service"
import type { ProjectService } from "./project-service"
import type { MixerService } from "./mixer-service"

interface RecordingTrackSidecar {
  assetId: string
  trackId: string
  trackName: string
  inputChannels: number[]
  finalPath: string | null
  contentHash: string | null
  sampleRate: number | null
  channels: number | null
  frameCount: number | null
}

interface RecordingSidecar extends PendingRecording {
  finalPath: string | null
  bitDepth: "float32" | "pcm24" | "pcm16"
  frameCount: number
  contentHash: string | null
  startFrame: number
  tracks: RecordingTrackSidecar[]
  resumePlaybackAfterRecording: boolean
}

function utcFields(date: Date): { date: string; time: string } {
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19)
  }
}

export class RecordingService {
  private active: RecordingSidecar | null = null
  private lastWaveformSnapshot: WaveformPeakWindow | null = null

  constructor(
    private readonly settings: ApplicationSettingsStore,
    private readonly projects: ProjectService,
    private readonly operations: OperationService,
    private readonly mixer: MixerService
  ) {}

  get current(): RecordingSession | null {
    return this.active ? this.toSession(this.active) : null
  }

  private toSession(recording: RecordingSidecar): RecordingSession {
    return {
      id: recording.id,
      startedAt: recording.startedAt,
      swapPath: recording.audioPath,
      startFrame: recording.startFrame,
      trackIds: recording.tracks.map((track) => track.trackId)
    }
  }

  private async writeSidecar(recording: RecordingSidecar): Promise<void> {
    const temporary = `${recording.sidecarPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(recording, null, 2)}\n`, "utf8")
    await rename(temporary, recording.sidecarPath)
  }

  async start(): Promise<RecordingSession> {
    if (this.active) throw new Error("A recording is already active")
    this.lastWaveformSnapshot = null
    const project = this.projects.current
    if (!project) throw new Error("Open a project before recording")
    const deterministicTestCapture = process.env.YADAW_TEST_CAPTURE_SOURCE === "1"
    const runtime = audioEngineSnapshot()
    if (!deterministicTestCapture && (runtime.state !== "running" || !runtime.inputSampleRate)) {
      throw new Error("Start the audio engine before recording")
    }
    const applicationSettings = await this.settings.get()
    const graph = await this.mixer.snapshot()
    const armed = graph.channels.filter((channel) =>
      channel.kind === "audio" && channel.recordArmed
    )
    const targets = armed.length > 0
      ? armed
      : graph.channels.filter((channel) => channel.kind === "audio").slice(0, 1)
    if (targets.length === 0) throw new Error("Arm an audio track before recording")
    await mkdir(applicationSettings.swapDirectory, { recursive: true })
    const id = randomUUID()
    const startedAt = Date.now()
    const transportBeforeRecording = this.mixer.transportSnapshot()
    const startFrame = transportBeforeRecording.positionFrames
    const partialPath = join(applicationSettings.swapDirectory, `${id}.partial.bwf`)
    const sidecarPath = join(applicationSettings.swapDirectory, `${id}.recording.json`)
    const sidecar: RecordingSidecar = {
      id,
      state: "partial",
      audioPath: partialPath,
      sidecarPath,
      projectPath: project.path,
      sampleRate: deterministicTestCapture ? 48_000 : runtime.inputSampleRate!,
      channels: 2,
      startedAt,
      dropoutFrames: 0,
      assetExists: false,
      finalPath: null,
      bitDepth: applicationSettings.recordingBitDepth,
      frameCount: 0,
      contentHash: null,
      startFrame,
      recordedTracks: [],
      resumePlaybackAfterRecording: transportBeforeRecording.state === "playing",
      tracks: targets.map((track, index) => ({
        assetId: index === 0 ? id : randomUUID(),
        trackId: track.id,
        trackName: track.name,
        inputChannels: [...track.inputChannels],
        finalPath: null,
        contentHash: null,
        sampleRate: null,
        channels: null,
        frameCount: null
      }))
    }
    await this.writeSidecar(sidecar)
    const utc = utcFields(new Date(startedAt))
    try {
      if (!deterministicTestCapture) startNativeRecording({
        path: partialPath,
        assetId: id,
        originator: "YADAW",
        originationDate: utc.date,
        originationTime: utc.time,
        timeReference: Math.round(
          startFrame * sidecar.sampleRate / project.configuration.sampleRate
        )
      })
      this.mixer.transport({ type: "record" })
    } catch (error) {
      await rm(sidecarPath, { force: true })
      throw error
    }
    this.active = sidecar
    return this.toSession(sidecar)
  }

  async stop(onFinalizing?: () => void): Promise<PendingRecording> {
    const recording = this.active
    if (!recording) throw new Error("No recording is active")
    this.active = null
    const operationId = `recording:${recording.id}`
    const operation: OperationSnapshot = {
      id: operationId,
      title: `Finalizing ${basename(recording.audioPath)}`,
      phase: "closing-recording",
      state: "running",
      completedUnits: null,
      totalUnits: null,
      cancellable: false,
      message: null,
      dropoutFrames: 0
    }
    this.operations.upsert(operation, true)
    try {
      const startedUtc = utcFields(new Date(recording.startedAt))
      const deterministicFrameCount = Math.min(
        0xffff_ffff,
        Math.max(
          4_800,
          Math.round((Date.now() - recording.startedAt) / 1_000 * recording.sampleRate)
        )
      )
      let captured
      try {
        captured = process.env.YADAW_TEST_CAPTURE_SOURCE === "1"
          ? writeDeterministicTestRecording({
              path: recording.audioPath,
              assetId: recording.id,
              originator: "YADAW test",
              originationDate: startedUtc.date,
              originationTime: startedUtc.time,
              timeReference: recording.startFrame
            }, recording.sampleRate, deterministicFrameCount)
          : stopNativeRecording()
      } finally {
        this.mixer.transport({
          type: recording.resumePlaybackAfterRecording ? "play" : "pause"
        })
      }
      recording.frameCount = captured.frameCount
      recording.dropoutFrames = captured.dropoutFrames
      recording.channels = captured.channels
      const readyPath = recording.audioPath.replace(".partial.bwf", ".ready.bwf")
      await rename(recording.audioPath, readyPath)
      recording.audioPath = readyPath
      recording.state = "ready"
      await this.writeSidecar(recording)
      onFinalizing?.()
      await this.finalizeAndCommit(recording, operationId)
      return this.toPending(recording)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.operations.patch(operationId, { state: "failed", message, cancellable: false }, true)
      throw error
    }
  }

  waveformSnapshot(request: WaveformWindowRequest): WaveformPeakWindow {
    const recording = this.active
    if (!recording || recording.id !== request.id) {
      if (this.lastWaveformSnapshot?.id === request.id) {
        return structuredClone(this.lastWaveformSnapshot)
      }
      throw new Error("Recording is no longer active")
    }
    if (
      request.startFrame < 0 ||
      request.endFrame < request.startFrame ||
      request.maxBuckets < 1 ||
      request.maxBuckets > 4_096
    ) {
      throw new TypeError("Invalid recording waveform request")
    }
    if (process.env.YADAW_TEST_CAPTURE_SOURCE === "1") {
      const frameCount = Math.max(1, Math.floor((Date.now() - recording.startedAt) / 1_000 * recording.sampleRate))
      const start = Math.min(frameCount, request.startFrame)
      const end = Math.min(frameCount, Math.max(start, request.endFrame))
      let framesPerBucket = 64
      while (Math.ceil((end - start) / framesPerBucket) > request.maxBuckets) framesPerBucket *= 4
      const bucketCount = Math.ceil((end - start) / framesPerBucket)
      const values = new Float32Array(bucketCount * 4)
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        let minimum = 1
        let maximum = -1
        const bucketStart = start + bucket * framesPerBucket
        const bucketEnd = Math.min(end, bucketStart + framesPerBucket)
        for (let frame = bucketStart; frame < bucketEnd; frame += 1) {
          const sample = Math.sin(Math.PI * 2 * 1_000 * frame / recording.sampleRate) * 0.25
          minimum = Math.min(minimum, sample)
          maximum = Math.max(maximum, sample)
        }
        values.set([minimum, maximum, minimum, maximum], bucket * 4)
      }
      const result: WaveformPeakWindow = {
        id: request.id,
        sampleRate: recording.sampleRate,
        channels: 2,
        frameCount,
        startFrame: start,
        endFrame: end,
        framesPerBucket,
        bucketCount,
        peaks: new Uint8Array(values.buffer)
      }
      this.lastWaveformSnapshot = result
      return result
    }
    const snapshot = nativeRecordingWaveformSnapshot(
      request.startFrame,
      request.endFrame,
      request.maxBuckets
    )
    const result: WaveformPeakWindow = {
      id: request.id,
      sampleRate: snapshot.sampleRate,
      channels: snapshot.channels,
      frameCount: snapshot.frameCount,
      startFrame: snapshot.startFrame,
      endFrame: snapshot.endFrame,
      framesPerBucket: snapshot.framesPerBucket,
      bucketCount: snapshot.bucketCount,
      peaks: new Uint8Array(snapshot.peaks)
    }
    this.lastWaveformSnapshot = result
    return result
  }

  private async finalizeAndCommit(recording: RecordingSidecar, operationId: string): Promise<void> {
    const project = this.projects.current
    if (!project || project.path !== recording.projectPath) {
      throw new Error("Open the recording's project before recovering it")
    }
    if (!recording.tracks?.length) {
      const fallback = await this.projects.query({
        sql: `SELECT id, name, input_channels FROM mixer_channels
          WHERE kind = 'audio' ORDER BY sort_order, id LIMIT 1`,
        params: [],
        method: "all"
      })
      const row = fallback.rows[0]
      if (!row) throw new Error("The recording project has no audio track")
      recording.startFrame ??= 0
      recording.tracks = [{
        assetId: recording.id,
        trackId: String(row[0]),
        trackName: String(row[1]),
        inputChannels: Array.isArray(row[2]) ? row[2].map(Number) : [1, 2],
        finalPath: recording.finalPath,
        contentHash: recording.contentHash,
        sampleRate: null,
        channels: null,
        frameCount: null
      }]
    }
    const started = new Date(recording.startedAt)
    const utc = utcFields(started)
    this.operations.patch(operationId, {
      phase: "resampling",
      completedUnits: null,
      totalUnits: null,
      cancellable: false
    }, true)
    const finalizedTracks = []
    for (const [index, track] of recording.tracks.entries()) {
      const finalPath = recording.audioPath.replace(
        ".ready.bwf",
        `.track-${index + 1}.final-${recording.bitDepth}.bwf`
      )
      const finalized = await finalizeRecording({
        inputPath: recording.audioPath,
        outputPath: finalPath,
        targetSampleRate: project.configuration.sampleRate,
        bitDepth: recording.bitDepth,
        assetId: track.assetId,
        originator: "YADAW",
        originationDate: utc.date,
        originationTime: utc.time,
        timeReference: recording.startFrame,
        channelIndices: track.inputChannels
      })
      track.finalPath = finalPath
      track.contentHash = finalized.contentHash
      track.sampleRate = finalized.sampleRate
      track.channels = finalized.channels
      track.frameCount = finalized.frameCount
      finalizedTracks.push({ track, finalized })
    }
    const primary = finalizedTracks[0]!
    recording.finalPath = primary.track.finalPath
    recording.contentHash = primary.finalized.contentHash
    recording.frameCount = primary.finalized.frameCount
    await this.writeSidecar(recording)

    this.operations.patch(operationId, {
      phase: "writing-large-object",
      completedUnits: 0,
      totalUnits: null,
      cancellable: true
    }, true)
    this.operations.setCancelHandler(operationId, () => this.projects.cancelOperation(operationId))
    const imported: string[] = []
    try {
      for (const { track, finalized } of finalizedTracks) {
        await this.projects.importLargeObject(track.finalPath!, operationId, {
          id: track.assetId,
          name: `Recording ${track.trackName} ${new Date(recording.startedAt).toLocaleString()}.bwf`,
          mimeType: "audio/x-bwf",
          contentHash: finalized.contentHash,
          sampleRate: finalized.sampleRate,
          channels: finalized.channels,
          bitDepth: finalized.bitDepth as RecordingSidecar["bitDepth"],
          frameCount: BigInt(finalized.frameCount),
          bwfTimeReference: BigInt(finalized.timeReference),
          waveformLevels: finalized.waveformLevels.map((level) => ({
            framesPerBucket: level.framesPerBucket,
            bucketCount: level.bucketCount,
            peaks: new Uint8Array(level.peaks)
          }))
        }, (completed, total) => {
          if (total > 0 && completed >= total) {
            this.operations.setCancelHandler(operationId, null)
            this.operations.patch(operationId, {
              phase: "committing-database",
              completedUnits: null,
              totalUnits: null,
              cancellable: false
            }, true)
          } else {
            this.operations.patch(operationId, { completedUnits: completed, totalUnits: total })
          }
        })
        imported.push(track.assetId)
      }
    } catch (error) {
      if (imported.length > 0) {
        await this.projects.transaction({
          queries: imported.map((id) => ({
            sql: "DELETE FROM assets WHERE id = $1",
            params: [id],
            method: "execute" as const
          }))
        })
      }
      throw error
    }
    this.operations.setCancelHandler(operationId, null)
    recording.state = "committed"
    recording.assetExists = true
    recording.recordedTracks = this.toPending(recording).recordedTracks
    // The worker returning is the database commit boundary. Do not block completion
    // on a second sidecar rewrite: swap may live on a slow/network-scanned volume.
    // Keeping the durable sidecar as `ready` is intentional until the archive save;
    // startup reconciliation checks the asset table and classifies it as committed.
    this.operations.patch(operationId, {
      state: "completed",
      message: recording.dropoutFrames > 0
        ? `${recording.dropoutFrames} input frames were dropped during capture.`
        : null,
      dropoutFrames: recording.dropoutFrames
    }, true)
  }

  private toPending(recording: RecordingSidecar): PendingRecording {
    const {
      id, state, audioPath, sidecarPath, projectPath, sampleRate, channels,
      startedAt, dropoutFrames, assetExists
    } = recording
    const recordedTracks: RecordedTrackAsset[] = (recording.tracks ?? [])
      .filter((track) =>
        track.sampleRate !== null && track.channels !== null && track.frameCount !== null
      )
      .map((track) => ({
        assetId: track.assetId,
        trackId: track.trackId,
        name: `Recording ${track.trackName}`,
        sampleRate: track.sampleRate!,
        channels: track.channels!,
        frameCount: track.frameCount!
      }))
    return {
      id, state, audioPath, sidecarPath, projectPath, sampleRate, channels,
      startedAt, dropoutFrames, assetExists, recordedTracks
    }
  }

  async listPending(): Promise<PendingRecording[]> {
    const applicationSettings = await this.settings.get()
    let files: string[]
    try {
      files = await readdir(applicationSettings.swapDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const pending: PendingRecording[] = []
    for (const file of files.filter((name) => name.endsWith(".recording.json"))) {
      try {
        const sidecar = JSON.parse(await readFile(join(applicationSettings.swapDirectory, file), "utf8")) as RecordingSidecar
        if (this.projects.current?.path === sidecar.projectPath) {
          sidecar.assetExists = await this.assetAlreadyCommitted(sidecar)
        }
        pending.push(this.toPending(sidecar))
      } catch {
        // A malformed sidecar is left on disk for explicit manual inspection.
      }
    }
    return pending.sort((a, b) => b.startedAt - a.startedAt)
  }

  private async readSidecar(id: string): Promise<RecordingSidecar> {
    const settings = await this.settings.get()
    const path = join(settings.swapDirectory, `${id}.recording.json`)
    return JSON.parse(await readFile(path, "utf8")) as RecordingSidecar
  }

  private async assetAlreadyCommitted(recording: RecordingSidecar): Promise<boolean> {
    const project = this.projects.current
    if (!project || project.path !== recording.projectPath) return false
    const tracks = recording.tracks?.length
      ? recording.tracks
      : [{ assetId: recording.id, contentHash: recording.contentHash }]
    let committed = 0
    for (const track of tracks) {
      const result = await this.projects.query({
        sql: "SELECT content_hash FROM assets WHERE id = $1",
        params: [track.assetId],
        method: "all"
      })
      const row = result.rows[0]
      if (!row) continue
      if (track.contentHash && String(row[0]) !== track.contentHash) {
        throw new Error("A recording asset ID exists with different audio content")
      }
      committed += 1
    }
    if (committed !== tracks.length) return false
    recording.state = "committed"
    recording.assetExists = true
    return true
  }

  async recover(id: string): Promise<void> {
    const recording = await this.readSidecar(id)
    if (recording.assetExists || recording.state === "committed" || await this.assetAlreadyCommitted(recording)) return
    const recoverableIds = recording.tracks?.map((track) => track.assetId) ?? [recording.id]
    await this.projects.transaction({
      queries: recoverableIds.map((assetId) => ({
        sql: "DELETE FROM assets WHERE id = $1",
        params: [assetId],
        method: "execute" as const
      }))
    })
    if (recording.state === "partial") {
      this.operations.upsert({
        id: `recording:${id}`,
        title: `Recovering ${basename(recording.audioPath)}`,
        phase: "repairing-header",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        message: null,
        dropoutFrames: recording.dropoutFrames
      }, true)
      recording.frameCount = repairRecordingHeader(recording.audioPath, recording.channels)
      const readyPath = recording.audioPath.replace(".partial.bwf", ".ready.bwf")
      await rename(recording.audioPath, readyPath)
      recording.audioPath = readyPath
      recording.state = "ready"
      await this.writeSidecar(recording)
    } else {
      this.operations.upsert({
        id: `recording:${id}`,
        title: `Recovering ${basename(recording.audioPath)}`,
        phase: "hashing",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        message: null,
        dropoutFrames: recording.dropoutFrames
      }, true)
    }
    await this.finalizeAndCommit(recording, `recording:${id}`)
  }

  async deletePending(id: string): Promise<void> {
    const recording = await this.readSidecar(id)
    await Promise.all([
      rm(recording.audioPath, { force: true }),
      recording.finalPath ? rm(recording.finalPath, { force: true }) : Promise.resolve(),
      ...(recording.tracks ?? [])
        .filter((track) => track.finalPath && track.finalPath !== recording.finalPath)
        .map((track) => rm(track.finalPath!, { force: true })),
      rm(recording.sidecarPath, { force: true })
    ])
  }

  async cleanupCommittedForProject(projectPath: string): Promise<void> {
    const settings = await this.settings.get()
    const files = await readdir(settings.swapDirectory).catch(() => [] as string[])
    for (const file of files.filter((name) => name.endsWith(".recording.json"))) {
      try {
        const sidecar = JSON.parse(await readFile(join(settings.swapDirectory, file), "utf8")) as RecordingSidecar
        if (sidecar.projectPath !== projectPath) continue
        let assetExists = sidecar.state === "committed"
        if (!assetExists && this.projects.current?.path === projectPath) {
          assetExists = await this.assetAlreadyCommitted(sidecar)
        }
        if (assetExists) {
          await this.deletePending(sidecar.id)
        }
      } catch {
        // Keep any recording whose state cannot be proven safe to delete.
      }
    }
  }
}
