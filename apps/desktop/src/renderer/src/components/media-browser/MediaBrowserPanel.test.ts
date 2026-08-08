import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAssetSummary } from "@heron/contracts"
import { rpcSuccess } from "../../test/ipc"
import { useProjectStore } from "../../stores/project"
import MediaBrowserPanel from "./MediaBrowserPanel.vue"

enableAutoUnmount(afterEach)

const assets: ProjectAssetSummary[] = [
  {
    id: "audio-1",
    kind: "audio",
    name: "Kick.mp3",
    contentHash: "audio-hash",
    sampleRate: 48_000,
    channels: 2,
    bitDepth: "float32",
    frameCount: 48_000n
  },
  {
    id: "midi-1",
    kind: "midi",
    name: "Bass.mid",
    contentHash: "midi-hash",
    byteLength: 128
  }
]

function mountBrowser() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const project = useProjectStore()
  project.projectRef = {
    kind: "project-session",
    id: "project-1",
    epoch: "test-main",
    generation: 1
  }
  project.projectAssets = structuredClone(assets)
  return mount(MediaBrowserPanel, { global: { plugins: [pinia] } })
}

describe("MediaBrowserPanel", () => {
  beforeEach(() => {
    window.heron.startAssetAudition = vi.fn(async () => rpcSuccess(undefined))
    window.heron.stopAssetAudition = vi.fn(async () => rpcSuccess(undefined))
  })

  it("searches and filters the open project's audio and MIDI assets", async () => {
    const wrapper = mountBrowser()
    expect(wrapper.text()).toContain("Kick.mp3")
    expect(wrapper.text()).toContain("Bass.mid")

    expect(wrapper.get('input[type="search"]').attributes("aria-label")).toBe(
      "Search project assets"
    )

    await wrapper.get('input[type="search"]').setValue("bass")
    expect(wrapper.text()).not.toContain("Kick.mp3")
    expect(wrapper.text()).toContain("Bass.mid")

    await wrapper.get('input[type="search"]').setValue("")
    await wrapper.findAll(".filter-row button")[1]!.trigger("click")
    expect(wrapper.text()).toContain("Kick.mp3")
    expect(wrapper.text()).not.toContain("Bass.mid")
  })

  it("auditions only the selected audio asset and toggles the active preview", async () => {
    const wrapper = mountBrowser()
    const audioRow = wrapper.findAll(".asset-row")[0]!
    await audioRow.trigger("click")
    await wrapper.get('button[aria-label="Audition Kick.mp3"]').trigger("click")
    await flushPromises()

    expect(window.heron.startAssetAudition).toHaveBeenCalledWith(expect.any(Object), "audio-1")
    await wrapper.get('button[aria-label="Stop auditioning Kick.mp3"]').trigger("click")
    await flushPromises()
    expect(window.heron.stopAssetAudition).toHaveBeenCalledOnce()
  })
})
