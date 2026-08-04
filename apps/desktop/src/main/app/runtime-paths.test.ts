import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  applicationIconPath,
  applicationIconPathForPlatform,
  rendererDirectory
} from "./runtime-paths"

describe("runtime-paths", () => {
  it("resolves the renderer directory next to the main bundle root", () => {
    expect(basename(rendererDirectory)).toBe("renderer")
    expect(rendererDirectory).toBe(join(import.meta.dirname, "../renderer"))
  })

  it("uses the macOS-safe icon for Darwin", () => {
    const iconPath = applicationIconPathForPlatform("darwin")

    expect(basename(iconPath)).toBe("icon-macos.png")
    expect(iconPath).toBe(join(import.meta.dirname, "../../build/icon-macos.png"))
  })

  it.each(["linux", "win32"] satisfies NodeJS.Platform[])(
    "uses the full-size runtime icon on %s",
    (platform) => {
      const iconPath = applicationIconPathForPlatform(platform)

      expect(basename(iconPath)).toBe("icon.png")
      expect(iconPath).toBe(join(import.meta.dirname, "../../build/icon.png"))
    }
  )

  it("resolves the current platform icon", () => {
    expect(applicationIconPath).toBe(applicationIconPathForPlatform(process.platform))
  })
})
