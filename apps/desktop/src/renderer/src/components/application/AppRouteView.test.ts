import { mount } from "@vue/test-utils"
import { defineComponent, nextTick } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it } from "vitest"
import AppRouteView from "./AppRouteView.vue"

const WelcomeRoute = defineComponent({
  template: '<main data-route="welcome">Welcome</main>'
})

const SettingsRoute = defineComponent({
  template: '<main data-route="settings">Settings</main>'
})

describe("AppRouteView", () => {
  it("renders route components inside the shared transition surface", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: WelcomeRoute },
        { path: "/settings", component: SettingsRoute }
      ]
    })

    await router.push("/")
    await router.isReady()

    const wrapper = mount(AppRouteView, {
      global: {
        plugins: [router]
      }
    })

    expect(wrapper.get(".app-route-view").attributes("class")).toContain("app-route-view")
    expect(wrapper.get('[data-route="welcome"]').text()).toBe("Welcome")

    await router.push("/settings")
    await nextTick()

    expect(wrapper.get('[data-route="settings"]').text()).toBe("Settings")
  })
})
