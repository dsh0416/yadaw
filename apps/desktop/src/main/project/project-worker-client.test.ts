import type { WorkerProgress, WorkerResponse } from "@heron/project-db/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectWorkerClient } from "./project-worker-client"
import type { ProjectWorkerPort } from "./project-worker-port"

class FakeWorkerPort implements ProjectWorkerPort {
  private messageListener: ((message: WorkerResponse | WorkerProgress) => void) | null = null
  private errorListener: ((error: unknown) => void) | null = null
  private exitListener: ((code: number) => void) | null = null
  readonly postMessage = vi.fn<(message: unknown) => void>()
  readonly terminate = vi.fn(async () => 0)

  onMessage(listener: (message: WorkerResponse | WorkerProgress) => void): void {
    this.messageListener = listener
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener
  }

  onExit(listener: (code: number) => void): void {
    this.exitListener = listener
  }

  message(message: WorkerResponse): void {
    this.messageListener?.(message)
  }

  error(error: unknown): void {
    this.errorListener?.(error)
  }

  exit(code: number): void {
    this.exitListener?.(code)
  }
}

describe("ProjectWorkerClient", () => {
  let port: FakeWorkerPort
  let client: ProjectWorkerClient

  beforeEach(() => {
    port = new FakeWorkerPort()
    client = new ProjectWorkerClient(new URL("file:///project-worker.mjs"), () => port)
  })

  it("rejects a response whose operation type does not match the pending call", async () => {
    const configuration = client.getConfiguration()
    port.message({ id: 1, type: "list-assets", ok: true, value: [] } as never)

    await expect(configuration).rejects.toThrow(
      "Project worker response mismatch: expected 'get-configuration', received 'list-assets'"
    )
  })

  it("rejects and removes a pending call when postMessage throws", async () => {
    port.postMessage.mockImplementationOnce(() => {
      throw new Error("structured clone failed")
    })

    await expect(client.getConfiguration()).rejects.toThrow("structured clone failed")
    const next = client.getConfiguration()
    port.message({
      id: 2,
      type: "get-configuration",
      ok: true,
      value: {
        name: "Recovered",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      }
    } as never)
    await expect(next).resolves.toMatchObject({ name: "Recovered" })
  })

  it("rejects every pending call after an abnormal worker exit", async () => {
    const configuration = client.getConfiguration()
    const assets = client.listAssets()

    port.exit(17)

    await expect(configuration).rejects.toThrow("Project worker exited with code 17")
    await expect(assets).rejects.toThrow("Project worker exited with code 17")
    await expect(client.getConfiguration()).rejects.toThrow("Project worker is failed")
  })

  it("propagates worker errors to pending calls", async () => {
    const configuration = client.getConfiguration()
    port.error(new Error("worker crashed"))
    await expect(configuration).rejects.toThrow("worker crashed")
  })
})
