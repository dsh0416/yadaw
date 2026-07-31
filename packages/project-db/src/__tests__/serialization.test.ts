import { describe, expect, it } from "vitest"
import { bytes, pluginDescriptor } from "../internal/serialization"

describe("serialization helpers", () => {
  it("returns Uint8Array values unchanged", () => {
    const value = new Uint8Array([1, 2, 3])
    expect(bytes(value)).toBe(value)
  })

  it("copies ArrayBuffer views into Uint8Array", () => {
    const source = new Uint16Array([0x0102, 0x0304])
    const copied = bytes(source)
    expect(copied).toBeInstanceOf(Uint8Array)
    expect(copied.byteLength).toBe(source.byteLength)
  })

  it("returns an empty buffer for unsupported values", () => {
    expect(bytes(null)).toEqual(new Uint8Array())
    expect(bytes("text")).toEqual(new Uint8Array())
  })

  it("parses plugin descriptor snapshots", () => {
    const descriptor = {
      source: { kind: "external" },
      classId: "ABCDEF0123456789ABCDEF0123456789",
      modulePath: "/plugin.vst3",
      name: "Effect",
      vendor: "YADAW",
      version: "1.0",
      categories: ["Fx"],
      kind: "effect",
      architecture: "x86_64",
      buses: [],
      supportedAudioModes: ["stereo"],
      hasEditor: true,
      compatibility: "compatible",
      compatibilityReason: null,
      category: "legacy-category"
    }

    expect(pluginDescriptor(JSON.stringify(descriptor))).toMatchObject({
      classId: descriptor.classId,
      name: "Effect",
      kind: "effect"
    })
  })
})
