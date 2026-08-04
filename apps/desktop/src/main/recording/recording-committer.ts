import { rename } from "node:fs/promises"
import { basename } from "node:path"
import { repairRecordingHeader } from "@heron/dsp-node"
import type { OperationService } from "../kernel"
import type { ProjectCommandService, ProjectGraphService, ProjectService } from "../project"
import { t } from "../settings"
import { commitMidiRecordingTakes } from "./midi-recording-commit"
import { RecordingFinalizer } from "./recording-finalizer"
import { RecordingRecoveryRepository } from "./recording-recovery-repository"
import { toPendingRecording, utcFields, type RecordingSidecar } from "./recording-contracts"

export class RecordingCommitter {
  constructor(
    private readonly projects: ProjectService,
    private readonly operations: OperationService,
    private readonly graphs: ProjectGraphService,
    private readonly recovery: RecordingRecoveryRepository,
    private readonly commands: ProjectCommandService | null,
    private readonly finalizer = new RecordingFinalizer()
  ) {}

  async isCommitted(recording: RecordingSidecar): Promise<boolean> {
    const project = this.projects.current
    if (!project || project.path !== recording.projectPath) return false
    recording.midiTakes ??= []
    if (recording.tracks?.length || !recording.midiTakes.length) {
      const tracks = recording.tracks?.length
        ? recording.tracks
        : [{ assetId: recording.id, contentHash: recording.contentHash }]
      const contentHashes = new Map(
        (await this.projects.assetContentHashes(tracks.map((track) => track.assetId))).map(
          (asset) => [asset.id, asset.contentHash]
        )
      )
      for (const track of tracks) {
        const contentHash = contentHashes.get(track.assetId)
        if (!contentHash) return false
        if (track.contentHash && contentHash !== track.contentHash) {
          throw new Error("A recording asset ID exists with different audio content")
        }
      }
    }
    if (recording.midiTakes.length > 0) {
      const graph = await this.graphs.snapshot()
      for (const take of recording.midiTakes) {
        if (!graph.midiClips.some((clip) => clip.id === take.clipId)) return false
      }
    }
    recording.state = "committed"
    recording.assetExists = true
    return true
  }

  async recover(recording: RecordingSidecar): Promise<void> {
    recording.midiTakes ??= []
    recording.startTick ??= 0
    const recoverableIds = recording.tracks?.length
      ? recording.tracks.map((track) => track.assetId)
      : recording.midiTakes.length > 0
        ? []
        : [recording.id]
    if (recoverableIds.length > 0) await this.graphs.deleteUnusedAssets(recoverableIds)

    const operationId = `recording:${recording.id}`
    const partial = recording.state === "partial"
    this.operations.upsert(
      {
        id: operationId,
        title: t("operation.recoveringRecording"),
        description: basename(recording.audioPath),
        phase: partial ? "repairing-header" : "hashing",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        error: null,
        dropoutFrames: recording.dropoutFrames
      },
      true
    )
    if (partial) {
      if (recording.tracks?.length && recording.audioPath.endsWith(".partial.bwf")) {
        recording.frameCount = repairRecordingHeader(recording.audioPath, recording.channels)
        const readyPath = recording.audioPath.replace(".partial.bwf", ".ready.bwf")
        await rename(recording.audioPath, readyPath)
        recording.audioPath = readyPath
      }
      recording.state = "ready"
      await this.recovery.write(recording)
    }
    await this.commit(recording, operationId)
  }

  async commit(recording: RecordingSidecar, operationId: string): Promise<void> {
    const project = this.projects.current
    if (!project || project.path !== recording.projectPath) {
      throw new Error("Open the recording's project before recovering it")
    }
    recording.midiTakes ??= []
    recording.startTick ??= 0
    if (!recording.tracks?.length && recording.midiTakes.length === 0) {
      const fallback = await this.projects.defaultRecordingTrack()
      if (!fallback) throw new Error("The recording project has no audio track")
      recording.startFrame ??= 0
      recording.tracks = [
        {
          assetId: recording.id,
          trackId: fallback.id,
          trackName: fallback.name,
          inputChannels: fallback.inputChannels,
          finalPath: recording.finalPath,
          contentHash: recording.contentHash,
          sampleRate: null,
          channels: null,
          frameCount: null
        }
      ]
    }
    const started = new Date(recording.startedAt)
    const utc = utcFields(started)
    const finalizedTracks = []
    if (recording.tracks.length > 0) {
      this.operations.patch(
        operationId,
        {
          phase: "resampling",
          completedUnits: null,
          totalUnits: null,
          cancellable: false
        },
        true
      )
      for (const [index, track] of recording.tracks.entries()) {
        const finalPath = recording.audioPath.replace(
          ".ready.bwf",
          `.track-${index + 1}.final-${recording.bitDepth}.bwf`
        )
        const finalized = await this.finalizer.finalize({
          inputPath: recording.audioPath,
          outputPath: finalPath,
          targetSampleRate: project.configuration.sampleRate,
          bitDepth: recording.bitDepth,
          assetId: track.assetId,
          originator: "Heron",
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
      await this.recovery.write(recording)

      this.operations.patch(
        operationId,
        {
          phase: "writing-large-object",
          completedUnits: 0,
          totalUnits: null,
          cancellable: true
        },
        true
      )
      this.operations.setCancelHandler(operationId, () =>
        this.projects.cancelOperation(operationId)
      )
      const imported: string[] = []
      try {
        for (const { track, finalized } of finalizedTracks) {
          await this.projects.importLargeObject(
            track.finalPath!,
            operationId,
            {
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
            },
            (completed, total) => {
              if (total > 0 && completed >= total) {
                this.operations.setCancelHandler(operationId, null)
                this.operations.patch(
                  operationId,
                  {
                    phase: "committing-database",
                    completedUnits: null,
                    totalUnits: null,
                    cancellable: false
                  },
                  true
                )
              } else {
                this.operations.patch(operationId, { completedUnits: completed, totalUnits: total })
              }
            }
          )
          imported.push(track.assetId)
        }
      } catch (error) {
        if (imported.length > 0) {
          await this.graphs.deleteUnusedAssets(imported)
        }
        throw error
      }
      this.operations.setCancelHandler(operationId, null)
    }

    if (recording.midiTakes.length > 0) {
      if (!this.commands) {
        throw new Error("MIDI recording commit requires the project command service")
      }
      this.operations.patch(
        operationId,
        {
          phase: "committing-database",
          completedUnits: null,
          totalUnits: null,
          cancellable: false
        },
        true
      )
      const workspace = this.commands.currentWorkspace()
      if (!workspace) {
        throw new Error("Open the recording's project before recovering it")
      }
      const trackNames = new Map(
        workspace.graph.tracks.map((track) => {
          const channel = workspace.graph.channels.find(
            (candidate) => candidate.id === track.channelId
          )
          return [track.id, channel?.name ?? "Instrument"] as const
        })
      )
      await commitMidiRecordingTakes(
        this.commands,
        workspace,
        operationId,
        recording.startTick,
        recording.midiTakes,
        trackNames
      )
    }

    recording.state = "committed"
    recording.assetExists = true
    recording.recordedTracks = toPendingRecording(recording).recordedTracks
    // The worker returning is the database commit boundary. Do not block completion
    // on a second sidecar rewrite: swap may live on a slow/network-scanned volume.
    // Keeping the durable sidecar as `ready` is intentional until the archive save;
    // startup reconciliation checks the asset table and classifies it as committed.
    this.operations.patch(
      operationId,
      {
        state: "completed",
        dropoutFrames: recording.dropoutFrames
      },
      true
    )
  }
}
