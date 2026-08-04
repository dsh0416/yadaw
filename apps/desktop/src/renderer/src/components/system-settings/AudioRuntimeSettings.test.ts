import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AudioRuntimeSettings from "./AudioRuntimeSettings.vue"

describe("AudioRuntimeSettings", () => {
  it("shows resolved threads and emits a validated manual configuration", async () => {
    const wrapper = mount(AudioRuntimeSettings, {
      props: {
        modelValue: {
          workerThreads: "auto",
          maxBlockingThreads: "auto"
        },
        resolved: {
          workerThreads: 2,
          maxBlockingThreads: 4
        },
        applying: false,
        error: ""
      }
    })

    expect(wrapper.text()).toContain("2 workers")
    await wrapper.get('select[aria-label="Worker thread mode"]').setValue("manual")
    await wrapper.get('input[aria-label="Worker threads"]').setValue("3")
    await wrapper.get('button[type="button"]').trigger("click")

    expect(wrapper.emitted("apply")?.[0]?.[0]).toEqual({
      workerThreads: 3,
      maxBlockingThreads: "auto"
    })
  })

  it("disables apply until the draft differs from persisted settings", () => {
    const wrapper = mount(AudioRuntimeSettings, {
      props: {
        modelValue: {
          workerThreads: "auto",
          maxBlockingThreads: "auto"
        },
        resolved: null,
        applying: false,
        error: ""
      }
    })

    expect(wrapper.get('button[type="button"]').attributes("disabled")).toBeDefined()
  })
})
