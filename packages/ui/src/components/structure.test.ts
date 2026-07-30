import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import { UI_DOMAIN_COLORS } from "../domainColors"
import UiButton from "./UiButton.vue"
import UiEmptyState from "./UiEmptyState.vue"
import UiLoadingState from "./UiLoadingState.vue"
import UiRadioGroup from "./UiRadioGroup.vue"
import UiSectionHeading from "./UiSectionHeading.vue"
import UiSelect from "./UiSelect.vue"
import UiSlider from "./UiSlider.vue"
import UiSpinner from "./UiSpinner.vue"
import UiStatusNotice from "./UiStatusNotice.vue"
import UiSurface from "./UiSurface.vue"
import UiToolbar from "./UiToolbar.vue"

describe("UiSurface", () => {
  it("renders a section with the default level and padding", () => {
    const wrapper = mount(UiSurface, { slots: { default: "Mixer" } })

    expect(wrapper.element.tagName).toBe("SECTION")
    expect(wrapper.classes()).toContain("ui-surface--base")
    expect(wrapper.classes()).toContain("ui-surface--padding-md")
    expect(wrapper.text()).toBe("Mixer")
  })

  it("honors the requested element, level, and padding", () => {
    const wrapper = mount(UiSurface, {
      props: { as: "aside", level: "raised", padding: "none" }
    })

    expect(wrapper.element.tagName).toBe("ASIDE")
    expect(wrapper.classes()).toContain("ui-surface--raised")
    expect(wrapper.classes()).toContain("ui-surface--padding-none")
  })
})

describe("UiSpinner", () => {
  it("announces a default loading label to screen readers", () => {
    const wrapper = mount(UiSpinner)

    expect(wrapper.attributes("role")).toBe("status")
    expect(wrapper.get(".ui-visually-hidden").text()).toBe("Loading")
    expect(wrapper.classes()).toContain("ui-spinner--md")
  })

  it("uses the supplied label and size", () => {
    const wrapper = mount(UiSpinner, { props: { label: "Scanning plug-ins", size: "lg" } })

    expect(wrapper.get(".ui-visually-hidden").text()).toBe("Scanning plug-ins")
    expect(wrapper.classes()).toContain("ui-spinner--lg")
  })

  it("hides the decorative ring from assistive technology", () => {
    const wrapper = mount(UiSpinner)

    expect(wrapper.get(".ui-spinner__ring").attributes("aria-hidden")).toBe("true")
  })
})

describe("UiEmptyState", () => {
  it("renders only the title when nothing else is supplied", () => {
    const wrapper = mount(UiEmptyState, { props: { title: "No projects yet" } })

    expect(wrapper.get("h2").text()).toBe("No projects yet")
    expect(wrapper.find("p").exists()).toBe(false)
    expect(wrapper.find(".ui-empty-state__icon").exists()).toBe(false)
    expect(wrapper.find(".ui-empty-state__actions").exists()).toBe(false)
  })

  it("renders the description, icon, and actions slots", () => {
    const wrapper = mount(UiEmptyState, {
      props: { title: "No projects yet", description: "Create one to get started." },
      slots: {
        icon: '<svg class="glyph" />',
        actions: '<button type="button">New project</button>'
      }
    })

    expect(wrapper.get("p").text()).toBe("Create one to get started.")
    expect(wrapper.get(".ui-empty-state__icon").attributes("aria-hidden")).toBe("true")
    expect(wrapper.find(".ui-empty-state__icon .glyph").exists()).toBe(true)
    expect(wrapper.get(".ui-empty-state__actions").text()).toBe("New project")
  })
})

describe("UiLoadingState", () => {
  it("shows a spinner while progress is unknown", () => {
    const wrapper = mount(UiLoadingState, { props: { title: "Scanning plug-ins" } })

    expect(wrapper.attributes("role")).toBe("status")
    expect(wrapper.attributes("aria-live")).toBe("polite")
    expect(wrapper.find(".ui-spinner").exists()).toBe(true)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.get("strong").text()).toBe("Scanning plug-ins")
  })

  it("swaps the spinner for a progress bar once a value is known", () => {
    const wrapper = mount(UiLoadingState, {
      props: { title: "Rendering stems", description: "12 of 48 clips", value: 25, max: 48 }
    })

    expect(wrapper.find(".ui-spinner").exists()).toBe(false)
    const progress = wrapper.get('[role="progressbar"]')
    expect(progress.attributes("aria-valuenow")).toBe("25")
    expect(progress.attributes("aria-valuemax")).toBe("48")
    expect(wrapper.get("p").text()).toBe("12 of 48 clips")
  })

  it("keeps the progress bar indeterminate for a null value", () => {
    const wrapper = mount(UiLoadingState, { props: { title: "Opening project", value: null } })

    expect(wrapper.find(".ui-spinner").exists()).toBe(false)
    expect(wrapper.get('[role="progressbar"]').attributes("aria-valuenow")).toBeUndefined()
  })
})

