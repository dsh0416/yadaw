import { describe, expect, it, vi } from "vitest"
import type { PluginDescriptor } from "@heron/contracts"
import {
  PLUGIN_DRAG_TYPE,
  claimPluginDropPreview,
  clearActivePluginDropPreview,
  readPluginDrag,
  releasePluginDropPreview,
  writePluginDrag
} from "./plugin-drag"

const descriptor = {
  source: { kind: "external" },
  classId: "effect",
  modulePath: "/Effect.vst3",
  name: "Effect",
  vendor: "YADAW",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["stereo"],
  hasEditor: false,
  compatibility: "compatible",
  compatibilityReason: null
} satisfies PluginDescriptor

function dragEvent(data?: string): DragEvent {
  const transfer = {
    effectAllowed: "none",
    setData: vi.fn(),
    getData: vi.fn((type: string) => (type === PLUGIN_DRAG_TYPE ? (data ?? "") : ""))
  }
  return { dataTransfer: transfer } as unknown as DragEvent
}

describe("plugin drag helpers", () => {
  it("writes catalog and rack payloads with the correct effectAllowed", () => {
    const catalogEvent = dragEvent()
    writePluginDrag(catalogEvent, { source: "catalog", descriptor })
    expect(catalogEvent.dataTransfer?.effectAllowed).toBe("copy")
    expect(catalogEvent.dataTransfer?.setData).toHaveBeenCalledWith(
      PLUGIN_DRAG_TYPE,
      JSON.stringify({ source: "catalog", descriptor })
    )

    const rackEvent = dragEvent()
    writePluginDrag(rackEvent, { source: "rack", instanceId: "plugin-1" })
    expect(rackEvent.dataTransfer?.effectAllowed).toBe("move")
  })

  it("reads valid payloads and ignores malformed drag data", () => {
    expect(readPluginDrag(dragEvent(JSON.stringify({ source: "rack", instanceId: "p1" })))).toEqual(
      { source: "rack", instanceId: "p1" }
    )
    expect(readPluginDrag(dragEvent(JSON.stringify({ source: "catalog", descriptor })))).toEqual({
      source: "catalog",
      descriptor
    })
    expect(readPluginDrag(dragEvent(""))).toBeNull()
    expect(readPluginDrag(dragEvent("{"))).toBeNull()
    expect(readPluginDrag(dragEvent(JSON.stringify({ source: "rack" })))).toBeNull()
    expect(readPluginDrag({ dataTransfer: null } as DragEvent)).toBeNull()
  })

  it("claims, replaces, and clears drop preview owners", () => {
    const first = vi.fn()
    const second = vi.fn()
    claimPluginDropPreview(first)
    claimPluginDropPreview(first)
    expect(first).not.toHaveBeenCalled()

    claimPluginDropPreview(second)
    expect(first).toHaveBeenCalledOnce()

    releasePluginDropPreview(first)
    clearActivePluginDropPreview()
    expect(second).toHaveBeenCalledOnce()

    const third = vi.fn()
    claimPluginDropPreview(third)
    releasePluginDropPreview(third)
    clearActivePluginDropPreview()
    expect(third).not.toHaveBeenCalled()
  })
})
