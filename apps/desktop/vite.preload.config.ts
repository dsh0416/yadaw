import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { defineConfig } from "vite"

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs"
    },
    minify: false,
    outDir: resolve(import.meta.dirname, "out/preload"),
    rolldownOptions: {
      external: ["electron", ...nodeBuiltins]
    },
    sourcemap: true,
    target: "node22"
  }
})

