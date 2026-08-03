import { shallowMount } from "@vue/test-utils"
import { createHead } from "@unhead/vue/client"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HeronDesktopApi } from "@heron/contracts"
import App from "./App.vue"
import { useAboutStore } from "./stores/about"
import { useLifecycleStore } from "./stores/lifecycle"
import { rpcEvent } from "./test/ipc"

describe("App", () => {
  let nativeCommandListener: Parameters<typeof window.heron.subscribeApplicationCommands>[0] | null
  let originalBootstrap: HeronDesktopApi["bootstrap"]
  let originalSubscribeApplicationCommands: HeronDesktopApi["subscribeApplicationCommands"]
  let originalSubscribeLifecycle: HeronDesktopApi["subscribeLifecycle"]

  beforeEach(() => {
    nativeCommandListener = null
    originalBootstrap = window.heron.bootstrap
    originalSubscribeApplicationCommands = window.heron.subscribeApplicationCommands
    originalSubscribeLifecycle = window.heron.subscribeLifecycle
    window.heron.bootstrap = vi.fn(() => new Promise<never>(() => undefined))
    window.heron.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
    })
    window.heron.subscribeLifecycle = vi.fn(() => () => undefined)
  })

  afterEach(() => {
    window.heron.bootstrap = originalBootstrap
    window.heron.subscribeApplicationCommands = originalSubscribeApplicationCommands
    window.heron.subscribeLifecycle = originalSubscribeLifecycle
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
    expect(window.heron.subscribeApplicationCommands).toHaveBeenCalledOnce()

    nativeCommandListener?.(rpcEvent("application.about"))
    await nextTick()

    expect(useAboutStore(pinia).isOpen).toBe(true)
    wrapper.unmount()
  })
})
