import { createHash } from "node:crypto"
import { access, cp, readdir, readFile, rm } from "node:fs/promises"
import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { buildProjectTemplateArchive } from "@heron/project-db/template"
import { defineConfig } from "vite"
import type { Plugin } from "vite"

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]
const migrationsDirectory = resolve(import.meta.dirname, "../../packages/project-db/drizzle")
const bundledMigrationsDirectory = resolve(import.meta.dirname, "out/drizzle")
const bundledProjectTemplate = resolve(import.meta.dirname, "out/project-template.pglite.gz")

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDirectory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort()
}

async function migrationDigest(files: string[]): Promise<string> {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file.slice(migrationsDirectory.length))
    hash.update(await readFile(file))
  }
  return hash.digest("hex")
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

let generatedTemplateDigest: string | null = null

const projectMigrations: Plugin = {
  name: "heron-project-migrations",
  async buildStart() {
    this.addWatchFile(migrationsDirectory)
    for (const file of await migrationFiles()) this.addWatchFile(file)
  },
  async writeBundle() {
    const files = await migrationFiles()
    await rm(bundledMigrationsDirectory, { force: true, recursive: true })
    await cp(migrationsDirectory, bundledMigrationsDirectory, { recursive: true })

    const digest = await migrationDigest(files)
    if (digest !== generatedTemplateDigest || !(await exists(bundledProjectTemplate))) {
      await buildProjectTemplateArchive(bundledProjectTemplate, migrationsDirectory)
      generatedTemplateDigest = digest
    }
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
