import { AudioHostDiagnostics } from "./audio-host-diagnostics"
import { AudioHostBenchmarkRunner } from "./audio-host-benchmark-runner"
import type { AudioHostBenchmarkReport } from "./audio-host-benchmark-runner"
import { AudioHostHealthMonitor } from "./audio-host-health-monitor"
import { AudioHostMidiInputClient } from "./audio-host-midi-input-client"
import { drainHostEvents } from "./audio-host-events"
import type {
  AraHostCallback,
  PluginSidechainRouteRequest,
  Vst3HostNotification
} from "./audio-host-events"
import { graphDiff, readCrashMarker } from "./audio-host-graph-client"
import { AudioHostRecordingClient } from "./audio-host-recording-client"
import { AudioHostPluginClient } from "./audio-host-plugin-client"
import { AudioHostTransportClient } from "./audio-host-transport-client"
import { AudioHostGraphTransactions } from "./audio-host-graph-transactions"
import type { PreparedGraphDeployment } from "./audio-host-graph-transactions"
import type { AudioHostIpcClient } from "@heron/audio-host-client"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioIpcPerformanceSnapshot,
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  CompiledAudioGraphSnapshot,
  ProjectGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MidiInputSnapshot,
  MidiSyncPreferences,
  PluginEditorMode,
  PluginEditorPreference,
  PluginDescriptor,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterCommand,
  PluginParameterEnqueueResult,
  PluginParameterInfo,
  ProjectGraphRef,
  RpcRequestMeta,
  RpcResult,
  RoundTripLatencyMeasurement,
  RoundTripLatencyMeasurementRequest,
  ShortcutPreferences,
  TransportCommand,
  TransportSnapshot
} from "@heron/contracts"
import type {
  PluginEditorAppearanceWire,
  PluginEditorContextWire
} from "./audio-host-plugin-client"

import { AudioHostGateway } from "./audio-host-gateway"
import { AudioHostProcessSupervisor } from "./audio-host-process-supervisor"
import { AudioHostSessionCoordinator } from "./audio-host-session-coordinator"
import { AudioHostEventDispatcher } from "./audio-host-event-dispatcher"
import {
  AudioHostRestartCoordinator,
  type AudioHostRestartState
} from "./audio-host-restart-coordinator"
import type {
  AudioHostGraph,
  AudioHostMidiRecordingConfig,
  AudioHostMidiRecordingResult,
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform,
  ControlResponse,
  PriorityResponse,
  TelemetryWire
} from "./wire"
export type {
  AudioHostGraph,
  AudioHostMidiRecordingConfig,
  AudioHostMidiRecordingResult,
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform
} from "./wire"
export type { PreparedGraphDeployment } from "./audio-host-graph-transactions"

export class AudioHostService {
  private pluginEditorAppearance: PluginEditorAppearanceWire = {
    theme: "dark",
    locale: "en-US"
  }
  private readonly pendingPreferenceWrites = new Set<Promise<void>>()
  private readonly supervisor: AudioHostProcessSupervisor
  private readonly session = new AudioHostSessionCoordinator()
  private readonly gateway: AudioHostGateway
  private readonly events = new AudioHostEventDispatcher({
    helperEpoch: () => this.helperEpoch(),
    rejectSidechainRoute: (request) =>
      this.resolvePluginSidechainRoute(
        request.requestId,
        request.instanceId,
        false,
        "Side-chain routing could not be committed."
      )
  })
  private readonly restarts = new AudioHostRestartCoordinator({
    isStopping: () => this.stopping,
    runtimePreferences: () => structuredClone(this.runtimePreferences),
    setRuntimePreferences: (preferences) => {
      this.runtimePreferences = structuredClone(preferences)
    },
    captureConfigurationState: () => this.captureConfigurationRestartState(),
    capturePluginStates: () => this.capturePluginStatesForRestart(),
    prepareConfigurationRestart: (state) => this.prepareConfigurationRestart(state),
    shutdownCurrentHelper: () => this.shutdownCurrentClient(),
    restart: (state, mode) =>
      mode === "recovery"
        ? this.recoverAfterFailure(
            state.audioPreferences,
            state.transport,
            state.audioEngineWasRunning
          )
        : this.restartAfterConfiguration(
            state.audioPreferences,
            state.transport,
            state.audioEngineWasRunning
          ),
    reportFailure: (message) => this.onFailure(message)
  })

