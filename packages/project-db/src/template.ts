import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrateProjectDatabase } from "./migrations.ts"
import * as schema from "./schema.ts"

export async function buildProjectTemplateArchive(
  outputPath: string,
  migrationsFolder: string
): Promise<void> {
  const workingDirectory = await mkdtemp(join(tmpdir(), "heron-project-template-"))
  const outputDirectory = dirname(outputPath)
  const temporaryOutputPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp`)
  let client: PGlite | null = null

  try {
    client = await PGlite.create(join(workingDirectory, "pgdata"))
    await migrateProjectDatabase(drizzle(client, { schema }), migrationsFolder)
    await client.syncToFs()
    const archive = await client.dumpDataDir("gzip")

    await mkdir(outputDirectory, { recursive: true })
    await writeFile(temporaryOutputPath, Buffer.from(await archive.arrayBuffer()))
    await rename(temporaryOutputPath, outputPath)
  } finally {
    try {
      await client?.close()
    } finally {
      await Promise.all([
        rm(temporaryOutputPath, { force: true }),
        rm(workingDirectory, { force: true, recursive: true })
      ])
    }
  }
}
