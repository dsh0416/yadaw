import { enableAutoUnmount, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot } from "@heron/contracts"
import { useMidiInputStore } from "../../stores/midiInput"
import { useMixerStore } from "../../stores/mixer"
import TrackInspector from "./TrackInspector.vue"

enableAutoUnmount(afterEach)

const graph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [
    { id: "track-audio", channelId: "audio", sortOrder: 0 },
    { id: "track-instrument", channelId: "instrument", sortOrder: 1 }
  ],
  channels: [
    {
      id: "audio",
      kind: "audio",
      systemRole: null,
      name: "Vocal",
      color: "#4F8CFF",
      sortOrder: 0,
      inputSource: "hardware",
      inputFormat: "mono",
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [1],
      hardwareOutputChannels: []
    },
    {
      id: "instrument",
      kind: "instrument",
      systemRole: null,
      name: "Keys",
      color: "#73D6A2",
      sortOrder: 1,
      inputSource: null,
      inputFormat: null,
      midiInput: { portId: "port-a", portName: "Keyboard", channel: null },
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      recordArmed: false,
      inputMonitoring: true,
      inputChannels: [],
      hardwareOutputChannels: []
    },
    {
      id: "aux",
      kind: "aux",
      systemRole: null,
      name: "Reverb",
      color: "#E8B85F",
      sortOrder: 0,
      inputSource: "bus",
      inputFormat: "stereo",
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [1, 2],
      hardwareOutputChannels: []
    }
  ],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
}

let mixer: ReturnType<typeof useMixerStore>
let midiInput: ReturnType<typeof useMidiInputStore>

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  mixer = useMixerStore()
  midiInput = useMidiInputStore()
  mixer.hydrate(graph)
  midiInput.snapshot = {
    ...midiInput.snapshot,
    ports: [
      { id: "port-a", name: "Keyboard", connected: true },
      { id: "port-b", name: "Pads", connected: true }
    ]
  }
})

describe("TrackInspector", () => {
  it("commits trimmed names and colors through the selected track", async () => {
    mixer.selectedChannelId = "audio"
    const updateChannel = vi.spyOn(mixer, "updateChannel").mockResolvedValue(true)
    const wrapper = mount(TrackInspector)

    expect(wrapper.text()).toContain("Vocal")
    expect(wrapper.text()).toContain("Audio")

    const nameInput = wrapper.get('input:not([type="color"])')
    await nameInput.trigger("focus")
    await nameInput.setValue("  Lead Vocal  ")
    await nameInput.trigger("keydown", { key: "Enter" })
    await nameInput.trigger("focus")
    await nameInput.setValue("Vocal Take")
    await nameInput.trigger("blur")
    const colorInput = wrapper.get('input[type="color"]')
    await colorInput.setValue("#123456")

    expect(updateChannel).toHaveBeenNthCalledWith(1, "audio", { name: "Lead Vocal" })
    expect(updateChannel).toHaveBeenNthCalledWith(2, "audio", { name: "Vocal Take" })
    expect(updateChannel).toHaveBeenNthCalledWith(3, "audio", { color: "#123456" })
    expect(wrapper.find("select").exists()).toBe(false)
  })

  it("updates the MIDI input port and maps Omni and channels 1–16", async () => {
    mixer.selectedChannelId = "instrument"
    const updateChannel = vi.spyOn(mixer, "updateChannel").mockResolvedValue(true)
    const wrapper = mount(TrackInspector)
    const port = wrapper.get('select[aria-label="MIDI input port"]')
    const channel = wrapper.get('select[aria-label="MIDI input channel"]')

    expect(port.findAll("option")).toHaveLength(3)
    expect(channel.findAll("option")).toHaveLength(17)
    expect(channel.find("option").text()).toBe("Omni")
    await port.setValue("port-b")
    await channel.setValue("15")
    await channel.setValue("")

    expect(updateChannel).toHaveBeenNthCalledWith(1, "instrument", {
      midiInput: { portId: "port-b", portName: "Pads", channel: null }
    })
    expect(updateChannel).toHaveBeenNthCalledWith(2, "instrument", {
      midiInput: { portId: "port-a", portName: "Keyboard", channel: 15 }
    })
    expect(updateChannel).toHaveBeenNthCalledWith(3, "instrument", {
      midiInput: { portId: "port-a", portName: "Keyboard", channel: null }
    })
  })

  it("keeps a disconnected MIDI port visible in the inspector", () => {
    mixer.selectedChannelId = "instrument"
    const instrument = mixer.graph?.channels.find((channel) => channel.id === "instrument")
    if (instrument?.kind !== "instrument") throw new Error("Missing instrument fixture")
    instrument.midiInput = { portId: "gone", portName: "Stage Piano", channel: 0 }
    midiInput.snapshot = { ...midiInput.snapshot, ports: [] }

    const wrapper = mount(TrackInspector)

    expect(wrapper.get(".midi-port-control.missing").text()).toContain("Stage Piano — Missing")
    expect(wrapper.text()).toContain("The selected MIDI input is not connected.")
  })

  it("shows guidance when the selected channel is not a timeline track", async () => {
    mixer.selectedChannelId = "aux"
    const wrapper = mount(TrackInspector)

    expect(wrapper.text()).toContain("Select a track")
    expect(wrapper.find('input[type="color"]').exists()).toBe(false)

    mixer.selectedChannelId = "instrument"
    await nextTick()
    expect(wrapper.text()).toContain("Keys")
  })
})
