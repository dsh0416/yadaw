import { afterEach, describe, expect, it, vi } from "vitest"
import type { AudioClipState, TempoMapSnapshot } from "@heron/contracts"
import { useAudioClipEdit } from "./useAudioClipEdit"

afterEach(() => {
  document.body.innerHTML = ""
})

const tempoMap: TempoMapSnapshot = {
  ticksPerQuarter: 960,
  tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

const clip: AudioClipState = {
  id: "audio-1",
  assetId: "asset-1",
  trackId: "track-1",
  name: "Take",
  startFrame: 48_000,
  sourceOffsetFrames: 0,
  lengthFrames: 48_000,
  sourceLengthFrames: 96_000,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  assetSampleRate: 48_000,
  assetChannels: 2
}

function pointerTarget(): HTMLElement {
  const lane = document.createElement("div")
  const clipElement = document.createElement("div")
  clipElement.className = "audio-clip"
  const handle = document.createElement("span")
  handle.setPointerCapture = vi.fn()
  clipElement.append(handle)
  lane.append(clipElement)
  document.body.append(lane)
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 2_000,
    bottom: 40,
    left: 0,
    width: 2_000,
    height: 40,
    toJSON: () => ({})
  })
  return handle
}

function pointerEvent(
  type: string,
  target: HTMLElement,
  overrides: Partial<PointerEvent> & { clientX: number; pointerId?: number }
): PointerEvent {
  return {
    type,
    pointerId: overrides.pointerId ?? 1,
    clientX: overrides.clientX,
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as PointerEvent
}

describe("useAudioClipEdit", () => {
  it("previews and commits a frame-accurate trim gesture", () => {
    const commitTrim = vi.fn()
    const commitFade = vi.fn()
    const edit = useAudioClipEdit({
      clip: () => clip,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      projectSampleRate: () => 48_000,
      commitTrim,
      commitFade
    })
    const handle = pointerTarget()

    edit.startTrim(pointerEvent("pointerdown", handle, { clientX: 960 }), "start")
    edit.update(pointerEvent("pointermove", handle, { clientX: 1_200 }))
    expect(edit.preview.value).toMatchObject({ startFrame: 60_000, lengthFrames: 36_000 })
    edit.finish(pointerEvent("pointerup", handle, { clientX: 1_200 }))

    expect(commitTrim).toHaveBeenCalledWith("start", 60_000)
    expect(commitFade).not.toHaveBeenCalled()
    expect(edit.active.value).toBe(false)
  })

  it("previews and commits fade-in and fade-out gestures", () => {
    const commitTrim = vi.fn()
    const commitFade = vi.fn()
    const edit = useAudioClipEdit({
      clip: () => clip,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      projectSampleRate: () => 48_000,
      commitTrim,
      commitFade
    })
    const handle = pointerTarget()

    edit.startFade(pointerEvent("pointerdown", handle, { clientX: 960 }), "in")
    edit.update(pointerEvent("pointermove", handle, { clientX: 1_200 }))
    expect(edit.preview.value).toMatchObject({ fadeInFrames: 12_000 })
    edit.finish(pointerEvent("pointerup", handle, { clientX: 1_200 }))
    expect(commitFade).toHaveBeenCalledWith("in", 12_000)

    edit.startFade(pointerEvent("pointerdown", handle, { clientX: 1_920 }), "out")
    edit.update(pointerEvent("pointermove", handle, { clientX: 1_680 }))
    expect(edit.preview.value).toMatchObject({ fadeOutFrames: 12_000 })
    edit.finish(pointerEvent("pointerup", handle, { clientX: 1_680 }))
    expect(commitFade).toHaveBeenCalledWith("out", 12_000)
  })

  it("ignores gestures that are not rooted in an audio clip lane", () => {
    const edit = useAudioClipEdit({
      clip: () => clip,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      projectSampleRate: () => 48_000,
      commitTrim: vi.fn(),
      commitFade: vi.fn()
    })
    const orphan = document.createElement("span")

    edit.startTrim(pointerEvent("pointerdown", orphan, { clientX: 100 }), "start")
    edit.startFade(pointerEvent("pointerdown", orphan, { clientX: 100 }), "in")

    expect(edit.active.value).toBe(false)
    expect(edit.preview.value).toBeNull()
  })

  it("cancels an in-flight preview without committing", () => {
    const commitTrim = vi.fn()
    const edit = useAudioClipEdit({
      clip: () => clip,
      tempoMap: () => tempoMap,
      pixelsPerQuarter: () => 480,
      projectSampleRate: () => 48_000,
      commitTrim,
      commitFade: vi.fn()
    })
    const handle = pointerTarget()

    edit.startTrim(pointerEvent("pointerdown", handle, { clientX: 960 }), "end")
    edit.update(pointerEvent("pointermove", handle, { clientX: 1_440 }))
    edit.cancel()
    edit.finish(pointerEvent("pointerup", handle, { clientX: 1_440 }))

    expect(commitTrim).not.toHaveBeenCalled()
    expect(edit.preview.value).toBeNull()
  })
})
