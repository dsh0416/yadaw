import { afterEach, describe, expect, it } from "vitest"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import type { MixerChannelState, PluginDescriptor, PluginInstanceState } from "@heron/contracts"
import { PLUGIN_DRAG_TYPE } from "../plugins/plugin-drag"
import MixerPluginSection from "./MixerPluginSection.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  systemRole: null,
  name: "Vocal",
  color: "#4F8CFF",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  locator: { format: "vst3", artifactPath: "compressor.vst3", nativeId: "compressor" },
  name: "Compressor",
  vendor: "Heron Studio",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["mono", "mono-to-stereo", "stereo", "dual-mono"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const plugin: PluginInstanceState = {
  id: "plugin",
  channelId: "audio",
  role: "insert",
  slotOrder: 0,
  locator: descriptor.locator,
  descriptor,
  audioMode: "stereo",
  enabled: true,
  sidechainInputs: [],
  state: { version: 1, chunks: [] }
}

function rackDragData(instanceId: string) {
  return {
    types: [PLUGIN_DRAG_TYPE],
    effectAllowed: "move",
    dropEffect: "none",
    setData: () => undefined,
    getData: () => JSON.stringify({ source: "rack", instanceId })
  }
}

function setRowBounds(element: Element, top: number): void {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: top,
    top,
    right: 220,
    bottom: top + 24,
    left: 0,
    width: 220,
    height: 24,
    toJSON: () => undefined
  })
}

