import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginDescriptor, ProjectAssetSummary } from "@heron/contracts"
import { usePluginStore } from "../../stores/plugins"
import SoundBrowser from "./SoundBrowser.vue"
import { writePluginDrag } from "../plugins/plugin-drag"

vi.mock("../plugins/plugin-drag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-drag")>()),
  writePluginDrag: vi.fn()
}))

function descriptor(
  name: string,
  kind: "effect" | "instrument",
  format: "vst3" | "clap" = "vst3",
  compatibility: PluginDescriptor["compatibility"] = "compatible"
): PluginDescriptor {
  return {
    source: { kind: "external" },
    locator: { format, artifactPath: `/${name}.${format}`, nativeId: name },
    name,
    vendor: "Acme Audio",
    version: "1",
    categories: [kind === "effect" ? "Delay" : "Synth"],
    kind,
    architecture: "x86_64",
    buses: [],
    supportedAudioModes: ["stereo"],
    hasEditor: true,
    compatibility,
    compatibilityReason: compatibility === "compatible" ? null : "crashed during scan"
  }
}

const synth = descriptor("Bright Synth", "instrument")
const delay = descriptor("Echo Delay", "effect")
const clapEffect = descriptor("Clap Space", "effect", "clap", "quarantined")
const assets: ProjectAssetSummary[] = [
  {
    id: "asset-1",
    name: "Kick.wav",
    sampleRate: 48_000,
    channels: 2,
    bitDepth: "pcm24",
    frameCount: 24_000n
  }
]

function mountBrowser() {
  const store = usePluginStore()
  store.catalog = {
    scannerVersion: 7,
    scanning: false,
    scannedAt: 1,
    plugins: [synth, delay, clapEffect]
  }
  vi.spyOn(store, "load").mockResolvedValue()
  return {
    store,
    wrapper: mount(SoundBrowser, {
      props: { assets },
      global: {
        stubs: {
          PluginAudioModeMenu: {
            props: ["descriptor", "inputWidth"],
            emits: ["select", "cancel"],
            template:
              '<div class="mode-menu"><span>{{ descriptor.name }} {{ inputWidth }}</span><button class="select-mode" @click="$emit(\'select\', \'stereo\')">select</button><button class="cancel-mode" @click="$emit(\'cancel\')">cancel</button></div>'
          }
        }
      }
    })
  }
}

describe("SoundBrowser", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(writePluginDrag).mockReset()
  })

  it("loads the catalog and filters every browser section", async () => {
    const { store, wrapper } = mountBrowser()
    expect(store.load).toHaveBeenCalledOnce()
    expect(wrapper.findAll(".browser-tab").map((tab) => tab.find("small").text())).toEqual([
      "1",
      "1",
      "1",
      "3"
    ])
    expect(wrapper.find('[role="tabpanel"] .library-item').text()).toContain("Bright Synth")

    await wrapper.find(".search-field input").setValue("missing")
    expect(wrapper.find(".library-empty").exists()).toBe(true)

    await wrapper.find(".search-field input").setValue("kick")
    await wrapper.findAll(".browser-tab")[2]!.trigger("click")
    expect(wrapper.findAll('[role="tabpanel"]')[2]!.text()).toContain("Kick.wav")
  })

  it("opens mode selection and activates instruments and effects", async () => {
    const { store, wrapper } = mountBrowser()
    const activate = vi.spyOn(store, "activate").mockResolvedValue(true)
    const inputWidth = vi.spyOn(store, "requireSelectedEffectInputWidth").mockReturnValue("stereo")

    await wrapper.find(".library-item").trigger("dblclick")
    expect(wrapper.find(".mode-menu").text()).toContain("Bright Synth")
    await wrapper.find(".select-mode").trigger("click")
    expect(activate).toHaveBeenLastCalledWith({ descriptor: synth, audioMode: "stereo" })

    await wrapper.findAll(".browser-tab")[1]!.trigger("click")
    await wrapper.findAll('[role="tabpanel"]')[1]!.find(".library-item").trigger("dblclick")
    expect(inputWidth).toHaveBeenCalledOnce()
    expect(wrapper.find(".mode-menu").text()).toContain("Echo Delay stereo")
    await wrapper.find(".cancel-mode").trigger("click")
    expect(wrapper.find(".mode-menu").exists()).toBe(false)
  })

  it("does not open an effect when no channel width can be resolved", async () => {
    const { store, wrapper } = mountBrowser()
    vi.spyOn(store, "requireSelectedEffectInputWidth").mockReturnValue(null)
    await wrapper.findAll(".browser-tab")[1]!.trigger("click")
    await wrapper.findAll('[role="tabpanel"]')[1]!.find(".library-item").trigger("dblclick")
    expect(wrapper.find(".mode-menu").exists()).toBe(false)
  })

  it("supports plugin dragging, catalog format filtering, and rescanning", async () => {
    const { store, wrapper } = mountBrowser()
    const scan = vi.spyOn(store, "scan").mockResolvedValue()
    await wrapper.find(".library-item").trigger("dragstart")
    expect(writePluginDrag).toHaveBeenCalledWith(expect.anything(), {
      source: "catalog",
      descriptor: synth
    })

    await wrapper.findAll(".browser-tab")[3]!.trigger("click")
    const catalogPanel = wrapper.findAll('[role="tabpanel"]')[3]!
    expect(catalogPanel.findAll(".plugin-record")).toHaveLength(3)
    await catalogPanel.findAll(".plugin-format-filter button")[2]!.trigger("click")
    expect(catalogPanel.findAll(".plugin-record")).toHaveLength(1)
    expect(catalogPanel.text()).toContain("Clap Space")

    await catalogPanel.find(".plugin-scan button").trigger("click")
    expect(scan).toHaveBeenCalledWith(false)
  })
})
