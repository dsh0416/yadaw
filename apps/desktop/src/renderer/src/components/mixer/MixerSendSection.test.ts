import { afterEach, describe, expect, it } from "vitest"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import type { MixerChannelState, MixerSendState } from "@yadaw/contracts"
import MixerSendSection from "./MixerSendSection.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  name: "Vocal",
  color: "#4F8CFF",
  sortOrder: 0,
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const bus: MixerChannelState = {
  ...channel,
  id: "reverb",
  kind: "bus",
  name: "Reverb",
  inputFormat: null,
  inputChannels: []
}

const send: MixerSendState = {
  id: "send",
  sourceChannelId: "audio",
  targetChannelId: "reverb",
  sortOrder: 0,
  enabled: true,
  tap: "post",
  levelDb: -12
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerSendSection", () => {
  it("edits all three send positions and parameter gestures from the compact row", async () => {
    const wrapper = mount(MixerSendSection, {
      attachTo: document.body,
      props: {
        channel,
        sends: [send],
        buses: [bus],
        sendTargets: [],
        slotRows: 2
      }
    })

    expect(wrapper.get('button[aria-label="Edit send to Reverb"]').text()).toContain("POST")
    expect(wrapper.text()).not.toContain("EMPTY SEND")
    expect(wrapper.find('button[aria-label="Add send in empty slot"]').exists()).toBe(false)
    expect(wrapper.findAll(".send-row.alignment-spacer")).toHaveLength(1)
    await wrapper.get('button[aria-label="Edit send to Reverb"]').trigger("click")
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

    const level = new DOMWrapper(
      document.body.querySelector<HTMLInputElement>('input[aria-label="Send level"]')
    )
    expect(document.body.querySelector('[aria-label="Send pan"]')).toBeNull()
    await level.setValue("-6")
    expect(wrapper.emitted("preview")?.at(-1)?.[0]).toMatchObject({
      target: "send",
      id: "send",
      parameter: "levelDb",
      value: -6
    })
    expect(wrapper.emitted("updateSend")?.at(-1)).toEqual(["send", { levelDb: -6 }])
  })

  it("adds a send from available bus targets", async () => {
    const wrapper = mount(MixerSendSection, {
      attachTo: document.body,
      props: {
        channel,
        sends: [],
        buses: [bus],
        sendTargets: [bus],
        slotRows: 1
      }
    })

    expect(wrapper.findAll(".send-row.empty")).toHaveLength(1)
    expect(wrapper.find(".send-row.alignment-spacer").exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Add send"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="Add send in empty slot"]').trigger("click")
    await flushPromises()
    const addButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add"
    )
    await new DOMWrapper(addButton).trigger("click")
    expect(wrapper.emitted("addSend")?.at(-1)).toEqual(["reverb"])
  })
})
