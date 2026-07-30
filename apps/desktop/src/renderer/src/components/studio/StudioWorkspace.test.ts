import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { describe, expect, it } from "vitest"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import StudioWorkspace from "./StudioWorkspace.vue"

describe("StudioWorkspace", () => {
  it("renders lower-dock content without introducing a second navigation control", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const workspace = useStudioWorkspaceStore()
    workspace.reset()
    const wrapper = mount(StudioWorkspace, {
      props: {
        recordingId: null,
        recordingStartedAt: null,
        recordingStartFrame: null,
        recordingError: ""
      },
      global: {
        plugins: [pinia],
        stubs: {
          ArrangementWorkspace: true,
          MixerConsole: { template: '<div data-testid="mixer-dock" />' },
          PianoRollDock: {
            emits: ["close"],
            template: '<button data-testid="piano-roll-dock" @click="$emit(\'close\')" />'
          }
        }
      }
    })

    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mixer-dock"]').exists()).toBe(true)

    workspace.togglePianoRollDock()
    await nextTick()
    expect(wrapper.find('[data-testid="piano-roll-dock"]').exists()).toBe(true)

    await wrapper.get('[data-testid="piano-roll-dock"]').trigger("click")
    expect(workspace.lowerDockOpen).toBe(false)
  })
})
