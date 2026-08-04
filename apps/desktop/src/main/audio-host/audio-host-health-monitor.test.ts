import type { AudioHostRuntime } from "@heron/dsp-node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioHostHealthMonitor } from "./audio-host-health-monitor"
import type { PriorityResponse } from "./wire"

function heartbeat(callbackGeneration: number, transportState = "stopped"): PriorityResponse {
  return {
    request_id: 1,
    result: {
      type: "heartbeat",
      ipc_generation: 2,
      tokio_generation: 3,
      winit_generation: 4,
      callback_generation: callbackGeneration,
      transport_state: transportState
    }
  }
}

describe("AudioHostHealthMonitor", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("serializes heartbeat requests and records a readonly snapshot", async () => {
    let resolveHeartbeat!: (response: PriorityResponse) => void
    const pending = new Promise<PriorityResponse>((resolve) => {
      resolveHeartbeat = resolve
    })
    const client = {} as AudioHostRuntime
    const request = vi.fn(() => pending)
    const captureTransport = vi.fn()
    const monitor = new AudioHostHealthMonitor({
      currentClient: () => client,
      heartbeat: request,
      captureTransport,
      onFailure: vi.fn()
    })
    monitor.start(client)

    await vi.advanceTimersByTimeAsync(750)
    expect(request).toHaveBeenCalledOnce()
    resolveHeartbeat(heartbeat(5))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)

    expect(request).toHaveBeenCalledTimes(2)
    expect(captureTransport).toHaveBeenCalledWith(client)
    expect(monitor.snapshot()).toMatchObject({
      lastHeartbeatAt: expect.any(Number),
      lastHeartbeatGenerations: { ipc: 2, tokio: 3, winit: 4, callback: 5 }
    })
    monitor.stop()
  })

  it("reports an active callback that makes no progress for two seconds", async () => {
    const client = {} as AudioHostRuntime
    const onFailure = vi.fn()
    const monitor = new AudioHostHealthMonitor({
      currentClient: () => client,
      heartbeat: vi.fn(async () => heartbeat(7, "playing")),
      captureTransport: vi.fn(),
      onFailure
    })
    monitor.start(client)

    await vi.advanceTimersByTimeAsync(2_500)

    expect(onFailure).toHaveBeenCalledWith(client, "audio callback made no progress for 2 seconds")
    monitor.stop()
  })

  it("suppresses an in-flight heartbeat failure when a benchmark begins", async () => {
    let rejectHeartbeat!: (error: unknown) => void
    const client = {} as AudioHostRuntime
    const onFailure = vi.fn()
    const request = vi.fn(
      () =>
        new Promise<PriorityResponse>((_resolve, reject) => {
          rejectHeartbeat = reject
        })
    )
    const monitor = new AudioHostHealthMonitor({
      currentClient: () => client,
      heartbeat: request,
      captureTransport: vi.fn(),
      onFailure
    })
    monitor.start(client)
    await vi.advanceTimersByTimeAsync(250)

    const generation = monitor.beginBenchmark()
    rejectHeartbeat(new Error("deadline exceeded"))
    await Promise.resolve()
    await Promise.resolve()
    expect(onFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(request).toHaveBeenCalledOnce()

    monitor.endBenchmark(generation)
    monitor.stop()
  })

  it("stops heartbeat polling during shutdown", async () => {
    const client = {} as AudioHostRuntime
    const request = vi.fn(async () => heartbeat(1))
    const monitor = new AudioHostHealthMonitor({
      currentClient: () => client,
      heartbeat: request,
      captureTransport: vi.fn(),
      onFailure: vi.fn()
    })
    monitor.start(client)
    monitor.stop()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(request).not.toHaveBeenCalled()
  })

  it("reports a persistent failure only once", async () => {
    const client = {} as AudioHostRuntime
    const onFailure = vi.fn()
    const monitor = new AudioHostHealthMonitor({
      currentClient: () => client,
      heartbeat: vi.fn(async () => {
        throw new Error("runtime stalled")
      }),
      captureTransport: vi.fn(),
      onFailure
    })
    monitor.start(client)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(onFailure).toHaveBeenCalledOnce()
    monitor.stop()
  })
})
