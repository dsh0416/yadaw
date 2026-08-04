import { join } from "node:path"

// Vite bundles the main-process modules into out/main, alongside out/renderer.
// Keeping this calculation shared prevents source-directory-relative paths from
// resolving differently after bundling.
export const rendererDirectory = join(import.meta.dirname, "../renderer")
export const applicationIconPath = join(import.meta.dirname, "../../build/icon.png")
