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

  it("runs the complete benchmark in an isolated one-shot helper", async () => {
    const effect = {
      kind: "effect",
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      classId: "test-gain",
      modulePath: "/tmp/gain.vst3"
    } as PluginDescriptor

    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const primary = fakeHost.Client.instances[0]!

    const result = await service.runAudioBenchmark(effect)
    const benchmarkClient = fakeHost.Client.instances[1]!
    const commandTypes = benchmarkClient.commands.map((command) => command.type)
    const firstBenchmark = commandTypes.indexOf("run-audio-benchmark")
    expect(commandTypes.slice(0, firstBenchmark)).toEqual(Array(64).fill("load-plugin"))
    expect(commandTypes.slice(firstBenchmark, firstBenchmark + 1)).toEqual(["run-audio-benchmark"])
    expect(commandTypes.filter((type) => type === "unload-plugin")).toHaveLength(0)
    expect(commandTypes.filter((type) => type === "benchmark-echo").length).toBeGreaterThan(0)
    expect(result.ipc.scenarios.length).toBeGreaterThan(0)
    expect(primary.commands.some((command) => command.type === "load-plugin")).toBe(false)
    expect(primary.closed).toBe(false)
    expect(benchmarkClient.closed).toBe(true)

    fakeHost.Client.failNextAudioBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "audio DSP benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(fakeHost.Client.instances[2]?.closed).toBe(true)

    fakeHost.Client.failNextIpcBenchmark = true
    await expect(service.runAudioBenchmark(effect)).rejects.toThrow(
      "audio IPC benchmark failed: errors.audioBenchmarkFailed"
    )
    expect(fakeHost.Client.instances[3]?.closed).toBe(true)

    await service.stop()
  })

  it("keeps project requests on the primary helper while the isolated benchmark runs", async () => {
    const effect = {
      kind: "effect",
      compatibility: "compatible",
      supportedAudioModes: ["stereo"],
      classId: "test-gain",
      modulePath: "/tmp/gain.vst3"
    } as PluginDescriptor
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const primary = fakeHost.Client.instances[0]!
    await service.audioEngineSnapshot()

    fakeHost.Client.deferNextAudioBenchmark = true
    const benchmark = service.runAudioBenchmark(effect)
    await vi.waitFor(() => expect(fakeHost.Client.instances).toHaveLength(2))
    const benchmarkClient = fakeHost.Client.instances[1]!
    await vi.waitFor(() =>
      expect(
        benchmarkClient.commands.some((command) => command.type === "run-audio-benchmark")
      ).toBe(true)
    )
    const snapshotCommandCount = primary.commands.filter(
      (command) => command.type === "audio-engine-snapshot"
    ).length
    await service.audioEngineSnapshot()
    expect(
      primary.commands.filter((command) => command.type === "audio-engine-snapshot")
    ).toHaveLength(snapshotCommandCount + 1)
    expect(primary.closed).toBe(false)

    benchmarkClient.audioBenchmarkDeferred!.resolve()
    await benchmark
    expect(benchmarkClient.closed).toBe(true)
    await service.stop()
  })

  it("round-trips physical latency channel selections and measurement results", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
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
