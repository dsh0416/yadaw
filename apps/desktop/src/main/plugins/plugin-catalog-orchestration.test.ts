import { describe, expect, it, vi } from "vitest"
import { PluginCatalogService } from "./plugin-catalog-service"

describe("PluginCatalogService orchestration", () => {
  it("publishes built-in fallbacks when isolated probes fail", async () => {
    const probeClient = { probe: vi.fn().mockRejectedValue(new Error("probe unavailable")) }
    const discovery = { loadCachedCatalog: vi.fn().mockResolvedValue(null), scan: vi.fn() }
    const service = new PluginCatalogService("user-data", "probe", "builtins", {
      probeClient: probeClient as never,
      discovery: discovery as never
    })

    await service.initialize()

    expect(service.list().plugins).toHaveLength(3)
    expect(service.list().plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: { kind: "builtin", id: "live.minori.heron.gain" },
          compatibility: "load-error",
          compatibilityReason: "probe unavailable"
        })
      ])
    )
  })

  it("coalesces concurrent scans through the catalog facade", async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const discovery = {
      loadCachedCatalog: vi.fn().mockResolvedValue(null),
      scan: vi.fn().mockImplementation(async (catalog) => {
        await pending
        return { ...catalog, scanning: false, scannedAt: 1 }
      })
    }
    const service = new PluginCatalogService("user-data", "probe", "builtins", {
      probeClient: { probe: vi.fn() } as never,
      discovery: discovery as never
    })

    const first = service.scan({ force: true })
    const second = service.scan({ retryQuarantined: true })
    expect(discovery.scan).toHaveBeenCalledOnce()
    finish()

    await expect(first).resolves.toMatchObject({ scannedAt: 1 })
    await expect(second).resolves.toMatchObject({ scannedAt: 1 })
  })
})
