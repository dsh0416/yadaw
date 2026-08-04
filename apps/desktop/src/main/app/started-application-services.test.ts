import { describe, expect, it, vi } from "vitest"
import { createStartedApplicationServices } from "./started-application-services"

describe("createStartedApplicationServices", () => {
  it("disposes event registrations in order and only once", () => {
    const calls: string[] = []
    const first = vi.fn(() => calls.push("ipc"))
    const second = vi.fn(() => calls.push("application-events"))
    const services = createStartedApplicationServices({} as never, {} as never, [
      { dispose: first },
      { dispose: second }
    ])

    services.dispose()
    services.dispose()

    expect(calls).toEqual(["ipc", "application-events"])
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })
})
