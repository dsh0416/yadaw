import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import UiButton from "./UiButton.vue"
import UiCheckbox from "./UiCheckbox.vue"
import UiField from "./UiField.vue"
import UiProgress from "./UiProgress.vue"
import UiStatusNotice from "./UiStatusNotice.vue"
import UiTextInput from "./UiTextInput.vue"

describe("UI controls", () => {
  it("disables a loading button and exposes its busy state", () => {
    const wrapper = mount(UiButton, {
      props: { loading: true },
      slots: { default: "Save project" }
    })

    const button = wrapper.get("button")
    expect(button.attributes("disabled")).toBeDefined()
    expect(button.attributes("aria-busy")).toBe("true")
    expect(button.text()).toContain("Save project")
  })

  it("forwards input attributes and updates v-model", async () => {
    const wrapper = mount(UiTextInput, {
      props: {
        modelValue: "Initial",
        "onUpdate:modelValue": (value: string) => wrapper.setProps({ modelValue: value })
      },
      attrs: {
        name: "project-name",
        autocomplete: "off"
      }
    })

    await wrapper.get("input").setValue("Renamed")
    expect(wrapper.props("modelValue")).toBe("Renamed")
    expect(wrapper.get("input").attributes("name")).toBe("project-name")
  })

  it("updates checkbox v-model from a user interaction", async () => {
    const wrapper = mount(UiCheckbox, {
      props: { label: "Enable monitoring", modelValue: false }
    })

    await wrapper.get("input").setValue(true)
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]])
  })
})

describe("UI feedback semantics", () => {
  it("connects field help and error text through exposed slot ids", () => {
    const wrapper = mount(UiField, {
      props: {
        label: "Project name",
        description: "Shown in recent projects.",
        error: "A project name is required."
      },
      slots: {
        default: `
          <template #default="{ controlId, descriptionId, errorId }">
            <input :id="controlId" :aria-describedby="[descriptionId, errorId].filter(Boolean).join(' ')" />
          </template>
        `
      }
    })

    const input = wrapper.get("input")
    expect(wrapper.get("label").attributes("for")).toBe(input.attributes("id"))
    expect(input.attributes("aria-describedby")).toContain("-description")
    expect(input.attributes("aria-describedby")).toContain("-error")
    expect(wrapper.get('[role="alert"]').text()).toContain("required")
  })

  it("distinguishes determinate from indeterminate progress", async () => {
    const wrapper = mount(UiProgress, {
      props: { label: "Rendering stems", value: 25, max: 100 }
    })

    expect(wrapper.attributes("aria-valuenow")).toBe("25")
    await wrapper.setProps({ value: null })
    expect(wrapper.attributes("aria-valuenow")).toBeUndefined()
  })

  it("uses a live region only when requested", () => {
    const wrapper = mount(UiStatusNotice, {
      props: { tone: "danger", live: "assertive" },
      slots: { default: "Audio device disconnected." }
    })

    expect(wrapper.attributes("role")).toBe("alert")
    expect(wrapper.attributes("aria-live")).toBe("assertive")
  })
})
