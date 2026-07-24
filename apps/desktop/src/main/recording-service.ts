import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type {
  OperationSnapshot,
  PendingRecording,
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

interface RecordingSidecar extends PendingRecording {
  finalPath: string | null
  bitDepth: "float32" | "pcm24" | "pcm16"
  frameCount: number
  contentHash: string | null
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
    private readonly operations: OperationService
  ) {}

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
    await mkdir(applicationSettings.swapDirectory, { recursive: true })
    const id = randomUUID()
    const startedAt = Date.now()
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
      contentHash: null
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
        timeReference: 0
      })
    } catch (error) {
      await rm(sidecarPath, { force: true })
      throw error
    }
    this.active = sidecar
    return { id, startedAt, swapPath: partialPath }
  }

  async stop(): Promise<PendingRecording> {
    const recording = this.active
    if (!recording) throw new Error("No recording is active")
    this.active = null
    const operationId = `recording:${recording.id}`
    const operation: OperationSnapshot = {
      id: operationId,
      title: `Finalizing ${basename(recording.audioPath)}`,
      phase: "closing-recording",
      state: "running",
      completedBytes: null,
      totalBytes: null,
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
      const captured = process.env.YADAW_TEST_CAPTURE_SOURCE === "1"
        ? writeDeterministicTestRecording({
            path: recording.audioPath,
            assetId: recording.id,
            originator: "YADAW test",
            originationDate: startedUtc.date,
            originationTime: startedUtc.time,
            timeReference: 0
          }, recording.sampleRate, deterministicFrameCount)
        : stopNativeRecording()
      recording.frameCount = captured.frameCount
      recording.dropoutFrames = captured.dropoutFrames
      const readyPath = recording.audioPath.replace(".partial.bwf", ".ready.bwf")
      await rename(recording.audioPath, readyPath)
      recording.audioPath = readyPath
      recording.state = "ready"
      await this.writeSidecar(recording)
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
    const started = new Date(recording.startedAt)
    const utc = utcFields(started)
    const finalPath = recording.audioPath.replace(".ready.bwf", `.final-${recording.bitDepth}.bwf`)
    this.operations.patch(operationId, {
      phase: "resampling",
      completedBytes: null,
      totalBytes: null,
      cancellable: false
    }, true)
    const finalized = await finalizeRecording({
      inputPath: recording.audioPath,
      outputPath: finalPath,
      targetSampleRate: project.configuration.sampleRate,
      bitDepth: recording.bitDepth,
      assetId: recording.id,
      originator: "YADAW",
      originationDate: utc.date,
      originationTime: utc.time,
      timeReference: 0
    })
    recording.finalPath = finalPath
    recording.contentHash = finalized.contentHash
    recording.frameCount = finalized.frameCount
    await this.writeSidecar(recording)

    this.operations.patch(operationId, {
      phase: "writing-large-object",
      completedBytes: 0,
      totalBytes: null,
      cancellable: true
    }, true)
    this.operations.setCancelHandler(operationId, () => this.projects.cancelOperation(operationId))
    await this.projects.importLargeObject(finalPath, operationId, {
      id: recording.id,
      name: `Recording ${new Date(recording.startedAt).toLocaleString()}.bwf`,
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
        // All LO chunks are in the transaction. From this point onward cancellation
        // would race the asset insert/commit, so publish the real commit phase now.
        this.operations.setCancelHandler(operationId, null)
        this.operations.patch(operationId, {
          phase: "committing-database",
          completedBytes: null,
          totalBytes: null,
          cancellable: false
        }, true)
      } else {
        this.operations.patch(operationId, { completedBytes: completed, totalBytes: total })
      }
    })
    this.operations.setCancelHandler(operationId, null)
    recording.state = "committed"
    recording.assetExists = true
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
    const { id, state, audioPath, sidecarPath, projectPath, sampleRate, channels, startedAt, dropoutFrames, assetExists } = recording
    return { id, state, audioPath, sidecarPath, projectPath, sampleRate, channels, startedAt, dropoutFrames, assetExists }
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
          const result = await this.projects.query({
            sql: "SELECT EXISTS(SELECT 1 FROM assets WHERE id = $1)",
            params: [sidecar.id],
            method: "all"
          })
          sidecar.assetExists = Boolean(result.rows[0]?.[0])
          if (sidecar.assetExists) sidecar.state = "committed"
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
    const result = await this.projects.query({
      sql: "SELECT content_hash FROM assets WHERE id = $1",
      params: [recording.id],
      method: "all"
    })
    const row = result.rows[0]
    if (!row) return false
    if (recording.contentHash && String(row[0]) !== recording.contentHash) {
      throw new Error("The recording ID already exists with different audio content")
    }
    recording.state = "committed"
    recording.assetExists = true
    return true
  }

  async recover(id: string): Promise<void> {
    const recording = await this.readSidecar(id)
    if (recording.assetExists || recording.state === "committed" || await this.assetAlreadyCommitted(recording)) return
    if (recording.state === "partial") {
      this.operations.upsert({
        id: `recording:${id}`,
        title: `Recovering ${basename(recording.audioPath)}`,
        phase: "repairing-header",
        state: "running",
        completedBytes: null,
        totalBytes: null,
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
        completedBytes: null,
        totalBytes: null,
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
          const result = await this.projects.query({
            sql: "SELECT EXISTS(SELECT 1 FROM assets WHERE id = $1)",
            params: [sidecar.id],
            method: "all"
          })
          assetExists = Boolean(result.rows[0]?.[0])
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
