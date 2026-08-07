import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { defineComponent } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectSession, ProjectWorkspaceSnapshot } from "@heron/contracts"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useAudioPreferencesStore } from "../stores/audioPreferences"
import { useMidiInputStore } from "../stores/midiInput"
import { useMixerStore } from "../stores/mixer"
import { useProjectStore } from "../stores/project"
import ProjectSettingsView from "./ProjectSettingsView.vue"
import SystemSettingsView from "./SystemSettingsView.vue"
import WelcomeView from "./WelcomeView.vue"

const EmptyRoute = defineComponent({ template: "<div />" })
const session: ProjectSession = {
  id: "project",
  path: "/projects/session.heron",
  configuration: {
    name: "Session",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

function workspace(): ProjectWorkspaceSnapshot {
  return {
    project: { kind: "project-session", id: "project", epoch: "main", generation: 1 },
    projectGraph: { kind: "project-graph", id: "graph", epoch: "main", generation: 1 },
    revision: 1,
    session,
    graph: {
      sampleRate: 48_000,
      tracks: [],
      channels: [],
      audioClips: [],
      sends: [],
      plugins: [],
      midiClips: [],
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      },
      keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
    },
    assets: []
  }
}

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "welcome", component: EmptyRoute },
      { path: "/studio", name: "studio", component: EmptyRoute },
      { path: "/system", name: "system-settings", component: EmptyRoute },
      { path: "/project", name: "project-settings", component: EmptyRoute }
    ]
  })
}

describe("route views", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("loads settings diagnostics and delegates every system settings action", async () => {
    const app = useApplicationSettingsStore()
    const audio = useAudioPreferencesStore()
    const midi = useMidiInputStore()
    const loadSettings = vi.spyOn(app, "load").mockResolvedValue()
    const loadMidi = vi.spyOn(midi, "load").mockResolvedValue()
    const refresh = vi.spyOn(app, "refreshAudioHostRuntimeDiagnostics").mockResolvedValue()
    const configureRuntime = vi.spyOn(app, "configureAudioHostRuntime").mockResolvedValue()
    const configureMidi = vi.spyOn(midi, "configure").mockResolvedValue(true)
    const applyAudio = vi.spyOn(audio, "apply").mockResolvedValue(true)
    const navigation = router()
    await navigation.push("/system")
    const wrapper = mount(SystemSettingsView, {
      global: {
        plugins: [navigation],
        stubs: {
          SystemSettingsPage: {
            emits: ["close", "apply-audio", "configure-runtime", "configure-midi"],
            template:
              '<div><button class="close" @click="$emit(\'close\')"/><button class="audio" @click="$emit(\'apply-audio\', {})"/><button class="runtime" @click="$emit(\'configure-runtime\', {})"/><button class="midi" @click="$emit(\'configure-midi\', {})"/></div>'
          }
        }
      }
    })
    await flushPromises()

    expect(loadSettings).toHaveBeenCalledOnce()
    expect(loadMidi).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    await wrapper.find(".runtime").trigger("click")
    await wrapper.find(".midi").trigger("click")
    await wrapper.find(".audio").trigger("click")
    await flushPromises()
    expect(configureRuntime).toHaveBeenCalledOnce()
    expect(configureMidi).toHaveBeenCalledOnce()
    expect(applyAudio).toHaveBeenCalledOnce()
    expect(navigation.currentRoute.value.name).toBe("welcome")
  })

  it("redirects project settings without a session", async () => {
    const navigation = router()
    await navigation.push("/project")
    mount(ProjectSettingsView, { global: { plugins: [navigation] } })
    await flushPromises()
    expect(navigation.currentRoute.value.name).toBe("welcome")
  })

  it("saves project settings, reports failures, and closes to the studio", async () => {
    const project = useProjectStore()
    project.applyLifecycleState({ status: "open", session, error: null })
    const save = vi
      .spyOn(project, "updateConfiguration")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("disk full"))
    const navigation = router()
    await navigation.push("/project")
    const wrapper = mount(ProjectSettingsView, {
      global: {
        plugins: [navigation],
        stubs: {
          ProjectSettingsPage: {
            props: ["configuration", "saving", "error", "saved"],
            emits: ["save", "close"],
            template:
              '<div><span class="state">{{ saving }} {{ saved }} {{ error }}</span><button class="save" @click="$emit(\'save\', configuration)"/><button class="close" @click="$emit(\'close\')"/></div>'
          }
        }
      }
    })

    await wrapper.find(".save").trigger("click")
    await flushPromises()
    expect(save).toHaveBeenCalledWith(session.configuration)
    expect(wrapper.find(".state").text()).toContain("true")

    await wrapper.find(".save").trigger("click")
    await flushPromises()
    expect(wrapper.find(".state").text()).toContain("disk full")

    await wrapper.find(".close").trigger("click")
    await flushPromises()
    expect(navigation.currentRoute.value.name).toBe("studio")
  })

  it("hydrates and enters the studio after creating or opening a workspace", async () => {
    const settings = useApplicationSettingsStore()
    const project = useProjectStore()
    const mixer = useMixerStore()
    vi.spyOn(settings, "load").mockResolvedValue()
    const create = vi.spyOn(project, "create").mockResolvedValue(workspace())
    const open = vi.spyOn(project, "open").mockResolvedValue(workspace())
    const hydrate = vi.spyOn(mixer, "hydrate")
    const navigation = router()
    await navigation.push("/")
    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [navigation],
        stubs: {
          ProjectWelcome: {
            emits: ["create", "open"],
            template:
              "<div><button class=\"create\" @click=\"$emit('create', { name: 'New' })\"/><button class=\"open\" @click=\"$emit('open', '/project.heron')\"/></div>"
          }
        }
      }
    })
    await wrapper.find(".create").trigger("click")
    await flushPromises()
    expect(create).toHaveBeenCalledOnce()
    expect(hydrate).toHaveBeenCalledWith(workspace().graph)
    expect(navigation.currentRoute.value.name).toBe("studio")

    await navigation.push("/")
    await wrapper.find(".open").trigger("click")
    await flushPromises()
    expect(open).toHaveBeenCalledWith("/project.heron")
    expect(hydrate).toHaveBeenCalledTimes(2)
  })

  it("stays on welcome when project selection is cancelled", async () => {
    const project = useProjectStore()
    vi.spyOn(useApplicationSettingsStore(), "load").mockResolvedValue()
    vi.spyOn(project, "open").mockResolvedValue(null)
    const navigation = router()
    await navigation.push("/")
    const wrapper = mount(WelcomeView, {
      global: {
        plugins: [navigation],
        stubs: {
          ProjectWelcome: {
            emits: ["open"],
            template: '<button class="open" @click="$emit(\'open\')" />'
          }
        }
      }
    })
    await wrapper.find(".open").trigger("click")
    await flushPromises()
    expect(navigation.currentRoute.value.name).toBe("welcome")
  })
})