  private readonly diagnostics = new AudioHostDiagnostics(
    () => this.client,
    (command) => this.request(command),
    () => ({
      executablePath: this.executablePath,
      runtimePreferences: this.runtimePreferences,
      ...this.health.snapshot()
    })
  )

  private readonly health = new AudioHostHealthMonitor({
    currentClient: () => this.client,
    heartbeat: (client) => this.performPriority({ type: "heartbeat" }, client),
    captureTransport: (client) => this.audioTransport.captureTransport(client),
    onFailure: (client, message) => this.handleExit(client, message),
    onStable: (client) => {
      if (this.client === client) this.restarts.markStable()
    }
  })

  private readonly midiInput = new AudioHostMidiInputClient(
    (command) => this.request(command),
    (command, client) => this.requestImmediately(command, client)
  )

  private readonly benchmarkRunner = new AudioHostBenchmarkRunner((onFailure) => {
    const host = new AudioHostService(
      this.executablePath,
      `${this.crashMarkerPath}.benchmark`,
      structuredClone(this.runtimePreferences),
      undefined,
      onFailure,
      async () => {}
    )
    return {
      start: () => host.start(false),
      stop: () => host.stop(),
      loadPlugin: (plugin, sampleRate) => host.loadPlugin(plugin, sampleRate),
      request: (command) => host.request(command),
      runIpcBenchmark: () => host.diagnostics.runIpcBenchmark(),
      beginBenchmark: () => host.health.beginBenchmark(),
      endBenchmark: (generation) => host.health.endBenchmark(generation)
    }
  })

  private readonly recording = new AudioHostRecordingClient((command) => this.request(command))

  private readonly plugins = new AudioHostPluginClient(
    () => this.client,
    (command) => this.request(command),
    (command) => this.requestImmediately(command)
  )

  private readonly audioTransport = new AudioHostTransportClient(
    () => this.client,
    (command) => this.request(command),
    () => this.diagnostics.readTelemetry(),
    () => this.lastGraph?.project.sampleRate ?? null,
    (value) => this.plugins.coalesceParameter(value),
    () => this.client?.persistentSharedPages ?? false
  )

  private readonly graphTransactions = new AudioHostGraphTransactions({
    client: () => this.client,
    request: (command) => this.request(command),
    loadPlugin: (plugin, sampleRate) =>
      this.plugins.loadPluginWithRequest(plugin, sampleRate, false),
    pluginStatus: (instanceId) => this.plugins.status(instanceId),
    isPluginBypassed: (instanceId) => this.plugins.isBypassed(instanceId),
    commit: async (deployment) => {
      await this.commitDesiredGraph(deployment)
      await this.retireRemovedPlugins(deployment)
      this.publishedGraph = {
        revision: deployment.graphRevision,
        runtime: structuredClone(deployment.runtime)
      }
      this.audioTransport.setChannelIds(deployment.runtime.channels)
    }
  })

  constructor(
    private readonly executablePath: string,
    private readonly crashMarkerPath: string,
    private runtimePreferences: AudioHostRuntimePreferences,
    editorOwnerWindowHandle: Buffer | undefined,
    private readonly onFailure: (message: string) => void,
    private readonly onEditorPreferenceChanged: (
      classId: string,
      preference: PluginEditorPreference
    ) => Promise<void>,
    private readonly onEditorClosed: (instanceId: string) => void = () => {}
  ) {
    this.supervisor = new AudioHostProcessSupervisor(
      executablePath,
      crashMarkerPath,
      editorOwnerWindowHandle
    )
    this.gateway = new AudioHostGateway(
      () => this.client,
      () => (this.stopping ? "stopping" : this.restarts.recoveryPromise),
      onEditorPreferenceChanged,
      this.pendingPreferenceWrites,
      onEditorClosed,
      (callback) => this.events.dispatchAra(callback),
      (notification) => this.events.dispatchVst3(notification),
      (request) => this.events.dispatchSidechain(request)
    )
  }

  setAraCallbackHandler(handler: (callback: AraHostCallback) => void | Promise<void>): void {
    this.events.setAraHandler(handler)
  }

