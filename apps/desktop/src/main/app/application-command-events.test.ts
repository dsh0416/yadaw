import { describe, expect, it, vi } from "vitest"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import { applicationCommandEvent, sendApplicationCommand } from "./application-command-events"

describe("application command envelopes", () => {
  it("builds a revisioned RpcEvent payload", () => {
    const event = applicationCommandEvent("window.close")
    expect(event).toMatchObject({
      protocolVersion: IPC_PROTOCOL_VERSION,
      payload: "window.close",
      sequence: expect.any(Number),
      resourceRevision: expect.any(Number),
      sourceEpoch: expect.any(String)
    })
    expect(event.sequence).toBe(event.resourceRevision)
  })

  it("sends the envelope on the application command channel", () => {
    const send = vi.fn()
    const show = vi.fn()
    sendApplicationCommand({ show, webContents: { send } }, "application.quit")
    expect(show).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.applicationCommandRequested,
      expect.objectContaining({
        protocolVersion: IPC_PROTOCOL_VERSION,
        payload: "application.quit"
      })
    )
  })
})
