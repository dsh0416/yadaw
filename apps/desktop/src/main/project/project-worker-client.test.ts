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

  message(message: WorkerResponse | WorkerProgress): void {
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

  it("forwards progress and ignores responses without a pending call", () => {
    const onProgress = vi.fn()
    client.onProgress = onProgress
    const progress: WorkerProgress = {
      type: "progress",
      operationId: "import-1",
      completed: 4,
      total: 10
    }
    port.message(progress)
    port.message({ id: 999, type: "close", ok: true, value: undefined })
    expect(onProgress).toHaveBeenCalledWith(progress)
  })

  it("maps structured worker failures to errors with protocol identity", async () => {
    const pending = client.listAssets()
    port.message({
      id: 1,
      type: "list-assets",
      ok: false,
      error: {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: "worker-correlation",
        userMessageKey: "errors.projectWorkerFailed",
        details: { type: "resource-unavailable", component: "project-worker", dispatched: true }
      }
    })
    await expect(pending).rejects.toMatchObject({
      message: "errors.projectWorkerFailed",
      code: "resource-unavailable",
      correlationId: "worker-correlation"
    })
  })

  it("serializes every project database operation through its typed envelope", async () => {
    const operations: Array<{
      type: string
      call: () => Promise<unknown>
      value?: unknown
    }> = [
      {
        type: "create",
        call: () =>
          client.create("/data", {
            name: "Project",
            sampleRate: 48_000,
            numerator: 4,
            denominator: 4,
            waveformDisplayMode: "separate"
          })
      },
      { type: "get-configuration", call: () => client.getConfiguration(), value: {} },
      {
        type: "update-configuration",
        call: () => client.updateConfiguration({} as never),
        value: {}
      },
      { type: "list-assets", call: () => client.listAssets(), value: [] },
      { type: "mixer-snapshot", call: () => client.mixerSnapshot(), value: {} },
      {
        type: "prepare-project-command",
        call: () => client.prepareProjectCommand("operation", 3, {} as never, "master"),
        value: {}
      },
      {
        type: "commit-project-command",
        call: () => client.commitProjectCommand({} as never),
        value: {}
      },
      { type: "abort-project-command", call: () => client.abortProjectCommand({} as never) },
      {
        type: "project-command-status",
        call: () => client.projectCommandStatus("operation"),
        value: { state: "absent" }
      },
      { type: "import-midi", call: () => client.importMidi({} as never, {} as never, "master") },
      { type: "rollback-midi", call: () => client.rollbackMidi("midi", {} as never, "master") },
      { type: "save-plugin-states", call: () => client.savePluginStates([]) },
      { type: "asset-content-hashes", call: () => client.assetContentHashes(["asset"]), value: [] },
      { type: "default-recording-track", call: () => client.defaultRecordingTrack(), value: null },
      { type: "assets-missing-waveform", call: () => client.assetsMissingWaveform(2), value: [] },
      { type: "delete-assets", call: () => client.deleteAssets(["asset"]) },
      { type: "dump", call: () => client.dump("/archive") },
      {
        type: "import-large-object",
        call: () => client.importLargeObject("/audio", "import", {} as never),
        value: 7
      },
      {
        type: "read-large-object",
        call: () => client.readLargeObject("asset"),
        value: new Uint8Array([1])
      },
      { type: "read-waveform", call: () => client.readWaveform("asset", 0, 10, 2), value: null },
      { type: "store-waveform", call: () => client.storeWaveform("asset", {} as never) },
      { type: "cancel", call: () => client.cancel("import") }
    ]

    for (const operation of operations) {
      const pending = operation.call()
      const request = port.postMessage.mock.calls.at(-1)![0] as { id: number; type: string }
      expect(request.type).toBe(operation.type)
      port.message({
        id: request.id,
        type: operation.type,
        ok: true,
        value: operation.value
      } as never)
      await expect(pending).resolves.toEqual(operation.value)
    }

    const closing = client.close()
    const closeRequest = port.postMessage.mock.calls.at(-1)![0] as { id: number; type: string }
    expect(closeRequest.type).toBe("close")
    port.message({ id: closeRequest.id, type: "close", ok: true, value: undefined })
    await closing
  })

  it("opens a database and closes it before terminating exactly once", async () => {
    const opened = client.open("/data", "/archive.heron")
    port.message({ id: 1, type: "open", ok: true, value: undefined })
    await opened

    const termination = client.terminate()
    const closeRequest = port.postMessage.mock.calls.at(-1)![0] as { id: number; type: string }
    expect(closeRequest.type).toBe("close")
    port.message({ id: closeRequest.id, type: "close", ok: true, value: undefined })
    await termination
    await client.terminate()
    expect(port.terminate).toHaveBeenCalledOnce()
    await expect(client.listAssets()).rejects.toThrow("Project worker is terminated")
  })

  it("still terminates when the best-effort close cannot be posted", async () => {
    const opened = client.open("/data")
    port.message({ id: 1, type: "open", ok: true, value: undefined })
    await opened
    port.postMessage.mockImplementationOnce(() => {
      throw new Error("worker unavailable")
    })
    await client.terminate()
    expect(port.terminate).toHaveBeenCalledOnce()
  })
})
