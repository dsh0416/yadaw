import { AudioHostDiagnostics } from "./audio-host-diagnostics"
import { drainHostEvents } from "./audio-host-events"
import { graphDiff, readCrashMarker } from "./audio-host-graph-client"
import { AudioHostRecordingClient } from "./audio-host-recording-client"
import { AudioHostPluginClient } from "./audio-host-plugin-client"
import { AudioHostTransportClient } from "./audio-host-transport-client"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type {
  AudioBackendDescriptor,
  AudioBenchmarkScenario,
  AudioDeviceList,
  AudioIpcBenchmarkReport,
  AudioIpcPerformanceSnapshot,
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  CompiledAudioGraphSnapshot,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MidiInputSnapshot,
  MidiSyncPreferences,
  PluginEditorMode,
  PluginEditorPreference,
  PluginDescriptor,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo,
  RoundTripLatencyMeasurement,
  RoundTripLatencyMeasurementRequest,
  ShortcutPreferences,
  TransportCommand,
  TransportSnapshot
} from "@yadaw/contracts"

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_LOGICAL_REQUEST_BYTES = MAX_MESSAGE_BYTES * 2
const HEARTBEAT_INTERVAL_MS = 250
const HEARTBEAT_TIMEOUT_MS = 2_000

import { extractLargeAttachments, hydrateAttachments } from "./audio-host-wire"
import type {
  AudioHostGraph,
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform,
  ControlResponse,
  PriorityResponse,
  TelemetryWire
} from "./audio-host-wire"
export type {
  AudioHostGraph,
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform
} from "./audio-host-wire"

export class AudioHostService {
  private client: AudioHostIpcClient | null = null
  private readonly pendingRequests = new Set<Promise<ControlResponse>>()
  private nextRequestId = 1
  private heartbeat: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private audioBenchmarkInFlight = false
  private audioBenchmarkGeneration = 0
  private stableTimer: NodeJS.Timeout | null = null
  private lastCallbackGeneration: number | null = null
  private callbackStagnantSince = 0
  private lastHeartbeatAt: number | null = null
  private lastHeartbeatGenerations = {
    ipc: 0,
    tokio: 0,
    winit: 0,
    callback: 0
  }
  private lastHostIpcMetrics = {
    egressActive: 0,
    egressQueueDepth: 0,
    egressQueueHighWater: 0,
    egressBatches: 0,
    blockingJobs: 0,
    arenaRegions: 0,
    arenaCapacityBytes: 0,
    arenaUsedBytes: 0,
    arenaHighWaterBytes: 0,
    arenaOffers: 0,
    arenaBusy: 0,
    arenaQuarantinedRegions: 0,
    arenaCopiedBytes: 0
  }
  private restartBudget = 1
  private stopping = false
  private lastGraph: {
    revision: number
    project: MixerGraphSnapshot
    runtime: AudioHostGraph
  } | null = null
  private publishedGraph: {
    revision: number
    runtime: AudioHostGraph
  } | null = null
  private readonly pendingPreferenceWrites = new Set<Promise<void>>()
  private recovery: Promise<void> | null = null
  private reconfiguring = false
  private midiPreferences: MidiSyncPreferences = {
    enabled: false,
    sourcePortId: null,
    sourcePortName: null,
    inputOffsetsMs: {}
  }
  private midiPreferencesConfigured = false
  private midiControlPortIds: string[] = []
  private midiControlLearning = false

