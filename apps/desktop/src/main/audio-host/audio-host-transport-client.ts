import { decode } from "@msgpack/msgpack"
import type { AudioHostRuntime } from "@heron/dsp-node"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  ApplicationCaptureSnapshot,
  ApplicationCaptureLogicalTarget,
  ApplicationCaptureTargetDescriptor,
  AudioPreferences,
  AudioRuntimeSnapshot,
  CompiledAudioGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  RoundTripLatencyMeasurement,
  RoundTripLatencyMeasurementRequest,
  TransportCommand,
  TransportSnapshot
} from "@heron/contracts"
import { stableRuntimeHandle } from "./wire"
import type {
  AudioHostApplicationCaptureSnapshot,
  AudioHostApplicationCaptureTarget,
  AudioHostDevice,
  ControlResponse,
  TelemetryWire
} from "./wire"

function normalizeApplicationCaptureStatus(value: string): ApplicationCaptureSnapshot["status"] {
  return value === "capturing" ||
    value === "no-stream" ||
    value === "target-missing" ||
    value === "ambiguous-target" ||
    value === "target-exited" ||
    value === "permission-denied" ||
    value === "unsupported" ||
    value === "error"
    ? value
    : "inactive"
}

function applicationCaptureLogicalTarget(
  target: AudioHostApplicationCaptureTarget["logical_target"]
): ApplicationCaptureLogicalTarget {
  const common = {
    executablePath: target.executable_path,
    executableName: target.executable_name,
    includeProcessTree: target.include_process_tree
  }
  if (target.platform === "windows") {
    return { platform: "windows", ...common }
  }
  if (target.platform === "macos") {
    return {
      platform: "macos",
      bundleIdentifier: target.bundle_identifier,
      ...common
    }
  }
  throw new Error(
    `audio host returned an unsupported application capture platform: ${target.platform}`
  )
}

