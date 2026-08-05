import { randomUUID } from "node:crypto"
import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type {
  PendingMidiTake,
  RecordingSession,
  WaveformPeakWindow,
  WaveformWindowRequest
} from "@heron/contracts"
import { writeDeterministicTestRecording } from "@heron/dsp-node"
import type { AudioHostService } from "../audio-host"
import type { TransportService } from "../audio"
import type { ApplicationSettingsStore } from "../settings"
import type { ProjectGraphService, ProjectService } from "../project"
import { RecordingRecoveryRepository } from "./recording-recovery-repository"
import { RecordingSessionController } from "./recording-session-controller"
import { toRecordingSession, utcFields, type RecordingSidecar } from "./recording-contracts"

export class RecordingCaptureCoordinator {
  private readonly sessions = new RecordingSessionController<RecordingSidecar>()

  constructor(
    private readonly settings: ApplicationSettingsStore,
    private readonly projects: ProjectService,
    private readonly graphs: ProjectGraphService,
    private readonly transport: TransportService,
    private readonly recovery: RecordingRecoveryRepository,
    private readonly audioHost: AudioHostService | null
  ) {}

  get current(): RecordingSession | null {
    return this.sessions.active ? toRecordingSession(this.sessions.active) : null
  }

  activeSidecar(): RecordingSidecar | null {
    return this.sessions.active
  }

  async start(countIn = false): Promise<RecordingSession> {
    if (this.sessions.active) throw new Error("A recording is already active")
    this.sessions.lastWaveformSnapshot = null
    const project = this.projects.current
    if (!project) throw new Error("Open a project before recording")
    const deterministicTestCapture = process.env.HERON_TEST_CAPTURE_SOURCE === "1"
    const runtime = deterministicTestCapture
      ? {
          state: "running" as const,
          inputSampleRate: 48_000,
          sampleRate: 48_000
        }
      : await this.audioHost?.audioEngineSnapshot()
    if (
      !runtime ||
      (!deterministicTestCapture && (runtime.state !== "running" || !runtime.sampleRate))
    ) {
      throw new Error("Start the audio engine before recording")
    }
    const applicationSettings = await this.settings.get()
    const graph = await this.graphs.snapshot()
    const audioTargets = graph.channels.filter(
      (channel) => channel.kind === "audio" && channel.recordArmed
    )
    const midiTargets = graph.channels.filter(
      (channel) =>
        channel.kind === "instrument" && channel.systemRole === null && channel.recordArmed
    )
    if (audioTargets.length === 0 && midiTargets.length === 0) {
      throw new Error("Arm an audio or instrument track before recording")
    }
    await mkdir(applicationSettings.swapDirectory, { recursive: true })
    const id = randomUUID()
    const startedAt = Date.now()
    const transportBeforeRecording =
      !deterministicTestCapture && this.audioHost
        ? await this.audioHost.transportControlSnapshot()
        : await this.transport.snapshot()
    const startFrame = transportBeforeRecording.positionFrames
    const startTick = Math.max(0, Math.floor(transportBeforeRecording.positionTicks ?? 0))
    const hasAudio = audioTargets.length > 0
    let nextRecordingChannel = 1
    const recordingLayouts = audioTargets.map((channel) => {
      const width = Math.min(2, Math.max(1, channel.inputChannels.length))
      const recordingChannels = Array.from(
        { length: width },
        (_, index) => nextRecordingChannel + index
      )
      nextRecordingChannel += width
      return recordingChannels
    })
    const recordingChannelCount = nextRecordingChannel - 1
    const partialPath = hasAudio
      ? join(applicationSettings.swapDirectory, `${id}.partial.bwf`)
      : join(applicationSettings.swapDirectory, `${id}.midi-only`)
    const sidecarPath = join(applicationSettings.swapDirectory, `${id}.recording.json`)
    const midiTakes: PendingMidiTake[] = midiTargets.map((channel) => {
      const track = graph.tracks.find((candidate) => candidate.channelId === channel.id)
      if (!track) {
        throw new Error(`Armed instrument channel '${channel.id}' has no project track`)
      }
      const sourceId = randomUUID()
      const clipId = randomUUID()
      return {
        trackId: track.id,
        sourceId,
        clipId,
        journalPath: join(
          applicationSettings.swapDirectory,
          `${id}.${track.id}.partial.midijournal`
        ),
        eventCount: 0,
        droppedEvents: 0
      }
    })
    const sidecar: RecordingSidecar = {
      id,
      state: "partial",
      audioPath: partialPath,
      sidecarPath,
      projectPath: project.path,
      sampleRate: deterministicTestCapture ? 48_000 : runtime.sampleRate!,
      channels: hasAudio ? recordingChannelCount : 0,
      startedAt,
      dropoutFrames: 0,
      assetExists: false,
      finalPath: null,
      bitDepth: applicationSettings.recordingBitDepth,
      frameCount: 0,
      contentHash: null,
      startFrame,
      startTick,
      recordedTracks: [],
      midiTakes,
      audioTrackIds: audioTargets.map((track) => track.id),
      midiTrackIds: midiTakes.map((take) => take.trackId),
      resumePlaybackAfterRecording: transportBeforeRecording.state === "playing",
      tracks: audioTargets.map((track, index) => ({
        assetId: index === 0 ? id : randomUUID(),
        trackId: track.id,
        trackName: track.name,
        inputChannels: [...track.inputChannels],
        recordingChannels: recordingLayouts[index],
        finalPath: null,
        contentHash: null,
        sampleRate: null,
        channels: null,
        frameCount: null
      }))
    }
    await this.recovery.write(sidecar)
    const utc = utcFields(new Date(startedAt))
    let midiRecordingStarted = false
    try {
      if (!deterministicTestCapture && hasAudio) {
        await this.audioHost!.startRecording({
          path: partialPath,
          assetId: id,
          originator: "Heron",
          originationDate: utc.date,
          originationTime: utc.time,
          timeReference: Math.round(
            (startFrame * sidecar.sampleRate) / project.configuration.sampleRate
          ),
          sampleRate: sidecar.sampleRate,
          channels: sidecar.channels
        })
      }
      if (!deterministicTestCapture && midiTakes.length > 0) {
        await this.audioHost!.startMidiRecording({
          takes: midiTakes.map((take, index) => {
            const channel = midiTargets[index]!
            return {
              path: take.journalPath,
              sourceId: take.sourceId,
              clipId: take.clipId,
              trackId: take.trackId,
              portId: channel.midiInput?.portId ?? null,
              channel: channel.midiInput?.channel ?? null
            }
          })
        })
        midiRecordingStarted = true
      }
      await this.transport.command({ type: countIn ? "record-count-in" : "record" })
    } catch (error) {
      await Promise.allSettled([
        deterministicTestCapture || !hasAudio
          ? Promise.resolve()
          : (this.audioHost?.stopRecording() ?? Promise.resolve()),
        midiRecordingStarted
          ? (this.audioHost?.stopMidiRecording() ?? Promise.resolve())
          : Promise.resolve(),
        this.transport.command({ type: "pause" })
      ])
      await Promise.all(
        midiTakes.map((take) => rm(take.journalPath, { force: true }).catch(() => undefined))
      )
      await rm(sidecarPath, { force: true })
      throw error
    }
    this.sessions.begin(sidecar)
    return toRecordingSession(sidecar)
  }

