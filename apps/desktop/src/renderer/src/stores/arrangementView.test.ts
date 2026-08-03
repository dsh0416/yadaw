import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { beforeEach, describe, expect, it } from "vitest"
import { useArrangementViewStore } from "./arrangementView"

const storedValues = new Map<string, string>()
const storage: Storage = {
  get length() {
    return storedValues.size
  },
  clear() {
    storedValues.clear()
  },
  getItem(key) {
    return storedValues.get(key) ?? null
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null
  },
  removeItem(key) {
    storedValues.delete(key)
  },
  setItem(key, value) {
    storedValues.set(key, value)
  }
}

describe("arrangement view store", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage })
    storage.clear()
    setActivePinia(createPinia())
  })

  it("keeps time, track, and amplitude zoom independent and resettable", () => {
    const store = useArrangementViewStore()
    store.zoomTime(1)
    expect(store.pixelsPerQuarter).toBe(62.5)
    expect(store.trackHeight).toBe(104)
    expect(store.amplitudeScale).toBe(1)
    store.zoomTrack(1)
    expect(store.trackHeight).toBe(120)
    store.zoomAmplitude(1)
    expect(store.amplitudeScale).toBeCloseTo(Math.SQRT2)
    store.reset()
    expect(store.$state).toMatchObject({
      pixelsPerQuarter: 50,
      trackHeight: 104,
      trackScales: {},
      amplitudeScale: 1,
      globalTracksExpanded: true
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
    store.setTimeZoom(0)
    store.setTrackHeight(0)
    store.setAmplitudeScale(0)
    expect(store.pixelsPerQuarter).toBe(12.5)
    expect(store.trackHeight).toBe(72)
    expect(store.amplitudeScale).toBe(0.5)
    store.setTimeZoom(Number.POSITIVE_INFINITY)
    store.setTrackHeight(Number.POSITIVE_INFINITY)
    store.setAmplitudeScale(Number.POSITIVE_INFINITY)
    expect(store.pixelsPerQuarter).toBe(800)
    expect(store.trackHeight).toBe(320)
    expect(store.amplitudeScale).toBe(8)
    for (let index = 0; index < 100; index += 1) {
      store.zoomTime(1)
      store.zoomTrack(1)
      store.zoomAmplitude(1)
    }
    expect(store.pixelsPerQuarter).toBe(800)
    expect(store.trackHeight).toBe(320)
    expect(store.amplitudeScale).toBe(8)
    for (let index = 0; index < 100; index += 1) {
      store.zoomTime(-1)
      store.zoomTrack(-1)
      store.zoomAmplitude(-1)
    }
    expect(store.pixelsPerQuarter).toBe(12.5)
    expect(store.trackHeight).toBe(72)
    expect(store.amplitudeScale).toBe(0.5)
  })

  it("shows and hides every global track with one shared state", () => {
    const store = useArrangementViewStore()

    store.toggleGlobalTracks()
    expect(store.globalTracksExpanded).toBe(false)

    store.setGlobalTracksExpanded(true)
    expect(store.globalTracksExpanded).toBe(true)

    store.toggleGlobalTracks()
    store.reset()
    expect(store.globalTracksExpanded).toBe(true)
  })

  it("persists global track visibility", async () => {
    const store = useArrangementViewStore()

    store.setGlobalTracksExpanded(false)
    await nextTick()

    expect(localStorage.getItem("heron.arrangement.global-tracks-expanded.v1")).toBe("false")

    setActivePinia(createPinia())
    expect(useArrangementViewStore().globalTracksExpanded).toBe(false)
  })
})