export class AudioHostTransportClient {
  private lastAudioPreferences: AudioPreferences | null = null
  private lastAudioRuntime: AudioRuntimeSnapshot | null = null
  private audioEngineExpectedRunning = false
  private lastTransport: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 0,
    loopEnabled: false,
    loopRange: null
  }
  private readonly channelIdsByHandle = new Map<number, string>()

  constructor(
    private readonly getClient: () => AudioHostRuntime | null,
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>,
    private readonly readTelemetry: () => TelemetryWire,
    private readonly sessionSampleRate: () => number | null,
    private readonly coalesceParameter: (value: {
      targetKind: "plugin" | "mixer-channel" | "mixer-send"
      runtimeHandle: number
      parameterToken: number
      value: number
    }) => void,
    private readonly directTelemetry: () => boolean = () => true
  ) {}

  audioPreferences(): AudioPreferences | null {
    return this.lastAudioPreferences ? structuredClone(this.lastAudioPreferences) : null
  }

  engineExpectedRunning(): boolean {
    return this.audioEngineExpectedRunning
  }

  transportIntent(): TransportSnapshot {
    return { ...this.lastTransport }
  }

  setChannelIds(channels: ReadonlyArray<{ id: string }>): void {
    this.channelIdsByHandle.clear()
    for (const channel of channels) {
      this.channelIdsByHandle.set(stableRuntimeHandle(1, channel.id), channel.id)
    }
  }

  resetConnection(): void {
    this.channelIdsByHandle.clear()
  }

  async listAudioBackends(): Promise<AudioBackendDescriptor[]> {
    const response = await this.request({ type: "list-audio-backends" })
    if (response.result.type !== "audio-backends") {
      throw new Error("audio host returned an invalid backend response")
    }
    return response.result.backends ?? []
  }

  async listAudioDevices(backend: string): Promise<AudioDeviceList> {
    const response = await this.request({ type: "list-audio-devices", backend })
    if (response.result.type !== "audio-devices" || !response.result.devices) {
      throw new Error("audio host returned an invalid device response")
    }
    const convert = (device: AudioHostDevice) => ({
      id: device.id,
      name: device.name,
      isDefault: device.is_default,
      defaultSampleRate: device.default_sample_rate,
      minBufferSize: device.min_buffer_size,
      maxBufferSize: device.max_buffer_size,
      channelCount: device.channel_count
    })
    return {
      inputs: response.result.devices.inputs.map(convert),
      outputs: response.result.devices.outputs.map(convert)
    }
  }

  async listApplicationCaptureTargets(): Promise<ApplicationCaptureTargetDescriptor[]> {
    const response = await this.request({ type: "list-application-capture-targets" })
    if (response.result.type !== "application-capture-targets") {
      throw new Error("audio host returned an invalid application capture target response")
    }
    return (response.result.targets ?? []).map((target: AudioHostApplicationCaptureTarget) => ({
      runtimeId: target.runtime_id,
      processId: target.process_id,
      displayName: target.display_name,
      executablePath: target.executable_path,
      logicalTarget: applicationCaptureLogicalTarget(target.logical_target),
      channelCount: target.channel_count,
      status: normalizeApplicationCaptureStatus(target.status)
    }))
  }

  async applicationCaptureSnapshot(): Promise<ApplicationCaptureSnapshot[]> {
    const response = await this.request({ type: "application-capture-snapshot" })
    if (response.result.type !== "application-captures") {
      throw new Error("audio host returned an invalid application capture snapshot response")
    }
    return (response.result.captures ?? []).map((capture: AudioHostApplicationCaptureSnapshot) => ({
      runtimeId: capture.runtime_id,
      processId: capture.process_id,
      displayName: capture.display_name,
      executablePath: capture.executable_path,
      logicalTarget: applicationCaptureLogicalTarget(capture.logical_target),
      channelCount: capture.channel_count,
      status: normalizeApplicationCaptureStatus(capture.status),
      dropoutFrames: capture.dropout_frames,
      overflowFrames: capture.overflow_frames,
      underflowFrames: capture.underflow_frames
    }))
  }

  async startAudioEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot> {
    const response = await this.request({
      type: "start-audio-engine",
      config: this.audioEngineConfig(preferences)
    })
    const runtime = this.runtimeResult(response)
    if (runtime.state === "running") {
      this.lastAudioPreferences = structuredClone(preferences)
      this.audioEngineExpectedRunning = true
    }
    return runtime
  }

  async restoreAudioEngine(): Promise<AudioRuntimeSnapshot> {
    if (!this.lastAudioPreferences) {
      throw new Error("Audio preferences are unavailable for engine restoration")
    }
    return this.startAudioEngine(this.lastAudioPreferences)
  }

  audioEngineConfig(
    preferences: AudioPreferences,
    sessionSampleRate = this.sessionSampleRate()
  ): Record<string, unknown> {
    return {
      backend: preferences.backend,
      input_device_id: preferences.inputDeviceId,
      output_device_id: preferences.outputDeviceId,
      buffer_size: preferences.bufferSize,
      session_sample_rate: sessionSampleRate
    }
  }

  async stopAudioEngine(): Promise<AudioRuntimeSnapshot> {
    // Stopping is user intent; record it before awaiting the native runtime.
    this.audioEngineExpectedRunning = false
    const runtime = this.runtimeResult(await this.request({ type: "stop-audio-engine" }))
    return runtime
  }

  async audioEngineSnapshot(): Promise<AudioRuntimeSnapshot> {
    return this.runtimeResult(await this.request({ type: "audio-engine-snapshot" }))
  }

  cachedAudioEngineSnapshot(): AudioRuntimeSnapshot | null {
    return this.lastAudioRuntime ? structuredClone(this.lastAudioRuntime) : null
  }

  async startRoundTripLatencyMeasurement(
    request: RoundTripLatencyMeasurementRequest
  ): Promise<RoundTripLatencyMeasurement> {
    return this.roundTripLatencyMeasurementResult(
      await this.request({
        type: "start-round-trip-latency-measurement",
        request: {
          input_channel: request.inputChannel,
          output_channel: request.outputChannel
        }
      })
    )
  }

  async roundTripLatencyMeasurementSnapshot(): Promise<RoundTripLatencyMeasurement> {
    return this.roundTripLatencyMeasurementResult(
      await this.request({ type: "round-trip-latency-measurement-snapshot" })
    )
  }

  private roundTripLatencyMeasurementResult(
    response: ControlResponse
  ): RoundTripLatencyMeasurement {
    const value = response.result.measurement
    if (response.result.type !== "round-trip-latency-measurement" || !value) {
      throw new Error("audio host returned an invalid round-trip latency response")
    }
    const status =
      value.status === "preparing" ||
      value.status === "measuring" ||
      value.status === "complete" ||
      value.status === "failed"
        ? value.status
        : "idle"
    const failure =
      value.failure === "input-too-loud" || value.failure === "signal-not-detected"
        ? value.failure
        : null
    return {
      status,
      inputChannel: value.input_channel,
      outputChannel: value.output_channel,
      measuredRoundTripLatencyMs: value.measured_round_trip_latency_ms,
      failure
    }
  }

  runtimeResult(response: ControlResponse): AudioRuntimeSnapshot {
    const value = response.result.runtime
    if (response.result.type !== "audio-runtime" || !value) {
      throw new Error("audio host returned an invalid runtime response")
    }
    const runtime: AudioRuntimeSnapshot = {
      state: value.state === "running" || value.state === "error" ? value.state : "stopped",
      requestedBufferSize: value.requested_buffer_size,
      sampleRate: value.sample_rate,
      inputSampleRate: value.input_sample_rate,
      outputSampleRate: value.output_sample_rate,
      inputBufferSize: value.input_buffer_size,
      outputBufferSize: value.output_buffer_size,
      ringBufferCapacityFrames: value.ring_buffer_capacity_frames,
      ringBufferFillFrames: value.ring_buffer_fill_frames,
      inputLatencyMs: value.input_latency_ms,
      outputLatencyMs: value.output_latency_ms,
      ringBufferLatencyMs: value.ring_buffer_latency_ms,
      engineLatencyMs: value.engine_latency_ms,
      estimatedRoundTripLatencyMs: value.estimated_round_trip_latency_ms,
      xruns: value.xruns,
      clockSync:
        value.clock_sync === "shared-device" || value.clock_sync === "adaptive-resampled"
          ? value.clock_sync
          : "inactive",
      bufferFallback: value.buffer_fallback
    }
    this.lastAudioRuntime = structuredClone(runtime)
    return runtime
  }

  async previewMixerParameter(preview: MixerParameterPreview): Promise<void> {
    if (preview.target === "plugin") {
      await this.request({
        type: "preview-mixer-parameter",
        preview
      })
      return
    }
    const client = this.getClient()
    if (!client) throw new Error("audio host is not running")
    const targetKind = preview.target === "channel" ? "mixer-channel" : "mixer-send"
    const parameterId = preview.parameter === "pan" ? 1 : 0
    const normalized =
      preview.parameter === "pan" ? (preview.value + 1) / 2 : (preview.value + 60) / 72
    const result = client.enqueueParameter({
      targetKind,
      runtimeHandle: stableRuntimeHandle(preview.target === "channel" ? 1 : 2, preview.id),
      parameterToken: parameterId,
      value: Math.max(0, Math.min(1, normalized)),
      gesture: "perform"
    })
    if (result.outcome === "soft-full" || result.outcome === "full") {
      this.coalesceParameter({
        targetKind,
        runtimeHandle: stableRuntimeHandle(preview.target === "channel" ? 1 : 2, preview.id),
        parameterToken: parameterId,
        value: normalized
      })
    }
  }

  async mixerSnapshot(): Promise<MixerRuntimeSnapshot> {
    if (!this.directTelemetry()) {
      const response = await this.request({ type: "mixer-snapshot" })
      if (response.result.type !== "mixer-snapshot") {
        throw new Error("audio host returned an invalid mixer snapshot")
      }
      return {
        meters: (response.result.meters ?? []).map((meter) => ({
          channelId: meter.channel_id,
          preFaderPeak: [meter.pre_left, meter.pre_right],
          postFaderPeak: [meter.post_left, meter.post_right],
          heldPeak: [meter.held_left, meter.held_right],
          clipped: meter.clipped
        })),
        capturedAt: Date.now()
      }
    }
    const telemetry = this.readTelemetry()
    return {
      meters: telemetry[6].flatMap((meter) => {
        const channelId = this.channelIdsByHandle.get(meter[0])
        return channelId
          ? [
              {
                channelId,
                preFaderPeak: [meter[1], meter[2]] as [number, number],
                postFaderPeak: [meter[3], meter[4]] as [number, number],
                heldPeak: [meter[5], meter[6]] as [number, number],
                clipped: meter[7]
              }
            ]
          : []
      }),
      capturedAt: Date.now()
    }
  }

  async compiledAudioGraphSnapshot(): Promise<CompiledAudioGraphSnapshot | null> {
    const response = await this.request({ type: "compiled-graph-snapshot" })
    if (response.result.type !== "compiled-graph-snapshot") {
      throw new Error("audio host returned an invalid compiled graph snapshot")
    }
    const value = response.result.snapshot
    if (!value) return null
    return {
      graphRevision: value.graph_revision,
      buildGeneration: value.build_generation,
      sampleRate: value.sample_rate,
      lowLatencyUnavoidableLatencySamples: value.low_latency_unavoidable_latency_samples ?? 0,
      hasLowLatencyMonitoringPath: value.has_low_latency_monitoring_path ?? false,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        channelId: node.channel_id,
        pluginInstanceId: node.plugin_instance_id,
        signalWidth: node.signal_width,
        latencySamples: node.latency_samples,
        pluginState: node.plugin_state,
        latencySensitive: node.latency_sensitive,
        lowLatencyBypassed: node.low_latency_bypassed
      })),
      edges: value.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        signalWidth: edge.signal_width,
        ...(edge.target_input_port_key === undefined
          ? {}
          : { targetInputPortKey: edge.target_input_port_key })
      }))
    }
  }

  async clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    await this.request({ type: "clear-meter-clips" })
    return this.mixerSnapshot()
  }

  async transport(command: TransportCommand): Promise<TransportSnapshot> {
    const response = await this.request({
      type: "transport",
      command: {
        kind: command.type,
        position_frames: command.type === "seek" ? command.positionFrames : null,
        ...(command.type === "set-loop"
          ? {
              loop_enabled: command.enabled,
              loop_start_tick: command.range?.startTick ?? null,
              loop_end_tick: command.range?.endTick ?? null
            }
          : {})
      }
    })
    return this.rememberTransport(this.transportResult(response))
  }

  async transportSnapshot(): Promise<TransportSnapshot> {
    if (!this.directTelemetry()) return this.transportControlSnapshot()
    const telemetry = this.readTelemetry()
    return this.rememberTransport({
      ...this.lastTransport,
      state:
        telemetry[3] === 1
          ? "playing"
          : telemetry[3] === 2
            ? "recording"
            : telemetry[3] === 3
              ? "waiting"
              : telemetry[3] === 4
                ? "counting-in"
                : "stopped",
      positionFrames: telemetry[4],
      sampleRate: telemetry[5]
    })
  }

  /** Control-plane snapshot including authoritative musical ticks. */
  async transportControlSnapshot(): Promise<TransportSnapshot> {
    const response = await this.request({ type: "transport-snapshot" })
    return this.rememberTransport(this.transportResult(response))
  }

  private transportResult(response: ControlResponse): TransportSnapshot {
    const value = response.result.transport
    if (response.result.type !== "transport-snapshot" || !value) {
      throw new Error("audio host returned an invalid transport snapshot")
    }
    return {
      state:
        value.state === "waiting" ||
        value.state === "counting-in" ||
        value.state === "playing" ||
        value.state === "recording"
          ? value.state
          : "stopped",
      positionFrames: value.position_frames,
      positionTicks: value.position_ticks,
      sampleRate: value.sample_rate,
      effectiveBpm: value.effective_bpm ?? undefined,
      clockSource: value.clock_source === "external" ? "external" : "internal",
      waitingFor:
        value.waiting_for === "play" || value.waiting_for === "record" ? value.waiting_for : null,
      loopEnabled: Boolean(value.loop_enabled),
      loopRange:
        typeof value.loop_start_tick === "number" && typeof value.loop_end_tick === "number"
          ? { startTick: value.loop_start_tick, endTick: value.loop_end_tick }
          : null
    }
  }

  private rememberTransport(snapshot: TransportSnapshot): TransportSnapshot {
    this.lastTransport = { ...snapshot }
    return snapshot
  }

  rememberTransportResponse(response: ControlResponse): TransportSnapshot {
    return this.rememberTransport(this.transportResult(response))
  }

  captureTransport(client: AudioHostRuntime): void {
    if (!this.directTelemetry()) return
    try {
      const telemetry = decode(client.readTelemetry()) as TelemetryWire
      this.rememberTransport({
        ...this.lastTransport,
        state:
          telemetry[3] === 1
            ? "playing"
            : telemetry[3] === 2
              ? "recording"
              : telemetry[3] === 3
                ? "waiting"
                : telemetry[3] === 4
                  ? "counting-in"
                  : "stopped",
        positionFrames: telemetry[4],
        sampleRate: telemetry[5]
      })
    } catch {
      // Keep the most recent successfully observed transport intent.
    }
  }
}
