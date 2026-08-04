import { describe, expect, it, vi } from "vitest"
import type { PluginDescriptor } from "@heron/contracts"
import { PluginCatalogService } from "./plugin-catalog-service"

function externalDescriptor(buses: PluginDescriptor["buses"] = []): PluginDescriptor {
  return {
    source: { kind: "external" },
    classId: "sidechain-effect",
    modulePath: "/plugins/Sidechain.vst3",
    name: "Sidechain",
    vendor: "Acme",
    version: "1",
    categories: ["Fx"],
    kind: "effect",
    architecture: process.arch,
    buses,
    supportedAudioModes: ["stereo"],
    hasEditor: true,
    compatibility: "compatible",
    compatibilityReason: null
  }
}

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

  it("deep-probes once per bundle immediately before runtime loading", async () => {
    const deep = externalDescriptor([
      {
        index: 0,
        direction: "input",
        kind: "main",
        name: "Stereo In",
        channels: 2,
        defaultActive: true
      },
      {
        index: 1,
        direction: "input",
        kind: "aux",
        name: "Stereo Side Chain",
        channels: 2,
        defaultActive: true
      }
    ])
    const probeClient = { probe: vi.fn().mockResolvedValue([deep]) }
    const service = new PluginCatalogService("user-data", "probe", "builtins", {
      probeClient: probeClient as never
    })
    const startupDescriptor = externalDescriptor()

    const [first, second] = await Promise.all([
      service.resolveDescriptorForRuntime(startupDescriptor),
      service.resolveDescriptorForRuntime(startupDescriptor)
    ])

    expect(probeClient.probe).toHaveBeenCalledOnce()
    expect(probeClient.probe).toHaveBeenCalledWith(startupDescriptor.modulePath, "deep")
    expect(first.buses).toContainEqual(
      expect.objectContaining({ index: 1, direction: "input", kind: "aux" })
    )
    expect(second).toEqual(first)
  })
})
