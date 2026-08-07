import { AudioHostDiagnostics } from "./audio-host-diagnostics"
import { AudioHostBenchmarkRunner } from "./audio-host-benchmark-runner"
import type { AudioHostBenchmarkReport } from "./audio-host-benchmark-runner"
import { AudioHostHealthMonitor } from "./audio-host-health-monitor"
import { AudioHostMidiInputClient } from "./audio-host-midi-input-client"
import { drainHostEvents } from "./audio-host-events"
import type {
  AraHostCallback,
  PluginHostNotification,
  PluginSidechainRouteRequest
} from "./audio-host-events"
import { graphDiff } from "./audio-host-graph-client"
import { AudioHostRecordingClient } from "./audio-host-recording-client"
import { AudioHostPluginClient } from "./audio-host-plugin-client"
import { AudioHostTransportClient } from "./audio-host-transport-client"
import { AudioHostGraphTransactions } from "./audio-host-graph-transactions"
import type { PreparedGraphDeployment } from "./audio-host-graph-transactions"
import { AudioHostRuntime } from "@heron/dsp-node"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioRuntimePerformanceSnapshot,
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  ApplicationCaptureSnapshot,
  ApplicationCaptureTargetDescriptor,
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
import { AudioHostSessionCoordinator } from "./audio-host-session-coordinator"
import { AudioHostEventDispatcher } from "./audio-host-event-dispatcher"
import type { AudioHostEditorWindows } from "./audio-host-editor-windows"
import type {
  AudioHostGraph,
  AudioHostBounceRequest,
  AudioHostBounceStatus,
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
  AudioHostBounceRequest,
  AudioHostBounceStatus,
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
  private client: AudioHostRuntime | null = null
  private stopping = false
  private uiDrainTimer: ReturnType<typeof setInterval> | null = null
  private uiDrainScheduled = false
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
  private readonly diagnostics = new AudioHostDiagnostics(
    () => this.client,
    (command) => this.request(command),
    () => ({
      runtimePreferences: this.runtimePreferences,
      ...this.health.snapshot()
    })
  )

  private readonly health = new AudioHostHealthMonitor({
    currentClient: () => this.client,
    heartbeat: (client) => this.performPriority({ type: "heartbeat" }, client),
    captureTransport: (client) => this.audioTransport.captureTransport(client),
    onFailure: (_client, message) => this.onFailure(message)
  })

  private readonly midiInput = new AudioHostMidiInputClient(
    (command) => this.request(command),
    (command, client) => this.requestImmediately(command, client)
  )

  private readonly benchmarkRunner = new AudioHostBenchmarkRunner((onFailure) => ({
    start: () => {
      if (!this.client) {
        onFailure("embedded audio runtime is not running")
        throw new Error("embedded audio runtime is not running")
      }
    },
    stop: async () => {},
    loadPlugin: (plugin, sampleRate) => this.loadPlugin(plugin, sampleRate),
    unloadPlugin: (instanceId) => this.plugins.unloadPlugin(instanceId),
    request: (command) => this.request(command),
    runNativeBenchmark: () => this.diagnostics.runNativeBenchmark(),
    beginBenchmark: () => this.health.beginBenchmark(),
    endBenchmark: (generation) => this.health.endBenchmark(generation)
  }))

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
    () => this.client?.directTelemetry ?? false
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
    private runtimePreferences: AudioHostRuntimePreferences,
    private readonly editorOwnerWindowHandle: Buffer | undefined,
    private readonly onFailure: (message: string) => void,
    private readonly onEditorPreferenceChanged: (
      pluginTypeKey: string,
      preference: PluginEditorPreference
    ) => Promise<void>,
    private readonly onEditorClosed: (instanceId: string) => void = () => {},
    private readonly editorWindows?: AudioHostEditorWindows
  ) {
    this.gateway = new AudioHostGateway(
      () => this.client,
      () => (this.stopping ? "stopping" : null),
      onEditorPreferenceChanged,
      this.pendingPreferenceWrites,
      (instanceId) => {
        this.editorWindows?.hostClosed(instanceId)
        onEditorClosed(instanceId)
      },
      (callback) => this.events.dispatchAra(callback),
      (notification) => this.events.dispatchPlugin(notification),
      (request) => this.events.dispatchSidechain(request)
    )
  }

  setAraCallbackHandler(handler: (callback: AraHostCallback) => void | Promise<void>): void {
    this.events.setAraHandler(handler)
  }

  setPluginHostNotificationHandler(
    handler: (notification: PluginHostNotification) => void | Promise<void>
  ): void {
    this.events.setPluginHandler(handler)
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

  helperEpoch(): string | null {
    return this.client?.runtimeEpoch ?? null
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
    let client: AudioHostRuntime
    try {
      client = new AudioHostRuntime(
        this.runtimePreferences.workerThreads === "auto"
          ? undefined
          : this.runtimePreferences.workerThreads,
        this.runtimePreferences.maxBlockingThreads === "auto"
          ? undefined
          : this.runtimePreferences.maxBlockingThreads,
        this.editorOwnerWindowHandle,
        () => this.scheduleUiDrain()
      )
      this.client = client
    } catch (error) {
      this.onFailure(`could not start audio host: ${String(error)}`)
      return
    }
    this.health.start(client)
    this.startUiDrain()
    if (restoreGraph && this.lastGraph)
      void this.restoreGraph().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.onFailure(`could not restore graph: ${message}`)
      })
  }

  private async performPriority(
    command: Record<string, unknown>,
    expectedClient?: AudioHostRuntime
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

  listApplicationCaptureTargets(): Promise<ApplicationCaptureTargetDescriptor[]> {
    return this.audioTransport.listApplicationCaptureTargets()
  }

  applicationCaptureSnapshot(): Promise<ApplicationCaptureSnapshot[]> {
    return this.audioTransport.applicationCaptureSnapshot()
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

  performanceDiagnostics(): AudioRuntimePerformanceSnapshot | null {
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
    const client = this.client
    if (!client || !this.editorWindows) {
      return this.plugins.openPluginEditor(instanceId, preference, context)
    }
    return this.editorWindows.open(
      client,
      instanceId,
      {
        channelName: context.channelName,
        channelColor: context.channelColor,
        pluginName: context.pluginName,
        theme: context.appearance.theme,
        locale: context.appearance.locale
      },
      () => this.plugins.openPluginEditor(instanceId, preference, context),
      (action) => this.plugins.applyPluginEditorAction(instanceId, action),
      () => this.plugins.pluginParameters(instanceId),
      async (parameterId, normalized, gesture) => {
        const parameter = (await this.plugins.pluginParameters(instanceId)).find(
          (candidate) => candidate.runtimeToken === parameterId
        )
        if (!parameter) throw new Error("Plugin parameter token is stale")
        const value =
          parameter.minValue +
          Math.max(0, Math.min(1, normalized)) * (parameter.maxValue - parameter.minValue)
        await this.plugins.setPluginParameter({
          instanceId,
          parameterKey: parameter.parameterKey,
          value,
          gesture
        })
      },
      () => this.plugins.closePluginEditor(instanceId)
    )
  }

  pluginEditorAppearanceSnapshot(): PluginEditorAppearanceWire {
    return { ...this.pluginEditorAppearance }
  }

  async configurePluginEditorAppearance(appearance: PluginEditorAppearanceWire): Promise<void> {
    this.pluginEditorAppearance = { ...appearance }
    await this.plugins.configurePluginEditorAppearance(appearance)
  }

  async closePluginEditor(instanceId: string): Promise<void> {
    if (this.editorWindows && (await this.editorWindows.close(instanceId))) return
    await this.plugins.closePluginEditor(instanceId)
  }

  setPluginParameter(change: PluginParameterChange): Promise<void> {
    return this.plugins.setPluginParameter(change)
  }

  enqueuePluginParameter(command: PluginParameterCommand): Promise<PluginParameterEnqueueResult> {
    return this.plugins.enqueuePluginParameter(command)
  }

  savePluginState(instanceId: string): Promise<import("@heron/contracts").PluginStateEnvelope> {
    return this.plugins.savePluginState(instanceId)
  }

  private request(command: Record<string, unknown>): Promise<ControlResponse> {
    return this.gateway.request(command)
  }

  private requestImmediately(
    command: Record<string, unknown>,
    expectedClient?: AudioHostRuntime
  ): Promise<ControlResponse> {
    return this.gateway.requestImmediately(command, expectedClient)
  }

  get configurationRestarting(): boolean {
    return false
  }

  async configureRuntime(preferences: AudioHostRuntimePreferences): Promise<void> {
    this.runtimePreferences = structuredClone(preferences)
  }

  private async waitForGraphPublication(revision: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (this.client?.directTelemetry) {
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
    throw new Error(`Audio graph revision ${revision} was not published`)
  }

  private async shutdownCurrentClient(): Promise<void> {
    this.health.stop()
    const client = this.client
    if (!client) return
    await this.editorWindows?.closeAll()
    this.plugins.resetConnection()
    try {
      await this.performPriority({ type: "shutdown" }, client)
    } catch {
      // Closing below is idempotent if shutdown already completed.
    }
    drainHostEvents(
      client,
      this.onEditorPreferenceChanged,
      this.pendingPreferenceWrites,
      this.onEditorClosed,
      (callback) => this.events.dispatchAra(callback),
      (notification) => this.events.dispatchPlugin(notification),
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
    this.stopUiDrain()
    await this.shutdownCurrentClient()
  }

  async startBounceOutput(
    request: Omit<AudioHostBounceRequest, "graph" | "graph_revision">
  ): Promise<AudioHostBounceStatus> {
    const graph = this.lastGraph
    if (!graph) throw new Error("project audio graph is unavailable")
    const response = await this.request({
      type: "start-bounce-output",
      request: {
        ...request,
        graph_revision: graph.revision,
        graph: structuredClone(graph.runtime)
      }
    })
    if (response.result.type !== "bounce-output" || !response.result.status) {
      throw new Error(response.result.error?.userMessageKey ?? "audio host rejected bounce")
    }
    return response.result.status
  }

  refreshDesiredProjectGraph(project: ProjectGraphSnapshot): void {
    if (!this.lastGraph) throw new Error("project audio graph is unavailable")
    const currentPluginIds = this.lastGraph.project.plugins.map((plugin) => plugin.id)
    const nextPluginIds = project.plugins.map((plugin) => plugin.id)
    if (JSON.stringify(currentPluginIds) !== JSON.stringify(nextPluginIds)) {
      throw new Error("project plug-in topology changed while preparing the offline bounce")
    }
    this.lastGraph = {
      ...this.lastGraph,
      project: structuredClone(project)
    }
  }

  async bounceOutputStatus(operationId: string): Promise<AudioHostBounceStatus> {
    const response = await this.request({ type: "bounce-output-status", operation_id: operationId })
    if (response.result.type !== "bounce-output" || !response.result.status) {
      throw new Error(response.result.error?.userMessageKey ?? "bounce status is unavailable")
    }
    return response.result.status
  }

  async cancelBounceOutput(operationId: string): Promise<void> {
    const response = await this.request({ type: "cancel-bounce-output", operation_id: operationId })
    if (response.result.type !== "bounce-output") {
      throw new Error(response.result.error?.userMessageKey ?? "bounce cancellation failed")
    }
  }

  async prepareOfflineBounce(): Promise<void> {
    await this.restartAfterOfflineBounce(false)
  }

  async restartAfterOfflineBounce(restoreAudioEngine: boolean): Promise<void> {
    const preferences = this.audioTransport.audioPreferences()
    await this.shutdownCurrentClient()
    this.stopping = false
    this.start(false)
    await this.restoreGraph(true)
    if (preferences && restoreAudioEngine) await this.startAudioEngine(preferences)
  }

  private scheduleUiDrain(): void {
    if (this.uiDrainScheduled || this.stopping) return
    this.uiDrainScheduled = true
    setImmediate(() => {
      this.uiDrainScheduled = false
      const client = this.client
      if (!client || this.stopping) return
      try {
        const pending = client.drainUiWork()
        this.editorWindows?.drain(client)
        if (pending) this.scheduleUiDrain()
      } catch (error) {
        if (!this.stopping) console.error("Could not drain embedded audio UI work", error)
      }
    })
  }

  private startUiDrain(): void {
    if (this.uiDrainTimer) return
    this.scheduleUiDrain()
    // Plug-in timers and ARA callbacks require periodic main-thread service
    // even when Tokio has not enqueued a new command.
    this.uiDrainTimer = setInterval(() => this.scheduleUiDrain(), 16)
    this.uiDrainTimer.unref()
  }

  private stopUiDrain(): void {
    if (!this.uiDrainTimer) return
    clearInterval(this.uiDrainTimer)
    this.uiDrainTimer = null
  }
}
