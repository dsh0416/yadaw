import type { PluginDescriptor } from "@heron/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioHostService, fakeHost, resetFakeHost } from "./audio-host-service.fixture"

describe("AudioHostService benchmark", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeHost()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs the complete benchmark in the embedded runtime and cleans up temporary plugins", async () => {
    const effect = {
      source: { kind: "external" },
      locator: { format: "vst3", artifactPath: "/tmp/gain.vst3", nativeId: "test-gain" },
      name: "Test Gain",
      vendor: "Heron",
      version: "1",
      categories: ["Fx"],
      kind: "effect",
      architecture: "x86_64",
      buses: [],
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      hasEditor: false,
      compatibilityReason: null
    } as PluginDescriptor

    const service = new AudioHostService(
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const primary = fakeHost.Client.instances[0]!

    const result = await service.runAudioBenchmark(effect)
    const commandTypes = primary.commands.map((command) => command.type)
    const firstBenchmark = commandTypes.indexOf("run-audio-benchmark")
    expect(commandTypes.slice(0, firstBenchmark)).toEqual(Array(64).fill("load-plugin"))
    expect(commandTypes.slice(firstBenchmark, firstBenchmark + 1)).toEqual(["run-audio-benchmark"])
    expect(commandTypes.filter((type) => type === "unload-plugin")).toHaveLength(64)
    expect(commandTypes.filter((type) => type === "benchmark-echo").length).toBeGreaterThan(0)
    expect(result.nativeBridge.scenarios.length).toBeGreaterThan(0)
    expect(primary.closed).toBe(false)
    expect(fakeHost.Client.instances).toHaveLength(1)

    primary.failAudioBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "audio DSP benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(primary.closed).toBe(false)

    primary.failAudioBenchmark = false
    primary.failNativeBridgeBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "native audio bridge benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(primary.closed).toBe(false)

    await service.stop()
  })

  it("keeps project requests available while the embedded benchmark runs", async () => {
    const effect = {
      source: { kind: "external" },
      locator: { format: "vst3", artifactPath: "/tmp/gain.vst3", nativeId: "test-gain" },
      name: "Test Gain",
      vendor: "Heron",
      version: "1",
      categories: ["Fx"],
      kind: "effect",
      architecture: "x86_64",
      buses: [],
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      hasEditor: false,
      compatibilityReason: null
    } as PluginDescriptor
    const service = new AudioHostService(
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const primary = fakeHost.Client.instances[0]!
    await service.audioEngineSnapshot()

    primary.audioBenchmarkDeferred = new fakeHost.Deferred<void>()
    const benchmark = service.runAudioBenchmark(effect)
    await vi.waitFor(() =>
      expect(primary.commands.some((command) => command.type === "run-audio-benchmark")).toBe(true)
    )
    const snapshotCommandCount = primary.commands.filter(
      (command) => command.type === "compiled-graph-snapshot"
    ).length
    await service.compiledAudioGraphSnapshot()
    expect(
      primary.commands.filter((command) => command.type === "compiled-graph-snapshot")
    ).toHaveLength(snapshotCommandCount + 1)
    expect(primary.closed).toBe(false)

    primary.audioBenchmarkDeferred.resolve()
    await benchmark
    expect(primary.closed).toBe(false)
    await service.stop()
  })

  it("round-trips physical latency channel selections and measurement results", async () => {
    const service = new AudioHostService(
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const client = fakeHost.Client.instances[0]!

    const started = await service.startRoundTripLatencyMeasurement({
      inputChannel: 2,
      outputChannel: 4
    })
    expect(started).toMatchObject({
      status: "preparing",
      inputChannel: 2,
      outputChannel: 4
    })
    expect(client.commands.at(-1)).toEqual({
      type: "start-round-trip-latency-measurement",
      request: { input_channel: 2, output_channel: 4 }
    })

    client.latencyMeasurement = {
      status: "complete",
      input_channel: 2,
      output_channel: 4,
      measured_round_trip_latency_ms: 8.75,
      failure: null
    }
    await expect(service.roundTripLatencyMeasurementSnapshot()).resolves.toEqual({
      status: "complete",
      inputChannel: 2,
      outputChannel: 4,
      measuredRoundTripLatencyMs: 8.75,
      failure: null
    })

    await service.stop()
  })
})
