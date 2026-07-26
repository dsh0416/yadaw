import type { Results } from "@electric-sql/pglite"
import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

export interface DatabaseMaintenanceExecutor {
  execute(query: SQL): PromiseLike<Results<Record<string, unknown>>>
}

export async function listLargeObjectOids(
  executor: DatabaseMaintenanceExecutor
): Promise<number[]> {
  const result = await executor.execute(
    sql`select oid from pg_catalog.pg_largeobject_metadata order by oid`
  )
  return result.rows.map((row) => Number(row.oid)).filter((oid) => Number.isInteger(oid) && oid > 0)
}

export async function vacuumAndAnalyze(executor: DatabaseMaintenanceExecutor): Promise<void> {
  // VACUUM cannot run inside a transaction. Keep this as a separate save-time
  // maintenance step after orphan cleanup has committed.
  await executor.execute(sql`vacuum (analyze)`)
}