async function openPickerSubmenu(ariaLabel: string): Promise<void> {
  const trigger = document.body.querySelector<HTMLElement>(`[aria-label="${ariaLabel}"]`)
  expect(trigger).not.toBeNull()
  const menuTrigger = new DOMWrapper(trigger)
  await menuTrigger.trigger("focus")
  await menuTrigger.trigger("keydown", { key: "ArrowRight" })
  await flushPromises()
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerPluginSection", () => {
  it("offers compact open, bypass, remove, catalog drop, and empty-slot picker actions", async () => {
    const nextDescriptor = {
      ...descriptor,
      locator: { ...descriptor.locator, nativeId: "delay" },
      name: "Delay"
    }
    const wrapper = mount(MixerPluginSection, {
      attachTo: document.body,
      props: {
        channel,
        inserts: [plugin],
        runtime: {},
        effectPlugins: [nextDescriptor],
        slotRows: 4,
        initialInputWidth: "mono"
      }
    })

    await wrapper.get('button[aria-label="Open Compressor editor"]').trigger("click")
    expect(wrapper.emitted("open")?.at(-1)).toEqual(["plugin"])
    const pluginRow = wrapper.get('[aria-label="Compressor plugin active"]')
    expect(pluginRow.classes()).toContain("active")
    expect(pluginRow.find("i").exists()).toBe(false)
    expect(pluginRow.attributes("draggable")).toBeUndefined()
    expect(wrapper.get('[aria-label="Move Compressor"]').attributes("draggable")).toBe("true")
    await wrapper.get('button[aria-label="Bypass Compressor"]').trigger("click")
    expect(wrapper.emitted("toggle")?.at(-1)).toEqual(["plugin", false])
    await wrapper.get('button[aria-label="Remove Compressor"]').trigger("click")
    expect(wrapper.emitted("remove")?.at(-1)).toEqual(["plugin"])
    expect(wrapper.findAll(".plugin-row.empty")).toHaveLength(1)
    expect(wrapper.get('button[aria-label="Add VST3 audio effect"]').text()).toBe("")
    expect(wrapper.findAll(".plugin-row.alignment-spacer")).toHaveLength(2)

    await wrapper.find(".plugin-row.empty").trigger("drop", {
      dataTransfer: {
        types: [PLUGIN_DRAG_TYPE],
        getData: () =>
          JSON.stringify({
            source: "catalog",
            descriptor: nextDescriptor
          })
      }
    })
    expect(wrapper.emitted("insert")).toBeUndefined()
    await wrapper.get('button[title="Dual mono: 2 × (1 → 1)"]').trigger("click")
    expect(wrapper.emitted("insert")?.at(-1)).toEqual([
      { descriptor: nextDescriptor, audioMode: "dual-mono" },
      1
    ])

    const pickerTrigger = wrapper.get('button[aria-label="Add VST3 audio effect"]')
    await pickerTrigger.trigger("click")
    await flushPromises()
    expect(pickerTrigger.attributes("data-state")).toBe("open")
    await openPickerSubmenu("Browse Heron Studio plug-ins")
    await openPickerSubmenu("Choose Delay")
    expect(wrapper.emitted("insert")).toHaveLength(1)
    const stereoMode = document.body.querySelector<HTMLElement>('[title="Stereo: 2 → 2"]')
    expect(stereoMode).not.toBeNull()
    await new DOMWrapper(stereoMode).trigger("click")
    expect(wrapper.emitted("insert")?.at(-1)).toEqual([
      { descriptor: nextDescriptor, audioMode: "stereo" },
      1
    ])

    await wrapper.setProps({ inserts: [{ ...plugin, enabled: false }] })
    expect(wrapper.get('[aria-label="Compressor plugin bypassed"]').classes()).toContain("bypassed")

    await wrapper.setProps({
      runtime: {
        plugin: {
          instanceId: "plugin",
          state: "active",
          editorOpen: true,
          latencySamples: 0,
          tailSamples: 0,
          error: null
        }
      }
    })
    expect(wrapper.get('[aria-label="Compressor plugin bypassed"]').classes()).toContain("bypassed")
    expect(wrapper.get('button[aria-label="Enable Compressor"]').attributes("aria-pressed")).toBe(
      "false"
    )

    await wrapper.setProps({
      runtime: {
        plugin: {
          instanceId: "plugin",
          state: "failed",
          editorOpen: false,
          latencySamples: 0,
          tailSamples: 0,
          error: "Could not load"
        }
      }
    })
    expect(wrapper.get('[aria-label="Compressor plugin failed"]').classes()).toContain("failed")
  })

  it("offers only mono-input modes at the start of a mono insert chain", async () => {
    const wrapper = mount(MixerPluginSection, {
      attachTo: document.body,
      props: {
        channel,
        inserts: [],
        runtime: {},
        effectPlugins: [descriptor],
        slotRows: 1,
        initialInputWidth: "mono"
      }
    })

    await wrapper.get('button[aria-label="Add VST3 audio effect"]').trigger("click")
    await flushPromises()
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search VST3 audio effects"]'
    )
    expect(search).not.toBeNull()
    await new DOMWrapper(search).setValue("missing")
    expect(document.body.textContent).toContain("No plug-ins match this search.")
    await new DOMWrapper(search).setValue("compressor")

    expect(document.body.querySelector('[title="Mono: 1 → 1"]')).not.toBeNull()
    expect(document.body.querySelector('[title="Mono to stereo: 1 → 2"]')).not.toBeNull()
    expect(document.body.querySelector('[title="Stereo: 2 → 2"]')).toBeNull()
    expect(document.body.querySelector('[title="Dual mono: 2 × (1 → 1)"]')).toBeNull()
    wrapper.unmount()
  })

  it("snaps rack moves before or after a row and previews the final slot", async () => {
    const delayDescriptor = {
      ...descriptor,
      locator: { ...descriptor.locator, nativeId: "delay" },
      name: "Delay"
    }
    const delayPlugin: PluginInstanceState = {
      ...plugin,
      id: "delay-plugin",
      locator: delayDescriptor.locator,
      descriptor: delayDescriptor,
      slotOrder: 1
    }
    const wrapper = mount(MixerPluginSection, {
      props: {
        channel,
        inserts: [plugin, delayPlugin],
        runtime: {},
        effectPlugins: [],
        slotRows: 3,
        initialInputWidth: "stereo"
      }
    })

    const compressorRow = wrapper.get('[aria-label="Compressor plugin active"]')
    const delayRow = wrapper.get('[aria-label="Delay plugin active"]')
    const compressorGrip = wrapper.get('[aria-label="Move Compressor"]')
    const delayGrip = wrapper.get('[aria-label="Move Delay"]')
    setRowBounds(delayRow.element, 100)
    const compressorDrag = rackDragData("plugin")

    await compressorGrip.trigger("dragstart", { dataTransfer: compressorDrag })
    await delayRow.trigger("dragover", { clientY: 121, dataTransfer: compressorDrag })

    const afterPreview = wrapper.get('[data-testid="plugin-drop-preview"]')
    expect(afterPreview.attributes("aria-label")).toBe("Drop at effect slot 2")
    expect(afterPreview.text()).toBe("")

    await afterPreview.trigger("drop", { dataTransfer: compressorDrag })
    expect(wrapper.emitted("move")?.at(-1)).toEqual(["plugin", 1])
    expect(wrapper.find('[data-testid="plugin-drop-preview"]').exists()).toBe(false)
    await compressorGrip.trigger("dragend", { dataTransfer: compressorDrag })

    setRowBounds(compressorRow.element, 100)
    const delayDrag = rackDragData("delay-plugin")
    await delayGrip.trigger("dragstart", { dataTransfer: delayDrag })
    await compressorRow.trigger("dragover", { clientY: 103, dataTransfer: delayDrag })

    const beforePreview = wrapper.get('[data-testid="plugin-drop-preview"]')
    expect(beforePreview.attributes("aria-label")).toBe("Drop at effect slot 1")
    expect(beforePreview.text()).toBe("")

    await delayGrip.trigger("dragend", { dataTransfer: delayDrag })
    expect(wrapper.find('[data-testid="plugin-drop-preview"]').exists()).toBe(false)
  })

  it("transfers the snap preview when a drag enters an adjacent mixer strip", async () => {
    const adjacentDescriptor = {
      ...descriptor,
      locator: { ...descriptor.locator, nativeId: "adjacent-fx" },
      name: "Adjacent FX"
    }
    const adjacentPlugin: PluginInstanceState = {
      ...plugin,
      id: "adjacent-plugin",
      channelId: "adjacent",
      locator: adjacentDescriptor.locator,
      descriptor: adjacentDescriptor
    }
    const commonProps = {
      runtime: {},
      effectPlugins: [],
      slotRows: 2,
      initialInputWidth: "stereo" as const
    }
    const sourceStrip = mount(MixerPluginSection, {
      props: {
        ...commonProps,
        channel,
        inserts: [plugin]
      }
    })
    const adjacentStrip = mount(MixerPluginSection, {
      props: {
        ...commonProps,
        channel: { ...channel, id: "adjacent", name: "Adjacent" },
        inserts: [adjacentPlugin]
      }
    })
    const sourceRow = sourceStrip.get('[aria-label="Compressor plugin active"]')
    const adjacentRow = adjacentStrip.get('[aria-label="Adjacent FX plugin active"]')
    const sourceGrip = sourceStrip.get('[aria-label="Move Compressor"]')
    setRowBounds(sourceRow.element, 100)
    setRowBounds(adjacentRow.element, 100)
    const dragData = rackDragData("plugin")

    await sourceGrip.trigger("dragstart", { dataTransfer: dragData })
    await sourceRow.trigger("dragover", { clientY: 103, dataTransfer: dragData })
    expect(sourceStrip.find('[data-testid="plugin-drop-preview"]').exists()).toBe(true)

    await adjacentRow.trigger("dragover", { clientY: 103, dataTransfer: dragData })
    expect(sourceStrip.find('[data-testid="plugin-drop-preview"]').exists()).toBe(false)
    expect(adjacentStrip.find('[data-testid="plugin-drop-preview"]').exists()).toBe(true)

    await sourceGrip.trigger("dragend", { dataTransfer: dragData })
    expect(adjacentStrip.find('[data-testid="plugin-drop-preview"]').exists()).toBe(false)
    sourceStrip.unmount()
    adjacentStrip.unmount()
  })
})
