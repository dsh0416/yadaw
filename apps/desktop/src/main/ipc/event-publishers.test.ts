import type { PluginScanEvent } from "@heron/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerIpcEventPublishers } from "./event-publishers"

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn()
}))

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: electronMocks.getAllWindows }
}))

function createServices() {
  let pluginListener: ((event: PluginScanEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const send = vi.fn()
  const midiInputSnapshot = vi.fn(async () => ({ ports: [] }))
  const midiRuntimeSnapshot = vi.fn(() => ({ revision: 7, ports: [] }))
  electronMocks.getAllWindows.mockReturnValue([{ webContents: { send } }])
  const services = {
    plugins: {
      subscribe: vi.fn((listener: (event: PluginScanEvent) => void) => {
        pluginListener = listener
        return unsubscribe
      })
    },
    audioHost: { midiInputSnapshot },
    lifecycle: {
      applicationState: {
        resources: { epoch: "application" },
        audioHost: { epoch: "audio-host" },
        midiRuntimeSnapshot
      }
    }
  }
  return {
    services,
    emitPlugin: (event: PluginScanEvent) => pluginListener?.(event),
    midiInputSnapshot,
    midiRuntimeSnapshot,
    send,
    unsubscribe
  }
}

describe("registerIpcEventPublishers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electronMocks.getAllWindows.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("releases the plugin subscription and MIDI timer exactly once", () => {
    const fixture = createServices()
    const registration = registerIpcEventPublishers(fixture.services as never)

    expect(vi.getTimerCount()).toBe(1)
    registration.dispose()
    registration.dispose()
    fixture.emitPlugin({ type: "started", total: 1 })

    expect(vi.getTimerCount()).toBe(0)
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.send).not.toHaveBeenCalled()
  })

  it("does not publish an in-flight MIDI snapshot after disposal", async () => {
    let resolveSnapshot: ((value: { ports: never[] }) => void) | undefined
    const fixture = createServices()
    fixture.midiInputSnapshot.mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve))
    )
    const registration = registerIpcEventPublishers(fixture.services as never)

    vi.advanceTimersByTime(100)
    await Promise.resolve()
    expect(fixture.midiInputSnapshot).toHaveBeenCalledOnce()

    registration.dispose()
    resolveSnapshot?.({ ports: [] })
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.midiRuntimeSnapshot).not.toHaveBeenCalled()
    expect(fixture.send).not.toHaveBeenCalled()
  })
})
