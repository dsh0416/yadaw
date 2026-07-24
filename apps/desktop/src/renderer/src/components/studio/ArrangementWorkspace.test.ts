import { createPinia, setActivePinia } from "pinia"
import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { Asset } from "@yadaw/project-db/schema"
import { useProjectStore } from "../../stores/project"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"

const recordingAsset: Asset = {
  id: "recording-1",
  name: "First take.bwf",
  mimeType: "audio/x-bwf",
  contentHash: "hash",
  byteLength: 100n,
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n,
  bwfTimeReference: 0n,
  largeObjectOid: 1,
  createdAt: new Date()
}

describe("ArrangementWorkspace", () => {
  it("renders project audio as a selectable timeline clip", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.session = {
      id: "project",
      path: "project.yadaw",
      configuration: {
        name: "Session",
        sampleRate: 48_000,
        tempo: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: true,
      recoveredWorkingCopy: false
    }
    project.projectAssets = [recordingAsset]

    const wrapper = mount(ArrangementWorkspace, {
      props: { recordingId: null, recordingStartedAt: null, recordingError: "" },
      global: { plugins: [pinia] }
    })

    const clip = wrapper.get('button[aria-label="Audio clip First take"]')
    expect(clip.attributes("aria-pressed")).toBe("false")
    await clip.trigger("click")
    expect(clip.attributes("aria-pressed")).toBe("true")
    expect(wrapper.text()).toContain("First take")
    expect(wrapper.text()).toContain("1 clip")
    expect(wrapper.get(".waveform").attributes("style")).toContain("width: 1px")
    expect(wrapper.get('[aria-label="2 channels audio"]').findAll("path")).toHaveLength(2)
    expect(wrapper.text()).not.toContain("2 CH")
  })

  it("shows a growing capture clip while recording", () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const project = useProjectStore()
    project.session = {
      id: "project",
      path: "project.yadaw",
      configuration: {
        name: "Session",
        sampleRate: 48_000,
        tempo: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    }

    const wrapper = mount(ArrangementWorkspace, {
      props: {
        recordingId: "recording-live",
        recordingStartedAt: Date.now() - 1_000,
        recordingError: ""
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('button[aria-label="Recording New recording"]').attributes("aria-label"))
      .toBe("Recording New recording")
    expect(wrapper.text()).toContain("Recording")
  })
})
