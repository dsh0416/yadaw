import type { PluginInstanceState, ProjectGraphSnapshot } from "@yadaw/contracts"
import { describe, expect, it, vi } from "vitest"
import { synchronizePluginStatesAtomically } from "./plugin-state-synchronizer"

function plugin(id: string): PluginInstanceState {
  return { id } as PluginInstanceState
}

function graph(...plugins: PluginInstanceState[]): ProjectGraphSnapshot {
  return { sampleRate: 48_000, plugins } as ProjectGraphSnapshot
}

describe("synchronizePluginStatesAtomically", () => {
  it("does not persist a partial snapshot when any plug-in fails", async () => {
    const failure = new Error("state unavailable")
    const audioHost = {
      loadPlugin: vi.fn(async () => ({ latencySamples: 0, tailSamples: null })),
      savePluginState: vi.fn(async (instanceId: string) => {
        if (instanceId === "broken") throw failure
        return {
          componentState: new Uint8Array([1]),
          controllerState: new Uint8Array([2]),
          araDocumentState: new Uint8Array([3])
        }
      })
    }
    const projectGraph = {
      snapshot: vi.fn(async () => graph(plugin("healthy"), plugin("broken"))),
      savePluginStates: vi.fn(async () => undefined)
    }

    await expect(synchronizePluginStatesAtomically(audioHost, projectGraph)).rejects.toThrow(
      "Could not synchronize every VST3 plug-in state"
    )
    expect(projectGraph.savePluginStates).not.toHaveBeenCalled()
  })

  it("persists one complete snapshot after every plug-in succeeds", async () => {
    const audioHost = {
      loadPlugin: vi.fn(async () => ({ latencySamples: 0, tailSamples: null })),
      savePluginState: vi.fn(async () => ({
        componentState: new Uint8Array([1]),
        controllerState: new Uint8Array([2]),
        araDocumentState: new Uint8Array([3])
      }))
    }
    const projectGraph = {
      snapshot: vi.fn(async () => graph(plugin("first"), plugin("second"))),
      savePluginStates: vi.fn(async () => undefined)
    }

    await synchronizePluginStatesAtomically(audioHost, projectGraph)

    expect(projectGraph.savePluginStates).toHaveBeenCalledOnce()
    expect(projectGraph.savePluginStates).toHaveBeenCalledWith([
      expect.objectContaining({ id: "first" }),
      expect.objectContaining({ id: "second" })
    ])
  })
})
