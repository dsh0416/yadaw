import { describe, expect, it, vi } from "vitest"
import { PROJECT_MEDIA_DRAG_TYPE, readProjectMediaDrag, writeProjectMediaDrag } from "./mediaDrag"

function transfer() {
  const values = new Map<string, string>()
  return {
    effectAllowed: "none",
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: vi.fn((type: string) => values.get(type) ?? "")
  } as unknown as DataTransfer
}

describe("project media drag payload", () => {
  it("round-trips only the asset identity and kind", () => {
    const data = transfer()
    writeProjectMediaDrag(data, {
      id: "asset-1",
      kind: "audio",
      name: "Audio.wav",
      contentHash: "hash",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32",
      frameCount: 48_000n
    })

    expect(data.effectAllowed).toBe("copy")
    expect(readProjectMediaDrag(data)).toEqual({ assetId: "asset-1", kind: "audio" })
  })

  it("rejects malformed or unsupported payloads", () => {
    const data = transfer()
    data.setData(PROJECT_MEDIA_DRAG_TYPE, JSON.stringify({ assetId: "asset-1", kind: "plugin" }))
    expect(readProjectMediaDrag(data)).toBeNull()
    data.setData(PROJECT_MEDIA_DRAG_TYPE, "not json")
    expect(readProjectMediaDrag(data)).toBeNull()
  })
})
