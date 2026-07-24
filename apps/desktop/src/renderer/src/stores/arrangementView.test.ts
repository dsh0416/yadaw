import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import { useArrangementViewStore } from "./arrangementView"

describe("arrangement view store", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("keeps time, track, and amplitude zoom independent and resettable", () => {
    const store = useArrangementViewStore()
    store.zoomTime(1)
    expect(store.pixelsPerSecond).toBe(125)
    expect(store.trackHeight).toBe(104)
    expect(store.amplitudeScale).toBe(1)
    store.zoomTrack(1)
    expect(store.trackHeight).toBe(120)
    store.zoomAmplitude(1)
    expect(store.amplitudeScale).toBeCloseTo(Math.SQRT2)
    store.reset()
    expect(store.$state).toMatchObject({
      pixelsPerSecond: 100,
      trackHeight: 104,
      amplitudeScale: 1
    })
  })

  it("enforces all zoom bounds", () => {
    const store = useArrangementViewStore()
    for (let index = 0; index < 100; index += 1) {
      store.zoomTime(1)
      store.zoomTrack(1)
      store.zoomAmplitude(1)
    }
    expect(store.pixelsPerSecond).toBe(1_600)
    expect(store.trackHeight).toBe(320)
    expect(store.amplitudeScale).toBe(8)
    for (let index = 0; index < 100; index += 1) {
      store.zoomTime(-1)
      store.zoomTrack(-1)
      store.zoomAmplitude(-1)
    }
    expect(store.pixelsPerSecond).toBe(25)
    expect(store.trackHeight).toBe(72)
    expect(store.amplitudeScale).toBe(0.5)
  })
})
