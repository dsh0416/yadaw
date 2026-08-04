import { describe, expect, it, vi } from "vitest"
import type { PluginDescriptor, ProjectCommand } from "@heron/contracts"
import { isPluginCommand, persistPluginCommand } from "../internal/plugin-persistence"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  locator: {
    format: "vst3",
    artifactPath: "/plugins/Effect.vst3",
    nativeId: "ABCDEF0123456789ABCDEF0123456789"
  },
  name: "Effect",
  vendor: "Heron Studio",
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
        locator: descriptor.locator,
        descriptor,
        audioMode: "stereo",
        enabled: true,
        sidechainInputs: [],
        state: {
          version: 1,
          chunks: [
            { key: "component", bytes: new Uint8Array([1]) },
            { key: "controller", bytes: new Uint8Array([2]) }
          ]
        }
      }
    })

    expect(tx.insert).toHaveBeenCalled()
    expect(tx.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "plugin-1",
        locatorFormat: "vst3",
        artifactPath: descriptor.locator.artifactPath,
        nativeId: descriptor.locator.nativeId,
        descriptorSnapshot: expect.stringContaining("Effect")
      })
    )
    expect(tx.insertValues).toHaveBeenNthCalledWith(2, [
      { pluginId: "plugin-1", chunkKey: "component", bytes: new Uint8Array([1]) },
      { pluginId: "plugin-1", chunkKey: "controller", bytes: new Uint8Array([2]) }
    ])
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
      patch: { enabled: false, slotOrder: 2, descriptor }
    })
    expect(tx.update).toHaveBeenCalled()
    expect(tx.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        slotOrder: 2,
        descriptorSnapshot: JSON.stringify(descriptor)
      })
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
