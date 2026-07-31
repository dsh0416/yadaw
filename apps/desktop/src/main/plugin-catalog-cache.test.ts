import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PluginCatalogCache } from "./plugin-catalog-cache"

describe("PluginCatalogCache", () => {
  let directory: string

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("returns null when the cache file is missing", async () => {
    directory = await mkdtemp(join(tmpdir(), "plugin-cache-"))
    const cache = new PluginCatalogCache(join(directory, "missing", "catalog.json"))

    await expect(cache.load()).resolves.toBeNull()
  })

  it("stores and reloads JSON catalogs atomically", async () => {
    directory = await mkdtemp(join(tmpdir(), "plugin-cache-"))
    const path = join(directory, "nested", "catalog.json")
    const cache = new PluginCatalogCache(path)
    const value = { plugins: [{ id: "a" }], scannedAt: 12 }

    await cache.store(value)

    await expect(cache.load()).resolves.toEqual(value)
    await expect(readFile(path, "utf8")).resolves.toContain('"scannedAt": 12')
  })

  it("returns null for malformed cache contents", async () => {
    directory = await mkdtemp(join(tmpdir(), "plugin-cache-"))
    const path = join(directory, "catalog.json")
    const cache = new PluginCatalogCache(path)
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(directory, { recursive: true })
    await writeFile(path, "{not-json", "utf8")

    await expect(cache.load()).resolves.toBeNull()
  })
})
