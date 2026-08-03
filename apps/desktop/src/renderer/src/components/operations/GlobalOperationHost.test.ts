import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { describe, expect, it, vi } from "vitest"
import GlobalOperationHost from "./GlobalOperationHost.vue"
import { useOperationStore } from "../../stores/operations"

describe("GlobalOperationHost", () => {
  it("renders subscribed operation state without owning the subscription", async () => {
    const unsubscribe = vi.fn()
    window.heron.subscribeOperations = vi.fn(() => unsubscribe)
    const pinia = createPinia()
    const wrapper = mount(GlobalOperationHost, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    const store = useOperationStore(pinia)
    store.startSubscription()
    store.apply({
      type: "upsert",
      operation: {
        id: "save",
        title: "Saving project",
        description: "Lifecycle",
        phase: "saving-archive",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        error: null,
        dropoutFrames: 0
      }
    })
    await wrapper.vm.$nextTick()
    const dialog = document.body.querySelector("[role=dialog]")
    expect(dialog?.querySelectorAll(".ui-dialog__title")).toHaveLength(1)
    expect(dialog?.querySelector(".ui-dialog__eyebrow")).toBeNull()
    expect(dialog?.querySelector(".ui-dialog__title")?.textContent).toBe("Background operation")
    expect(dialog?.querySelector(".ui-dialog__description")).toBeNull()
    expect(dialog?.querySelector(".operation-description")?.textContent?.trim()).toBe(
      "Saving project · Saving project archive"
    )
    expect(dialog?.textContent).not.toContain("Lifecycle")
    expect(dialog?.querySelector("h3")).toBeNull()
    expect(dialog?.textContent).not.toContain("Track progress and review")
    wrapper.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()
    store.stopSubscription()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("dismisses a retained completed warning through the shared dialog close action", async () => {
    window.heron.subscribeOperations = vi.fn(() => vi.fn())
    const pinia = createPinia()
    const wrapper = mount(GlobalOperationHost, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    const store = useOperationStore(pinia)
    store.apply({
      type: "upsert",
      operation: {
        id: "warning",
        title: "Finalizing",
        phase: "committing-database",
        state: "completed",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        error: null,
        dropoutFrames: 4
      }
    })
    await wrapper.vm.$nextTick()
    const close = document.body.querySelector<HTMLButtonElement>(
      '[role=dialog] button[aria-label="Close dialog"]'
    )
    expect(close).not.toBeNull()
    close?.click()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=dialog]")).toBeNull()
    wrapper.unmount()
  })
})
