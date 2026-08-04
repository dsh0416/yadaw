import type {
  AudioBenchmarkScenario,
  AudioNativeBenchmarkReport,
  PluginDescriptor,
  PluginInstanceState
} from "@heron/contracts"
import type { ControlResponse } from "./wire"

export interface AudioHostBenchmarkReport {
  durationMs: number
  overallRealtimeFactor: number
  worstP99DeadlineUtilizationPercent: number
  scenarios: AudioBenchmarkScenario[]
  nativeBridge: AudioNativeBenchmarkReport
}

interface AudioHostBenchmarkHost {
  start(): void
  stop(): Promise<void>
  loadPlugin(plugin: PluginInstanceState, sampleRate: number): Promise<unknown>
  unloadPlugin(instanceId: string): Promise<unknown>
  request(command: Record<string, unknown>): Promise<ControlResponse>
  runNativeBenchmark(): Promise<AudioNativeBenchmarkReport>
  beginBenchmark(): number
  endBenchmark(generation: number): void
}

type CreateBenchmarkHost = (onFailure: (message: string) => void) => AudioHostBenchmarkHost

function stageError(stage: string, error: unknown, helperFailure: string | null): Error {
  const message = error instanceof Error ? error.message : String(error)
  const failure = helperFailure && !message.includes(helperFailure) ? ` (${helperFailure})` : ""
  return new Error(`${stage} failed: ${message}${failure}`, { cause: error })
}

export class AudioHostBenchmarkRunner {
  private running = false

  constructor(private readonly createHost: CreateBenchmarkHost) {}

  async run(effect: PluginDescriptor): Promise<AudioHostBenchmarkReport> {
    if (this.running) throw new Error("audio benchmark is already running")
    this.running = true
    let helperFailure: string | null = null
    const host = this.createHost((message) => {
      helperFailure = message
    })
    host.start()
    try {
      let dsp: Omit<AudioHostBenchmarkReport, "nativeBridge">
      try {
        dsp = await this.runDspPhase(host, effect)
      } catch (error) {
        throw stageError("audio DSP benchmark", error, helperFailure)
      }
      let nativeBridge: AudioNativeBenchmarkReport
      try {
        nativeBridge = await host.runNativeBenchmark()
      } catch (error) {
        throw stageError("native audio bridge benchmark", error, helperFailure)
      }
      return { ...dsp, nativeBridge }
    } finally {
      try {
        await host.stop()
      } finally {
        this.running = false
      }
    }
  }

  private async runDspPhase(
    host: AudioHostBenchmarkHost,
    effect: PluginDescriptor
  ): Promise<Omit<AudioHostBenchmarkReport, "nativeBridge">> {
    if (
      effect.kind !== "effect" ||
      effect.compatibility !== "compatible" ||
      !effect.supportedAudioModes.includes("stereo")
    ) {
      throw new Error("audio benchmark requires a compatible stereo VST3 effect")
    }
    const generation = host.beginBenchmark()
    const pluginInstanceIds = Array.from(
      { length: 64 },
      (_, index) => `__heron-audio-benchmark-gain-${index}`
    )
    try {
      // The VST3 actor serializes most loads. Loading sequentially prevents
      // later request deadlines from expiring while queued behind earlier loads.
      for (const [slotOrder, id] of pluginInstanceIds.entries()) {
        await host.loadPlugin(
          {
            id,
            channelId: "__heron-audio-benchmark",
            role: "insert",
            slotOrder,
            classId: effect.classId,
            descriptor: effect,
            audioMode: "stereo",
            enabled: true,
            sidechainInputs: [],
            componentState: new Uint8Array(),
            controllerState: new Uint8Array()
          },
          48_000
        )
      }
      const response = await host.request({
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
      await Promise.allSettled(pluginInstanceIds.map((instanceId) => host.unloadPlugin(instanceId)))
      host.endBenchmark(generation)
    }
  }
}
