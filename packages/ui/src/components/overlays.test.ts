import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { h } from "vue"

import UiAlertDialog from "./UiAlertDialog.vue"
import UiDialog from "./UiDialog.vue"
import UiIconButton from "./UiIconButton.vue"
import UiMenubar from "./UiMenubar.vue"
import UiPopover from "./UiPopover.vue"
import UiProvider from "./UiProvider.vue"
import UiTooltip from "./UiTooltip.vue"

// Overlays teleport into `document.body` and keep listeners there, so every
// wrapper has to be torn down before the next test inspects the document.
enableAutoUnmount(afterEach)

/** Overlay content is portalled to `document.body`, outside the wrapper element. */
function portal(selector: string): DOMWrapper<HTMLElement> {
  return new DOMWrapper(document.body.querySelector<HTMLElement>(selector))
}

function portalAll(selector: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(selector)]
}

describe("UiDialog", () => {
  it("renders title, description, body, and actions when open", async () => {
    mount(UiDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        eyebrow: "Project",
        title: "Unsaved changes",
        description: "Save before closing?"
      },
      slots: {
        default: "<p>Three tracks changed.</p>",
        actions: '<button type="button">Save</button>'
      }
    })
    await flushPromises()

    expect(portal(".ui-dialog__eyebrow").text()).toBe("Project")
    expect(portal(".ui-dialog__title").text()).toBe("Unsaved changes")
    expect(portal(".ui-dialog__description").text()).toBe("Save before closing?")
    expect(portal(".ui-dialog__body").text()).toContain("Three tracks changed.")
    expect(portal(".ui-dialog__actions").text()).toContain("Save")
  })

  it("stays closed until the model opens it", async () => {
    const wrapper = mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: false, title: "Export" }
    })
    await flushPromises()
    expect(document.body.querySelector(".ui-dialog")).toBeNull()

    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    expect(document.body.querySelector(".ui-dialog")).not.toBeNull()
  })

  it("applies the requested size and omits an empty actions footer", async () => {
    mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: true, title: "Export", size: "lg" }
    })
    await flushPromises()

    expect(portal(".ui-dialog").classes()).toContain("ui-dialog--lg")
    expect(document.body.querySelector(".ui-dialog__actions")).toBeNull()
  })

  it("offers a labelled close affordance that clears the model", async () => {
    const wrapper = mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: true, title: "Export", closeLabel: "Dismiss export" }
    })
    await flushPromises()

    const close = portal(".ui-dialog__close")
    expect(close.attributes("aria-label")).toBe("Dismiss export")
    await close.trigger("click")
    await flushPromises()

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false])
  })

  it("hides the close button for non-dismissible dialogs", async () => {
    mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: true, title: "Migrating project", dismissible: false }
    })
    await flushPromises()

    expect(document.body.querySelector(".ui-dialog__close")).toBeNull()
  })

  it("replaces the default heading with a header slot", async () => {
    mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: true, title: "Ignored" },
      slots: { header: '<h2 class="custom-heading">Custom</h2>' }
    })
    await flushPromises()

    expect(document.body.querySelector(".ui-dialog__title")).toBeNull()
    expect(portal(".custom-heading").text()).toBe("Custom")
  })

  it("opens from a trigger slot", async () => {
    const wrapper = mount(UiDialog, {
      attachTo: document.body,
      props: { modelValue: false, title: "Export" },
      slots: { trigger: '<button type="button">Open</button>' }
    })

    await wrapper.get("button").trigger("click")
    await flushPromises()

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([true])
  })
})