describe("UiSectionHeading", () => {
  it("renders a level 2 heading by default", () => {
    const wrapper = mount(UiSectionHeading, { props: { title: "Audio device" } })

    expect(wrapper.get(".ui-section-heading__title").element.tagName).toBe("H2")
    expect(wrapper.find(".ui-section-heading__description").exists()).toBe(false)
    expect(wrapper.find(".ui-section-heading__actions").exists()).toBe(false)
  })

  it("renders the requested heading level with a description and actions", () => {
    const wrapper = mount(UiSectionHeading, {
      props: { title: "Audio device", description: "Choose the interface.", level: 3 },
      slots: { actions: '<button type="button">Rescan</button>' }
    })

    expect(wrapper.get(".ui-section-heading__title").element.tagName).toBe("H3")
    expect(wrapper.get(".ui-section-heading__description").text()).toBe("Choose the interface.")
    expect(wrapper.get(".ui-section-heading__actions").text()).toBe("Rescan")
  })
})

describe("UiSlider", () => {
  it("exposes a labelled range bound to its numeric model", () => {
    const wrapper = mount(UiSlider, {
      props: { modelValue: 40, label: "Dry/wet", min: 0, max: 100, step: 5 }
    })

    const input = wrapper.get("input")
    expect(input.attributes("type")).toBe("range")
    expect(input.attributes("aria-label")).toBe("Dry/wet")
    expect(input.attributes("min")).toBe("0")
    expect(input.attributes("max")).toBe("100")
    expect(input.attributes("step")).toBe("5")
    expect((input.element as HTMLInputElement).value).toBe("40")
  })

  it("emits numbers rather than strings when dragged", async () => {
    const wrapper = mount(UiSlider, { props: { modelValue: 40, label: "Dry/wet" } })

    await wrapper.get("input").setValue("65")

    expect(wrapper.emitted("update:modelValue")).toEqual([[65]])
  })

  it("forwards fallthrough attributes and a spoken value", () => {
    const wrapper = mount(UiSlider, {
      props: { modelValue: 40, label: "Dry/wet", valueText: "40 percent" },
      attrs: { disabled: true, "data-testid": "dry-wet" }
    })

    const input = wrapper.get("input")
    expect(input.attributes("aria-valuetext")).toBe("40 percent")
    expect(input.attributes("disabled")).toBeDefined()
    expect(input.attributes("data-testid")).toBe("dry-wet")
  })
})

describe("UiRadioGroup", () => {
  const options = [
    { value: "mono", label: "Mono" },
    { value: "stereo", label: "Stereo", description: "Two channels" },
    { value: "surround", label: "Surround", disabled: true }
  ]

  it("labels the group and renders one radio per option", () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options }
    })

    expect(wrapper.element.tagName).toBe("FIELDSET")
    expect(wrapper.get("legend").text()).toBe("Channel format")
    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(3)
    expect(wrapper.get(".ui-radio-group__description").text()).toBe("Two channels")
    expect(wrapper.classes()).toContain("ui-radio-group--vertical")
  })

  it("groups the radios under one generated name so only one can be checked", () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options }
    })

    const names = wrapper.findAll("input").map((input) => input.attributes("name"))
    expect(new Set(names).size).toBe(1)
    expect(names[0]).toMatch(/^ui-radio-/)
  })

  it("uses an explicit name when one is provided", () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options, name: "format" }
    })

    expect(wrapper.get("input").attributes("name")).toBe("format")
  })

  it("checks the option matching the model and updates it on selection", async () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options }
    })

    const inputs = wrapper.findAll("input")
    expect((inputs[0]?.element as HTMLInputElement).checked).toBe(true)

    await inputs[1]?.setValue()
    expect(wrapper.emitted("update:modelValue")).toEqual([["stereo"]])
  })

  it("disables individual options and the whole group", () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options, orientation: "horizontal" }
    })

    expect(wrapper.findAll("input")[2]?.attributes("disabled")).toBeDefined()
    expect(wrapper.findAll(".ui-radio-group__option")[2]?.classes()).toContain(
      "ui-radio-group__option--disabled"
    )
    expect(wrapper.classes()).toContain("ui-radio-group--horizontal")
    expect(wrapper.attributes("disabled")).toBeUndefined()
  })

  it("disables every radio when the group is disabled", () => {
    const wrapper = mount(UiRadioGroup, {
      props: { modelValue: "mono", label: "Channel format", options, disabled: true }
    })

    expect(wrapper.attributes("disabled")).toBeDefined()
  })
})

