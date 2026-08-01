import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import type { UiMenuEntry } from "../menu"
import UiContextMenu from "./UiContextMenu.vue"
import UiDropdownMenu from "./UiDropdownMenu.vue"

const effectEntries: readonly UiMenuEntry[] = [
  {
    kind: "submenu",
    id: "dynamics",
    label: "Dynamics",
    children: [
      {
        kind: "item",
        id: "compressor",
        label: "Compressor",
        shortcut: "⇧C",
        keywords: ["gain"]
      }
    ]
  },
  { kind: "separator", id: "edit-separator" },
  {
    kind: "checkbox",
    id: "auto-gain",
    label: "Auto gain",
    checked: true
  }
]

let mounted: VueWrapper | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ""
})

describe("menu components", () => {
  it("flattens searchable dropdown results and emits the terminal action", async () => {
    mounted = mount(UiDropdownMenu, {
      attachTo: document.body,
      props: {
        entries: effectEntries,
        menuLabel: "Add audio effect",
        searchOptions: {
          label: "Search effects",
          placeholder: "Plug-in or category",
          emptyMessage: "No effects found."
        }
      },
      slots: {
        default: '<button type="button">Add effect</button>'
      }
    })

    await mounted.get("button").trigger("click")
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search effects"]'
    )
    expect(search).not.toBeNull()
    expect(document.activeElement).toBe(search)

    await new DOMWrapper(search).setValue("comp")
    const result = document.body.querySelector<HTMLElement>('[role="menuitem"]')
    expect(result?.textContent).toContain("Compressor")
    expect(result?.textContent).toContain("Dynamics")
    expect(document.body.querySelector('[data-state="open"] .ui-menu__sub-content')).toBeNull()

    await new DOMWrapper(result).trigger("click")
    expect(mounted.emitted("select")).toEqual([["compressor"]])
  })

  it("keeps the menu open after toggling a checked command", async () => {
    mounted = mount(UiDropdownMenu, {
      attachTo: document.body,
      props: {
        entries: effectEntries,
        menuLabel: "Effect options",
        open: false,
        "onUpdate:open": (value: boolean) => void mounted?.setProps({ open: value })
      },
      slots: {
        default: '<button type="button">Options</button>'
      }
    })

    await mounted.get("button").trigger("click")
    expect(mounted.props("open")).toBe(true)
    const autoGain = document.body.querySelector<HTMLElement>(
      '[role="menuitemcheckbox"][aria-checked="true"]'
    )
    expect(autoGain?.textContent).toContain("Auto gain")
    await new DOMWrapper(autoGain).trigger("click")
    await flushPromises()

    expect(mounted.emitted("select")).toEqual([["auto-gain"]])
    expect(mounted.props("open")).toBe(true)
  })

  it("keeps the host empty copy when the unfiltered tree is empty", async () => {
    mounted = mount(UiDropdownMenu, {
      attachTo: document.body,
      props: {
        entries: [],
        menuLabel: "Add audio effect",
        emptyMessage: "No compatible effects found.",
        searchOptions: {
          label: "Search effects",
          emptyMessage: "No effects match this search."
        }
      },
      slots: {
        default: '<button type="button">Add effect</button>'
      }
    })

    await mounted.get("button").trigger("click")
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search effects"]'
    )
    expect(search).not.toBeNull()
    await new DOMWrapper(search).setValue("delay")
    await flushPromises()

    expect(document.body.querySelector(".ui-menu__empty")?.textContent).toBe(
      "No compatible effects found."
    )
  })

  it("opens from a native contextmenu event and emits the selected action", async () => {
    mounted = mount(UiContextMenu, {
      attachTo: document.body,
      props: {
        entries: [
          {
            kind: "item",
            id: "rename",
            label: "Rename",
            shortcut: "F2"
          },
          {
            kind: "item",
            id: "delete",
            label: "Delete",
            tone: "danger"
          }
        ],
        menuLabel: "Clip commands"
      },
      slots: {
        default: '<button type="button">Verse clip</button>'
      }
    })

    await mounted.get("button").trigger("contextmenu", {
      clientX: 20,
      clientY: 20
    })
    await flushPromises()

    expect(mounted.emitted("openContext")).toHaveLength(1)
    const rename = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Rename")
    )
    expect(rename).toBeDefined()
    await new DOMWrapper(rename).trigger("click")
    expect(mounted.emitted("select")).toEqual([["rename"]])
  })
})
