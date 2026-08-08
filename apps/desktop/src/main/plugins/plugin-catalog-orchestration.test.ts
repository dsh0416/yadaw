import { describe, expect, it, vi } from "vitest"
import type { PluginDescriptor } from "@heron/contracts"
import { PluginCatalogService } from "./plugin-catalog-service"

function externalDescriptor(buses: PluginDescriptor["buses"] = []): PluginDescriptor {
  return {
    source: { kind: "external" },
    locator: {
      format: "vst3",
      artifactPath: "/plugins/Sidechain.vst3",
      nativeId: "sidechain-effect"
    },
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
        portKey: "vst3:audio:input:0",
        direction: "input",
        kind: "main",
        name: "Stereo In",
        channels: 2,
        defaultActive: true
      },
      {
        portKey: "vst3:audio:input:1",
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
    expect(probeClient.probe).toHaveBeenCalledWith(startupDescriptor.locator.artifactPath, "deep")
    expect(first.buses).toContainEqual(
      expect.objectContaining({
        portKey: "vst3:audio:input:1",
        direction: "input",
        kind: "aux"
      })
    )
    expect(second).toEqual(first)
  })

  it("does not load a soft-advertised layout after the deep probe crashes", async () => {
    const probeClient = { probe: vi.fn().mockRejectedValue(new Error("probe crashed")) }
    const service = new PluginCatalogService("user-data", "probe", "builtins", {
      probeClient: probeClient as never
    })

    const resolved = await service.resolveDescriptorForRuntime({
      ...externalDescriptor(),
      supportedAudioModes: ["mono-to-stereo"]
    })

    expect(resolved).toMatchObject({
      compatibility: "load-error",
      compatibilityReason: "probe crashed",
      supportedAudioModes: []
    })
  })

  it("does not fall back to soft metadata when the requested class disappears", async () => {
    const probeClient = {
      probe: vi.fn().mockResolvedValue([
        {
          ...externalDescriptor(),
          locator: { ...externalDescriptor().locator, nativeId: "different-effect" }
        }
      ])
    }
    const service = new PluginCatalogService("user-data", "probe", "builtins", {
      probeClient: probeClient as never
    })

    const resolved = await service.resolveDescriptorForRuntime(externalDescriptor())

    expect(resolved.supportedAudioModes).toEqual([])
    expect(resolved.compatibility).toBe("load-error")
    expect(resolved.compatibilityReason).toContain("requested plug-in class")
  })
})