  private readonly diagnostics = new AudioHostDiagnostics(
    () => this.client,
    (command) => this.request(command),
    () => ({
      executablePath: this.executablePath,
      runtimePreferences: this.runtimePreferences,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatGenerations: this.lastHeartbeatGenerations,
      lastHostIpcMetrics: this.lastHostIpcMetrics
    })
  )

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
    (value) => this.plugins.coalesceParameter(value)
  )

  constructor(
    private readonly executablePath: string,
    private readonly crashMarkerPath: string,
    private runtimePreferences: AudioHostRuntimePreferences,
    private readonly editorOwnerWindowHandle: Buffer | undefined,
    private readonly onFailure: (message: string) => void,
    private readonly onEditorPreferenceChanged: (
      classId: string,
      preference: PluginEditorPreference
    ) => Promise<void>
  ) {}

  start(restoreGraph = true): void {
    if (this.client || this.stopping) return
    let client: AudioHostIpcClient
    try {
      client = new AudioHostIpcClient(
        this.executablePath,
        this.crashMarkerPath,
        this.runtimePreferences.workerThreads === "auto"
          ? undefined
          : this.runtimePreferences.workerThreads,
        this.runtimePreferences.maxBlockingThreads === "auto"
          ? undefined
          : this.runtimePreferences.maxBlockingThreads,
        this.runtimePreferences.egressConcurrency === "auto"
          ? undefined
          : this.runtimePreferences.egressConcurrency,
        this.editorOwnerWindowHandle
      )
    } catch (error) {
      this.onFailure(`could not start audio host: ${String(error)}`)
      return
    }
    this.client = client
    this.heartbeatInFlight = false
    this.lastCallbackGeneration = null
    this.callbackStagnantSince = 0
    this.lastHeartbeatAt = null
    this.lastHeartbeatGenerations = { ipc: 0, tokio: 0, winit: 0, callback: 0 }
    this.lastHostIpcMetrics = {
      egressActive: 0,
      egressQueueDepth: 0,
      egressQueueHighWater: 0,
      egressBatches: 0,
      blockingJobs: 0,
      arenaRegions: 0,
      arenaCapacityBytes: 0,
      arenaUsedBytes: 0,
      arenaHighWaterBytes: 0,
      arenaOffers: 0,
      arenaBusy: 0,
      arenaQuarantinedRegions: 0,
      arenaCopiedBytes: 0
    }
    this.heartbeat = setInterval(() => {
      if (this.client !== client || this.heartbeatInFlight || this.audioBenchmarkInFlight) return
      const benchmarkGeneration = this.audioBenchmarkGeneration
      this.heartbeatInFlight = true
      void this.performHeartbeat(client)
        .then((response) => {
          if (this.client !== client) return
          if (response.result.type !== "heartbeat") return
          this.audioTransport.captureTransport(client)
          const generation = response.result.callback_generation ?? 0
          this.lastHeartbeatAt = Date.now()
          this.lastHeartbeatGenerations = {
            ipc: response.result.ipc_generation ?? 0,
            tokio: response.result.tokio_generation ?? 0,
            winit: response.result.winit_generation ?? 0,
            callback: generation
          }
          this.lastHostIpcMetrics = {
            egressActive: response.result.egress_active ?? 0,
            egressQueueDepth: response.result.egress_queue_depth ?? 0,
            egressQueueHighWater: response.result.egress_queue_high_water ?? 0,
            egressBatches: response.result.egress_batches ?? 0,
            blockingJobs: response.result.blocking_jobs ?? 0,
            arenaRegions: response.result.arena_regions ?? 0,
            arenaCapacityBytes: response.result.arena_capacity_bytes ?? 0,
            arenaUsedBytes: response.result.arena_used_bytes ?? 0,
            arenaHighWaterBytes: response.result.arena_high_water_bytes ?? 0,
            arenaOffers: response.result.arena_offers ?? 0,
            arenaBusy: response.result.arena_busy ?? 0,
            arenaQuarantinedRegions: response.result.arena_quarantined_regions ?? 0,
            arenaCopiedBytes: response.result.arena_copied_bytes ?? 0
          }
          const active =
            response.result.transport_state === "playing" ||
            response.result.transport_state === "recording"
          if (!active || generation !== this.lastCallbackGeneration) {
            this.lastCallbackGeneration = generation
            this.callbackStagnantSince = Date.now()
            return
          }
          if (this.callbackStagnantSince === 0) this.callbackStagnantSince = Date.now()
          if (Date.now() - this.callbackStagnantSince >= HEARTBEAT_TIMEOUT_MS) {
            this.handleExit(client, "audio callback made no progress for 2 seconds")
          }
        })
        .catch((error: unknown) => {
          // A benchmark can begin after this heartbeat was sent. Its deliberately
          // saturating VST3 workload has a 60-second request deadline, so a
          // two-second health-check timeout during that interval is not evidence
          // that the helper has failed.
          if (
            this.audioBenchmarkInFlight ||
            this.audioBenchmarkGeneration !== benchmarkGeneration
          ) {
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          this.handleExit(client, `heartbeat failed: ${message}`)
        })
        .finally(() => {
          if (this.client === client) this.heartbeatInFlight = false
        })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    this.stableTimer = setTimeout(() => {
      if (this.client === client) this.restartBudget = 1
    }, 5_000)
    this.stableTimer.unref()
    if (restoreGraph && this.lastGraph)
      void this.restoreGraph().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.handleExit(client, `could not restore graph: ${message}`)
      })
  }

  private async performHeartbeat(client: AudioHostIpcClient): Promise<PriorityResponse> {
    return this.performPriority({ type: "heartbeat" }, client)
  }

  private async performPriority(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<PriorityResponse> {
    const client = expectedClient ?? this.client
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const payload = Buffer.from(
      encode({
        request_id: requestId,
        command
      })
    )
    const wireResponse = await client.heartbeat(payload)
    const response = decode(wireResponse.body) as PriorityResponse
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an invalid priority response")
    }
    if (response.result.type === "error") {
      throw new Error(response.result.message ?? "audio host heartbeat failed")
    }
    drainHostEvents(client, this.onEditorPreferenceChanged, this.pendingPreferenceWrites)
    return response
  }

  async loadGraph(
    revision: number,
    project: MixerGraphSnapshot,
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
      sampleRate: sessionSampleRate
    }
  }

  private async restoreSessionRateTransition(transport: TransportSnapshot): Promise<void> {
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
      previous && previous.runtime.sample_rate === runtime.sample_rate
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
    if (this.audioBenchmarkInFlight) {
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

  async midiInputSnapshot(): Promise<MidiInputSnapshot> {
    return this.midiInputResult(await this.request({ type: "midi-input-snapshot" }))
  }

  async configureMidiInput(
    preferences: MidiSyncPreferences,
    shortcuts: ShortcutPreferences = { keyboard: {}, midi: {} }
  ): Promise<MidiInputSnapshot> {
    const controlPortIds = [
      ...new Set(
        Object.values(shortcuts.midi)
          .map((binding) => binding?.portId)
          .filter((portId): portId is string => Boolean(portId))
      )
    ]
    const snapshot = this.midiInputResult(
      await this.request({
        type: "configure-midi-input",
        preferences: {
          enabled: preferences.enabled,
          source_port_id: preferences.sourcePortId,
          source_port_name: preferences.sourcePortName,
          input_offsets_ms: preferences.inputOffsetsMs,
          control_port_ids: controlPortIds,
          capture_all_controls: this.midiControlLearning
        }
      })
    )
    this.midiPreferences = structuredClone(preferences)
    this.midiControlPortIds = controlPortIds
    this.midiPreferencesConfigured = true
    return snapshot
  }

  async setMidiControlLearning(enabled: boolean): Promise<void> {
    this.midiInputResult(
      await this.request({
        type: "configure-midi-input",
        preferences: {
          enabled: this.midiPreferences.enabled,
          source_port_id: this.midiPreferences.sourcePortId,
          source_port_name: this.midiPreferences.sourcePortName,
          input_offsets_ms: this.midiPreferences.inputOffsetsMs,
          control_port_ids: this.midiControlPortIds,
          capture_all_controls: enabled
        }
      })
    )
    this.midiControlLearning = enabled
  }

  private async restoreMidiInput(client: AudioHostIpcClient): Promise<void> {
    if (!this.midiPreferencesConfigured) return
    this.midiInputResult(
      await this.requestImmediately(
        {
          type: "configure-midi-input",
          preferences: {
            enabled: this.midiPreferences.enabled,
            source_port_id: this.midiPreferences.sourcePortId,
            source_port_name: this.midiPreferences.sourcePortName,
            input_offsets_ms: this.midiPreferences.inputOffsetsMs,
            control_port_ids: this.midiControlPortIds,
            capture_all_controls: this.midiControlLearning
          }
        },
        client
      )
    )
  }

  private midiInputResult(response: ControlResponse): MidiInputSnapshot {
    const value = response.result.midi_input
    if (response.result.type !== "midi-input-snapshot" || !value) {
      throw new Error(response.result.message ?? "audio host returned an invalid MIDI snapshot")
    }
    return {
      ports: value.ports,
      sync: {
        state: value.sync.state as MidiInputSnapshot["sync"]["state"],
        sourcePortId: value.sync.source_port_id,
        sourcePortName: value.sync.source_port_name,
        effectiveBpm: value.sync.effective_bpm,
        jitterMicroseconds: value.sync.jitter_microseconds,
        lastClockAgeMs: value.sync.last_clock_age_ms,
        droppedEvents: value.sync.dropped_events,
        ignoredSystemMessages: value.sync.ignored_system_messages,
        error: value.sync.error
      },
      controlEvents: value.control_events.map((event) => ({
        generation: event.generation,
        timestampMicroseconds: event.timestamp_microseconds,
        portId: event.port_id,
        portName: event.port_name,
        channel: event.channel,
        type: event.type,
        number: event.number,
        value: event.value
      })),
      capturedAt: value.captured_at
    }
  }

  runIpcBenchmark(): Promise<AudioIpcBenchmarkReport> {
    return this.diagnostics.runIpcBenchmark()
  }

  async runAudioBenchmark(effect: PluginDescriptor): Promise<{
    durationMs: number
    overallRealtimeFactor: number
    worstP99DeadlineUtilizationPercent: number
    scenarios: AudioBenchmarkScenario[]
  }> {
    const pluginCount = 64
    if (
      effect.kind !== "effect" ||
      effect.compatibility !== "compatible" ||
      !effect.supportedAudioModes.includes("stereo")
    ) {
      throw new Error("audio benchmark requires a compatible stereo VST3 effect")
    }
    if (this.audioBenchmarkInFlight) {
      throw new Error("audio benchmark is already running")
    }
    this.audioBenchmarkInFlight = true
    this.audioBenchmarkGeneration += 1
    const pluginInstanceIds = Array.from(
      { length: pluginCount },
      (_, index) => `__yadaw-audio-benchmark-gain-${index}`
    )
    try {
      // Load one at a time. The VST3 actor largely serializes loads, and each IPC request's
      // deadline starts when the client sends it — firing all 64 at once lets later requests
      // time out while still queued behind earlier successful loads.
      for (const [slotOrder, id] of pluginInstanceIds.entries()) {
        await this.plugins.loadPlugin(
          {
            id,
            channelId: "__yadaw-audio-benchmark",
            role: "insert",
            slotOrder,
            classId: effect.classId,
            descriptor: effect,
            audioMode: "stereo",
            enabled: true,
            componentState: new Uint8Array(),
            controllerState: new Uint8Array()
          },
          48_000
        )
      }

      const response = await this.request({
        type: "run-audio-benchmark",
        plugin_instance_ids: pluginInstanceIds
      })
      if (response.result.type !== "audio-benchmark" || !response.result.report) {
        throw new Error("audio host returned an invalid audio benchmark response")
      }
      const report = response.result.report
      return {
        durationMs: report.duration_ms,
        overallRealtimeFactor: report.overall_realtime_factor,
        worstP99DeadlineUtilizationPercent: report.worst_p99_deadline_utilization_percent,
        scenarios: report.scenarios.map((scenario) => ({
          id: scenario.id,
          label: scenario.label,
          description: scenario.description,
          sampleRate: scenario.sample_rate,
          blockSize: scenario.block_size,
          tracks: scenario.tracks,
          buses: scenario.buses,
          sends: scenario.sends,
          plugins: scenario.plugins,
          elapsedMs: scenario.elapsed_ms,
          audioDurationMs: scenario.audio_duration_ms,
          averageBlockMs: scenario.average_block_ms,
          p95BlockMs: scenario.p95_block_ms,
          p99BlockMs: scenario.p99_block_ms,
          maxBlockMs: scenario.max_block_ms,
          bufferBudgetMs: scenario.buffer_budget_ms,
          p99DeadlineUtilizationPercent: scenario.p99_deadline_utilization_percent,
          deadlineMisses: scenario.deadline_misses,
          measuredBlocks: scenario.measured_blocks,
          realtimeFactor: scenario.realtime_factor
        }))
      }
    } finally {
      // Unload sequentially for the same deadline reason as loads. Host unload drops these
      // non-graph instances instead of retaining them in retired_instances.
      for (const id of pluginInstanceIds) {
        try {
          await this.plugins.unloadPlugin(id)
        } catch (error) {
          console.error(`Could not unload audio benchmark VST3 instance ${id}:`, error)
        }
      }
      this.audioBenchmarkInFlight = false
    }
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
    preference: PluginEditorPreference
  ): Promise<{ editorMode: PluginEditorMode; open: boolean }> {
    return this.plugins.openPluginEditor(instanceId, preference)
  }

  closePluginEditor(instanceId: string): Promise<void> {
    return this.plugins.closePluginEditor(instanceId)
  }

  setPluginParameter(change: PluginParameterChange): Promise<void> {
    return this.plugins.setPluginParameter(change)
  }

  savePluginState(instanceId: string): Promise<{
    componentState: Uint8Array
    controllerState: Uint8Array
    araDocumentState: Uint8Array
  }> {
    return this.plugins.savePluginState(instanceId)
  }

  private request(command: Record<string, unknown>): Promise<ControlResponse> {
    if (this.stopping && command.type !== "shutdown") {
      return Promise.reject(new Error("audio host is stopping"))
    }
    const recovery = this.recovery
    if (recovery && command.type !== "shutdown") {
      return recovery.then(() => this.requestImmediately(command))
    }
    return this.requestImmediately(command)
  }

  private requestImmediately(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const pending = this.performRequest(command, expectedClient)
    this.pendingRequests.add(pending)
    void pending.finally(() => this.pendingRequests.delete(pending)).catch(() => {})
    return pending
  }

  private async performRequest(
    command: Record<string, unknown>,
    expectedClient?: AudioHostIpcClient
  ): Promise<ControlResponse> {
    const client = expectedClient ?? this.client
    if (!client) throw new Error("audio host is not running")
    const requestId = this.nextRequestId++
    const request = {
      request_id: requestId,
      command
    }
    const attachments: Buffer[] = []
    extractLargeAttachments(request, attachments)
    const payload = Buffer.from(encode(request))
    if (payload.length > MAX_LOGICAL_REQUEST_BYTES) {
      throw new Error("audio host logical request exceeds 128 MiB")
    }
    const wireResponse = await client.request(payload, attachments)
    const response = decode(wireResponse.body) as ControlResponse
    hydrateAttachments(response, wireResponse.attachments)
    if (response.request_id !== requestId) {
      throw new Error("audio host returned an out-of-order response")
    }
    if (response.result.type === "error") {
      throw new Error(response.result.message ?? "audio host request failed")
    }
    return response
  }

  private handleExit(client: AudioHostIpcClient, message: string): void {
    // A timed-out request from an older helper may reject after its replacement
    // is already running. It must never be allowed to tear down that new client.
    if (this.client !== client) return
    this.audioTransport.captureTransport(client)
    this.client = null
    this.heartbeatInFlight = false
    this.plugins.resetConnection()
    this.publishedGraph = null
    this.audioTransport.resetConnection()
    try {
      client.close()
    } catch {
      // The helper may already have exited.
    }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
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
    if (this.reconfiguring || this.recovery || this.restartBudget <= 0) return

    this.restartBudget -= 1
    const audioPreferences = this.audioTransport.audioPreferences()
      ? structuredClone(this.audioTransport.audioPreferences())
      : null
    const transport = { ...this.audioTransport.transportIntent() }
    const recovery = this.recoverAfterFailure(
      audioPreferences,
      transport,
      this.audioTransport.engineExpectedRunning()
    )
    this.recovery = recovery
    void recovery
      .catch((error: unknown) => {
        if (!this.stopping) this.onFailure(`audio helper recovery failed: ${String(error)}`)
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null
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
    await this.restoreMidiInput(client)
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
    return this.reconfiguring || this.recovery !== null
  }

  async configureRuntime(preferences: AudioHostRuntimePreferences): Promise<void> {
    if (this.reconfiguring || this.recovery || this.stopping) {
      throw new Error("Audio host runtime configuration is busy")
    }
    this.reconfiguring = true
    const previousPreferences = structuredClone(this.runtimePreferences)
    const transport = await this.transportSnapshot()
    const audioRuntime = await this.audioEngineSnapshot()
    const audioEngineWasRunning = audioRuntime.state === "running"
    const audioPreferences = this.audioTransport.audioPreferences()
      ? structuredClone(this.audioTransport.audioPreferences())
      : null
    try {
      await this.capturePluginStatesForRestart()
      if (transport.state !== "stopped") await this.transport({ type: "pause" })
      for (const instanceId of this.plugins.loadedInstanceIds()) {
        try {
          await this.closePluginEditor(instanceId)
        } catch {
          // An editor may already have been closed by the plug-in.
        }
      }
      if (audioEngineWasRunning) await this.stopAudioEngine()
      await this.shutdownCurrentClient()
      this.runtimePreferences = structuredClone(preferences)
      await this.restartAfterConfiguration(audioPreferences, transport, audioEngineWasRunning)
    } catch (error) {
      try {
        await this.shutdownCurrentClient()
        this.runtimePreferences = previousPreferences
        await this.restartAfterConfiguration(audioPreferences, transport, audioEngineWasRunning)
      } catch (rollbackError) {
        this.onFailure(
          `audio runtime configuration and rollback failed: ${String(error)}; ${String(rollbackError)}`
        )
      }
      throw error
    } finally {
      this.reconfiguring = false
    }
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
    await this.restoreMidiInput(this.client)
    const audioEngineRestored = audioEngineWasRunning && audioPreferences !== null
    if (audioEngineRestored) await this.startAudioEngine(audioPreferences)
    await this.restoreGraph()
    if (audioEngineRestored && this.lastGraph) {
      await this.waitForGraphPublication(this.lastGraph.revision)
    }
    if (audioEngineRestored) {
      await this.transport({ type: "seek", positionFrames: transport.positionFrames })
      if (transport.state === "playing") await this.transport({ type: "play" })
    }
  }

  private async waitForGraphPublication(revision: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const telemetry = this.readTelemetry()
      if (telemetry[1] === revision) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Audio graph revision ${revision} was not published after restart`)
  }

  private async shutdownCurrentClient(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.heartbeatInFlight = false
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    this.plugins.resetConnection()
    const client = this.client
    if (!client) return
    try {
      await this.performPriority({ type: "shutdown" }, client)
    } catch {
      // Closing the client below also reaps a helper that exited early.
    }
    drainHostEvents(client, this.onEditorPreferenceChanged, this.pendingPreferenceWrites)
    if (this.client === client) this.client = null
    client.close()
    await Promise.allSettled([...this.pendingRequests])
    await Promise.allSettled([...this.pendingPreferenceWrites])
    this.publishedGraph = null
    this.audioTransport.resetConnection()
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.shutdownCurrentClient()
  }
}
