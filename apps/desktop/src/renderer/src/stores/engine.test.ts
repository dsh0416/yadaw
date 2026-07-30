import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeEngineInfo } from "@yadaw/contracts"
import { useEngineStore } from "./engine"

const info: NativeEngineInfo = { backend: "cpal", version: "0.1.4", nodeApi: 9 }

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => setActivePinia(createPinia()))

describe("initialize", () => {
  it("reads the native engine description once", async () => {
    const engineInfo = vi.fn(async () => info)
    stubApi({ engineInfo })
    const store = useEngineStore()

    await store.initialize()
    await store.initialize()

    expect(engineInfo).toHaveBeenCalledTimes(1)
    expect(store.nativeInfo).toEqual(info)
    expect(store.error).toBeUndefined()
  })

  it("records why the native addon could not be reached", async () => {
    stubApi({
      engineInfo: vi.fn(async () => {
        throw new Error("Cannot find native binding")
      })
    })
    const store = useEngineStore()

    await store.initialize()

    expect(store.nativeInfo).toBeUndefined()
    expect(store.error).toBe("Cannot find native binding")
  })

  it("uses a generic message for non-Error rejections", async () => {
    stubApi({
      engineInfo: vi.fn().mockRejectedValue("boom")
    })
    const store = useEngineStore()

    await store.initialize()

    expect(store.error).toBe("Native engine unavailable")
  })

  it("does not retry after a failure", async () => {
    const engineInfo = vi.fn(async () => {
      throw new Error("unavailable")
    })
    stubApi({ engineInfo })
    const store = useEngineStore()

    await store.initialize()
    await store.initialize()

    expect(engineInfo).toHaveBeenCalledTimes(1)
  })
})

describe("runPreview", () => {
  it("sends the preview samples through the native gain stage", async () => {
    const processGain = vi.fn(async () => ({ samples: [-1, 0.5, 2], peak: 2 }))
    stubApi({ processGain })
    const store = useEngineStore()

    await store.runPreview(2)

    expect(processGain).toHaveBeenCalledWith({ samples: [-0.5, 0.25, 1], gain: 2 })
    expect(store.peak).toBe(2)
    expect(store.error).toBeUndefined()
  })

  it("clears a previous error once a preview succeeds", async () => {
    stubApi({
      engineInfo: vi.fn(async () => {
        throw new Error("unavailable")
      }),
      processGain: vi.fn(async () => ({ samples: [], peak: 0 }))
    })
    const store = useEngineStore()
    await store.initialize()
    expect(store.error).toBe("unavailable")

    await store.runPreview(1)

    expect(store.error).toBeUndefined()
  })

  it("keeps the last peak when a preview fails", async () => {
    stubApi({ processGain: vi.fn(async () => ({ samples: [], peak: 0.75 })) })
    const store = useEngineStore()
    await store.runPreview(1)

    stubApi({
      processGain: vi.fn(async () => {
        throw new Error("engine stopped")
      })
    })
    await store.runPreview(1)

    expect(store.peak).toBe(0.75)
    expect(store.error).toBe("engine stopped")
  })

  it("uses a generic message for non-Error rejections", async () => {
    stubApi({
      processGain: vi.fn().mockRejectedValue("boom")
    })
    const store = useEngineStore()

    await store.runPreview(1)

    expect(store.error).toBe("Native preview failed")
  })
})
