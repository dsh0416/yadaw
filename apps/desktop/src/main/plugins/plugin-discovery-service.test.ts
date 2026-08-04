import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginCatalogSnapshot, PluginDescriptor } from "@heron/contracts"
import { PluginDiscoveryService, PLUGIN_SCANNER_VERSION } from "./plugin-discovery-service"
import { PluginCatalogCache } from "./plugin-catalog-cache"

const emptyCatalog = (): PluginCatalogSnapshot => ({
  scannerVersion: PLUGIN_SCANNER_VERSION,
  scanning: false,
  scannedAt: null,
  plugins: []
})

function descriptor(modulePath: string, classId = "class-id"): PluginDescriptor {
  return {
    source: { kind: "external" },
    classId,
    modulePath,
    name: classId,
    vendor: "Acme",
    version: "1",
    categories: ["Fx"],
    kind: "effect",
    architecture: process.arch,
    buses: [],
    supportedAudioModes: ["stereo"],
    hasEditor: false,
    compatibility: "compatible",
    compatibilityReason: null
  }
}

describe("PluginDiscoveryService", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function harness() {
    const userData = await mkdtemp(join(tmpdir(), "heron-plugin-discovery-"))
    const root = join(userData, "plugins")
    await mkdir(root)
    directories.push(userData)
    const probe = { probe: vi.fn() }
    return {
      userData,
      root,
      probe,
      service: new PluginDiscoveryService(userData, probe as never, () => [])
    }
  }

  it("loads and normalizes a compatible cache snapshot", async () => {
    const { userData, service } = await harness()
    const cached = descriptor("cached.vst3")
    await new PluginCatalogCache(join(userData, "plugin-catalog.json")).store({
      ...emptyCatalog(),
      scannedAt: 12,
      plugins: [cached]
    })

    await expect(service.loadCachedCatalog()).resolves.toMatchObject({
      scannedAt: 12,
      scanning: false,
      plugins: [expect.objectContaining({ classId: "class-id" })]
    })
  })

  it("reuses cached fingerprints, while force scans probe again", async () => {
    const { root, probe, service } = await harness()
    const bundle = join(root, "Legacy.vst3")
    await mkdir(bundle)
    probe.probe.mockResolvedValue([descriptor(bundle)])

    const first = await service.scan(emptyCatalog(), { paths: [root] }, vi.fn())
    await service.scan(first, { paths: [root] }, vi.fn())
    await service.scan(first, { paths: [root], force: true }, vi.fn())

    expect(probe.probe).toHaveBeenCalledTimes(2)
  })

  it("keeps quarantine cached until an explicit retry succeeds", async () => {
    const { root, probe, service } = await harness()
    const bundle = join(root, "Retry.vst3")
    await mkdir(bundle)
    probe.probe
      .mockRejectedValueOnce(new Error("probe crashed"))
      .mockResolvedValueOnce([descriptor(bundle)])

    const quarantined = await service.scan(emptyCatalog(), { paths: [root] }, vi.fn())
    expect(quarantined.plugins[0]?.compatibility).toBe("quarantined")
    await service.scan(quarantined, { paths: [root] }, vi.fn())
    const retried = await service.scan(
      quarantined,
      { paths: [root], retryQuarantined: true },
      vi.fn()
    )

    expect(probe.probe).toHaveBeenCalledTimes(2)
    expect(retried.plugins[0]?.compatibility).toBe("compatible")
  })

  it("deduplicates Class IDs and preserves successful bundles after a partial failure", async () => {
    const { root, probe, service } = await harness()
    const good = join(root, "Good.vst3")
    const duplicate = join(root, "Duplicate.vst3")
    const broken = join(root, "Broken.vst3")
    await Promise.all([mkdir(good), mkdir(duplicate), mkdir(broken)])
    const moduleInfo = JSON.stringify({
      "Factory Info": { Vendor: "Acme" },
      Classes: [
        {
          CID: "shared-id",
          Category: "Audio Module Class",
          Name: "Shared",
          "Sub Categories": ["Fx"]
        }
      ]
    })
    await Promise.all([
      writeFile(join(good, "moduleinfo.json"), moduleInfo),
      writeFile(join(duplicate, "moduleinfo.json"), moduleInfo)
    ])
    probe.probe.mockRejectedValue(new Error("broken bundle"))

    const catalog = await service.scan(emptyCatalog(), { paths: [root] }, vi.fn())

    expect(catalog.plugins.filter((plugin) => plugin.classId === "shared-id")).toHaveLength(1)
    expect(catalog.plugins.some((plugin) => plugin.compatibility === "quarantined")).toBe(true)
  })
})
