import { fileURLToPath } from "node:url"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import { migrate as runMigrations } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema.ts"

export const PROJECT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL(/* @vite-ignore */ "../drizzle", import.meta.url)
)

type ProjectDb = PgliteDatabase<typeof schema>

export function migrateProjectDatabase(
  db: ProjectDb,
  migrationsFolder = PROJECT_MIGRATIONS_FOLDER
): Promise<void> {
  return runMigrations(db, { migrationsFolder })
}
