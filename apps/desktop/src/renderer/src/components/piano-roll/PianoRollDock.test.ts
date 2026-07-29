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

  it("draws into the explicitly active clip", async () => {
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
    vi.spyOn(grid.element, "getBoundingClientRect").mockReturnValue({
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
    await grid.trigger("pointerdown", { clientX: 150, clientY: 1_206 })
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
})
