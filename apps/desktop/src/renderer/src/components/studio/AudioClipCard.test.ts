import { afterEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { UiContextMenu } from "@heron/ui"
import type { TimelineClip } from "../../stores/transport"
import AudioClipCard from "./AudioClipCard.vue"

const clip: TimelineClip = {
  id: "clip-1",
  assetId: "asset-1",
  trackId: "track-1",
  name: "Take",
  startSeconds: 1,
  durationSeconds: 1,
  endSeconds: 2,
  channels: 2,
  sampleRate: 96_000,
  projectSampleRate: 48_000,
  startFrame: 48_000,
  sourceOffsetFrames: 0,
  lengthFrames: 48_000,
  sourceLengthFrames: 96_000,
  fadeInFrames: 0,
  fadeOutFrames: 0
}

function mountCard(clipOverrides: Partial<TimelineClip> = {}) {
  return mount(AudioClipCard, {
    props: {
      clip: { ...clip, ...clipOverrides },
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      },
      pixelsPerQuarter: 480,
      viewportStartSeconds: 0,
      viewportEndSeconds: 4,
      amplitudeScale: 1,
      displayMode: "separate",
      selected: false,
      trackColor: "#73d6a2",
      playheadFrame: 72_000,
      splitShortcut: "Ctrl+E"
    },
    global: { plugins: [createPinia()] },
    attachTo: document.body
  })
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("AudioClipCard", () => {
  it("previews a frame-accurate trim and commits once on release", async () => {
    const wrapper = mountCard()
    const handle = wrapper.get('[data-testid="audio-trim-start"]')

    await handle.trigger("pointerdown", { pointerId: 7, clientX: 960 })
    await handle.trigger("pointermove", { pointerId: 7, clientX: 1_200 })
    expect(wrapper.get('[role="button"]').attributes("style")).toContain("left: 1200px")
    await handle.trigger("pointerup", { pointerId: 7, clientX: 1_200 })

    expect(wrapper.emitted("trim")).toEqual([["clip-1", "start", 60_000]])
  })

  it("selects an unselected target before exposing valid clip commands", async () => {
    const wrapper = mountCard()

    await wrapper.get('[role="button"]').trigger("contextmenu")

    expect(wrapper.emitted("select")).toEqual([["clip-1"]])
    expect(document.body.textContent).toContain("Split at playhead")
    expect(document.body.textContent).toContain("Reset fades")
    expect(document.body.textContent).toContain("Ctrl+E")
  })

  it("renders full-height equal-power fade envelopes", () => {
    const wrapper = mountCard({ fadeInFrames: 12_000, fadeOutFrames: 24_000 })
    const [fadeIn, fadeOut] = wrapper.findAll("svg.fade-region")

    expect(fadeIn?.attributes("viewBox")).toBe("0 0 100 100")
    expect(fadeIn?.attributes("style")).toContain("width: 25%")
    expect(fadeIn?.get(".fade-curve").attributes("d")).toMatch(/^M 0 100 .* L 100 0$/)
    expect(fadeOut?.attributes("viewBox")).toBe("0 0 100 100")
    expect(fadeOut?.attributes("style")).toContain("width: 50%")
    expect(fadeOut?.get(".fade-curve").attributes("d")).toMatch(/^M 0 0 .* L 100 100$/)
  })

  it("exposes fade slider range semantics and commits menu actions", async () => {
    const wrapper = mountCard({ fadeInFrames: 12_000, fadeOutFrames: 24_000 })
    const fadeIn = wrapper.get('[data-testid="audio-fade-in"]')
    const fadeOut = wrapper.get('[data-testid="audio-fade-out"]')

    expect(fadeIn.attributes("aria-valuemin")).toBe("0")
    expect(fadeIn.attributes("aria-valuemax")).toBe("24000")
    expect(fadeIn.attributes("aria-valuenow")).toBe("12000")
    expect(fadeOut.attributes("aria-valuemin")).toBe("0")
    expect(fadeOut.attributes("aria-valuemax")).toBe("36000")
    expect(fadeOut.attributes("aria-valuenow")).toBe("24000")

    await wrapper.getComponent(UiContextMenu).vm.$emit("select", "split")
    await wrapper.getComponent(UiContextMenu).vm.$emit("select", "trim-start")
    await wrapper.getComponent(UiContextMenu).vm.$emit("select", "trim-end")
    await wrapper.getComponent(UiContextMenu).vm.$emit("select", "reset-fades")
    await wrapper.getComponent(UiContextMenu).vm.$emit("select", "delete")
    await wrapper.get('[role="button"]').trigger("keydown", { key: "Backspace" })

    expect(wrapper.emitted("split")).toEqual([["clip-1"]])
    expect(wrapper.emitted("trim")).toEqual([
      ["clip-1", "start", 72_000],
      ["clip-1", "end", 72_000]
    ])
    expect(wrapper.emitted("resetFades")).toEqual([["clip-1"]])
    expect(wrapper.emitted("remove")).toEqual([["clip-1"], ["clip-1"]])
  })

  it("previews and commits a fade-out drag from the fade handle", async () => {
    const wrapper = mountCard({ fadeOutFrames: 0 })
    const handle = wrapper.get('[data-testid="audio-fade-out"]')

    await handle.trigger("pointerdown", { pointerId: 4, clientX: 1_920 })
    await handle.trigger("pointermove", { pointerId: 4, clientX: 1_680 })
    expect(handle.attributes("style")).toContain("width: 25%")
    await handle.trigger("pointerup", { pointerId: 4, clientX: 1_680 })

    expect(wrapper.emitted("fade")).toEqual([["clip-1", "out", 12_000]])
  })
})