  async abortStart(): Promise<void> {
    if (!this.sessions.active) return
    const recording = this.sessions.take()
    await Promise.allSettled([
      process.env.HERON_TEST_CAPTURE_SOURCE === "1" || recording.tracks.length === 0
        ? Promise.resolve()
        : (this.audioHost?.stopRecording() ?? Promise.resolve()),
      recording.midiTakes.length > 0
        ? (this.audioHost?.stopMidiRecording() ?? Promise.resolve())
        : Promise.resolve(),
      this.transport.command({ type: "pause" })
    ])
  }

  async stop(): Promise<RecordingSidecar> {
    const recording = this.sessions.take()
    const startedUtc = utcFields(new Date(recording.startedAt))
    const deterministicFrameCount = Math.min(
      0xffff_ffff,
      Math.max(
        4_800,
        Math.round(((Date.now() - recording.startedAt) / 1_000) * recording.sampleRate)
      )
    )
    const hasAudio = recording.tracks.length > 0
    const hasMidi = recording.midiTakes.length > 0
    try {
      if (hasAudio) {
        const captured =
          process.env.HERON_TEST_CAPTURE_SOURCE === "1"
            ? writeDeterministicTestRecording(
                {
                  path: recording.audioPath,
                  assetId: recording.id,
                  originator: "Heron test",
                  originationDate: startedUtc.date,
                  originationTime: startedUtc.time,
                  timeReference: recording.startFrame
                },
                recording.sampleRate,
                deterministicFrameCount
              )
            : await this.audioHost!.stopRecording()
        recording.frameCount = captured.frameCount
        recording.dropoutFrames = captured.dropoutFrames
        recording.channels = captured.channels
        const readyPath = recording.audioPath.replace(".partial.bwf", ".ready.bwf")
        await rename(recording.audioPath, readyPath)
        recording.audioPath = readyPath
      } else {
        recording.frameCount = 0
        recording.dropoutFrames = 0
        recording.channels = 0
      }
      if (hasMidi && process.env.HERON_TEST_CAPTURE_SOURCE !== "1") {
        const midiStopped = await this.audioHost!.stopMidiRecording()
        const byClipId = new Map(midiStopped.takes.map((take) => [take.clipId, take]))
        recording.midiTakes = recording.midiTakes.map((take) => {
          const stopped = byClipId.get(take.clipId)
          return stopped
            ? {
                ...take,
                journalPath: stopped.path,
                eventCount: stopped.eventCount,
                droppedEvents: stopped.droppedEvents
              }
            : take
        })
      }
    } finally {
      await this.transport.command({
        type: recording.resumePlaybackAfterRecording ? "play" : "pause"
      })
    }
    recording.state = "ready"
    await this.recovery.write(recording)
    return recording
  }

  async waveformSnapshot(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    const recording = this.sessions.active
    if (!recording || recording.id !== request.id) {
      if (this.sessions.lastWaveformSnapshot?.id === request.id) {
        return structuredClone(this.sessions.lastWaveformSnapshot)
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
    if (process.env.HERON_TEST_CAPTURE_SOURCE === "1") {
      const frameCount = Math.max(
        1,
        Math.floor(((Date.now() - recording.startedAt) / 1_000) * recording.sampleRate)
      )
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
          const sample = Math.sin((Math.PI * 2 * 1_000 * frame) / recording.sampleRate) * 0.25
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
      this.sessions.lastWaveformSnapshot = result
      return result
    }
    if (!this.audioHost) throw new Error("Audio host is not running")
    const snapshot = await this.audioHost.recordingWaveform(
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
    this.sessions.lastWaveformSnapshot = result
    return result
  }
}
