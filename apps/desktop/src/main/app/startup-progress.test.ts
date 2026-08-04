import { describe, expect, it, vi } from "vitest"
import { StartupProgress } from "./startup-progress"

describe("StartupProgress", () => {
  it("publishes cloned snapshots and keeps progress monotonic", () => {
    const startup = new StartupProgress()
    const listener = vi.fn()
    startup.subscribe(listener)

    startup.update({
      phase: "scanning-plugins",
      progress: 0.6,
      label: "Scanning VST3 plug-ins",
      completed: 3,
      total: 8
    })
    startup.update({ progress: 0.4, completed: 4 })

    expect(startup.snapshot()).toMatchObject({
      phase: "scanning-plugins",
      progress: 0.6,
      completed: 4,
      total: 8
    })
    expect(listener).toHaveBeenCalledTimes(2)

    const snapshot = startup.snapshot()
    snapshot.label = "mutated"
    expect(startup.snapshot().label).toBe("Scanning VST3 plug-ins")
  })

  it("records completion and recoverable startup failures", () => {
    const startup = new StartupProgress()
    startup.update({ total: 5, warnings: 2 })

    expect(startup.complete("5 plug-ins available")).toMatchObject({
      phase: "ready",
      progress: 1,
      completed: 5,
      total: 5,
      warnings: 2
    })

    const failed = new StartupProgress().fail(new Error("Audio helper unavailable"))
    expect(failed).toMatchObject({
      phase: "failed",
      label: "Startup failed",
      detail: "Audio helper unavailable"
    })
  })
})
