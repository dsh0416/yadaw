import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type {
  OperationSnapshot,
  PendingRecording,
  RecordingSession,
  RpcError,
  WaveformPeakWindow,
  WaveformWindowRequest
} from "@heron/contracts"
import type { AudioHostService } from "../audio-host"
import type { TransportService } from "../audio"
import type { OperationService } from "../kernel"
import type { ProjectCommandService, ProjectGraphService, ProjectService } from "../project"
import type { ApplicationSettingsStore } from "../settings"
import { t } from "../settings"
import { RecordingCaptureCoordinator } from "./recording-capture-coordinator"
import { RecordingCommitter } from "./recording-committer"
import { toPendingRecording } from "./recording-contracts"
import { PendingRecordingService } from "./pending-recording-service"
import { RecordingRecoveryRepository } from "./recording-recovery-repository"

export class RecordingService {
  private readonly capture: RecordingCaptureCoordinator
  private readonly committer: RecordingCommitter
  private readonly pending: PendingRecordingService

  constructor(
    settings: ApplicationSettingsStore,
    projects: ProjectService,
    operations: OperationService,
    graphs: ProjectGraphService,
    transport: TransportService,
    audioHost: AudioHostService | null = null,
    commands: ProjectCommandService | null = null
  ) {
    const recovery = new RecordingRecoveryRepository()
    this.capture = new RecordingCaptureCoordinator(
      settings,
      projects,
      graphs,
      transport,
      recovery,
      audioHost
    )
    this.committer = new RecordingCommitter(projects, operations, graphs, recovery, commands)
    this.pending = new PendingRecordingService(settings, projects, recovery, this.committer)
    this.operations = operations
  }

  private readonly operations: OperationService

  get current(): RecordingSession | null {
    return this.capture.current
  }

  start(countIn = false): Promise<RecordingSession> {
    return this.capture.start(countIn)
  }

  abortStart(): Promise<void> {
    return this.capture.abortStart()
  }

  async stop(onFinalizing?: () => void): Promise<PendingRecording> {
    const active = this.capture.activeSidecar()
    if (!active) throw new Error("No recording is active")
    const operationId = `recording:${active.id}`
    const operation: OperationSnapshot = {
      id: operationId,
      title: t("operation.finalizingRecording"),
      description: basename(active.audioPath),
      phase: "closing-recording",
      state: "running",
      completedUnits: null,
      totalUnits: null,
      cancellable: false,
      error: null,
      dropoutFrames: 0
    }
    this.operations.upsert(operation, true)
    try {
      const recording = await this.capture.stop()
      onFinalizing?.()
      await this.committer.commit(recording, operationId)
      return toPendingRecording(recording)
    } catch (error) {
      const correlationId = `recording:${operationId}:${randomUUID()}`
      console.error(`[recording] finalization failed (${correlationId})`, error)
      const operationError: RpcError = {
        code: "invariant-violation",
        category: "invariant-violation",
        outcome: "quarantined",
        retry: "after-reconcile",
        correlationId,
        userMessageKey: "errors.recordingFinalizationFailed",
        details: { type: "invariant-violation", component: "main" }
      }
      this.operations.patch(
        operationId,
        { state: "failed", error: operationError, cancellable: false },
        true
      )
      throw error
    }
  }

  waveformSnapshot(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    return this.capture.waveformSnapshot(request)
  }

  listPending(): Promise<PendingRecording[]> {
    return this.pending.listPending()
  }

  recover(id: string): Promise<PendingRecording> {
    return this.pending.recover(id)
  }

  deletePending(id: string): Promise<void> {
    return this.pending.deletePending(id)
  }

  cleanupCommittedForProject(projectPath: string): Promise<void> {
    return this.pending.cleanupCommittedForProject(projectPath)
  }
}
