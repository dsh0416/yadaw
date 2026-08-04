import { join } from "node:path"

// Vite bundles the main-process modules into out/main, alongside out/renderer.
// Keeping this calculation shared prevents source-directory-relative paths from
// resolving differently after bundling.
export const rendererDirectory = join(import.meta.dirname, "../renderer")

export function applicationIconPathForPlatform(platform: NodeJS.Platform): string {
  const filename = platform === "darwin" ? "icon-macos.png" : "icon.png"
  return join(import.meta.dirname, "../../build", filename)
}

export const applicationIconPath = applicationIconPathForPlatform(process.platform)
