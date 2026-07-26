import { afterEach, describe, expect, it } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import type { MixerChannelState } from "@yadaw/contracts"
import MixerInputSection from "./MixerInputSection.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  name: "Audio 1",
  color: "#4F8CFF",
  sortOrder: 0,
  inputFormat: "stereo",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputChannels: [1, 2],
  hardwareOutputChannels: []
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerInputSection", () => {
  it("keeps portalled routing content inside the shared popover surface", async () => {
    const wrapper = mount(MixerInputSection, {
      attachTo: document.body,
      props: { channel }
    })

    await wrapper.get('button[aria-label="Audio 1 input routing"]').trigger("click")
    await flushPromises()

    const layer = document.body.querySelector<HTMLElement>(".ui-popover")
    const popover = document.body.querySelector<HTMLElement>(".input-popover")
    expect(layer).not.toBeNull()
    expect(popover).not.toBeNull()
    expect(layer!.contains(popover)).toBe(true)
    expect(popover!.getAttributeNames().some((name) => name.startsWith("data-v-"))).toBe(true)
  })
})
