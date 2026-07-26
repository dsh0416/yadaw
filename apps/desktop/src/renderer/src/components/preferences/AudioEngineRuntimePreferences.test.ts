import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import AudioEngineRuntimePreferences from "./AudioEngineRuntimePreferences.vue"

describe("AudioEngineRuntimePreferences", () => {
  it("shows resolved threads and emits a validated manual configuration", async () => {
    const wrapper = mount(AudioEngineRuntimePreferences, {
      props: {
        modelValue: {
          workerThreads: "auto",
          maxBlockingThreads: "auto",
          egressConcurrency: "auto"
        },
        resolved: {
          workerThreads: 2,
          maxBlockingThreads: 4,
          egressConcurrency: 2
        },
        applying: false,
        error: ""
      }
    })

    expect(wrapper.text()).toContain("2 workers")
    await wrapper.findAll("select")[0]!.setValue("manual")
    await wrapper.get('input[aria-label="Worker threads"]').setValue("3")
    await wrapper.get("button").trigger("click")

    expect(wrapper.emitted("apply")?.[0]?.[0]).toEqual({
      workerThreads: 3,
      maxBlockingThreads: "auto",
      egressConcurrency: "auto"
    })
  })

  it("disables apply until the draft differs from persisted settings", () => {
    const wrapper = mount(AudioEngineRuntimePreferences, {
      props: {
        modelValue: {
          workerThreads: "auto",
          maxBlockingThreads: "auto",
          egressConcurrency: "auto"
        },
        resolved: null,
        applying: false,
        error: ""
      }
    })

    expect(wrapper.get("button").attributes("disabled")).toBeDefined()
  })
})
