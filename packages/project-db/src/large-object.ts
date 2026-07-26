import type { Results } from "@electric-sql/pglite"
import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

export interface LargeObjectExecutor {
  execute(query: SQL): PromiseLike<Results<Record<string, unknown>>>
}

function requiredNumber(value: unknown, operation: string, minimum = 1): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`PostgreSQL large-object ${operation} failed`)
  }
  return parsed
}

export async function createLargeObject(executor: LargeObjectExecutor): Promise<number> {
  const result = await executor.execute(sql`select lo_create(0) as oid`)
  return requiredNumber(result.rows[0]?.oid, "creation")
}

export async function openLargeObject(executor: LargeObjectExecutor, oid: number): Promise<number> {
  const result = await executor.execute(sql`select lo_open(${oid}, 131072) as descriptor`)
  return requiredNumber(result.rows[0]?.descriptor, "open", 0)
}

export async function writeLargeObject(
  executor: LargeObjectExecutor,
  descriptor: number,
  chunk: Uint8Array
): Promise<void> {
  await executor.execute(sql`select lowrite(${descriptor}, ${chunk})`)
}

export async function closeLargeObject(
  executor: LargeObjectExecutor,
  descriptor: number
): Promise<void> {
  await executor.execute(sql`select lo_close(${descriptor})`)
}

export async function readLargeObject(
  executor: LargeObjectExecutor,
  oid: number
): Promise<Uint8Array> {
  const result = await executor.execute(sql`select lo_get(${oid}) as data`)
  const data = result.rows[0]?.data
  if (!data) throw new Error(`PostgreSQL large object '${oid}' was not found`)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new Error(`PostgreSQL large object '${oid}' returned invalid data`)
}

export async function unlinkLargeObject(executor: LargeObjectExecutor, oid: number): Promise<void> {
  await executor.execute(sql`select lo_unlink(${oid})`)
}
