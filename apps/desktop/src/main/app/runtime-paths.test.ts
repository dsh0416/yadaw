import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { applicationIconPath, rendererDirectory } from "./runtime-paths"

describe("runtime-paths", () => {
  it("resolves the renderer directory next to the main bundle root", () => {
    expect(basename(rendererDirectory)).toBe("renderer")
    expect(rendererDirectory).toBe(join(import.meta.dirname, "../renderer"))
  })

  it("resolves the application icon from packaged and source main bundles", () => {
    expect(basename(applicationIconPath)).toBe("icon.png")
    expect(applicationIconPath).toBe(join(import.meta.dirname, "../../build/icon.png"))
  })
})
