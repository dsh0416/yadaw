import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createI18n } from "vue-i18n"
import type { MixerChannelState, ProjectWorkspaceSnapshot } from "@heron/contracts"
import { useBounceStore } from "../../stores/bounce"
import { useMixerStore } from "../../stores/mixer"
import { useProjectStore } from "../../stores/project"
import BounceOutputDialog from "./BounceOutputDialog.vue"

vi.mock("@heron/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heron/ui")>()),
  UiDialog: {
    props: ["modelValue", "title", "dismissible"],
    emits: ["update:modelValue"],
    template: `<section v-if="modelValue" :data-title="title" :data-dismissible="dismissible">
      <slot /><slot name="actions" />
    </section>`
  },
  UiButton: {
    props: ["disabled", "loading"],
    emits: ["click"],
    template: `<button :disabled="disabled" :data-loading="loading" @click="$emit('click')"><slot /></button>`
  },
  UiSelect: {
    props: ["modelValue", "options"],
    emits: ["update:modelValue"],
    template: `<select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)">
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>`
  }
}))

const output: MixerChannelState = {
  id: "output-1-2",
  kind: "output",
  systemRole: null,
  name: "Output 1–2",
  color: "#73d6c9",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: [1, 2]
}

function testI18n() {
  return createI18n({
    legacy: false,
    locale: "en",
    messages: {
      en: {
        bounce: {
          eyebrow: "Bounce",
          title: "Bounce {output}",
          description: "Export this output",
          sections: { channels: "Channels" },
          fields: { channels: "Channel mode" },
          channels: { stereo: "Stereo", mono: "Mono" },
          monoHelp: "Mono uses a safe fold-down.",
          actions: {
            close: "Close",
            cancel: "Cancel",
            export: "Export",
            starting: "Starting"
          }
        }
      }
    }
  })
}

function prepareStore() {
  setActivePinia(createPinia())
  const mixer = useMixerStore()
  const workspace: ProjectWorkspaceSnapshot = {
    project: { kind: "project-session", id: "project", epoch: "test", generation: 1 },
    projectGraph: { kind: "project-graph", id: "graph", epoch: "test", generation: 1 },
    revision: 4,
    session: {
      id: "project",
      path: "mix.heron",
      dirty: false,
      recoveredWorkingCopy: false,
      configuration: {
        name: "Mix",
        sampleRate: 96_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      }
    },
    graph: {
      ...structuredClone(mixer.graph),
      projectEndTick: 7_680,
      sampleRate: 96_000,
      channels: [...mixer.graph.channels.filter((channel) => channel.kind !== "output"), output]
    },
    assets: []
  }
  useProjectStore().applyWorkspace(workspace)
  mixer.hydrate(workspace.graph)
  const store = useBounceStore()
  store.openFor(output)
  return store
}

function mountDialog() {
  return mount(BounceOutputDialog, {
    global: {
      plugins: [testI18n()],
      stubs: {
        BounceFormatForm: {
          props: ["settings", "sampleRate", "projectSampleRate"],
          emits: ["updateSettings", "updateSampleRate"],
          template: `<button data-test="format" @click="$emit('updateSettings', { format: 'mp3', bitrate: { mode: 'cbr', kbps: 320 } })" />
            <button data-test="sample-rate" @click="$emit('updateSampleRate', 48000)" />`
        },
        BounceNormalizationForm: {
          emits: ["update:modelValue"],
          template: `<button data-test="normalization" @click="$emit('update:modelValue', { mode: 'off' })" />`
        },
        BounceRangeForm: {
          props: ["startBar", "endBar", "maximumBar", "includeTail"],
          emits: ["updateStartBar", "updateEndBar", "updateIncludeTail"],
          template: `<button data-test="start-bar" @click="$emit('updateStartBar', 2)" />
            <button data-test="end-bar" @click="$emit('updateEndBar', 3)" />
            <button data-test="include-tail" @click="$emit('updateIncludeTail', false)" />`
        }
      }
    }
  })
}

describe("BounceOutputDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("orchestrates format, normalization, channel, range, and tail settings", async () => {
    const store = prepareStore()
    const wrapper = mountDialog()

    expect(wrapper.get("section").attributes("data-title")).toBe("Bounce Output 1–2")
    await wrapper.get('[data-test="format"]').trigger("click")
    await wrapper.get('[data-test="sample-rate"]').trigger("click")
    await wrapper.get('[data-test="normalization"]').trigger("click")
    await wrapper.get("select").setValue("mono")
    await wrapper.get('[data-test="start-bar"]').trigger("click")
    await wrapper.get('[data-test="end-bar"]').trigger("click")
    await wrapper.get('[data-test="include-tail"]').trigger("click")

    expect(store.format.format).toBe("mp3")
    expect(store.sampleRate).toBe(48_000)
    expect(store.normalization).toEqual({ mode: "off" })
    expect(store.channelMode).toBe("mono")
    expect(store.startBar).toBe(2)
    expect(store.endBar).toBe(3)
    expect(store.includeTail).toBe(false)
    expect(wrapper.text()).toContain("Mono uses a safe fold-down.")
  })

  it("connects action state and displays operation errors", async () => {
    const store = prepareStore()
    store.error = "Export failed"
    const close = vi.spyOn(store, "close")
    const start = vi.spyOn(store, "start").mockResolvedValue(false)
    const wrapper = mountDialog()
    const buttons = wrapper.findAll("button")

    expect(wrapper.get('[role="alert"]').text()).toBe("Export failed")
    await buttons.at(-1)!.trigger("click")
    expect(start).toHaveBeenCalledOnce()

    store.starting = true
    await wrapper.vm.$nextTick()
    expect(wrapper.get("section").attributes("data-dismissible")).toBe("false")
    expect(buttons.at(-2)!.attributes("disabled")).toBeDefined()
    expect(buttons.at(-1)!.attributes("data-loading")).toBe("true")

    store.starting = false
    await wrapper.vm.$nextTick()
    await buttons.at(-2)!.trigger("click")
    expect(close).toHaveBeenCalledOnce()
  })
})
