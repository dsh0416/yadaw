import { describe, expect, it, vi } from "vitest"
import type { PluginDescriptor, ProjectCommand } from "@yadaw/contracts"
import { isPluginCommand, persistPluginCommand } from "../internal/plugin-persistence"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "ABCDEF0123456789ABCDEF0123456789",
  modulePath: "/plugins/Effect.vst3",
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
  compatibilityReason: null
}

function txMock() {
  const insertValues = vi.fn(async () => undefined)
  const deleteWhere = vi.fn(async () => undefined)
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
  const selectFrom = vi.fn(() => ({
    from: vi.fn(async () => [])
  }))
  return {
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn(() => selectFrom()),
    insertValues,
    deleteWhere,
    updateSet
  }
}

describe("plugin-persistence", () => {
  it("identifies plugin commands", () => {
    expect(isPluginCommand({ type: "create-plugin" } as ProjectCommand)).toBe(true)
    expect(isPluginCommand({ type: "delete-plugin" } as ProjectCommand)).toBe(true)
    expect(isPluginCommand({ type: "update-channel", channelId: "a", patch: {} })).toBe(false)
  })

  it("inserts create-plugin rows", async () => {
    const tx = txMock()
    await persistPluginCommand(tx as never, {
      type: "create-plugin",
      plugin: {
        id: "plugin-1",
        channelId: "master",
        role: "insert",
        slotOrder: 0,
        classId: descriptor.classId,
        descriptor,
        audioMode: "stereo",
        enabled: true,
        componentState: new Uint8Array([1]),
        controllerState: new Uint8Array([2])
      }
    })

    expect(tx.insert).toHaveBeenCalled()
    expect(tx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin-1",
        classId: descriptor.classId,
        descriptorSnapshot: expect.stringContaining("Effect")
      })
    )
  })

  it("deletes plugin rows", async () => {
    const tx = txMock()
    await persistPluginCommand(tx as never, {
      type: "delete-plugin",
      pluginId: "plugin-1"
    })
    expect(tx.delete).toHaveBeenCalled()
    expect(tx.deleteWhere).toHaveBeenCalled()
  })

  it("updates plugin patches when fields are present", async () => {
    const tx = txMock()
    await persistPluginCommand(tx as never, {
      type: "update-plugin",
      pluginId: "plugin-1",
      patch: { enabled: false, slotOrder: 2 }
    })
    expect(tx.update).toHaveBeenCalled()
    expect(tx.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, slotOrder: 2 })
    )
  })

  it("skips empty update patches", async () => {
    const tx = txMock()
    await persistPluginCommand(tx as never, {
      type: "update-plugin",
      pluginId: "plugin-1",
      patch: {}
    })
    expect(tx.update).not.toHaveBeenCalled()
  })
})