  setVst3HostNotificationHandler(
    handler: (notification: Vst3HostNotification) => void | Promise<void>
  ): void {
    this.events.setVst3Handler(handler)
  }

  setPluginSidechainRouteRequestHandler(
    handler: (request: PluginSidechainRouteRequest) => void | Promise<void>
  ): void {
    this.events.setSidechainHandler(handler)
  }

  async resolvePluginSidechainRoute(
    requestId: number,
    instanceId: string,
    accepted: boolean,
    warning?: string
  ): Promise<void> {
    await this.request({
      type: "resolve-plugin-sidechain-route",
      request_id: requestId,
      instance_id: instanceId,
      accepted,
      warning: warning ?? null
    })
  }

  private get client(): AudioHostIpcClient | null {
    return this.supervisor.client
  }
  private set client(value: AudioHostIpcClient | null) {
    this.supervisor.client = value
  }
  helperEpoch(): string | null {
    return this.client?.helperEpoch ?? null
  }
  private get stopping(): boolean {
    return this.supervisor.stopping
  }
  private set stopping(value: boolean) {
    this.supervisor.stopping = value
  }
  private get lastGraph(): AudioHostSessionCoordinator["graph"] {
    return this.session.graph
  }
  private set lastGraph(value: AudioHostSessionCoordinator["graph"]) {
    this.session.graph = value
  }
  private get publishedGraph(): AudioHostSessionCoordinator["published"] {
    return this.session.published
  }
  private set publishedGraph(value: AudioHostSessionCoordinator["published"]) {
    this.session.published = value
  }
  start(restoreGraph = true): void {
    if (this.client || this.stopping) return
    let client: AudioHostIpcClient
    try {
      client = this.supervisor.launch(this.runtimePreferences)
    } catch (error) {
      this.onFailure(`could not start audio host: ${String(error)}`)
      return
    }
    this.health.start(client)
    if (restoreGraph && this.lastGraph)
      void this.restoreGraph().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.handleExit(client, `could not restore graph: ${message}`)
      })
  }

  private async performPriority(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<PriorityResponse> {
    return this.gateway.priority(command, expectedClient)
  }

  async prepareGraphDeployment(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    graphRevision: number,
    project: ProjectGraphSnapshot,
    runtimeInput: AudioHostGraph
  ): Promise<RpcResult<PreparedGraphDeployment>> {
    return this.graphTransactions.prepare(meta, projectGraph, graphRevision, project, runtimeInput)
  }

  async activateGraphDeployment(
    deployment: PreparedGraphDeployment
  ): ReturnType<AudioHostGraphTransactions["activate"]> {
    return this.graphTransactions.activate(deployment)
  }

  async abortGraphDeployment(
    deployment: PreparedGraphDeployment
  ): ReturnType<AudioHostGraphTransactions["abort"]> {
    return this.graphTransactions.abort(deployment)
  }

  async commitDesiredGraph(deployment: PreparedGraphDeployment): Promise<void> {
    this.lastGraph = {
      revision: deployment.graphRevision,
      project: structuredClone(deployment.project),
      runtime: structuredClone(deployment.runtime)
    }
  }

  private async retireRemovedPlugins(deployment: PreparedGraphDeployment): Promise<void> {
    const desiredInstanceIds = new Set(deployment.project.plugins.map((plugin) => plugin.id))
    const retiredInstanceIds = this.plugins
      .loadedInstanceIds()
      .filter((instanceId) => !desiredInstanceIds.has(instanceId))
    const retired = await Promise.allSettled(
      retiredInstanceIds.map((instanceId) => this.plugins.unloadPlugin(instanceId))
    )
    for (const [index, result] of retired.entries()) {
      if (result.status === "rejected") {
        console.error(`Could not retire VST3 instance ${retiredInstanceIds[index]}:`, result.reason)
      }
    }
  }

  async loadGraph(
    revision: number,
    project: ProjectGraphSnapshot,
    runtime: AudioHostGraph,
    awaitPublication = false
  ): Promise<void> {
    this.lastGraph = {
      revision,
      project: structuredClone(project),
      runtime: structuredClone(runtime)
    }
    const transport = await this.prepareSessionRateTransition(project.sampleRate)
    await this.restoreGraph()
    if (awaitPublication || transport) {
      const audio = await this.audioEngineSnapshot()
      if (audio.state === "running") await this.waitForGraphPublication(revision)
    }
    if (transport) await this.restoreSessionRateTransition(transport)
  }

  private async prepareSessionRateTransition(
    sessionSampleRate: number
  ): Promise<TransportSnapshot | null> {
    const audio = await this.audioEngineSnapshot()
    if (audio.state !== "running" || audio.sampleRate === sessionSampleRate) return null
    const audioPreferences = this.audioTransport.audioPreferences()
    if (!audioPreferences) {
      throw new Error("Audio preferences are unavailable for a session-rate change")
    }
    const transport = await this.transportSnapshot()
    if (transport.state === "recording") {
      throw new Error("Stop recording before changing the project sample rate")
    }
    if (transport.state === "playing") await this.transport({ type: "pause" })
    const previousSampleRate = transport.sampleRate || audio.sampleRate || sessionSampleRate
    const positionFrames = Math.max(
      0,
      Math.round((transport.positionFrames * sessionSampleRate) / previousSampleRate)
    )
    const runtime = await this.startAudioEngine(audioPreferences)
    if (runtime.state !== "running" || runtime.sampleRate !== sessionSampleRate) {
      throw new Error("Audio engine did not adopt the project sample rate")
    }
    this.publishedGraph = null
    return {
      state: transport.state,
      positionFrames,
      sampleRate: sessionSampleRate,
      loopEnabled: transport.loopEnabled,
      loopRange: transport.loopRange ? { ...transport.loopRange } : null
    }
  }

  private async restoreSessionRateTransition(transport: TransportSnapshot): Promise<void> {
    await this.transport({
      type: "set-loop",
      enabled: transport.loopEnabled,
      range: transport.loopRange
    })
    await this.transport({ type: "seek", positionFrames: transport.positionFrames })
    if (transport.state === "playing") await this.transport({ type: "play" })
  }

  private async restoreGraph(immediate = false): Promise<void> {
    const graph = this.lastGraph
    if (!graph) return
    const loaded = await Promise.allSettled(
      graph.project.plugins.map((plugin) =>
        this.plugins.loadPluginWithRequest(plugin, graph.project.sampleRate, immediate)
      )
    )
    for (const [index, result] of loaded.entries()) {
      if (result.status === "rejected") {
        console.error(
          `Could not restore VST3 instance ${graph.project.plugins[index]?.id}:`,
          result.reason
        )
      }
    }
    const runtime = structuredClone(graph.runtime)
    runtime.plugins = runtime.plugins.map((plugin) => {
      const status = this.plugins.status(plugin.instance_id)
      return {
        ...plugin,
        enabled: plugin.enabled && !this.plugins.isBypassed(plugin.instance_id),
        latency_samples: status?.latencySamples ?? 0,
        tail_samples: status?.tailSamples ?? 0
      }
    })
    this.audioTransport.setChannelIds(runtime.channels)
    const previous = this.publishedGraph
    const update =
      previous &&
      previous.runtime.sample_rate === runtime.sample_rate &&
      JSON.stringify(previous.runtime.latency_policy ?? { type: "normal" }) ===
        JSON.stringify(runtime.latency_policy ?? { type: "normal" })
        ? {
            type: "patch",
            base_revision: previous.revision,
            revision: graph.revision,
            ops: graphDiff(previous.runtime, runtime)
          }
        : {
            type: "replace",
            revision: graph.revision,
            graph: runtime
          }
    const request = (command: Record<string, unknown>) =>
      immediate ? this.requestImmediately(command) : this.request(command)
    let response = await request({ type: "update-graph", update })
    if (response.result.type === "revision-mismatch") {
      response = await request({
        type: "update-graph",
        update: { type: "replace", revision: graph.revision, graph: runtime }
      })
    }
    if (response.result.type !== "graph-accepted") {
      throw new Error("audio host did not accept the mixer graph")
    }
    this.publishedGraph = {
      revision: graph.revision,
      runtime: structuredClone(runtime)
    }
  }

  listAudioBackends(): Promise<AudioBackendDescriptor[]> {
    return this.audioTransport.listAudioBackends()
  }

  listAudioDevices(backend: string): Promise<AudioDeviceList> {
    return this.audioTransport.listAudioDevices(backend)
  }

  startAudioEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot> {
    return this.audioTransport.startAudioEngine(preferences)
  }

  restoreAudioEngine(): Promise<AudioRuntimeSnapshot> {
    return this.audioTransport.restoreAudioEngine()
  }

  stopAudioEngine(): Promise<AudioRuntimeSnapshot> {
    return this.audioTransport.stopAudioEngine()
  }

  audioEngineSnapshot(): Promise<AudioRuntimeSnapshot> {
    if (this.health.isBenchmarkActive()) {
      const cached = this.audioTransport.cachedAudioEngineSnapshot()
      if (cached) return Promise.resolve(cached)
    }
    return this.audioTransport.audioEngineSnapshot()
  }

  startRoundTripLatencyMeasurement(
    request: RoundTripLatencyMeasurementRequest
  ): Promise<RoundTripLatencyMeasurement> {
    return this.audioTransport.startRoundTripLatencyMeasurement(request)
  }

  roundTripLatencyMeasurementSnapshot(): Promise<RoundTripLatencyMeasurement> {
    return this.audioTransport.roundTripLatencyMeasurementSnapshot()
  }

  previewMixerParameter(preview: MixerParameterPreview): Promise<void> {
    return this.audioTransport.previewMixerParameter(preview)
  }

  mixerSnapshot(): Promise<MixerRuntimeSnapshot> {
    return this.audioTransport.mixerSnapshot()
  }

  compiledAudioGraphSnapshot(): Promise<CompiledAudioGraphSnapshot | null> {
    return this.audioTransport.compiledAudioGraphSnapshot()
  }

  clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    return this.audioTransport.clearMeterClips()
  }

  transport(command: TransportCommand): Promise<TransportSnapshot> {
    return this.audioTransport.transport(command)
  }

  transportSnapshot(): Promise<TransportSnapshot> {
    return this.audioTransport.transportSnapshot()
  }

  transportControlSnapshot(): Promise<TransportSnapshot> {
    return this.audioTransport.transportControlSnapshot()
  }

  async midiInputSnapshot(): Promise<MidiInputSnapshot> {
    return this.midiInput.snapshot()
  }

  async configureMidiInput(
    preferences: MidiSyncPreferences,
    shortcuts: ShortcutPreferences = { keyboard: {}, midi: {} }
  ): Promise<MidiInputSnapshot> {
    return this.midiInput.configure(preferences, shortcuts)
  }

  async setMidiControlLearning(enabled: boolean): Promise<void> {
    return this.midiInput.setControlLearning(enabled)
  }

  runAudioBenchmark(effect: PluginDescriptor): Promise<AudioHostBenchmarkReport> {
    return this.benchmarkRunner.run(effect)
  }

  performanceDiagnostics(): AudioIpcPerformanceSnapshot | null {
    return this.diagnostics.performanceDiagnostics()
  }

  private readTelemetry(): TelemetryWire {
    return this.diagnostics.readTelemetry()
  }

  startRecording(config: AudioHostRecordingConfig): Promise<void> {
    return this.recording.startRecording(config)
  }

  stopRecording(): Promise<AudioHostRecordingResult> {
    return this.recording.stopRecording()
  }

  startMidiRecording(config: AudioHostMidiRecordingConfig): Promise<void> {
    return this.recording.startMidiRecording(config)
  }

  stopMidiRecording(): Promise<AudioHostMidiRecordingResult> {
    return this.recording.stopMidiRecording()
  }

  recordingWaveform(
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<AudioHostWaveform> {
    return this.recording.recordingWaveform(startFrame, endFrame, maxBuckets)
  }

  loadPlugin(
    plugin: PluginInstanceState,
    sampleRate: number
  ): Promise<{ latencySamples: number; tailSamples: number | null }> {
    return this.plugins.loadPlugin(plugin, sampleRate)
  }

  pluginParameters(instanceId: string): Promise<PluginParameterInfo[]> {
    return this.plugins.pluginParameters(instanceId)
  }

  openPluginEditor(
    instanceId: string,
    preference: PluginEditorPreference,
    context: PluginEditorContextWire
  ): Promise<{ editorMode: PluginEditorMode; open: boolean }> {
    return this.plugins.openPluginEditor(instanceId, preference, context)
  }

  pluginEditorAppearanceSnapshot(): PluginEditorAppearanceWire {
    return { ...this.pluginEditorAppearance }
  }

  async configurePluginEditorAppearance(appearance: PluginEditorAppearanceWire): Promise<void> {
    this.pluginEditorAppearance = { ...appearance }
    await this.plugins.configurePluginEditorAppearance(appearance)
  }

  closePluginEditor(instanceId: string): Promise<void> {
    return this.plugins.closePluginEditor(instanceId)
  }

  setPluginParameter(change: PluginParameterChange): Promise<void> {
    return this.plugins.setPluginParameter(change)
  }

  enqueuePluginParameter(command: PluginParameterCommand): Promise<PluginParameterEnqueueResult> {
    return this.plugins.enqueuePluginParameter(command)
  }

  savePluginState(instanceId: string): Promise<{
    componentState: Uint8Array
    controllerState: Uint8Array
    araDocumentState: Uint8Array
  }> {
    return this.plugins.savePluginState(instanceId)
  }

  private request(command: Record<string, unknown>): Promise<ControlResponse> {
    return this.gateway.request(command)
  }

  private requestImmediately(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    return this.gateway.requestImmediately(command, expectedClient)
  }

  private handleExit(client: AudioHostIpcClient, message: string): void {
    // A timed-out request from an older helper may reject after its replacement
    // is already running. It must never be allowed to tear down that new client.
    if (this.client !== client) return
    this.audioTransport.captureTransport(client)
    this.client = null
    this.events.resetHelper()
    this.health.stop()
    this.plugins.resetConnection()
    this.publishedGraph = null
    this.audioTransport.resetConnection()
    try {
      client.close()
    } catch {
      // The helper may already have exited.
    }
    if (this.stopping) return
    const suspect = readCrashMarker(
      this.crashMarkerPath,
      this.lastGraph?.revision,
      this.lastGraph?.runtime
    )
    if (suspect) {
      this.plugins.bypass(suspect)
      message = `${message}; recovering with plugin '${suspect}' bypassed`
    } else if ((this.lastGraph?.runtime.plugins.length ?? 0) > 0) {
      for (const plugin of this.lastGraph!.runtime.plugins) {
        this.plugins.bypass(plugin.instance_id)
      }
      message = `${message}; crash marker was inconclusive, recovering with all plugins bypassed`
    }
    this.onFailure(message)
    const audioPreferences = this.audioTransport.audioPreferences()
      ? structuredClone(this.audioTransport.audioPreferences())
      : null
    const transport = { ...this.audioTransport.transportIntent() }
    this.restarts.recover({
      audioPreferences,
      transport,
      audioEngineWasRunning: this.audioTransport.engineExpectedRunning()
    })
  }

  private async recoverAfterFailure(
    audioPreferences: AudioPreferences | null,
    transport: TransportSnapshot,
    audioEngineWasRunning: boolean
  ): Promise<void> {
    this.start(false)
    const client = this.client
    if (!client) throw new Error("Audio helper did not restart")

    this.audioTransport.runtimeResult(
      await this.requestImmediately({ type: "audio-engine-snapshot" }, client)
    )
    await this.midiInput.restore(client)
    const audioEngineRestored = audioEngineWasRunning && audioPreferences !== null
    if (audioEngineRestored) {
      const runtime = this.audioTransport.runtimeResult(
        await this.requestImmediately(
          {
            type: "start-audio-engine",
            config: this.audioTransport.audioEngineConfig(audioPreferences)
          },
          client
        )
      )
      if (runtime.state !== "running") {
        throw new Error("Audio engine did not return to running state")
      }
    }

    await this.restoreGraph(true)
    if (!audioEngineRestored) return
    if (this.lastGraph) await this.waitForGraphPublication(this.lastGraph.revision)

    const loop = await this.requestImmediately(
      {
        type: "transport",
        command: {
          kind: "set-loop",
          position_frames: null,
          loop_enabled: transport.loopEnabled,
          loop_start_tick: transport.loopRange?.startTick ?? null,
          loop_end_tick: transport.loopRange?.endTick ?? null
        }
      },
      client
    )
    this.audioTransport.rememberTransportResponse(loop)

    const seek = await this.requestImmediately(
      {
        type: "transport",
        command: { kind: "seek", position_frames: transport.positionFrames }
      },
      client
    )
    this.audioTransport.rememberTransportResponse(seek)
    if (transport.state === "playing") {
      const play = await this.requestImmediately(
        {
          type: "transport",
          command: { kind: "play", position_frames: null }
        },
        client
      )
      this.audioTransport.rememberTransportResponse(play)
    }
  }

  get configurationRestarting(): boolean {
    return this.restarts.busy
  }

  async configureRuntime(preferences: AudioHostRuntimePreferences): Promise<void> {
    await this.restarts.configure(preferences)
  }

  private async captureConfigurationRestartState(): Promise<AudioHostRestartState> {
    const transport = await this.transportSnapshot()
    const audioRuntime = await this.audioEngineSnapshot()
    const audioPreferences = this.audioTransport.audioPreferences()
      ? structuredClone(this.audioTransport.audioPreferences())
      : null
    return {
      audioPreferences,
      transport,
      audioEngineWasRunning: audioRuntime.state === "running"
    }
  }

  private async prepareConfigurationRestart(state: AudioHostRestartState): Promise<void> {
    if (state.transport.state !== "stopped") await this.transport({ type: "pause" })
    for (const instanceId of this.plugins.loadedInstanceIds()) {
      try {
        await this.closePluginEditor(instanceId)
      } catch {
        // An editor may already have been closed by the plug-in.
      }
    }
    if (state.audioEngineWasRunning) await this.stopAudioEngine()
    await this.shutdownCurrentClient()
  }

  private async capturePluginStatesForRestart(): Promise<void> {
    const graph = this.lastGraph
    if (!graph) return
    for (const plugin of graph.project.plugins) {
      if (!this.plugins.has(plugin.id)) continue
      try {
        const state = await this.savePluginState(plugin.id)
        plugin.componentState = state.componentState
        plugin.controllerState = state.controllerState
        plugin.araDocumentState = state.araDocumentState
      } catch (error) {
        console.warn(`Could not capture VST3 state for runtime restart (${plugin.id})`, error)
      }
    }
  }

  private async restartAfterConfiguration(
    audioPreferences: AudioPreferences | null,
    transport: TransportSnapshot,
    audioEngineWasRunning: boolean
  ): Promise<void> {
    this.start(false)
    if (!this.client) throw new Error("Audio helper did not restart")
    await this.audioEngineSnapshot()
    await this.midiInput.restore(this.client)
    const audioEngineRestored = audioEngineWasRunning && audioPreferences !== null
    if (audioEngineRestored) await this.startAudioEngine(audioPreferences)
    await this.restoreGraph()
    if (audioEngineRestored && this.lastGraph) {
      await this.waitForGraphPublication(this.lastGraph.revision)
    }
    if (audioEngineRestored) {
      await this.transport({
        type: "set-loop",
        enabled: transport.loopEnabled,
        range: transport.loopRange
      })
      await this.transport({ type: "seek", positionFrames: transport.positionFrames })
      if (transport.state === "playing") await this.transport({ type: "play" })
    }
  }

  private async waitForGraphPublication(revision: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (this.client?.persistentSharedPages) {
        const telemetry = this.readTelemetry()
        if (telemetry[1] === revision) return
      } else {
        const response = await this.requestImmediately({ type: "compiled-graph-snapshot" })
        if (
          response.result.type === "compiled-graph-snapshot" &&
          response.result.snapshot?.graph_revision === revision
        ) {
          return
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Audio graph revision ${revision} was not published after restart`)
  }

  private async shutdownCurrentClient(): Promise<void> {
    this.health.stop()
    this.plugins.resetConnection()
    const client = this.client
    if (!client) return
    try {
      await this.performPriority({ type: "shutdown" }, client)
    } catch {
      // Closing the client below also reaps a helper that exited early.
    }
    drainHostEvents(
      client,
      this.onEditorPreferenceChanged,
      this.pendingPreferenceWrites,
      this.onEditorClosed,
      (callback) => this.events.dispatchAra(callback),
      (notification) => this.events.dispatchVst3(notification),
      (request) => this.events.dispatchSidechain(request)
    )
    if (this.client === client) this.client = null
    client.close()
    await this.gateway.settle()
    await Promise.allSettled([...this.pendingPreferenceWrites])
    await this.events.settle()
    this.publishedGraph = null
    this.audioTransport.resetConnection()
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.shutdownCurrentClient()
  }
}
