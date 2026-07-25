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
      trackScales: {},
      amplitudeScale: 1
    })
  })

  it("multiplies the global height by each track's independent scale", () => {
    const store = useArrangementViewStore()

    store.setTrackScale("drums", 1.5)
    expect(store.trackScale("drums")).toBe(1.5)
    expect(store.trackScale("bass")).toBe(1)
    expect(store.effectiveTrackHeight("drums")).toBe(156)
    expect(store.effectiveTrackHeight("bass")).toBe(104)

    store.zoomTrack(1)
    expect(store.effectiveTrackHeight("drums")).toBe(180)
    expect(store.effectiveTrackHeight("bass")).toBe(120)

    store.resetTrackScale("drums")
    expect(store.trackScales).toEqual({})
    expect(store.effectiveTrackHeight("drums")).toBe(120)
  })

  it("bounds individual track scales and clears them during a full reset", () => {
    const store = useArrangementViewStore()

    store.setTrackScale("audio-1", 100)
    store.setTrackScale("audio-2", 0)
    expect(store.trackScale("audio-1")).toBe(4)
    expect(store.trackScale("audio-2")).toBe(0.5)

    store.reset()
    expect(store.trackScales).toEqual({})
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
