import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { decode } from "@msgpack/msgpack"
import { describe, expect, it } from "vitest"

interface MessagePackFixture {
  name: string
  producer: "rust" | "typescript"
  wireType: string
  base64: string
  normalized: unknown
}

const fixturePath = resolve(
  import.meta.dirname,
  "../../../../../crates/dsp-runtime/tests/fixtures/audio-host-messagepack.json"
)
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as MessagePackFixture[]

function normalizeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  if (Array.isArray(value)) return value.map(normalizeWireValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeWireValue(child)])
    )
  }
  return value
}

describe("Rust MessagePack fixtures", () => {
  it("cover the stable protocol scenarios", () => {
    expect(fixtures.map(({ name }) => name)).toEqual([
      "ping",
      "typed-rpc-error",
      "plugin-event",
      "heartbeat",
      "graph-transaction-resource-ref",
      "recording-binary-payload"
    ])
  })

  for (const fixture of fixtures.filter(({ producer }) => producer === "rust")) {
    it(`decodes and normalizes ${fixture.name}`, () => {
      const decoded = decode(Buffer.from(fixture.base64, "base64"))
      expect(normalizeWireValue(decoded)).toEqual(fixture.normalized)
    })
  }
})
