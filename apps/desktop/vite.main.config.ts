import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { defineConfig } from "vite"

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/main/index.ts"),
        "project-worker": resolve(import.meta.dirname, "src/main/project-worker.ts")
      },
      formats: ["es"],
      fileName: (_format, entryName) => entryName === "project-worker"
        ? `${entryName}.mjs`
        : `${entryName}.js`
    },
    minify: false,
    outDir: resolve(import.meta.dirname, "out/main"),
    rolldownOptions: {
      external: ["electron", "@electric-sql/pglite", "@yadaw/dsp-node", ...nodeBuiltins]
    },
    sourcemap: true,
    target: "node22"
  }
})
