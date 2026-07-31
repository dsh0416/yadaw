import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { rendererDirectory } from "./runtime-paths"

describe("runtime-paths", () => {
  it("resolves the renderer directory next to the main bundle root", () => {
    expect(basename(rendererDirectory)).toBe("renderer")
    expect(rendererDirectory).toBe(join(import.meta.dirname, "../renderer"))
  })
})
