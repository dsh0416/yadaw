import { randomBytes } from "node:crypto"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT, IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type {
  ApplicationSettingsRef,
  AudioLifecycleState,
  AudioRuntimeSnapshot,
  DesktopLifecycleEvent,
  DesktopLifecycleSnapshot,
  DesktopSessionRef,
  ProjectLifecycleState,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  RecordingLifecycleState
} from "@yadaw/contracts"
import type { OperationRegistry } from "./operation-registry"
import { ResourceRegistry } from "./resource-registry"
import type { ResourceRecord, ResourceRegistryError } from "./resource-registry"
import { kernelSuccess } from "./result"
import type { KernelResult } from "./result"

export interface ApplicationStateSnapshot {
  protocolVersion: typeof IPC_PROTOCOL_VERSION
  mainEpoch: string
  desktopSession: DesktopSessionRef
  applicationSettings: ApplicationSettingsRef
  revision: number
  lifecycle: DesktopLifecycleSnapshot
  resources: ResourceRecord[]
  operations: {
    active: number
    retainedTerminal: number
  }
}

export interface CreateApplicationStateOptions {
  epoch?: string
  project: ProjectSession | null
  runtime?: AudioRuntimeSnapshot
}

export type ApplicationStateListener = (event: DesktopLifecycleEvent) => void

function generateEpoch(): string {
  return randomBytes(8).readBigUInt64BE().toString()
}

function initialAudioState(runtime?: AudioRuntimeSnapshot): AudioLifecycleState {
  const initial = structuredClone(runtime ?? INITIAL_AUDIO_RUNTIME_SNAPSHOT)
  if (initial.state === "running") {
    return { status: "running", runtime: initial, error: null }
  }
  if (initial.state === "error") {
    return {
      status: "error",
      runtime: initial,
      error: "The native audio engine is in an error state."
    }
  }
  return { status: "stopped", runtime: initial, error: null }
}

export class ApplicationStateStore {
  private revision = 0
  private project: ProjectLifecycleState
  private audio: AudioLifecycleState
  private recording: RecordingLifecycleState = { status: "idle", error: null }
  private workspace: ProjectWorkspaceSnapshot | null = null
  private readonly listeners = new Set<ApplicationStateListener>()

  private constructor(
    readonly resources: ResourceRegistry,
    readonly desktopSession: DesktopSessionRef,
    readonly applicationSettings: ApplicationSettingsRef,
    project: ProjectSession | null,
    runtime?: AudioRuntimeSnapshot
  ) {
    this.project = project
      ? { status: "open", session: structuredClone(project), error: null }
      : { status: "closed", error: null }
    this.audio = initialAudioState(runtime)
  }

  static create(
    options: CreateApplicationStateOptions
  ): KernelResult<ApplicationStateStore, ResourceRegistryError> {
    const resources = new ResourceRegistry(options.epoch ?? generateEpoch())
    const desktopCandidate = resources.create({
      kind: "desktop-session",
      id: "desktop"
    })
    if (!desktopCandidate.ok) return desktopCandidate
    const desktop = resources.commit(desktopCandidate.value.ref, { status: "ready" })
    if (!desktop.ok) return desktop
    const settingsCandidate = resources.create({
      kind: "application-settings",
      id: "settings",
      parent: desktop.value.ref
    })
    if (!settingsCandidate.ok) return settingsCandidate
    const settings = resources.commit(settingsCandidate.value.ref, { loaded: true })
    if (!settings.ok) return settings

    return kernelSuccess(
      new ApplicationStateStore(
        resources,
        desktop.value.ref as DesktopSessionRef,
        settings.value.ref as ApplicationSettingsRef,
        options.project,
        options.runtime
      )
    )
  }

  lifecycleSnapshot(): DesktopLifecycleSnapshot {
    return structuredClone({
      revision: this.revision,
      project: this.project,
      audio: this.audio,
      recording: this.recording
    })
  }

  workspaceSnapshot(): ProjectWorkspaceSnapshot | null {
    return this.workspace ? structuredClone(this.workspace) : null
  }

  setWorkspace(workspace: ProjectWorkspaceSnapshot | null): void {
    this.workspace = workspace ? structuredClone(workspace) : null
  }

  snapshot(operations: OperationRegistry): ApplicationStateSnapshot {
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      mainEpoch: this.resources.epoch,
      desktopSession: structuredClone(this.desktopSession),
      applicationSettings: structuredClone(this.applicationSettings),
      revision: this.revision,
      lifecycle: this.lifecycleSnapshot(),
      resources: this.resources.snapshot(),
      operations: {
        active: operations.activeCount,
        retainedTerminal: operations.retainedTerminalCount
      }
    }
  }

  subscribe(listener: ApplicationStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setProject(state: ProjectLifecycleState): void {
    this.project = structuredClone(state)
    this.publish({ type: "project", revision: 0, state: this.project })
  }

  setAudio(state: AudioLifecycleState): void {
    this.audio = structuredClone(state)
    this.publish({ type: "audio", revision: 0, state: this.audio })
  }

  replaceAudioProjection(state: AudioLifecycleState): void {
    this.audio = structuredClone(state)
  }

  setRecording(state: RecordingLifecycleState): void {
    this.recording = structuredClone(state)
    this.publish({ type: "recording", revision: 0, state: this.recording })
  }

  private publish(event: DesktopLifecycleEvent): void {
    this.revision += 1
    const revisioned = structuredClone({ ...event, revision: this.revision })
    for (const listener of this.listeners) listener(structuredClone(revisioned))
  }
}
