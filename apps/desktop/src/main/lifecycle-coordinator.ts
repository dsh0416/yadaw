import { BrowserWindow } from "electron"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT, IPC_CHANNELS } from "@yadaw/contracts"
import type {
  AudioLifecycleState,
  AudioRuntimeSnapshot,
  DesktopLifecycleEvent,
  DesktopLifecycleSnapshot,
  ProjectCommand,
  ProjectLifecycleState,
  ProjectSession,
  RecordingLifecycleState,
  RecordingSession,
  TransportCommand
} from "@yadaw/contracts"
import { ApplicationStateStore } from "./kernel/application-state-store"

type ProjectTransition = "creating" | "opening" | "saving" | "closing"
type AudioTransition = "starting" | "reconfiguring" | "stopping"
interface LifecycleCoordinatorOptions {
  allowRecordingWithoutAudio?: boolean
  audioHostEpoch?: string
  stateStore?: ApplicationStateStore
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function realtimeOnly(command: ProjectCommand): boolean {
  if (command.type === "batch") return command.commands.every(realtimeOnly)
  if (command.type === "replace-key-signature-map") return true
  if (command.type === "update-channel") {
    return Object.keys(command.patch).every((key) => key === "gainDb" || key === "pan")
  }
  if (command.type === "update-send") {
    return Object.keys(command.patch).every((key) => key === "levelDb" || key === "pan")
  }
  return false
}

export class LifecycleCoordinator {
  private projectRollback: ProjectLifecycleState | null = null
  private readonly state: ApplicationStateStore

  constructor(
    project: ProjectSession | null,
    runtime?: AudioRuntimeSnapshot,
    private readonly options: LifecycleCoordinatorOptions = {}
  ) {
    const created = options.stateStore
      ? { ok: true as const, value: options.stateStore }
      : ApplicationStateStore.create({
          project,
          audioHostEpoch: options.audioHostEpoch,
          runtime: structuredClone(runtime ?? INITIAL_AUDIO_RUNTIME_SNAPSHOT)
        })
    if (!created.ok) {
      throw new Error(`Could not initialize application state: ${created.error.code}`)
    }
    this.state = created.value
    this.state.subscribe((event) => this.publish(event))
  }

  snapshot(): DesktopLifecycleSnapshot {
    return this.state.lifecycleSnapshot()
  }

  get applicationState(): ApplicationStateStore {
    return this.state
  }

