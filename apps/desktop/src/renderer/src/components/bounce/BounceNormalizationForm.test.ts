import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import BounceNormalizationForm from "./BounceNormalizationForm.vue"

vi.mock("@heron/ui", () => ({
  UiSelect: {
    props: ["modelValue", "options"],
    emits: ["update:modelValue"],
    template: `
      <select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)">
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    `
  },
  UiNumberInput: {
    props: ["modelValue", "min", "max", "step"],
    emits: ["update:modelValue"],
    template: `
      <input
        type="number"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:modelValue', Number($event.target.value))"
      />
    `
  }
}))

describe("BounceNormalizationForm", () => {
  it("maps every normalization choice to its typed settings", async () => {
    const wrapper = mount(BounceNormalizationForm, {
      props: { modelValue: { mode: "overload-protection" } }
    })
    const mode = wrapper.get("select")

    await mode.setValue("true-peak")
    await mode.setValue("off")
    await mode.setValue("overload-protection")

    expect(wrapper.emitted("update:modelValue")).toEqual([
      [{ mode: "true-peak", targetDbtp: -1 }],
      [{ mode: "off" }],
      [{ mode: "overload-protection" }]
    ])
  })

  it("emits an edited true-peak target", async () => {
    const wrapper = mount(BounceNormalizationForm, {
      props: { modelValue: { mode: "true-peak", targetDbtp: -1 } }
    })

    await wrapper.get('input[type="number"]').setValue("-3.5")

    expect(wrapper.emitted("update:modelValue")).toEqual([
      [{ mode: "true-peak", targetDbtp: -3.5 }]
    ])
  })
})
