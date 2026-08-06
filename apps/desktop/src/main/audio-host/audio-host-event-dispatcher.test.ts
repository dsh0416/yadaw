import { describe, expect, it, vi } from "vitest"
import { AudioHostEventDispatcher } from "./audio-host-event-dispatcher"

describe("AudioHostEventDispatcher", () => {
  it("deduplicates ARA callbacks within a helper epoch", async () => {
    const handler = vi.fn()
    const dispatcher = new AudioHostEventDispatcher({
      helperEpoch: () => "epoch-1",
      rejectSidechainRoute: vi.fn()
    })
    dispatcher.setAraHandler(handler)
    const callback = {
      helperEpoch: "epoch-1",
      instanceId: "ara-1",
      sequence: 2,
      event: { kind: "archive-progress", direction: "store", progress: 1 }
    } as const

    dispatcher.dispatchAra(callback)
    dispatcher.dispatchAra(callback)
    await dispatcher.settle()

    expect(handler).toHaveBeenCalledOnce()
  })

  it("rejects synchronous side-chain handler failures and settles pending work", async () => {
    const rejectSidechainRoute = vi.fn(async () => {})
    const dispatcher = new AudioHostEventDispatcher({
      helperEpoch: () => "epoch-1",
      rejectSidechainRoute
    })
    dispatcher.setSidechainHandler(() => {
      throw new Error("command failed")
    })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const request = {
      requestId: 4,
      instanceId: "plugin-1",
      inputPortKey: "vst3:audio:input:2",
      sourceChannelId: null
    }

    dispatcher.dispatchSidechain(request)
    await dispatcher.settle()

    expect(rejectSidechainRoute).toHaveBeenCalledWith(request)
    expect(error).toHaveBeenCalledWith(
      "Could not commit a VST3 side-chain route",
      expect.any(Error)
    )
    error.mockRestore()
  })
})
