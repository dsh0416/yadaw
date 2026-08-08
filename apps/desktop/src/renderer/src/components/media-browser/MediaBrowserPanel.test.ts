import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAssetSummary } from "@heron/contracts"
import { rpcFailure, rpcSuccess } from "../../test/ipc"
import { useProjectStore } from "../../stores/project"
import { useMidiImportStore } from "../../stores/midiImport"
import { useMediaBrowserStore } from "../../stores/mediaBrowser"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import { PROJECT_MEDIA_DRAG_TYPE } from "../../utils/mediaDrag"
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

  it("imports both media kinds, closes the panel, and exports project drag data", async () => {
    const wrapper = mountBrowser()
    const project = useProjectStore()
    const midiImport = useMidiImportStore()
    const workspace = useStudioWorkspaceStore()
    const importAudio = vi.spyOn(project, "importAudio").mockResolvedValue(["audio-1"])
    const prepareMidi = vi.spyOn(midiImport, "prepare").mockResolvedValue(undefined)
    const close = vi.spyOn(workspace, "closeRightPanel")

    await wrapper.findAll(".import-row button")[0]!.trigger("click")
    await flushPromises()
    expect(importAudio).toHaveBeenCalledOnce()
    importAudio.mockResolvedValueOnce([])
    await wrapper.findAll(".import-row button")[0]!.trigger("click")
    await flushPromises()
    expect(useMediaBrowserStore().selectedAssetId).toBe("audio-1")

    await wrapper.findAll(".import-row button")[1]!.trigger("click")
    await flushPromises()
    expect(prepareMidi).toHaveBeenCalledOnce()

    const setData = vi.fn()
    const dataTransfer = { effectAllowed: "none", setData } as unknown as DataTransfer
    await wrapper.findAll(".asset-row")[0]!.trigger("dragstart", { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe("copy")
    expect(setData).toHaveBeenCalledWith(
      PROJECT_MEDIA_DRAG_TYPE,
      JSON.stringify({ assetId: "audio-1", kind: "audio" })
    )

    await wrapper.get('button[aria-label="Close Media Browser"]').trigger("click")
    expect(close).toHaveBeenCalledOnce()
  })

  it("reconciles focus selection and handles zero-rate audio and drags without transfer data", async () => {
    const wrapper = mountBrowser()
    const project = useProjectStore()
    const media = useMediaBrowserStore()
    project.projectAssets = [{ ...assets[0]!, sampleRate: 0 }, assets[1]!] as ProjectAssetSummary[]
    await wrapper.vm.$nextTick()
    const audioRow = wrapper.findAll(".asset-row")[0]!

    await audioRow.trigger("focus")
    await audioRow.trigger("keydown", { key: "Enter" })
    await audioRow.trigger("dragstart")
    expect(media.selectedAssetId).toBe("audio-1")
    expect(audioRow.text()).toContain("0.0 s")

    project.projectAssets = [assets[1]!]
    await wrapper.vm.$nextTick()
    expect(media.selectedAssetId).toBeNull()
  })

  it("keeps the audition control active and reports a native stop failure", async () => {
    const wrapper = mountBrowser()
    await wrapper.get('button[aria-label="Audition Kick.mp3"]').trigger("click")
    await flushPromises()
    window.heron.stopAssetAudition = vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))

    await wrapper.get('button[aria-label="Stop auditioning Kick.mp3"]').trigger("click")
    await flushPromises()

    expect(wrapper.find('button[aria-label="Stop auditioning Kick.mp3"]').exists()).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toBe(
      "The audio asset could not be auditioned on the current Output."
    )
  })
})
