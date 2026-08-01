import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { nextTick } from "vue"
import { describe, expect, it } from "vitest"
import AboutYadawHost from "./AboutYadawHost.vue"
import { useAboutStore } from "../../stores/about"

describe("AboutYadawHost", () => {
  it("shows product identity, build details, and trusted project links", async () => {
    const pinia = createPinia()
    const aboutStore = useAboutStore(pinia)
    aboutStore.open()

    const wrapper = mount(AboutYadawHost, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")
    expect(dialog?.textContent).toContain("About YADAW")
    expect(dialog?.textContent).toContain(`v${__APP_VERSION__}`)
    expect(dialog?.textContent).toContain("Windows")
    expect(dialog?.textContent).toContain("GPL-3.0-only")

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
