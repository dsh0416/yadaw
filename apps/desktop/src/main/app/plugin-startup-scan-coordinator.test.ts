import type { StartupProgressSnapshot } from "@heron/contracts"
import { describe, expect, it, vi } from "vitest"
import { PluginStartupScanCoordinator } from "./plugin-startup-scan-coordinator"

describe("PluginStartupScanCoordinator", () => {
  it("projects scan progress and quarantine warnings", () => {
    const update = vi.fn<(value: Partial<StartupProgressSnapshot>) => unknown>()
    const coordinator = new PluginStartupScanCoordinator({ update })

    coordinator.handle({ type: "started", total: 2 })
    coordinator.handle({ type: "progress", completed: 1, total: 2, path: "/vst/Synth.vst3" })
    coordinator.handle({ type: "quarantined", path: "/vst/Broken.vst3", reason: "probe" })
    coordinator.handle({
      type: "completed",
      catalog: { plugins: [], scannedAt: 1, scannerVersion: 8, scanning: false }
    })

    expect(update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ progress: 0.47, detail: "Synth.vst3", completed: 1, total: 2 })
    )
    expect(update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ warnings: 1, detail: expect.stringContaining("Broken.vst3") })
    )
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 0.78, completed: 2, total: 2 })
    )
  })

  it("turns a scan failure into recoverable startup progress", () => {
    const update = vi.fn<(value: Partial<StartupProgressSnapshot>) => unknown>()
    const coordinator = new PluginStartupScanCoordinator({ update })

    coordinator.fail(new Error("probe crashed"))
    coordinator.fail("unknown")

    expect(update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        progress: 0.78,
        warnings: 1,
        detail: "VST3 scan finished with an error: probe crashed"
      })
    )
    expect(update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ progress: 0.78, warnings: 2 })
    )
  })
})
