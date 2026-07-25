import { readdirSync, readFileSync } from "node:fs"
import { extname, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (![".ts", ".vue"].includes(extname(entry.name))) return []
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) return []
    return [path]
  })
}

describe("renderer native-call boundary", () => {
  const rendererRoot = import.meta.dirname
  const desktopSourceRoot = resolve(rendererRoot, "../..")

  it("allows window.yadaw only in Pinia stores", () => {
    const violations = sourceFiles(rendererRoot)
      .filter((path) => readFileSync(path, "utf8").includes("window.yadaw"))
      .filter((path) => !relative(rendererRoot, path).replaceAll("\\", "/").startsWith("stores/"))
      .map((path) => relative(rendererRoot, path))

    expect(violations).toEqual([])
  })

  it("keeps the native addon out of renderer and preload", () => {
    const roots = [rendererRoot, resolve(desktopSourceRoot, "preload")]
    const violations = roots
      .flatMap(sourceFiles)
      .filter((path) => readFileSync(path, "utf8").includes("@yadaw/dsp-node"))
      .map((path) => relative(desktopSourceRoot, path))

    expect(violations).toEqual([])
  })
})
