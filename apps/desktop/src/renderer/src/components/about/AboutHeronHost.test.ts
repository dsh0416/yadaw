import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { nextTick } from "vue"
import { describe, expect, it } from "vitest"
import AboutHeronHost from "./AboutHeronHost.vue"
import { useAboutStore } from "../../stores/about"

describe("AboutHeronHost", () => {
  it("shows product identity, build details, and trusted project links", async () => {
    const pinia = createPinia()
    const aboutStore = useAboutStore(pinia)
    aboutStore.open()

    const wrapper = mount(AboutHeronHost, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")
    expect(dialog?.textContent).toContain("About Heron Studio")
    expect(dialog?.textContent).toContain(`v${__APP_VERSION__}`)
    expect(dialog?.textContent).toContain("Windows")
    expect(dialog?.textContent).toContain("GPL-3.0-only")
    expect(dialog?.textContent).toContain("VST® 3 compatibility")
    expect(dialog?.textContent).toContain(
      "VST is a registered trademark of Steinberg Media Technologies GmbH."
    )
    expect(dialog?.textContent).toContain("ASIO® compatibility")
    expect(dialog?.textContent).toContain(
      "ASIO is a registered trademark of Steinberg Media Technologies GmbH."
    )
    expect(dialog?.textContent).toContain("Copyright (c) 2025, Steinberg Media Technologies GmbH")
    expect(dialog?.textContent).toContain("Steinberg ASIO SDK 2.3.4")
    expect(dialog?.textContent).toContain("General Public License (GPL) Version 3")
    expect(dialog?.querySelector('[data-appearance="on-dark"]')).not.toBeNull()
    expect(dialog?.querySelector(".asio-compatible-logo")).not.toBeNull()

    const links = [...(dialog?.querySelectorAll<HTMLAnchorElement>("a") ?? [])]
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/dsh0416/yadaw",
      "https://yadaw.minori.live/manual/"
    ])
    expect(links.every((link) => link.target === "_blank")).toBe(true)

    const buttons = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    expect(buttons).toHaveLength(1)
    const closeButton = dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')
    closeButton?.click()
    await nextTick()

    expect(aboutStore.isOpen).toBe(false)
    expect(document.body.querySelector("[role=dialog]")).toBeNull()
    wrapper.unmount()
  })
})
