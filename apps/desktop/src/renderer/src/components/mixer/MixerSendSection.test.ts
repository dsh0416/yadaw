import { afterEach, describe, expect, it } from "vitest"
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import type { MixerBusState, MixerChannelState, MixerSendState } from "@heron/contracts"
import { UiCascadingSelect, UiRotaryControl } from "@heron/ui"
import MixerSendSection from "./MixerSendSection.vue"

const channel: MixerChannelState = {
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
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const bus: MixerBusState = {
  channel: 7,
  name: "BUS 7"
}

const output: MixerChannelState = {
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

const send: MixerSendState = {
  id: "send",
  sourceChannelId: "audio",
  targetBus: 7,
  sortOrder: 0,
  enabled: true,
  tap: "post",
  levelDb: -12
}

// Send menus teleport into `document.body`, so wrappers must unmount between tests.
enableAutoUnmount(afterEach)

describe("MixerSendSection", () => {
  it("edits all three send positions and parameter gestures from the compact row", async () => {
    const wrapper = mount(MixerSendSection, {
      attachTo: document.body,
      props: {
        channel,
        sends: [send],
        buses: [bus],
        outputs: [output],
        sendTargets: [{ kind: "output", channelId: "output" }],
        slotRows: 1
      }
    })

    expect(wrapper.get(".send-row").classes()).toContain("tap-post")
    expect(wrapper.get('button[aria-label="Edit send to BUS 7"]').text()).toBe("BUS 7")
    expect(wrapper.text()).not.toContain("EMPTY SEND")
    expect(wrapper.find('button[aria-label="Add send in empty slot"]').exists()).toBe(false)
    expect(wrapper.findAll(".send-row.alignment-spacer")).toHaveLength(0)

    const level = wrapper.get('input[aria-label="BUS 7 send level"]')
    await level.setValue("-6")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "send",
      id: "send",
      parameter: "levelDb",
      value: -6
    })
    expect(wrapper.emitted("updateSend")?.at(-1)).toEqual(["send", { levelDb: -6 }])

    await wrapper.get('button[aria-label="Edit send to BUS 7"]').trigger("click")
    await flushPromises()

    const tapButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".tap-options button")
    )
    const enabledToggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Disable send"]'
    )
    expect(enabledToggle?.getAttribute("aria-pressed")).toBe("true")
    expect(tapButtons.map((button) => button.textContent?.trim())).toEqual(["PRE", "POST", "PAN"])
    await new DOMWrapper(tapButtons[2]).trigger("click")
    expect(wrapper.emitted("updateSend")?.at(-1)).toEqual(["send", { tap: "post-pan" }])

    expect(document.body.querySelector('[aria-label="Send pan"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Send level"]')).toBeNull()

    const destination = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Send target"]'
    )
    expect(destination?.textContent?.trim()).toBe("BUS 7")
    expect(document.body.querySelector('select[aria-label="Send target"]')).toBeNull()
    await new DOMWrapper(destination).trigger("click")
    await flushPromises()
    const destinationGroups = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__sub-trigger")
    )
    expect(destinationGroups.map((button) => button.textContent?.trim())).toEqual([
      "Buses",
      "Outputs"
    ])
    await new DOMWrapper(destinationGroups[1]).trigger("keydown", { key: "ArrowRight" })
    await flushPromises()
    const outputOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__item")
    ).find((button) => button.textContent?.trim() === "Output 1–2")
    await new DOMWrapper(outputOption).trigger("click")
    expect(wrapper.emitted("updateSend")?.at(-1)).toEqual([
      "send",
      { targetChannelId: "output", targetBus: null }
    ])
  })

  it("uses Logic position and a stronger ring without redundant row labels", async () => {
    const wrapper = mount(MixerSendSection, {
      props: {
        channel,
        sends: [{ ...send, tap: "pre" }],
        buses: [bus],
        outputs: [output],
        sendTargets: [],
        slotRows: 1
      }
    })

    expect(wrapper.get(".send-row").classes()).toContain("tap-pre")
    expect(wrapper.get(".send-row").attributes("data-tap")).toBe("pre")
    expect(wrapper.get(".send-config").text()).toBe("BUS 7")
    expect(wrapper.find(".send-config i").exists()).toBe(false)
    expect(wrapper.find(".send-config b").exists()).toBe(false)
    expect(wrapper.get(".send-level").attributes("style")).toContain("--rotary-control-accent")
    expect(wrapper.get(".send-level").attributes("style")).toContain("--ui-color-action")
    expect(wrapper.get(".send-level").classes()).toContain("ui-rotary-control--ring-emphasized")
    expect(wrapper.getComponent(UiRotaryControl).props("dragRangePixels")).toBe(180)

    await wrapper.setProps({ sends: [{ ...send, tap: "post-pan" }] })
    expect(wrapper.get(".send-row").classes()).toContain("tap-post-pan")
    expect(wrapper.get(".send-config").text()).toBe("BUS 7")
    expect(wrapper.get(".send-level").attributes("style")).toContain("--ui-signal-meter-safe")
  })

  it("adds a send from available BUS and Output targets", async () => {
    const wrapper = mount(MixerSendSection, {
      attachTo: document.body,
      props: {
        channel,
        sends: [],
        buses: [bus],
        outputs: [output],
        sendTargets: [
          { kind: "bus", bus: 7 },
          { kind: "output", channelId: "output" }
        ],
        slotRows: 1
      }
    })

    expect(wrapper.findAll(".send-row.empty")).toHaveLength(1)
    expect(wrapper.find(".send-row.alignment-spacer").exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Add send"]').exists()).toBe(false)
    expect(wrapper.get('button[aria-label="Add send in empty slot"]').text()).toBe("")
    expect(wrapper.getComponent(UiCascadingSelect).props("hoverTreatment")).toBe("host-tint")

    await wrapper.get('button[aria-label="Add send in empty slot"]').trigger("click")
    await flushPromises()
    const routeGroups = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__sub-trigger")
    )
    expect(routeGroups.map((button) => button.textContent?.trim())).toEqual(["Buses", "Outputs"])

    await new DOMWrapper(routeGroups[0]).trigger("keydown", { key: "ArrowRight" })
    await flushPromises()
    const busOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__item")
    ).find((button) => button.textContent?.trim() === "BUS 7")
    await new DOMWrapper(busOption).trigger("click")
    expect(wrapper.emitted("addSend")?.at(-1)).toEqual([{ kind: "bus", bus: 7 }])

    await wrapper.get('button[aria-label="Add send in empty slot"]').trigger("click")
    await flushPromises()
    const outputGroup = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__sub-trigger")
    ).find((button) => button.textContent?.trim() === "Outputs")
    await new DOMWrapper(outputGroup).trigger("keydown", { key: "ArrowRight" })
    await flushPromises()
    const outputOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(".ui-cascading-select__item")
    ).find((button) => button.textContent?.trim() === "Output 1–2")
    await new DOMWrapper(outputOption).trigger("click")
    expect(wrapper.emitted("addSend")?.at(-1)).toEqual([{ kind: "output", channelId: "output" }])
  })
})