describe("UiAlertDialog", () => {
  it("renders the confirm and cancel pair by default", async () => {
    mount(UiAlertDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        title: "Discard recording?",
        description: "The take has not been saved."
      }
    })
    await flushPromises()

    expect(portal(".ui-alert-dialog__title").text()).toBe("Discard recording?")
    expect(portal(".ui-alert-dialog__description").text()).toBe("The take has not been saved.")
    expect(portalAll(".ui-alert-dialog__button").map((node) => node.textContent?.trim())).toEqual([
      "Cancel",
      "Continue"
    ])
  })

  it("emits confirm and cancel from the default buttons", async () => {
    const wrapper = mount(UiAlertDialog, {
      attachTo: document.body,
      props: { modelValue: true, title: "Discard?", description: "Unsaved take." }
    })
    await flushPromises()

    const [cancel, confirm] = portalAll(".ui-alert-dialog__button")
    await new DOMWrapper(cancel).trigger("click")
    expect(wrapper.emitted("cancel")).toHaveLength(1)

    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    await new DOMWrapper(portalAll(".ui-alert-dialog__button")[1] ?? confirm).trigger("click")
    expect(wrapper.emitted("confirm")).toHaveLength(1)
  })

  it("tones the confirm button and the content for destructive prompts", async () => {
    mount(UiAlertDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        title: "Delete take?",
        description: "This cannot be undone.",
        tone: "danger",
        confirmLabel: "Delete",
        cancelLabel: "Keep"
      }
    })
    await flushPromises()

    expect(portal(".ui-alert-dialog").attributes("data-tone")).toBe("danger")
    const buttons = portalAll(".ui-alert-dialog__button")
    expect(buttons[0]?.textContent?.trim()).toBe("Keep")
    expect(buttons[1]?.textContent?.trim()).toBe("Delete")
    expect(buttons[1]?.classList.contains("ui-alert-dialog__button--danger")).toBe(true)
  })

  it("renders custom actions and reports the chosen value", async () => {
    const wrapper = mount(UiAlertDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        title: "Close project?",
        description: "Three tracks changed.",
        actions: [
          { value: "save", label: "Save" },
          { value: "discard", label: "Discard", variant: "danger" },
          { value: "cancel", label: "Cancel", cancel: true }
        ]
      }
    })
    await flushPromises()

    const buttons = portalAll(".ui-alert-dialog__button")
    expect(buttons.map((node) => node.textContent?.trim())).toEqual(["Save", "Discard", "Cancel"])
    expect(buttons[1]?.classList.contains("ui-alert-dialog__button--danger")).toBe(true)

    await new DOMWrapper(buttons[1]).trigger("click")
    expect(wrapper.emitted("action")).toEqual([["discard"]])
  })

  it("disables every action while busy", async () => {
    mount(UiAlertDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        title: "Saving",
        description: "Writing the archive.",
        busy: true
      }
    })
    await flushPromises()

    for (const button of portalAll(".ui-alert-dialog__button")) {
      expect(button.hasAttribute("disabled")).toBe(true)
    }
  })

  it("shows an eyebrow and detail slot when supplied", async () => {
    mount(UiAlertDialog, {
      attachTo: document.body,
      props: {
        modelValue: true,
        eyebrow: "Recording",
        title: "Recover take?",
        description: "A take was left behind."
      },
      slots: { default: "<ul><li>take-01.wav</li></ul>" }
    })
    await flushPromises()

    expect(portal(".ui-alert-dialog__eyebrow").text()).toBe("Recording")
    expect(portal(".ui-alert-dialog__detail").text()).toContain("take-01.wav")
  })
})

describe("UiPopover", () => {
  it("wires the trigger slot to the portalled content", () => {
    const wrapper = mount(UiPopover, {
      attachTo: document.body,
      props: { modelValue: false },
      slots: {
        trigger: '<button type="button">Performance</button>',
        default: "<p>CPU 12%</p>"
      }
    })

    const trigger = wrapper.get("button")
    expect(trigger.text()).toBe("Performance")
    expect(trigger.attributes("aria-haspopup")).toBe("dialog")
    expect(trigger.attributes("aria-expanded")).toBe("false")
    expect(document.body.querySelector(".ui-popover")).toBeNull()
  })

  it("requests an open state when the trigger is activated", async () => {
    const wrapper = mount(UiPopover, {
      attachTo: document.body,
      props: { modelValue: false },
      slots: {
        trigger: '<button type="button">Performance</button>',
        default: "<p>CPU 12%</p>"
      }
    })

    await wrapper.get("button").trigger("click")

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([true])
  })
})

describe("UiTooltip", () => {
  it("renders its trigger content inline", () => {
    const wrapper = mount(UiProvider, {
      attachTo: document.body,
      slots: {
        default: () => h(UiTooltip, { text: "Play" }, () => h("button", { type: "button" }, "▶"))
      }
    })

    expect(wrapper.get("button").text()).toBe("▶")
  })

  it("shows the tooltip text and shortcut on focus", async () => {
    mount(UiProvider, {
      attachTo: document.body,
      props: { tooltipDelay: 0 },
      slots: {
        default: () =>
          h(UiTooltip, { text: "Play", shortcut: "Space" }, () =>
            h("button", { type: "button" }, "▶")
          )
      }
    })

    await new DOMWrapper(document.body.querySelector<HTMLElement>("button")).trigger("focus")
    await flushPromises()

    const tooltip = portal(".ui-tooltip")
    expect(tooltip.text()).toContain("Play")
    expect(tooltip.get("kbd").text()).toBe("Space")
  })

  it("stays hidden when disabled", async () => {
    mount(UiProvider, {
      attachTo: document.body,
      props: { tooltipDelay: 0 },
      slots: {
        default: () =>
          h(UiTooltip, { text: "Play", disabled: true }, () => h("button", { type: "button" }, "▶"))
      }
    })

    await new DOMWrapper(document.body.querySelector<HTMLElement>("button")).trigger("focus")
    await flushPromises()

    expect(document.body.querySelector(".ui-tooltip")).toBeNull()
  })
})

