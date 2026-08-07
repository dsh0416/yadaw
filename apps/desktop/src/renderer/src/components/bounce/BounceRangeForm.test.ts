import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createI18n } from "vue-i18n"
import BounceRangeForm from "./BounceRangeForm.vue"

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      bounce: {
        sections: { range: "Range" },
        fields: {
          startBar: "Start bar",
          endBar: "End bar",
          includeTail: "Include plug-in tails"
        },
        rangeHelp: "Project ends at bar {maximum}.",
        tailHelp: "Render effect decay after the end bar."
      }
    }
  }
})

describe("BounceRangeForm", () => {
  it("emits the tail preference from its accessible checkbox", async () => {
    const wrapper = mount(BounceRangeForm, {
      props: { startBar: 1, endBar: 4, maximumBar: 8, includeTail: true },
      global: { plugins: [i18n] }
    })
    const checkbox = wrapper.get('input[type="checkbox"]')

    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain("Include plug-in tails")
    await checkbox.setValue(false)

    expect(wrapper.emitted("updateIncludeTail")).toEqual([[false]])
  })
})
