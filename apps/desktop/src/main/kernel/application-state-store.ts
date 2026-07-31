import { randomBytes } from "node:crypto"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT, IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type {
  ApplicationSettingsRef,
  AudioEngineRef,
  AudioHostRef,
  AudioLifecycleState,
  AudioResourceSnapshot,
  AudioRuntimeSnapshot,
  DesktopLifecycleEvent,
  DesktopLifecycleSnapshot,
  DesktopSessionRef,
  ProjectAssetSummary,
  ProjectGraphSnapshot,
  ProjectLifecycleState,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  RecordingDependencies,
  RecordingLifecycleState,
  RecordingResourceSnapshot,
  RecordingSession,
  RecordingSessionRef,
  TransportRef
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
  audioHostEpoch?: string
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
  private recordingResource: RecordingResourceSnapshot | null = null
  private workspace: ProjectWorkspaceSnapshot | null = null
  private audioEngine: AudioEngineRef | null = null
  private transport: TransportRef | null = null
  private currentAudioHost: AudioHostRef
  private readonly listeners = new Set<ApplicationStateListener>()

  private constructor(
    readonly resources: ResourceRegistry,
    readonly desktopSession: DesktopSessionRef,
    readonly applicationSettings: ApplicationSettingsRef,
    audioHost: AudioHostRef,
    project: ProjectSession | null,
    runtime?: AudioRuntimeSnapshot
  ) {
    this.project = project
      ? { status: "open", session: structuredClone(project), error: null }
      : { status: "closed", error: null }
    this.audio = initialAudioState(runtime)
    this.currentAudioHost = audioHost
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
    const audioHostCandidate = resources.create({
      kind: "audio-host",
      id: "audio-host",
      epoch: options.audioHostEpoch,
      parent: desktop.value.ref
    })
    if (!audioHostCandidate.ok) return audioHostCandidate
    const audioHost = resources.commit(audioHostCandidate.value.ref, { status: "ready" })
    if (!audioHost.ok) return audioHost

    return kernelSuccess(
      new ApplicationStateStore(
        resources,
        desktop.value.ref as DesktopSessionRef,
        settings.value.ref as ApplicationSettingsRef,
        audioHost.value.ref as AudioHostRef,
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

  recordingResourceSnapshot(): RecordingResourceSnapshot | null {
    const current = this.recordingResource
    if (!current) return null
    for (const dependency of [
      current.recording,
      current.project,
      current.projectGraph,
      current.audioEngine
    ]) {
      if (!this.resources.resolve(dependency).ok) return null
    }
    return structuredClone(current)
  }

  commitRecording(
    session: RecordingSession,
    dependencies: RecordingDependencies
  ): RecordingResourceSnapshot {
    const candidate = this.resources.create({
      kind: "recording-session",
      id: session.id,
      epoch: dependencies.project.epoch,
      parent: dependencies.project
    })
    if (!candidate.ok) throw new Error(candidate.error.code)
    const committed = this.resources.commit(candidate.value.ref, { session, dependencies })
    if (!committed.ok) throw new Error(committed.error.code)
    this.recordingResource = {
      recording: committed.value.ref as RecordingSessionRef,
      project: structuredClone(dependencies.project),
      projectGraph: structuredClone(dependencies.projectGraph),
      audioEngine: structuredClone(dependencies.audioEngine),
      revision: committed.value.revision,
      session: structuredClone(session)
    }
    return this.recordingResourceSnapshot()!
  }

  async dropRecording(): Promise<RecordingResourceSnapshot | null> {
    const previous = this.recordingResourceSnapshot()
    if (previous) await this.resources.drop(previous.recording)
    this.recordingResource = null
    return previous
  }

  workspaceSnapshot(): ProjectWorkspaceSnapshot | null {
    return this.workspace ? structuredClone(this.workspace) : null
  }

  commitWorkspaceProjection(
    session: ProjectSession,
    graph: ProjectGraphSnapshot,
    assets: ProjectAssetSummary[]
  ): ProjectWorkspaceSnapshot {
    const current = this.workspace
    if (!current) throw new Error("project-workspace-unavailable")
    const updated = this.resources.update(current.projectGraph, current.revision, {
      graph,
      assets
    })
    if (!updated.ok) throw new Error(updated.error.code)
    this.workspace = {
      ...current,
      revision: updated.value.revision,
      session: structuredClone(session),
      graph: structuredClone(graph),
      assets: structuredClone(assets)
    }
    return this.workspaceSnapshot()!
  }

  audioResourceSnapshot(): AudioResourceSnapshot {
    const resolved = this.transport ? this.resources.resolve(this.transport) : null
    const revision = resolved?.ok ? resolved.value.revision : 0
    return {
      host: structuredClone(this.currentAudioHost),
      engine: this.audioEngine ? structuredClone(this.audioEngine) : null,
      transport: this.transport ? structuredClone(this.transport) : null,
      revision
    }
  }

  async commitAudioEngine(runtime: AudioRuntimeSnapshot): Promise<AudioResourceSnapshot> {
    await this.dropRecording()
    if (this.audioEngine) await this.resources.drop(this.audioEngine)
    const engineCandidate = this.resources.create({
      kind: "audio-engine",
      id: "audio-engine",
      epoch: this.currentAudioHost.epoch,
      parent: this.currentAudioHost
    })
    if (!engineCandidate.ok) throw new Error(engineCandidate.error.code)
    const engine = this.resources.commit(engineCandidate.value.ref, { runtime })
    if (!engine.ok) throw new Error(engine.error.code)
    const transportCandidate = this.resources.create({
      kind: "transport",
      id: "transport",
      parent: engine.value.ref
    })
    if (!transportCandidate.ok) throw new Error(transportCandidate.error.code)
    const transport = this.resources.commit(transportCandidate.value.ref, {
      state: "stopped",
      positionFrames: 0
    })
    if (!transport.ok) throw new Error(transport.error.code)
    this.audioEngine = engine.value.ref as AudioEngineRef
    this.transport = transport.value.ref as TransportRef
    return this.audioResourceSnapshot()
  }

  async dropAudioEngine(): Promise<AudioResourceSnapshot> {
    await this.dropRecording()
    if (this.audioEngine) await this.resources.drop(this.audioEngine)
    this.audioEngine = null
    this.transport = null
    return this.audioResourceSnapshot()
  }

  get audioHost(): AudioHostRef {
    return structuredClone(this.currentAudioHost)
  }

  async reconcileAudioHost(helperEpoch: string): Promise<AudioResourceSnapshot> {
    if (this.currentAudioHost.epoch === helperEpoch) return this.audioResourceSnapshot()
    const invalidatedRecording = await this.dropRecording()
    if (invalidatedRecording) {
      this.setRecording({ status: "idle", error: null })
    }
    await this.resources.drop(this.currentAudioHost)
    const candidate = this.resources.create({
      kind: "audio-host",
      id: "audio-host",
      epoch: helperEpoch,
      parent: this.desktopSession
    })
    if (!candidate.ok) throw new Error(candidate.error.code)
    const committed = this.resources.commit(candidate.value.ref, { status: "ready" })
    if (!committed.ok) throw new Error(committed.error.code)
    this.currentAudioHost = committed.value.ref as AudioHostRef
    this.audioEngine = null
    this.transport = null
    return this.audioResourceSnapshot()
  }

  advanceTransport(expectedRevision: number, snapshot: unknown): number {
    if (!this.transport) throw new Error("transport-unavailable")
    const updated = this.resources.update(this.transport, expectedRevision, snapshot)
    if (!updated.ok) throw new Error(updated.error.code)
    return updated.value.revision
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
    this.publish({
      type: "audio",
      revision: 0,
      state: this.audio,
      resources: this.audioResourceSnapshot()
    })
  }

  replaceAudioProjection(state: AudioLifecycleState): void {
    this.audio = structuredClone(state)
  }

  setRecording(state: RecordingLifecycleState): void {
    this.recording = structuredClone(state)
    this.publish({
      type: "recording",
      revision: 0,
      state: this.recording,
      resource: this.recordingResourceSnapshot()
    })
  }

  private publish(event: DesktopLifecycleEvent): void {
    this.revision += 1
    const revisioned = structuredClone({ ...event, revision: this.revision })
    for (const listener of this.listeners) listener(structuredClone(revisioned))
  }
}
