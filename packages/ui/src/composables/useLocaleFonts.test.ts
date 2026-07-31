import { createHead, renderDOMHead } from "@unhead/vue/client"
import { mount } from "@vue/test-utils"
import { defineComponent, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useLocaleFonts } from "./useLocaleFonts"

const loadHansFonts = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock("@fontsource-variable/noto-sans-sc/wght.css", () => {
  void loadHansFonts()
  return {}
})

describe("useLocaleFonts", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("lang")
    loadHansFonts.mockClear()
  })

  it("sets html lang for the active locale and loads Hans fonts for Chinese", async () => {
    const locale = ref("en-US")
    const head = createHead()
    const Host = defineComponent({
      setup() {
        useLocaleFonts(locale)
        return () => null
      }
    })
    mount(Host, {
      global: {
        plugins: [head]
      }
    })

    await nextTick()
    await renderDOMHead(head)
    expect(document.documentElement.lang).toBe("en-US")
    expect(loadHansFonts).not.toHaveBeenCalled()

    locale.value = "zh-cmn-Hans-CN"
    await nextTick()
    await renderDOMHead(head)
    expect(document.documentElement.lang).toBe("zh-CN")
    await vi.waitFor(() => {
      expect(loadHansFonts).toHaveBeenCalled()
    })
  })
})
