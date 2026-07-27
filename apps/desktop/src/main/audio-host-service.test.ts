import { decode, encode } from "@msgpack/msgpack"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fakeHost = vi.hoisted(() => {
  class Deferred<T> {
    readonly promise: Promise<T>
    resolve!: (value: T) => void
    reject!: (error: unknown) => void

    constructor() {
      this.promise = new Promise<T>((resolve, reject) => {
        this.resolve = resolve
        this.reject = reject
      })
    }
  }

  class Client {
    static instances: Client[] = []

    readonly commands: Array<Record<string, unknown>> = []
    readonly heartbeatDeferred = new Deferred<{ body: Buffer; attachments: Buffer[] }>()
    readonly delayedEngineStart =
      Client.instances.length === 1 ? new Deferred<{ body: Buffer; attachments: Buffer[] }>() : null
    heartbeatCalls = 0
    closed = false
    transportState = 0
    positionFrames = 0

    constructor(..._arguments: unknown[]) {
      Client.instances.push(this)
    }

    request(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      const request = decode(payload) as {
        request_id: number
        command: Record<string, unknown> & {
          command?: { kind?: string; position_frames?: number | null }
        }
      }
      this.commands.push(request.command)
      const response = (result: Record<string, unknown>) =>
        Promise.resolve({
          body: Buffer.from(encode({ request_id: request.request_id, result })),
          attachments: []
        })

      if (request.command.type === "audio-engine-snapshot") {
        return response({ type: "audio-runtime", runtime: runtime("stopped") })
      }
      if (request.command.type === "start-audio-engine") {
        if (this.delayedEngineStart) return this.delayedEngineStart.promise
        return response({ type: "audio-runtime", runtime: runtime("running") })
      }
      if (request.command.type === "transport") {
        const kind = request.command.command?.kind
        if (kind === "seek") {
          this.positionFrames = request.command.command?.position_frames ?? 0
          this.transportState = 0
        } else if (kind === "play") {
          this.transportState = 1
        } else {
          this.transportState = 0
        }
        return response({
          type: "transport-snapshot",
          transport: {
            state: this.transportState === 1 ? "playing" : "stopped",
            position_frames: this.positionFrames,
            sample_rate: 48_000
          }
        })
      }
      return response({ type: "accepted" })
    }

    heartbeatRequest(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      const request = decode(payload) as {
        request_id: number
        command: { type?: string }
      }
      if (request.command.type === "shutdown") {
        return Promise.resolve({
          body: Buffer.from(
            encode({ request_id: request.request_id, result: { type: "accepted" } })
          ),
          attachments: []
        })
      }
      this.heartbeatCalls += 1
      return this.heartbeatDeferred.promise
    }

    readTelemetry(): Buffer {
      return Buffer.from(encode([1, 0, 0, this.transportState, this.positionFrames, 48_000, []]))
    }

    enqueueParameter(): string {
      return "accepted"
    }

    transportDiagnostics(): Buffer {
      return Buffer.from(encode([]))
    }

    drainEvents(): Buffer[] {
      return []
    }

    close(): void {
      this.closed = true
    }
  }

  const runtime = (state: "running" | "stopped") => ({
    state,
    requested_buffer_size: 128,
    sample_rate: 48_000,
    input_sample_rate: 48_000,
    input_buffer_size: 128,
    output_buffer_size: 128,
    ring_buffer_capacity_frames: 512,
    ring_buffer_fill_frames: 256,
    input_latency_ms: 1,
    output_latency_ms: 1,
    ring_buffer_latency_ms: 1,
    engine_latency_ms: 1,
    estimated_round_trip_latency_ms: 4,
    xruns: 0,
    clock_sync: "shared",
    buffer_fallback: false
  })

  return { Client, runtime }
})

vi.mock("@yadaw/audio-host-client", () => ({
  AudioHostIpcClient: class extends fakeHost.Client {
    heartbeat(payload: Buffer): Promise<{ body: Buffer; attachments: Buffer[] }> {
      return this.heartbeatRequest(payload)
    }
  }
}))

import { AudioHostService } from "./audio-host-service"

describe("AudioHostService recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakeHost.Client.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("serializes heartbeats, restores the engine and gates transport during recovery", async () => {
    const failures: string[] = []
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      (message) => failures.push(message),
      async () => {}
    )
    service.start()
    const original = fakeHost.Client.instances[0]!

    await service.startAudioEngine({
      backend: "asio",
      inputDeviceId: "input",
      outputDeviceId: "output",
      bufferSize: 128
    })
    await service.transport({ type: "play" })
    original.positionFrames = 4096

    await vi.advanceTimersByTimeAsync(1_000)
    expect(original.heartbeatCalls).toBe(1)

    original.heartbeatDeferred.reject(new Error("audio-host request: deadline exceeded"))
    await vi.waitFor(() => expect(fakeHost.Client.instances).toHaveLength(2))
    const replacement = fakeHost.Client.instances[1]!
    expect(original.closed).toBe(true)
    ;(
      service as unknown as {
        handleExit(client: InstanceType<typeof fakeHost.Client>, message: string): void
      }
    ).handleExit(original, "late rejection from retired client")
    expect(replacement.closed).toBe(false)
    expect(fakeHost.Client.instances).toHaveLength(2)

    const queuedTransport = service.transport({ type: "pause" })
    expect(
      replacement.commands.some(
        (command) =>
          command.type === "transport" &&
          (command.command as { kind?: string } | undefined)?.kind === "pause"
      )
    ).toBe(false)

    replacement.delayedEngineStart!.resolve({
      body: Buffer.from(
        encode({
          request_id: 5,
          result: { type: "audio-runtime", runtime: fakeHost.runtime("running") }
        })
      ),
      attachments: []
    })
    await queuedTransport

    const transportKinds = replacement.commands
      .filter((command) => command.type === "transport")
      .map((command) => (command.command as { kind: string }).kind)
    expect(transportKinds).toEqual(["seek", "play", "pause"])
    expect(failures).toEqual(["heartbeat failed: audio-host request: deadline exceeded"])

    await service.stop()
  })
})
