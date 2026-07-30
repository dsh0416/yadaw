import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { MixerGraphSnapshot, ProjectCommand } from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import { usePianoRollStore } from "../../stores/pianoRoll"
import PianoRollDock from "./PianoRollDock.vue"

const graph: MixerGraphSnapshot = {
  sampleRate: 48_000,
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
  clips: [],
  sends: [],
  plugins: [],
  midiClips: [
    {
      id: "clip-1",
      sourceId: "source-1",
      trackId: "instrument-1",
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

function mockGridBounds(element: HTMLElement): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 640,
    bottom: 2_304,
    left: 0,
    width: 640,
    height: 2_304,
    toJSON: () => ({})
  })
}

describe("PianoRollDock", () => {
  it("renders editable notes and accepts the one-tick minimum duration", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain("Resolution 1/3840 note")
    expect(wrapper.find('[aria-label="Lower dock"]').exists()).toBe(false)
    expect(wrapper.findAll(".pitch-row")).toHaveLength(128)
    expect(wrapper.get('.pitch-row[data-key="61"]').classes()).toContain("black")
    expect(wrapper.get('.pitch-row[data-key="60"]').classes()).not.toContain("black")
    expect(wrapper.get('button[aria-label^="C4, start 960"]').attributes("aria-pressed")).toBe(
      "false"
    )
    await wrapper.get('button[aria-label="Zoom piano roll time in"]').trigger("click")
    expect(pianoRoll.pixelsPerQuarter).toBe(150)
    await wrapper.get("button.note").trigger("click")
    expect(pianoRoll.selectedNoteKeys.has("clip-1:note-1")).toBe(true)

    const durationInput = wrapper.findAll<HTMLInputElement>(".inspector input")[2]!
    await durationInput.setValue("1")
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { startTick: 0, durationTicks: 1 } }]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("draws into the explicitly active clip on pointer release", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    pianoRoll.tool = "draw"
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001")

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const grid = wrapper.get<HTMLElement>(".grid")
    mockGridBounds(grid.element)
    await grid.trigger("pointerdown", { pointerId: 1, clientX: 150, clientY: 1_206 })
    expect(execute).not.toHaveBeenCalled()
    await grid.trigger("pointerup", { pointerId: 1, clientX: 150, clientY: 1_206 })
    await flushPromises()

    const command = execute.mock.calls[0]?.[0]
    expect(command?.type).toBe("create-midi-notes")
    if (command?.type === "create-midi-notes") {
      expect(command.clipId).toBe("clip-1")
      expect(command.notes[0]).toMatchObject({
        id: "00000000-0000-4000-8000-000000000001",
        durationTicks: 240,
        key: 60
      })
    }

    wrapper.unmount()
  })

  it("sizes drawn notes by dragging with a live preview", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    pianoRoll.tool = "draw"
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const grid = wrapper.get<HTMLElement>(".grid")
    mockGridBounds(grid.element)
    await grid.trigger("pointerdown", { pointerId: 1, clientX: 150, clientY: 1_206 })
    await grid.trigger("pointermove", { pointerId: 1, clientX: 210, clientY: 1_206 })

    const preview = wrapper.get<HTMLElement>(".create-preview")
    expect(preview.element.style.left).toBe("150px")
    expect(preview.element.style.width).toBe("60px")
    expect(execute).not.toHaveBeenCalled()

    await grid.trigger("pointerup", { pointerId: 1, clientX: 210, clientY: 1_206 })
    await flushPromises()

    const command = execute.mock.calls[0]?.[0]
    expect(command?.type).toBe("create-midi-notes")
    if (command?.type === "create-midi-notes") {
      expect(command.notes[0]).toMatchObject({ startTick: 240, durationTicks: 480, key: 60 })
    }

    wrapper.unmount()
  })

  it("selects notes with a marquee and clears selection on plain grid clicks", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const grid = wrapper.get<HTMLElement>(".grid")
    mockGridBounds(grid.element)

    await grid.trigger("pointerdown", { pointerId: 1, clientX: 100, clientY: 1_200 })
    await grid.trigger("pointermove", { pointerId: 1, clientX: 160, clientY: 1_230 })

    expect(wrapper.find(".marquee").exists()).toBe(true)
    expect(pianoRoll.selectedNoteKeys.has("clip-1:note-1")).toBe(true)

    await grid.trigger("pointerup", { pointerId: 1, clientX: 160, clientY: 1_230 })
    expect(pianoRoll.selectedNoteKeys.has("clip-1:note-1")).toBe(true)

    await grid.trigger("pointerdown", { pointerId: 2, clientX: 400, clientY: 400 })
    await grid.trigger("pointerup", { pointerId: 2, clientX: 400, clientY: 400 })
    expect(pianoRoll.selectedNotes).toHaveLength(0)

    wrapper.unmount()
  })

  it("erases notes with the erase tool by dragging across them", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    pianoRoll.tool = "erase"
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const grid = wrapper.get<HTMLElement>(".grid")
    mockGridBounds(grid.element)
    const note = wrapper.get<HTMLElement>("button.note")

    await grid.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 400 })
    await note.trigger("pointerover")
    expect(note.classes()).toContain("erasing")
    expect(execute).not.toHaveBeenCalled()

    window.dispatchEvent(new Event("pointerup"))
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "delete-midi-notes",
      clipId: "clip-1",
      noteIds: ["note-1"]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("duplicates, octave-transposes, and quantizes the selection from the keyboard", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    const offGridGraph: MixerGraphSnapshot = {
      ...graph,
      midiClips: [
        {
          ...graph.midiClips[0]!,
          notes: [{ ...graph.midiClips[0]!.notes[0]!, startTick: 100 }]
        }
      ]
    }
    mixer.hydrate(offGridGraph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002")

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    await wrapper.get("button.note").trigger("click")

    await wrapper.trigger("keydown", { code: "KeyD", ctrlKey: true })
    await flushPromises()
    const duplicate = execute.mock.calls[0]?.[0]
    expect(duplicate?.type).toBe("create-midi-notes")
    if (duplicate?.type === "create-midi-notes") {
      expect(duplicate.notes[0]).toMatchObject({
        id: "00000000-0000-4000-8000-000000000002",
        startTick: 340,
        durationTicks: 240,
        key: 60
      })
    }

    execute.mockClear()
    // Selection moved to the (mocked) duplicated notes; re-select the real note.
    await wrapper.get("button.note").trigger("click")
    await wrapper.trigger("keydown", { code: "ArrowUp", shiftKey: true })
    await flushPromises()
    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { key: 72, startTick: 100, durationTicks: 240 } }]
    } satisfies ProjectCommand)

    execute.mockClear()
    await wrapper.trigger("keydown", { code: "KeyQ" })
    await flushPromises()
    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { startTick: 0, durationTicks: 240 } }]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("zooms keys from the toolbar and zooms at the pointer with ctrl+wheel", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })

    await wrapper.get('button[aria-label="Zoom piano roll keys in"]').trigger("click")
    expect(pianoRoll.rowHeight).toBe(20)
    await wrapper.get('button[aria-label="Zoom piano roll keys out"]').trigger("click")
    expect(pianoRoll.rowHeight).toBe(18)

    const viewport = wrapper.get<HTMLElement>('[aria-label="Piano roll note grid"]')
    vi.spyOn(viewport.element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      width: 800,
      height: 400,
      toJSON: () => ({})
    })
    let scrollLeft = 0
    let scrollTop = 0
    Object.defineProperty(viewport.element, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      }
    })
    Object.defineProperty(viewport.element, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    })

    await viewport.trigger("wheel", { ctrlKey: true, deltaY: -1, clientX: 272, clientY: 100 })
    expect(pianoRoll.pixelsPerQuarter).toBe(150)
    // The tick under the pointer (1600) stays put: 1600 * (0.15625 - 0.125) = 50.
    expect(scrollLeft).toBe(50)

    await viewport.trigger("wheel", {
      ctrlKey: true,
      altKey: true,
      deltaY: -1,
      clientX: 272,
      clientY: 100
    })
    expect(pianoRoll.rowHeight).toBe(20)
    // The row under the pointer ((100 - 28) / 18 = 4) stays put: 4 * 2 = 8.
    expect(scrollTop).toBe(8)

    wrapper.unmount()
  })

  it("quantizes from the inspector panel button", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    const offGridGraph: MixerGraphSnapshot = {
      ...graph,
      midiClips: [
        {
          ...graph.midiClips[0]!,
          notes: [{ ...graph.midiClips[0]!.notes[0]!, startTick: 100 }]
        }
      ]
    }
    mixer.hydrate(offGridGraph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)

    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const quantize = wrapper.get<HTMLButtonElement>(
      'button[aria-label="Quantize selected note starts to the snap grid"]'
    )
    expect(quantize.element.disabled).toBe(true)

    await wrapper.get("button.note").trigger("click")
    expect(quantize.element.disabled).toBe(false)
    await quantize.trigger("click")
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { startTick: 0, durationTicks: 240 } }]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })

  it("previews note movement and resizing before committing on pointer release", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixer = useMixerStore()
    mixer.hydrate(graph)
    const pianoRoll = usePianoRollStore()
    pianoRoll.selectArrangementClip("clip-1")
    pianoRoll.openSelection("clip-1")
    const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
    const wrapper = mount(PianoRollDock, { global: { plugins: [pinia] } })
    const note = wrapper.get<HTMLElement>("button.note")

    await note.trigger("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 })
    await note.trigger("pointermove", { pointerId: 1, clientX: 130, clientY: 82 })

    expect(note.element.style.left).toBe("150px")
    expect(note.element.style.top).toBe("1189px")
    expect(note.classes()).toContain("previewing")
    expect(execute).not.toHaveBeenCalled()

    await note.trigger("pointerup", { pointerId: 1, clientX: 130, clientY: 82 })
    await flushPromises()
    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [
        {
          noteId: "note-1",
          patch: { key: 61, startTick: 240, durationTicks: 240 }
        }
      ]
    } satisfies ProjectCommand)

    execute.mockClear()
    const rightHandle = wrapper.get<HTMLElement>(".resize-handle.right")
    await rightHandle.trigger("pointerdown", { pointerId: 2, clientX: 100, clientY: 100 })
    await rightHandle.trigger("pointermove", { pointerId: 2, clientX: 130, clientY: 100 })

    expect(note.element.style.width).toBe("60px")
    expect(execute).not.toHaveBeenCalled()

    await rightHandle.trigger("pointerup", { pointerId: 2, clientX: 130, clientY: 100 })
    await flushPromises()
    expect(execute).toHaveBeenCalledWith({
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { startTick: 0, durationTicks: 480 } }]
    } satisfies ProjectCommand)

    execute.mockClear()
    const leftHandle = wrapper.get<HTMLElement>(".resize-handle.left")
    const clipRange = wrapper.get<HTMLElement>(".clip-range")
    await leftHandle.trigger("pointerdown", { pointerId: 3, clientX: 100, clientY: 100 })
    await leftHandle.trigger("pointermove", { pointerId: 3, clientX: 70, clientY: 100 })

    expect(note.element.style.left).toBe("90px")
    expect(note.element.style.width).toBe("60px")
    expect(clipRange.element.style.left).toBe("90px")
    expect(clipRange.element.style.width).toBe("150px")
    expect(execute).not.toHaveBeenCalled()

    await leftHandle.trigger("pointerup", { pointerId: 3, clientX: 70, clientY: 100 })
    await flushPromises()
    expect(execute).toHaveBeenCalledWith({
      type: "batch",
      commands: [
        { type: "rebase-midi-clip-content", clipId: "clip-1", deltaTicks: 240 },
        {
          type: "update-midi-clip-range",
          clipId: "clip-1",
          patch: { startTick: 720, lengthTicks: 1_200, sourceOffsetTicks: 0 }
        },
        {
          type: "update-midi-notes",
          clipId: "clip-1",
          updates: [{ noteId: "note-1", patch: { startTick: 0, durationTicks: 480 } }]
        }
      ]
    } satisfies ProjectCommand)

    wrapper.unmount()
  })
})