describe("UiIconButton", () => {
  it("labels an icon-only button for assistive technology", () => {
    const wrapper = mount(UiProvider, {
      attachTo: document.body,
      slots: {
        default: () => h(UiIconButton, { label: "Toggle metronome" }, () => h("span", "M"))
      }
    })

    const button = wrapper.get("button")
    expect(button.attributes("aria-label")).toBe("Toggle metronome")
    expect(button.classes()).toContain("ui-icon-button")
    expect(button.text()).toBe("M")
  })

  it("exposes a toggle state and honors the disabled prop", () => {
    const wrapper = mount(UiProvider, {
      attachTo: document.body,
      slots: {
        default: () =>
          h(UiIconButton, {
            label: "Toggle metronome",
            pressed: true,
            disabled: true,
            size: "sm",
            variant: "secondary"
          })
      }
    })

    const button = wrapper.get("button")
    expect(button.attributes("aria-pressed")).toBe("true")
    expect(button.attributes("disabled")).toBeDefined()
    expect(button.classes()).toContain("ui-button--sm")
  })
})

describe("UiMenubar", () => {
  it("renders one trigger per menu", () => {
    const wrapper = mount(UiMenubar, {
      attachTo: document.body,
      props: {
        ariaLabel: "Main menu",
        menus: [
          { value: "file", label: "File", items: [{ value: "file.new", label: "New" }] },
          { value: "edit", label: "Edit", items: [{ value: "edit.undo", label: "Undo" }] }
        ]
      }
    })

    expect(wrapper.attributes("aria-label")).toBe("Main menu")
    expect(wrapper.findAll(".ui-menubar__trigger").map((item) => item.text())).toEqual([
      "File",
      "Edit"
    ])
  })

  it("shows items, shortcuts, separators, and reports the selected value", async () => {
    const wrapper = mount(UiMenubar, {
      attachTo: document.body,
      props: {
        menus: [
          {
            value: "file",
            label: "File",
            items: [
              { value: "file.new", label: "New project", shortcut: "Ctrl+N" },
              { value: "file.close", label: "Close", separatorBefore: true, disabled: true }
            ]
          }
        ]
      }
    })

    await wrapper.get(".ui-menubar__trigger").trigger("pointerdown", { button: 0 })
    await flushPromises()

    const items = portalAll(".ui-menubar__item")
    expect(items.map((item) => item.querySelector("span")?.textContent)).toEqual([
      "New project",
      "Close"
    ])
    expect(items[0]?.querySelector(".ui-menubar__shortcut")?.textContent?.trim()).toBe("Ctrl+N")
    expect(items[1]?.querySelector(".ui-menubar__shortcut")).toBeNull()
    expect(document.body.querySelector(".ui-menubar__separator")).not.toBeNull()
    expect(items[1]?.hasAttribute("data-disabled")).toBe(true)

    await new DOMWrapper(items[0]).trigger("click")
    await flushPromises()
    expect(wrapper.emitted("select")).toEqual([["file.new"]])
  })
})

describe("UiProvider", () => {
  it("renders its slot content", () => {
    const wrapper = mount(UiProvider, {
      slots: { default: '<span class="child">Studio</span>' }
    })

    expect(wrapper.get(".child").text()).toBe("Studio")
  })

  it("propagates the configured text direction to portalled overlays", async () => {
    mount(UiProvider, {
      attachTo: document.body,
      props: { dir: "rtl", locale: "ar", tooltipDelay: 0 },
      slots: {
        default: () => h(UiTooltip, { text: "تشغيل" }, () => h("button", { type: "button" }, "▶"))
      }
    })

    await new DOMWrapper(document.body.querySelector<HTMLElement>("button")).trigger("focus")
    await flushPromises()

    expect(portal(".ui-tooltip").attributes("dir")).toBe("rtl")
  })

  it("holds tooltips back until the configured delay elapses", async () => {
    mount(UiProvider, {
      attachTo: document.body,
      props: { tooltipDelay: 10_000 },
      slots: {
        default: () => h(UiTooltip, { text: "Play" }, () => h("button", { type: "button" }, "▶"))
      }
    })

    await new DOMWrapper(document.body.querySelector<HTMLElement>("button")).trigger("pointerenter")
    await flushPromises()

    expect(document.body.querySelector(".ui-tooltip")).toBeNull()
  })
})
