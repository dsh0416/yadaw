import { mount } from "@vue/test-utils"
import { defineComponent, nextTick, shallowRef } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThemePreference } from "@yadaw/contracts"
import { useTheme } from "./useTheme"

describe("useTheme", () => {
  let systemDark = true
  let changeListener: ((event: MediaQueryListEvent) => void) | null = null

  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return systemDark
        },
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: vi.fn((_type, listener) => {
          changeListener = listener as (event: MediaQueryListEvent) => void
        }),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )
  })

  afterEach(() => {
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ""
    vi.unstubAllGlobals()
  })

  it("resolves the system theme and responds to system changes", async () => {
    const preference = shallowRef<ThemePreference>("system")
    const wrapper = mount(
      defineComponent({
        setup() {
          useTheme(preference)
          return () => null
        }
      })
    )

    expect(document.documentElement.dataset.theme).toBe("dark")

    systemDark = false
    changeListener?.({ matches: false } as MediaQueryListEvent)
    await nextTick()
    expect(document.documentElement.dataset.theme).toBe("light")

    wrapper.unmount()
  })

  it("applies an explicit preference immediately", async () => {
    const preference = shallowRef<ThemePreference>("light")
    const wrapper = mount(
      defineComponent({
        setup() {
          useTheme(preference)
          return () => null
        }
      })
    )

    expect(document.documentElement.dataset.theme).toBe("light")
    preference.value = "dark"
    await nextTick()
    expect(document.documentElement.dataset.theme).toBe("dark")

    wrapper.unmount()
  })
})
