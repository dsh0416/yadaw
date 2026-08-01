import { describe, expect, it, vi } from "vitest"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import { deferProjectClose } from "./dirty-project-close"

describe("deferProjectClose", () => {
  it.each(["window.close", "application.quit"] as const)(
    "defers %s to the renderer while the project is dirty",
    (command) => {
      const event = { preventDefault: vi.fn() }
      const send = vi.fn()

      expect(
        deferProjectClose({
          command,
          event,
          project: { dirty: true },
          window: {
            isDestroyed: () => false,
            webContents: { send }
          }
        })
      ).toBe(true)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith(
        IPC_CHANNELS.applicationCommandRequested,
        expect.objectContaining({
          protocolVersion: IPC_PROTOCOL_VERSION,
          payload: command,
          sequence: expect.any(Number),
          resourceRevision: expect.any(Number),
          sourceEpoch: expect.any(String)
        })
      )
    }
  )

  it("defers clean projects so the renderer releases them before closing", () => {
    const event = { preventDefault: vi.fn() }
    const send = vi.fn()

    expect(
      deferProjectClose({
        command: "window.close",
        event,
        project: { dirty: false },
        window: {
          isDestroyed: () => false,
          webContents: { send }
        }
      })
    ).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
  })

  it("allows closing immediately when no project is open", () => {
    const event = { preventDefault: vi.fn() }
    const send = vi.fn()

    expect(
      deferProjectClose({
        command: "window.close",
        event,
        project: null,
        window: {
          isDestroyed: () => false,
          webContents: { send }
        }
      })
    ).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
