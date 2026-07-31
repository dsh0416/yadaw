import { flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { defineComponent, h } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ApplicationBootstrapSnapshot,
  ApplicationCommandId,
  ProjectSession,
  ProjectWorkspaceSnapshot
} from "@yadaw/contracts"
import { useApplicationCommands } from "./useApplicationCommands"
import { useGlobalDialog } from "./useGlobalDialog"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"

const session: ProjectSession = {
  id: "project",
  path: "session.yadaw",
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

function workspace(value: ProjectSession): ProjectWorkspaceSnapshot {
  return {
    project: {
      kind: "project-session",
      id: value.id,
      epoch: "main-epoch",
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: `${value.id}:graph`,
      epoch: "main-epoch",
      generation: 1
    },
    revision: 1,
    session: value,
    graph: {
      sampleRate: value.configuration.sampleRate,
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

function closedBootstrap(): ApplicationBootstrapSnapshot {
  return {
    protocolVersion: 2,
    mainEpoch: "main-epoch",
    desktopSession: {
      kind: "desktop-session",
      id: "desktop",
      epoch: "main-epoch",
      generation: 1
    },
    applicationSettings: {
      kind: "application-settings",
      id: "settings",
      epoch: "main-epoch",
      generation: 1
    },
    audioResources: {
      host: {
        kind: "audio-host",
        id: "audio-host",
        epoch: "main-epoch",
        generation: 1
      },
      engine: null,
      transport: null,
      revision: 0
    },
    recordingResource: null,
    revision: 2,
    lifecycle: {
      revision: 2,
      project: { status: "closed", error: null },
      audio: {} as ApplicationBootstrapSnapshot["lifecycle"]["audio"],
      recording: { status: "idle", error: null }
    },
    settings: {} as ApplicationBootstrapSnapshot["settings"],
    workspace: null
  }
}

function createHarness() {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "welcome", component: { template: "<div />" } },
      { path: "/studio", name: "studio", component: { template: "<div />" } },
      {
        path: "/settings/project",
        name: "project-settings",
        component: { template: "<div />" }
      },
      {
        path: "/settings/system",
        name: "system-settings",
        component: { template: "<div />" }
      }
    ]
  })
  const Harness = defineComponent({
    setup() {
      const { execute } = useApplicationCommands()
      const button = (command: ApplicationCommandId, label: string) =>
        h("button", { type: "button", onClick: () => execute(command) }, label)
      return () =>
        h("div", [
          button("application.preferences", "Preferences"),
          button("project.settings", "Project settings")
        ])
    }
  })
  const wrapper = mount(Harness, {
    global: { plugins: [pinia, router] }
  })
  useAudioRuntimeStore(pinia).applyResources({
    host: {
      kind: "audio-host",
      id: "audio-host",
      epoch: "main-epoch",
      generation: 1
    },
    engine: {
      kind: "audio-engine",
      id: "audio-engine",
      epoch: "main-epoch",
      generation: 1
    },
    transport: {
      kind: "transport",
      id: "transport",
      epoch: "main-epoch",
      generation: 1
    },
    revision: 0
  })
  return { pinia, router, wrapper }
}

describe("useApplicationCommands", () => {
  let nativeCommandListener: ((command: ApplicationCommandId) => void) | null

  beforeEach(() => {
    vi.clearAllMocks()
    nativeCommandListener = null
    Object.defineProperty(window.yadaw, "platform", {
      configurable: true,
      value: "win32"
    })
    window.yadaw.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
    })
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "transport",
      operationId: "transport-operation",
      resourceRevision: 1,
      value: {
        state: "stopped",
        positionFrames: 0,
        sampleRate: 48_000
      },
      warnings: []
    })
  })

  it("opens application preferences without requiring a project", async () => {
    const { router, wrapper } = createHarness()

    await wrapper.get("button:nth-of-type(1)").trigger("click")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("system-settings")
  })

  it("opens project settings only while a project is open", async () => {
    const { pinia, router, wrapper } = createHarness()

    await wrapper.get("button:nth-of-type(2)").trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.name).not.toBe("project-settings")

    useProjectStore(pinia).applyLifecycleState({
      status: "open",
      session,
      error: null
    })
    await wrapper.get("button:nth-of-type(2)").trigger("click")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("project-settings")
  })

  it("routes macOS system-menu commands through the same command dispatcher", async () => {
    const { router } = createHarness()

    nativeCommandListener?.("application.preferences")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("system-settings")
  })

  it.each(["window.close", "application.quit"] as const)(
    "prompts before %s and continues only after the dirty project is closed",
    async (command) => {
      window.yadaw.closeProject = vi.fn().mockResolvedValue({
        ok: true,
        requestId: "close",
        value: { closed: true, snapshot: closedBootstrap() },
        warnings: []
      })
      const { pinia } = createHarness()
      useProjectStore(pinia).applyWorkspace(workspace({ ...session, dirty: true }))
      const { activeDialog, selectDialogAction } = useGlobalDialog()

      nativeCommandListener?.(command)
      await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
      expect(window.yadaw.executeApplicationWindowCommand).not.toHaveBeenCalledWith(command)
      expect(window.yadaw.transportCommand).not.toHaveBeenCalled()
      selectDialogAction("discard")
      await flushPromises()

      expect(window.yadaw.transportCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ kind: "transport" }),
          expectedRevision: 0,
          mutation: expect.any(Object)
        }),
        { type: "pause" }
      )
      expect(window.yadaw.closeProject).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ kind: "project-session" }),
          mutation: expect.any(Object)
        }),
        "discard"
      )
      expect(window.yadaw.executeApplicationWindowCommand).toHaveBeenCalledWith(command)
    }
  )

  it("keeps the current dirty project when switching projects is cancelled", async () => {
    window.yadaw.prepareOpenProject = vi.fn()
    const { pinia } = createHarness()
    const projectStore = useProjectStore(pinia)
    projectStore.applyWorkspace(workspace({ ...session, dirty: true }))
    const { activeDialog, dismissDialog } = useGlobalDialog()

    nativeCommandListener?.("project.open")
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    dismissDialog()
    await flushPromises()

    expect(window.yadaw.closeProject).not.toHaveBeenCalled()
    expect(window.yadaw.prepareOpenProject).not.toHaveBeenCalled()
    expect(projectStore.session?.path).toBe(session.path)
  })
})
