import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot, ProjectCommand } from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import { usePianoRollStore } from "../../stores/pianoRoll"
import PianoRollDock from "./PianoRollDock.vue"

const graph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [{ id: "track:instrument-1", channelId: "instrument-1", sortOrder: 0 }],
  channels: [
    {
      id: "instrument-1",
      kind: "instrument",
      systemRole: null,
      name: "Keys",
      color: "#73D6A2",
      sortOrder: 0,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
  ],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [
    {
      id: "clip-1",
      sourceId: "source-1",
      trackId: "track:instrument-1",
      name: "Verse",
      startTick: 960,
      lengthTicks: 960,
      sourceOffsetTicks: 0,
      notes: [
        {
          id: "note-1",
          startTick: 0,
          durationTicks: 240,
          channel: 0,
          key: 60,
          velocity: 100,
          releaseVelocity: 0
        },
        {
          id: "note-2",
          startTick: 480,
          durationTicks: 240,
          channel: 0,
          key: 64,
          velocity: 90,
          releaseVelocity: 0
        }
      ],
      events: []
    }
  ],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
}

function mountDock(): {
  wrapper: VueWrapper
  mixer: ReturnType<typeof useMixerStore>
  pianoRoll: ReturnType<typeof usePianoRollStore>
  execute: ReturnType<typeof vi.spyOn>
} {
  const pinia = createPinia()
  setActivePinia(pinia)
  const mixer = useMixerStore()
  mixer.hydrate(graph)
  const pianoRoll = usePianoRollStore()
  pianoRoll.selectArrangementClip("clip-1")
  pianoRoll.openSelection("clip-1")
  const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
  const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
  return { wrapper, mixer, pianoRoll, execute }
}

function mockLaneBounds(wrapper: VueWrapper): ReturnType<VueWrapper["get"]> {
  const canvas = wrapper.get<HTMLElement>(".lane-canvas")
  vi.spyOn(canvas.element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 640,
    bottom: 100,
    left: 0,
    width: 640,
    height: 100,
    toJSON: () => ({})
  })
  return canvas
}

describe("PianoRollVelocityLane", () => {
  it("renders one bar per note with velocity-proportional height", () => {
    const { wrapper } = mountDock()
    const bars = wrapper.findAll<HTMLElement>(".velocity-bar")

    expect(bars).toHaveLength(2)
    expect(bars[0]!.element.style.left).toBe("120px")
    expect(bars[0]!.element.style.height).toBe(`${(100 / 127) * 100}%`)
    expect(bars[1]!.element.style.left).toBe("180px")

    wrapper.unmount()
  })

  it("commits a single velocity update when dragging a bar", async () => {
    const { wrapper, execute } = mountDock()
    const canvas = mockLaneBounds(wrapper)

    await canvas.trigger("pointerdown", { pointerId: 1, clientX: 122, clientY: 50 })
    expect(wrapper.findAll<HTMLElement>(".velocity-bar")[0]!.element.style.height).toBe(
      `${(64 / 127) * 100}%`
    )
    expect(execute).not.toHaveBeenCalled()

    await canvas.trigger("pointerup", { pointerId: 1, clientX: 122, clientY: 50 })
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { velocity: 64 } }]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("applies the dragged level to the whole selection", async () => {
    const { wrapper, pianoRoll, execute } = mountDock()
    pianoRoll.selectNote({ clipId: "clip-1", noteId: "note-1" })
    pianoRoll.selectNote({ clipId: "clip-1", noteId: "note-2" }, true)
    const canvas = mockLaneBounds(wrapper)

    await canvas.trigger("pointerdown", { pointerId: 1, clientX: 122, clientY: 50 })
    await canvas.trigger("pointerup", { pointerId: 1, clientX: 122, clientY: 50 })
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [
        { noteId: "note-1", patch: { velocity: 64 } },
        { noteId: "note-2", patch: { velocity: 64 } }
      ]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("paints velocities across bars from empty lane space", async () => {
    const { wrapper, execute } = mountDock()
    const canvas = mockLaneBounds(wrapper)

    await canvas.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 25 })
    await canvas.trigger("pointermove", { pointerId: 1, clientX: 180, clientY: 25 })
    await canvas.trigger("pointerup", { pointerId: 1, clientX: 180, clientY: 25 })
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-2", patch: { velocity: 95 } }]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("keeps the lane scroll in sync with the note grid viewport", async () => {
    const { wrapper } = mountDock()
    // The lane attaches its viewport listener once the template ref propagates.
    await flushPromises()
    const viewport = wrapper.get<HTMLElement>('[aria-label="Piano roll note grid"]')
    const laneScroll = wrapper.get<HTMLElement>(".lane-scroll")
    // jsdom has no layout, so scrollLeft assignments are ignored by default.
    for (const element of [viewport.element, laneScroll.element]) {
      let scrollLeft = 0
      Object.defineProperty(element, "scrollLeft", {
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value
        }
      })
    }

    viewport.element.scrollLeft = 50
    await viewport.trigger("scroll")
    expect(laneScroll.element.scrollLeft).toBe(50)

    laneScroll.element.scrollLeft = 75
    await laneScroll.trigger("scroll")
    expect(viewport.element.scrollLeft).toBe(75)

    wrapper.unmount()
  })

  it("toggles visibility from the inspector panel", async () => {
    const { wrapper } = mountDock()
    expect(wrapper.find(".velocity-lane").exists()).toBe(true)

    await wrapper.get('button[aria-label="Toggle velocity lane"]').trigger("click")
    expect(wrapper.find(".velocity-lane").exists()).toBe(false)

    await wrapper.get('button[aria-label="Toggle velocity lane"]').trigger("click")
    expect(wrapper.find(".velocity-lane").exists()).toBe(true)

    wrapper.unmount()
  })
})
