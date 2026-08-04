import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AudioHostService, fakeHost, resetFakeHost } from "./audio-host-service.fixture"

describe("AudioHostService events", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeHost()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("rejects a native side-chain request when its application handler fails", async () => {
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
    service.setPluginSidechainRouteRequestHandler(async () => {
      throw new Error("project command failed")
    })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    ;(
      service as unknown as {
        handleSidechainRouteRequest(request: {
          requestId: number
          instanceId: string
          inputBusIndex: number
          sourceChannelId: string | null
        }): void
      }
    ).handleSidechainRouteRequest({
      requestId: 41,
      instanceId: "sidechain-1",
      inputBusIndex: 2,
      sourceChannelId: "audio-1"
    })

    const client = fakeHost.Client.instances[0]!
    await vi.waitFor(() =>
      expect(client.commands).toContainEqual({
        type: "resolve-plugin-sidechain-route",
        request_id: 41,
        instance_id: "sidechain-1",
        accepted: false,
        warning: "Side-chain routing could not be committed."
      })
    )
    expect(error).toHaveBeenCalledWith(
      "Could not commit a VST3 side-chain route",
      expect.objectContaining({ message: "project command failed" })
    )

    error.mockRestore()
    await service.stop()
  })

  it("waits for pending application event handlers before stopping", async () => {
    const handler = new fakeHost.Deferred<void>()
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
    service.setVst3HostNotificationHandler(() => handler.promise)
    ;(
      service as unknown as {
        handleVst3HostNotification(notification: {
          instanceId: string
          kind: string
          value: string
        }): void
      }
    ).handleVst3HostNotification({
      instanceId: "plugin-1",
      kind: "dirty-changed",
      value: "true"
    })

    let stopped = false
    const stop = service.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)

    handler.resolve()
    await stop
    expect(stopped).toBe(true)
  })
})
