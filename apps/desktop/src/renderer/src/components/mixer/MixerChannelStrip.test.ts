import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { MixerChannelState, PluginDescriptor, PluginInstanceState } from "@heron/contracts"
import MixerChannelStrip from "./MixerChannelStrip.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  systemRole: null,
  name: "Vocal",
  color: "#8C83FF",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

describe("MixerChannelStrip", () => {
  it("exposes accessible controls and emits preview/commit gestures", async () => {
    const wrapper = mount(MixerChannelStrip, {
      attachTo: document.body,
      props: {
        channel,
        sends: [],
        meter: {
          channelId: "audio",
          preFaderPeak: [0.25, 0.25],
          postFaderPeak: [0.5, 0.5],
          heldPeak: [0.75, 0.75],
          clipped: false
        },
        outputs: [
          {
            ...channel,
            id: "output",
            kind: "output",
            name: "Output 1–2",
            inputSource: null,
            inputFormat: null,
            outputChannelId: null,
            inputChannels: [],
            hardwareOutputChannels: [1, 2]
          }
        ],
        buses: [],
        outputTargets: [{ kind: "output", channelId: "output" }],
        sendTargets: [],
        plugins: [],
        pluginRuntime: {},
        effectPlugins: [],
        instrumentPlugins: [],
        pluginSlotRows: 4,
        sendSlotRows: 2,
        selected: false
      },
      global: { plugins: [createPinia()] }
    })

    const volume = wrapper.get('input[aria-label="Vocal volume"]')
    Object.defineProperty(volume.element, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        right: 20,
        bottom: 100,
        left: 0,
        width: 20,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })
    const trackPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 80
    })
    expect(volume.element.dispatchEvent(trackPointer)).toBe(false)
    const thumbPointer = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY: 18
    })
    expect(volume.element.dispatchEvent(thumbPointer)).toBe(true)

    await volume.setValue("-6")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -6
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: -6 }])

    const commitsBeforeCancel = wrapper.emitted("updateChannel")?.length ?? 0
    await volume.trigger("pointerdown")
    ;(volume.element as HTMLInputElement).value = "-18"
    await volume.trigger("input")
    await volume.trigger("keydown", { key: "Escape" })
    await volume.trigger("change")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({ value: 0 })
    expect(wrapper.emitted("updateChannel")?.length).toBe(commitsBeforeCancel)

    await volume.trigger("dblclick")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: 0 }])

    const gainReadout = wrapper.get('button[aria-label="Vocal volume value in decibels"]')
    expect(gainReadout.text()).toBe("0.0")
    await gainReadout.trigger("dblclick")
    const gainEditor = wrapper.get('input[aria-label="Vocal volume value in decibels"]')
    ;(gainEditor.element as HTMLInputElement).value = "-3.5"
    await gainEditor.trigger("input")
    await wrapper.setProps({
      meter: {
        ...wrapper.props("meter"),
        postFaderPeak: [0.4, 0.4]
      }
    })
    expect((gainEditor.element as HTMLInputElement).value).toBe("-3.5")
    await gainEditor.trigger("change")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -3.5
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { gainDb: -3.5 }])
    const meterReadout = wrapper.get(
      'button[aria-label="Vocal latched maximum post-fader level in decibels"]'
    )
    expect(meterReadout.text()).toBe("-6.0")
    await meterReadout.trigger("click")
    expect(meterReadout.text()).toBe("−∞")
    expect(wrapper.emitted("resetMeterClips")).toHaveLength(1)

    const pan = wrapper.get('input[aria-label="Vocal pan"]')
    await pan.setValue("-32")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "pan",
      value: -0.5
    })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: -0.5 }])

    await pan.setValue("63")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: 1 }])

    expect(wrapper.find('input[aria-label="Vocal pan value"]').exists()).toBe(false)
    await wrapper.setProps({ channel: { ...channel, pan: 1 } })
    expect(wrapper.find(".pan-readout").exists()).toBe(false)
    await pan.trigger("dblclick")
    const panEditor = wrapper.get('input[aria-label="Vocal pan value"]')
    expect((panEditor.element as HTMLInputElement).value).toBe("63")
    await panEditor.setValue("-64")
    await panEditor.trigger("blur")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { pan: -1 }])

    await wrapper.get('button[aria-label="Mute Vocal"]').trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { muted: true }])
    expect(wrapper.get('button[aria-label="Arm Vocal"]').attributes("aria-pressed")).toBe("false")
    expect(wrapper.get('button[aria-label="Monitor Vocal"]').attributes("disabled")).toBeUndefined()
    expect(wrapper.find(".pan-heading").exists()).toBe(false)
    expect(
      wrapper.findAll("[data-section]").map((section) => section.attributes("data-section"))
    ).toEqual([
      "input",
      "plugins",
      "sends",
      "output",
      "group",
      "automation",
      "pan",
      "volume",
      "name"
    ])
    expect(wrapper.findAll(".fader-scale .db-scale-mark").map((mark) => mark.text())).toEqual([
      "+12",
      "0",
      "−12",
      "−30",
      "−60",
      "−∞"
    ])
    expect(wrapper.findAll(".meter-scale .db-scale-mark").map((mark) => mark.text())).toEqual([
      "0",
      "−6",
      "−12",
      "−24",
      "−48",
      "−∞"
    ])

    await wrapper
      .get('button[aria-label="Vocal channel name; double-click to rename"]')
      .trigger("dblclick")
    const nameEditor = wrapper.get('input[aria-label="Rename Vocal"]')
    expect(document.activeElement).toBe(nameEditor.element)
    await nameEditor.setValue("  Lead Vocal  ")
    await nameEditor.trigger("keydown", { key: "Enter" })
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { name: "Lead Vocal" }])
  })

  it("uses the conventional M/S/R/I action roles", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useApplicationSettingsStore().settings = {
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: true,
      midiSync: {
        enabled: false,
        sourcePortId: null,
        sourcePortName: null,
        inputOffsetsMs: {}
      },
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      pluginEditors: {},
      shortcuts: { keyboard: {}, midi: {} },
      recentProjects: []
    }
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel: {
          ...channel,
          muted: true,
          soloed: true,
          recordArmed: true,
          inputMonitoring: true
        },
        sends: [],
        meter: {
          channelId: "audio",
          preFaderPeak: [0, 0],
          postFaderPeak: [0, 0],
          heldPeak: [0, 0],
          clipped: false
        },
        outputs: [],
        buses: [],
        outputTargets: [],
        sendTargets: [],
        plugins: [],
        pluginRuntime: {},
        effectPlugins: [],
        instrumentPlugins: [],
        pluginSlotRows: 4,
        sendSlotRows: 2,
        selected: true
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('button[aria-label="Mute Vocal"]').classes()).toContain("mute")
    expect(wrapper.get('button[aria-label="Mute Vocal"]').classes()).toContain("active")
    expect(wrapper.get('button[aria-label="Solo Vocal"]').classes()).toContain("solo")
    expect(wrapper.get('button[aria-label="Solo Vocal"]').classes()).toContain("active")
    expect(wrapper.get('button[aria-label="Arm Vocal"]').classes()).toContain("record")
    expect(wrapper.get('button[aria-label="Arm Vocal"]').classes()).toContain("active")
    const monitor = wrapper.get('button[aria-label="Monitor Vocal"]')
    expect(monitor.classes()).toContain("monitor")
    expect(monitor.classes()).toContain("active")
    expect(monitor.attributes("disabled")).toBeUndefined()
    await monitor.trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual(["audio", { inputMonitoring: false }])
    expect(wrapper.get(".input-actions").findAll("button")).toHaveLength(2)
  })

  it("keeps application input monitoring configurable when global software monitoring is off", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useApplicationSettingsStore().settings = {
      swapDirectory: "C:/swap",
      recordingBitDepth: "float32",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      midiSync: {
        enabled: false,
        sourcePortId: null,
        sourcePortName: null,
        inputOffsetsMs: {}
      },
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto"
      },
      pluginEditors: {},
      shortcuts: { keyboard: {}, midi: {} },
      recentProjects: []
    }
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel: {
          ...channel,
          inputSource: "application",
          inputFormat: "stereo",
          inputChannels: [1, 2],
          applicationCapture: {
            platform: "windows",
            executablePath: "C:\\Program Files\\Steam\\steam.exe",
            executableName: "steam.exe",
            includeProcessTree: true
          }
        },
        sends: [],
        meter: {
          channelId: "audio",
          preFaderPeak: [0, 0],
          postFaderPeak: [0, 0],
          heldPeak: [0, 0],
          clipped: false
        },
        outputs: [],
        buses: [],
        outputTargets: [],
        sendTargets: [],
        plugins: [],
        pluginRuntime: {},
        effectPlugins: [],
        instrumentPlugins: [],
        pluginSlotRows: 4,
        sendSlotRows: 2,
        selected: false
      },
      global: { plugins: [pinia] }
    })

    const monitor = wrapper.get('button[aria-label="Monitor Vocal"]')
    expect(monitor.attributes("disabled")).toBeUndefined()
    await monitor.trigger("click")
    expect(wrapper.emitted("updateChannel")?.at(-1)).toEqual([
      "audio",
      {
        inputMonitoring: true,
        applicationCapture: {
          platform: "windows",
          executablePath: "C:\\Program Files\\Steam\\steam.exe",
          executableName: "steam.exe",
          includeProcessTree: true
        }
      }
    ])
  })

  it("keeps Master outside explicit routing and send controls", () => {
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel: {
          ...channel,
          id: "master",
          kind: "master",
          name: "Master",
          inputSource: null,
          inputFormat: null,
          outputChannelId: null,
          inputChannels: []
        },
        sends: [],
        meter: {
          channelId: "master",
          preFaderPeak: [0, 0],
          postFaderPeak: [0, 0],
          heldPeak: [0, 0],
          clipped: false
        },
        outputs: [],
        buses: [],
        outputTargets: [],
        sendTargets: [],
        plugins: [],
        pluginRuntime: {},
        effectPlugins: [],
        instrumentPlugins: [],
        pluginSlotRows: 4,
        sendSlotRows: 2,
        selected: false
      },
      global: { plugins: [createPinia()] }
    })

    expect(wrapper.text()).toContain("GLOBAL")
    expect(wrapper.find('select[aria-label="Master output"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Solo Master"]').exists()).toBe(false)
  })

  it("places an instrument in Input while keeping Audio FX rows aligned", () => {
    const instrumentDescriptor: PluginDescriptor = {
      source: { kind: "external" },
      classId: "synth",
      modulePath: "synth.vst3",
      name: "Synth",
      vendor: "Heron Studio",
      version: "1.0",
      categories: ["Instrument"],
      kind: "instrument",
      architecture: "x86_64",
      buses: [],
      supportedAudioModes: ["mono", "stereo"],
      hasEditor: true,
      compatibility: "compatible",
      compatibilityReason: null
    }
    const instrument: PluginInstanceState = {
      id: "instrument-plugin",
      channelId: "instrument",
      role: "instrument",
      slotOrder: 0,
      classId: instrumentDescriptor.classId,
      descriptor: instrumentDescriptor,
      audioMode: "stereo",
      enabled: true,
      sidechainInputs: [],
      componentState: new Uint8Array(),
      controllerState: new Uint8Array()
    }
    const wrapper = mount(MixerChannelStrip, {
      props: {
        channel: {
          ...channel,
          id: "instrument",
          kind: "instrument",
          name: "Keys",
          inputSource: null,
          inputFormat: null,
          inputChannels: []
        },
        sends: [],
        meter: {
          channelId: "instrument",
          preFaderPeak: [0, 0],
          postFaderPeak: [0, 0],
          heldPeak: [0, 0],
          clipped: false
        },
        outputs: [],
        buses: [],
        outputTargets: [],
        sendTargets: [],
        plugins: [instrument],
        pluginRuntime: {},
        effectPlugins: [],
        instrumentPlugins: [instrumentDescriptor],
        pluginSlotRows: 2,
        sendSlotRows: 2,
        selected: false
      },
      global: { plugins: [createPinia()] }
    })

    expect(wrapper.get('[data-section="input"]').text()).toContain("Synth")
    expect(wrapper.get('[data-section="input"]').text()).not.toContain("MIDI")
    expect(wrapper.get('[data-section="plugins"]').text()).not.toContain("Synth")
    expect(wrapper.get('[data-section="plugins"]').findAll(".plugin-row")).toHaveLength(2)
  })
})
