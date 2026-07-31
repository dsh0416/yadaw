import { describe, expect, it } from "vitest"
import {
  binaryBytes,
  extractLargeAttachments,
  hydrateAttachments,
  inlineBinary,
  percentile,
  stableRuntimeHandle
} from "./audio-host-wire"

describe("stableRuntimeHandle", () => {
  it("returns a stable positive hash for a namespace and id", () => {
    const first = stableRuntimeHandle(1, "channel-a")
    const second = stableRuntimeHandle(1, "channel-a")
    const other = stableRuntimeHandle(1, "channel-b")

    expect(first).toBe(second)
    expect(first).toBeGreaterThanOrEqual(1)
    expect(first).not.toBe(other)
  })
})

describe("inlineBinary and binaryBytes", () => {
  it("wraps and unwraps inline payloads", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const payload = inlineBinary(bytes)

    expect(payload).toEqual({ storage: "inline", bytes })
    expect(binaryBytes(payload)).toEqual(bytes)
  })

  it("returns an empty buffer for missing or attachment payloads", () => {
    expect(binaryBytes(undefined)).toEqual(new Uint8Array())
    expect(binaryBytes({ storage: "attachment", index: 0, offset: 0, length: 1 })).toEqual(
      new Uint8Array()
    )
  })
})

describe("extractLargeAttachments", () => {
  it("leaves small inline payloads in place", () => {
    const value = { payload: inlineBinary(new Uint8Array(16)) }
    const attachments: Buffer[] = []

    extractLargeAttachments(value, attachments)

    expect(attachments).toEqual([])
    expect(value.payload.storage).toBe("inline")
  })

  it("moves large nested payloads into attachments", () => {
    const large = new Uint8Array(64 * 1024 + 8)
    large.fill(7)
    const value = {
      nested: [{ payload: inlineBinary(large) }],
      ignored: null
    }
    const attachments: Buffer[] = []

    extractLargeAttachments(value, attachments)

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.equals(Buffer.from(large))).toBe(true)
    expect(value.nested[0]?.payload).toEqual({
      storage: "attachment",
      index: 0,
      offset: 0,
      length: large.byteLength
    })
  })

  it("ignores non-objects", () => {
    const attachments: Buffer[] = []
    extractLargeAttachments(null, attachments)
    extractLargeAttachments("text", attachments)
    expect(attachments).toEqual([])
  })
})

describe("hydrateAttachments", () => {
  it("restores attachment payloads into inline bytes", () => {
    const bytes = Buffer.from([9, 8, 7, 6, 5])
    const value = {
      payload: {
        storage: "attachment" as const,
        index: 0,
        offset: 1,
        length: 3
      }
    }

    hydrateAttachments(value, [bytes])

    expect(value.payload.storage).toBe("inline")
    expect(Uint8Array.from(value.payload.bytes as Uint8Array)).toEqual(new Uint8Array([8, 7, 6]))
  })

  it("hydrates nested arrays and rejects invalid references", () => {
    const value = {
      items: [{ storage: "attachment" as const, index: 0, offset: 0, length: 2 }]
    }
    hydrateAttachments(value, [Buffer.from([1, 2, 3])])
    expect(value.items[0]?.storage).toBe("inline")
    expect(Uint8Array.from((value.items[0] as { bytes: Uint8Array }).bytes)).toEqual(
      new Uint8Array([1, 2])
    )

    expect(() =>
      hydrateAttachments({ payload: { storage: "attachment", index: 0, offset: 0, length: 99 } }, [
        Buffer.from([1])
      ])
    ).toThrow("audio host returned an invalid attachment reference")
  })
})

describe("percentile", () => {
  it("returns 0 for an empty series", () => {
    expect(percentile([], 0.5)).toBe(0)
  })

  it("selects clamped percentile samples from a sorted copy", () => {
    const values = [40, 10, 30, 20]

    expect(percentile(values, 0)).toBe(10)
    expect(percentile(values, 1)).toBe(40)
    expect(percentile(values, 0.5)).toBe(30)
    expect(percentile(values, -1)).toBe(10)
    expect(percentile(values, 2)).toBe(40)
    expect(values).toEqual([40, 10, 30, 20])
  })
})