  private publish(event: DesktopLifecycleEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.lifecycleEvent, structuredClone(event))
    }
  }

  private setProject(state: ProjectLifecycleState): void {
    this.state.setProject(state)
  }

  private setAudio(state: AudioLifecycleState): void {
    this.state.setAudio(state)
  }

  private setRecording(state: RecordingLifecycleState): void {
    this.state.setRecording(state)
  }

  private get projectState(): ProjectLifecycleState {
    return this.state.lifecycleSnapshot().project
  }

  private get audioState(): AudioLifecycleState {
    return this.state.lifecycleSnapshot().audio
  }

  private get recordingState(): RecordingLifecycleState {
    return this.state.lifecycleSnapshot().recording
  }

  get recordingBusy(): boolean {
    return this.recordingState.status !== "idle"
  }

  beginProject(transition: ProjectTransition): void {
    if (this.recordingBusy && (transition === "saving" || transition === "closing")) {
      throw new Error("Stop recording before saving or closing the project")
    }
    if (transition === "creating" || transition === "opening") {
      if (this.projectState.status !== "closed") {
        throw new Error("Close the current project before opening another")
      }
      this.projectRollback = this.projectState
      this.setProject({ status: transition, error: null })
      return
    }
    if (this.projectState.status !== "open") {
      throw new Error(
        `Cannot ${transition === "saving" ? "save" : "close"} the project while it is ${this.projectState.status}`
      )
    }
    this.projectRollback = this.projectState
    this.setProject({
      status: transition,
      session: structuredClone(this.projectState.session),
      error: null
    })
  }

  completeProject(session: ProjectSession | null): void {
    this.projectRollback = null
    this.setProject(
      session
        ? { status: "open", session: structuredClone(session), error: null }
        : { status: "closed", error: null }
    )
  }

  cancelProject(): void {
    const rollback = this.projectRollback ?? { status: "closed", error: null }
    this.projectRollback = null
    this.setProject(rollback)
  }

  failProject(error: unknown): void {
    const rollback = this.projectRollback ?? { status: "closed", error: null }
    this.projectRollback = null
    const failure = message(error)
    this.setProject(
      rollback.status === "open"
        ? { ...rollback, error: failure }
        : { status: "closed", error: failure }
    )
  }

  syncProject(session: ProjectSession | null): void {
    if (
      this.projectState.status === "creating" ||
      this.projectState.status === "opening" ||
      this.projectState.status === "saving" ||
      this.projectState.status === "closing"
    )
      return
    this.completeProject(session)
  }

  beginAudio(transition: AudioTransition): void {
    if (this.recordingBusy) throw new Error("Stop recording before changing the audio engine")
    if (this.projectState.status === "saving" || this.projectState.status === "closing") {
      throw new Error(
        `Cannot change the audio engine while the project is ${this.projectState.status}`
      )
    }
    const runtime = structuredClone(this.audioState.runtime)
    if (transition === "stopping" && this.audioState.status !== "running") {
      throw new Error(`Cannot stop the audio engine while it is ${this.audioState.status}`)
    }
    if (
      transition !== "stopping" &&
      this.audioState.status !== "stopped" &&
      this.audioState.status !== "running" &&
      this.audioState.status !== "error"
    ) {
      throw new Error(`Cannot start the audio engine while it is ${this.audioState.status}`)
    }
    this.setAudio({ status: transition, runtime, error: null })
  }

  completeAudio(runtime: AudioRuntimeSnapshot): void {
    if (runtime.state === "running") {
      this.setAudio({ status: "running", runtime, error: null })
    } else if (runtime.state === "error") {
      this.setAudio({
        status: "error",
        runtime,
        error: "The native audio engine stopped unexpectedly."
      })
    } else {
      this.setAudio({ status: "stopped", runtime, error: null })
    }
  }

  failAudio(error: unknown, runtime: AudioRuntimeSnapshot): void {
    this.setAudio({ status: "error", runtime, error: message(error) })
  }

  refreshAudio(runtime: AudioRuntimeSnapshot): void {
    if (
      this.audioState.status === "starting" ||
      this.audioState.status === "reconfiguring" ||
      this.audioState.status === "stopping"
    )
      return
    const nextStatus =
      runtime.state === "running" ? "running" : runtime.state === "error" ? "error" : "stopped"
    if (nextStatus === this.audioState.status && runtime.state === this.audioState.runtime.state) {
      this.state.replaceAudioProjection({ ...this.audioState, runtime })
      return
    }
    this.completeAudio(runtime)
  }

  beginRecordingStart(): void {
    if (this.recordingState.status !== "idle") {
      throw new Error(`Cannot start recording while it is ${this.recordingState.status}`)
    }
    if (this.projectState.status !== "open") throw new Error("Open a project before recording")
    if (this.audioState.status !== "running" && !this.options.allowRecordingWithoutAudio) {
      throw new Error("Start the audio engine before recording")
    }
    this.setRecording({ status: "starting", error: null })
  }

  completeRecordingStart(session: RecordingSession): void {
    this.setRecording({ status: "recording", session: structuredClone(session), error: null })
  }

  failRecordingStart(error: unknown): void {
    this.setRecording({ status: "idle", error: message(error) })
  }

  beginRecordingStop(): RecordingSession {
    if (this.recordingState.status !== "recording") {
      throw new Error(`Cannot stop recording while it is ${this.recordingState.status}`)
    }
    const session = structuredClone(this.recordingState.session)
    this.setRecording({ status: "stopping", session, error: null })
    return session
  }

  markRecordingFinalizing(session: RecordingSession): void {
    this.setRecording({ status: "finalizing", session: structuredClone(session), error: null })
  }

  completeRecordingStop(): void {
    this.setRecording({ status: "idle", error: null })
  }

  failRecordingStop(error: unknown): void {
    this.setRecording({ status: "idle", error: message(error) })
  }

  beginRecordingRecovery(recordingId: string): void {
    if (this.recordingState.status !== "idle") {
      throw new Error(`Cannot recover a recording while it is ${this.recordingState.status}`)
    }
    this.setRecording({ status: "recovering", recordingId, error: null })
  }

  completeRecordingRecovery(): void {
    this.setRecording({ status: "idle", error: null })
  }

  failRecordingRecovery(error: unknown): void {
    this.setRecording({ status: "idle", error: message(error) })
  }

  assertTransportAllowed(_command: TransportCommand): void {
    if (this.recordingBusy) {
      throw new Error("Transport commands are owned by the recording workflow while recording")
    }
    if (this.projectState.status !== "open") {
      throw new Error(`Transport is unavailable while the project is ${this.projectState.status}`)
    }
  }

  assertMixerCommandAllowed(command: ProjectCommand): void {
    if (this.projectState.status !== "open") {
      throw new Error(
        `Mixer commands are unavailable while the project is ${this.projectState.status}`
      )
    }
    if (this.recordingBusy && !realtimeOnly(command)) {
      throw new Error("Mixer structure cannot change while recording")
    }
  }

  assertMixerPreviewAllowed(): void {
    if (this.projectState.status !== "open") {
      throw new Error(
        `Mixer preview is unavailable while the project is ${this.projectState.status}`
      )
    }
  }

  assertMixerLoadAllowed(): void {
    if (this.recordingBusy) throw new Error("The mixer graph cannot reload while recording")
    if (
      this.projectState.status !== "open" &&
      this.projectState.status !== "creating" &&
      this.projectState.status !== "opening"
    ) {
      throw new Error(
        `The mixer graph cannot load while the project is ${this.projectState.status}`
      )
    }
  }

  assertRecordingIdle(): void {
    if (this.recordingBusy) {
      throw new Error(
        `Recording operation is unavailable while recording is ${this.recordingState.status}`
      )
    }
  }

  assertProjectWriteAllowed(): void {
    if (this.recordingBusy) throw new Error("Project data cannot change while recording")
    if (this.projectState.status !== "open") {
      throw new Error(`Project data cannot change while the project is ${this.projectState.status}`)
    }
  }
}
