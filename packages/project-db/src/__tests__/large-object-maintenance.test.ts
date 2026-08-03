import { describe, expect, it } from "vitest"
import type { Results } from "@electric-sql/pglite"
import type { SQL } from "drizzle-orm"
import {
  closeLargeObject,
  createLargeObject,
  openLargeObject,
  readLargeObject,
  unlinkLargeObject,
  writeLargeObject
} from "../large-object"
import { listLargeObjectOids, vacuumAndAnalyze } from "../maintenance"

function createExecutor(responses: Array<Results<Record<string, unknown>>>) {
  let index = 0
  const queries: SQL[] = []
  return {
    queries,
    execute(query: SQL): Promise<Results<Record<string, unknown>>> {
      queries.push(query)
      const result = responses[index++]
      if (!result) {
        throw new Error(`Unexpected query at index ${index - 1}`)
      }
      return Promise.resolve(result)
    }
  }
}

describe("large-object helpers", () => {
  it("creates, writes, reads, and unlinks a large object through the executor", async () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const executor = createExecutor([
      { rows: [{ oid: 42 }], affectedRows: 0 },
      { rows: [{ descriptor: 7 }], affectedRows: 0 },
      { rows: [], affectedRows: 0 },
      { rows: [], affectedRows: 0 },
      { rows: [{ data: payload }], affectedRows: 0 },
      { rows: [], affectedRows: 0 }
    ])

    const oid = await createLargeObject(executor)
    const descriptor = await openLargeObject(executor, oid)
    await writeLargeObject(executor, descriptor, payload)
    await closeLargeObject(executor, descriptor)
    const read = await readLargeObject(executor, oid)
    await unlinkLargeObject(executor, oid)

    expect(oid).toBe(42)
    expect(descriptor).toBe(7)
    expect(read).toEqual(payload)
    expect(executor.queries).toHaveLength(6)
  })

  it("rejects invalid oid and descriptor values", async () => {
    const executor = createExecutor([{ rows: [{ oid: "bad" }], affectedRows: 0 }])

    await expect(createLargeObject(executor)).rejects.toThrow(/creation failed/)
  })

  it("normalizes ArrayBuffer payloads when reading", async () => {
    const buffer = new ArrayBuffer(2)
    new Uint8Array(buffer).set([9, 8])
    const executor = createExecutor([{ rows: [{ data: buffer }], affectedRows: 0 }])

    await expect(readLargeObject(executor, 5)).resolves.toEqual(new Uint8Array([9, 8]))
  })

  it("rejects missing large-object payloads", async () => {
    const executor = createExecutor([{ rows: [{}], affectedRows: 0 }])

    await expect(readLargeObject(executor, 5)).rejects.toThrow(/was not found/)
  })
})

describe("maintenance helpers", () => {
  it("lists large-object oids and ignores invalid rows", async () => {
    const executor = createExecutor([
      { rows: [{ oid: 1 }, { oid: "bad" }, { oid: 0 }, { oid: 3 }], affectedRows: 0 }
    ])

    await expect(listLargeObjectOids(executor)).resolves.toEqual([1, 3])
  })

  it("runs vacuum analyze outside transactions", async () => {
    const executor = createExecutor([{ rows: [], affectedRows: 0 }])

    await vacuumAndAnalyze(executor)

    expect(executor.queries).toHaveLength(1)
  })
})