describe("UiToolbar", () => {
  it("renders leading and trailing sections only when their slots are filled", () => {
    const bare = mount(UiToolbar, {
      props: { label: "Transport" },
      slots: { default: "<button type='button'>Play</button>" }
    })

    expect(bare.find(".ui-toolbar__section--start").exists()).toBe(false)
    expect(bare.find(".ui-toolbar__section--end").exists()).toBe(false)
    expect(bare.classes()).toContain("ui-toolbar--standard")

    const full = mount(UiToolbar, {
      props: { label: "Transport" },
      slots: {
        start: "<span>Left</span>",
        default: "<button type='button'>Play</button>",
        end: "<span>Right</span>"
      }
    })

    expect(full.get(".ui-toolbar__section--start").text()).toBe("Left")
    expect(full.get(".ui-toolbar__section--end").text()).toBe("Right")
  })
})

describe("UiStatusNotice", () => {
  it("stays out of the accessibility tree when it is not a live region", () => {
    const wrapper = mount(UiStatusNotice, { slots: { default: "Idle." } })

    expect(wrapper.attributes("role")).toBeUndefined()
    expect(wrapper.attributes("aria-live")).toBeUndefined()
    expect(wrapper.attributes("data-tone")).toBe("neutral")
    expect(wrapper.find(".ui-status-notice__title").exists()).toBe(false)
  })

  it("uses a polite status region and shows the optional title", () => {
    const wrapper = mount(UiStatusNotice, {
      props: { tone: "success", live: "polite", title: "Recording saved" },
      slots: { default: "Take 3 is in the project." }
    })

    expect(wrapper.attributes("role")).toBe("status")
    expect(wrapper.attributes("aria-live")).toBe("polite")
    expect(wrapper.attributes("data-tone")).toBe("success")
    expect(wrapper.get(".ui-status-notice__title").text()).toBe("Recording saved")
  })
})

describe("UiButton", () => {
  it("marks a disabled button as disabled without claiming to be busy", () => {
    const wrapper = mount(UiButton, {
      props: { disabled: true, variant: "danger", size: "lg" },
      slots: { default: "Delete" }
    })

    const button = wrapper.get("button")
    expect(button.attributes("disabled")).toBeDefined()
    expect(button.attributes("aria-disabled")).toBe("true")
    expect(button.attributes("aria-busy")).toBeUndefined()
    expect(button.classes()).toEqual(expect.arrayContaining(["ui-button--danger", "ui-button--lg"]))
  })

  it("leaves an idle button interactive and defaults to type button", () => {
    const wrapper = mount(UiButton, { slots: { default: "Play" } })

    const button = wrapper.get("button")
    expect(button.attributes("disabled")).toBeUndefined()
    expect(button.attributes("aria-disabled")).toBeUndefined()
    expect(button.attributes("type")).toBe("button")
  })
})

describe("UiSelect", () => {
  it("renders a disabled placeholder ahead of flat options", () => {
    const wrapper = mount(UiSelect, {
      props: {
        modelValue: "",
        placeholder: "Choose a device",
        invalid: true,
        options: [
          { label: "Built-in output", value: "builtin" },
          { label: "Unavailable", value: "missing", disabled: true }
        ]
      }
    })

    const options = wrapper.findAll("option")
    expect(options[0]?.text()).toBe("Choose a device")
    expect(options[0]?.attributes("disabled")).toBeDefined()
    expect(options[2]?.attributes("disabled")).toBeDefined()
    expect(wrapper.get("select").attributes("aria-invalid")).toBe("true")
  })
})

describe("UI_DOMAIN_COLORS", () => {
  it("serializes every domain color as an uppercase six-digit hex string", () => {
    for (const [role, color] of Object.entries(UI_DOMAIN_COLORS)) {
      expect(color, role).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it("keeps the channel colors distinguishable from one another", () => {
    const colors = Object.values(UI_DOMAIN_COLORS)

    expect(new Set(colors).size).toBe(colors.length)
  })
})
