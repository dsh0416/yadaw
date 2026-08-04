import { cp, rm } from "node:fs/promises"
import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import type { Plugin } from "vite"

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]
const migrationsDirectory = resolve(import.meta.dirname, "../../packages/project-db/drizzle")
const bundledMigrationsDirectory = resolve(import.meta.dirname, "out/drizzle")

const projectMigrations: Plugin = {
  name: "heron-project-migrations",
  buildStart() {
    this.addWatchFile(migrationsDirectory)
  },
  async writeBundle() {
    await rm(bundledMigrationsDirectory, { force: true, recursive: true })
    await cp(migrationsDirectory, bundledMigrationsDirectory, { recursive: true })
  }
}

export default defineConfig({
  plugins: [projectMigrations],
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/main/index.ts"),
        "project-worker": resolve(import.meta.dirname, "src/main/project/project-worker.ts")
      },
      formats: ["es"],
      fileName: (_format, entryName) =>
        entryName === "project-worker" ? `${entryName}.mjs` : `${entryName}.js`
    },
    minify: false,
    outDir: resolve(import.meta.dirname, "out/main"),
    rolldownOptions: {
      external: ["electron", "@electric-sql/pglite", "@heron/dsp-node", ...nodeBuiltins]
    },
    sourcemap: true,
    target: "node22"
  }
})
