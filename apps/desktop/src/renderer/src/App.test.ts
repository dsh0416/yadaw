import { shallowMount } from "@vue/test-utils"
import { createHead } from "@unhead/vue/client"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { YadawDesktopApi } from "@yadaw/contracts"
import App from "./App.vue"
import { useAboutStore } from "./stores/about"
import { useLifecycleStore } from "./stores/lifecycle"
import { rpcEvent } from "./test/ipc"

describe("App", () => {
  let nativeCommandListener: Parameters<typeof window.yadaw.subscribeApplicationCommands>[0] | null
  let originalBootstrap: YadawDesktopApi["bootstrap"]
  let originalSubscribeApplicationCommands: YadawDesktopApi["subscribeApplicationCommands"]
  let originalSubscribeLifecycle: YadawDesktopApi["subscribeLifecycle"]

  beforeEach(() => {
    nativeCommandListener = null
    originalBootstrap = window.yadaw.bootstrap
    originalSubscribeApplicationCommands = window.yadaw.subscribeApplicationCommands
    originalSubscribeLifecycle = window.yadaw.subscribeLifecycle
    window.yadaw.bootstrap = vi.fn(() => new Promise<never>(() => undefined))
    window.yadaw.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
    })
    window.yadaw.subscribeLifecycle = vi.fn(() => () => undefined)
  })

  afterEach(() => {
    window.yadaw.bootstrap = originalBootstrap
    window.yadaw.subscribeApplicationCommands = originalSubscribeApplicationCommands
    window.yadaw.subscribeLifecycle = originalSubscribeLifecycle
  })

  it("handles native About commands while lifecycle bootstrap is pending", async () => {
    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", name: "welcome", component: { template: "<div />" } }]
    })
    await router.push("/")
    await router.isReady()

    const wrapper = shallowMount(App, {
      global: { plugins: [pinia, router, createHead()] }
    })
    await nextTick()

    expect(useLifecycleStore(pinia).ready).toBe(false)
    expect(window.yadaw.subscribeApplicationCommands).toHaveBeenCalledOnce()

    nativeCommandListener?.(rpcEvent("application.about"))
    await nextTick()

    expect(useAboutStore(pinia).isOpen).toBe(true)
    wrapper.unmount()
  })
})
