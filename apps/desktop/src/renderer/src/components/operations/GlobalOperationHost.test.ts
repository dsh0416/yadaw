import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { describe, expect, it, vi } from "vitest"
import GlobalOperationHost from "./GlobalOperationHost.vue"
import { useOperationStore } from "../../stores/operations"

describe("GlobalOperationHost", () => {
  it("renders its Teleport in document.body and unsubscribes", async () => {
    const unsubscribe = vi.fn()
    window.yadaw.subscribeOperations = vi.fn(() => unsubscribe)
    const pinia = createPinia()
    const wrapper = mount(GlobalOperationHost, { attachTo: document.body, global: { plugins: [pinia] } })
    const store = useOperationStore(pinia)
    store.apply({ type: "upsert", operation: {
      id: "save", title: "Saving", phase: "saving-archive", state: "running",
      completedUnits: null, totalUnits: null, cancellable: false, message: null, dropoutFrames: 0
    } })
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=dialog]")?.textContent).toContain("Saving")
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("dismisses a retained completed warning when its backdrop is clicked", async () => {
    window.yadaw.subscribeOperations = vi.fn(() => vi.fn())
    const pinia = createPinia()
    const wrapper = mount(GlobalOperationHost, { attachTo: document.body, global: { plugins: [pinia] } })
    const store = useOperationStore(pinia)
    store.apply({ type: "upsert", operation: {
      id: "warning", title: "Finalizing", phase: "committing-database", state: "completed",
      completedUnits: null, totalUnits: null, cancellable: false, message: null, dropoutFrames: 4
    } })
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=dialog] button")).toBeNull()
    document.body.querySelector<HTMLElement>(".operation-overlay")?.click()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=dialog]")).toBeNull()
    wrapper.unmount()
  })
})
