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
} from "@heron/contracts"
import { useApplicationCommands } from "./useApplicationCommands"
import { useGlobalDialog } from "./useGlobalDialog"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useAboutStore } from "../stores/about"
import { useProjectStore } from "../stores/project"
import { useMixerStore } from "../stores/mixer"
import { usePianoRollStore } from "../stores/pianoRoll"
import { useTransportStore } from "../stores/transport"
import { useAudioBenchmarkStore } from "../stores/audioBenchmark"
import { useCompiledEffectGraphStore } from "../stores/compiledEffectGraph"
import { useStudioWorkflowStore } from "../stores/studioWorkflow"
import { useStudioWorkspaceStore } from "../stores/studioWorkspace"
import { useApplicationWindowStore } from "../stores/applicationWindow"
import { rpcEvent } from "../test/ipc"

const session: ProjectSession = {
  id: "project",
  path: "session.heron",
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
    offlineTools: {
      worker: {
        kind: "offline-worker",
        id: "offline-tools",
        epoch: "offline-epoch",
        generation: 1
      },
      revision: 1
    },
    audioResources: {
      host: {
        kind: "audio-host",
        id: "audio-host",
        epoch: "main-epoch",
        generation: 1
      },
      midiRuntime: {
        kind: "midi-runtime",
        id: "midi-runtime",
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
          button("project.settings", "Project settings"),
          button("transport.toggle-loop", "Cycle"),
          button("edit.split-at-playhead", "Split")
        ])
    }
  })
  const wrapper = mount(Harness, {
    global: { plugins: [pinia, router] }
  })
  useAudioRuntimeStore(pinia).applyResources({
    midiRuntime: {
      kind: "midi-runtime",
      id: "midi-runtime",
      epoch: "main-epoch",
      generation: 1
    },
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
  let nativeCommandListener: Parameters<typeof window.heron.subscribeApplicationCommands>[0] | null

  beforeEach(() => {
    vi.clearAllMocks()
    nativeCommandListener = null
    Object.defineProperty(window.heron, "platform", {
      configurable: true,
      value: "win32"
    })
    window.heron.subscribeApplicationCommands = vi.fn((listener) => {
      nativeCommandListener = listener
      return () => undefined
    })
    window.heron.transportCommand = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "transport",
      operationId: "transport-operation",
      resourceRevision: 1,
      value: {
        state: "stopped",
        positionFrames: 0,
        sampleRate: 48_000,
        loopEnabled: false,
        loopRange: null
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

    nativeCommandListener?.(rpcEvent("application.preferences"))
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("system-settings")
  })

  it("splits the selected audio clip at the playhead from the application command", async () => {
    const { pinia, router, wrapper } = createHarness()
    const openWorkspace = workspace(session)
    openWorkspace.graph = {
      ...openWorkspace.graph,
      audioClips: [
        {
          id: "audio-1",
          assetId: "asset-1",
          trackId: "track:audio-1",
          name: "Take",
          startFrame: 0,
          sourceOffsetFrames: 0,
          sourceLengthFrames: 96_000,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          lengthFrames: 48_000,
          assetSampleRate: 48_000,
          assetChannels: 2
        }
      ]
    }
    useProjectStore(pinia).applyWorkspace(openWorkspace)
    useMixerStore(pinia).hydrate(openWorkspace.graph)
    useTransportStore(pinia).selectClip("audio-1")
    useTransportStore(pinia).snapshot = {
      state: "stopped",
      positionFrames: 24_000,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    const execute = vi.spyOn(useMixerStore(pinia), "execute").mockResolvedValue(true)
    await router.push({ name: "studio" })

    await wrapper.get("button:nth-of-type(4)").trigger("click")
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "batch",
      commands: [
        {
          type: "update-audio-clip",
          clipId: "audio-1",
          patch: { lengthFrames: 24_000, fadeInFrames: 0, fadeOutFrames: 0 }
        },
        {
          type: "create-audio-clip",
          clip: expect.objectContaining({
            startFrame: 24_000,
            sourceOffsetFrames: 24_000,
            lengthFrames: 24_000
          })
        }
      ]
    })
  })

  it("splits selected MIDI clips at the playhead when no audio clip is selected", async () => {
    const { pinia, router, wrapper } = createHarness()
    const openWorkspace = workspace(session)
    openWorkspace.graph = {
      ...openWorkspace.graph,
      midiClips: [
        {
          id: "midi-1",
          sourceId: "source-1",
          trackId: "track:instrument-1",
          name: "Verse",
          startTick: 0,
          sourceOffsetTicks: 0,
          lengthTicks: 3_840,
          sourceLengthTicks: 3_840,
          notes: [],
          events: []
        }
      ]
    }
    useProjectStore(pinia).applyWorkspace(openWorkspace)
    useMixerStore(pinia).hydrate(openWorkspace.graph)
    usePianoRollStore(pinia).selectArrangementClip("midi-1")
    useTransportStore(pinia).snapshot = {
      state: "stopped",
      positionFrames: 48_000,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
    const execute = vi.spyOn(useMixerStore(pinia), "execute").mockResolvedValue(true)
    await router.push({ name: "studio" })

    await wrapper.get("button:nth-of-type(4)").trigger("click")
    await flushPromises()

    expect(execute).toHaveBeenCalledWith({
      type: "batch",
      commands: expect.arrayContaining([
        {
          type: "update-midi-clip-range",
          clipId: "midi-1",
          patch: { lengthTicks: 1_920 }
        }
      ])
    })
  })

  it("creates a one-bar range when Cycle is invoked without an existing range", async () => {
    const { pinia, router, wrapper } = createHarness()
    const openWorkspace = workspace(session)
    useProjectStore(pinia).applyWorkspace(openWorkspace)
    useMixerStore(pinia).hydrate(openWorkspace.graph)
    vi.mocked(window.heron.transportCommand).mockResolvedValueOnce({
      ok: true,
      requestId: "cycle",
      operationId: "cycle-operation",
      resourceRevision: 1,
      value: {
        state: "stopped",
        positionFrames: 0,
        sampleRate: 48_000,
        loopEnabled: true,
        loopRange: { startTick: 0, endTick: 3_840 }
      },
      warnings: []
    })
    await router.push({ name: "studio" })

    await wrapper.get("button:nth-of-type(3)").trigger("click")
    await flushPromises()

    expect(window.heron.transportCommand).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ kind: "transport" }) }),
      {
        type: "set-loop",
        enabled: true,
        range: { startTick: 0, endTick: 3_840 }
      }
    )
    expect(useTransportStore(pinia).loopRange).toEqual({ startTick: 0, endTick: 3_840 })
  })

  it("opens the renderer About dialog from a native application-menu command", async () => {
    const { pinia } = createHarness()

    nativeCommandListener?.(rpcEvent("application.about"))
    await flushPromises()

    expect(useAboutStore(pinia).isOpen).toBe(true)
    expect(window.heron.executeApplicationWindowCommand).not.toHaveBeenCalled()
  })

  it.each(["window.close", "application.quit"] as const)(
    "prompts before %s and continues only after the dirty project is closed",
    async (command) => {
      window.heron.closeProject = vi.fn().mockResolvedValue({
        ok: true,
        requestId: "close",
        value: { closed: true, snapshot: closedBootstrap() },
        warnings: []
      })
      const { pinia } = createHarness()
      useProjectStore(pinia).applyWorkspace(workspace({ ...session, dirty: true }))
      const { activeDialog, selectDialogAction } = useGlobalDialog()

      nativeCommandListener?.(rpcEvent(command))
      await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
      expect(window.heron.executeApplicationWindowCommand).not.toHaveBeenCalledWith(command)
      expect(window.heron.transportCommand).not.toHaveBeenCalled()
      selectDialogAction("discard")
      await flushPromises()

      expect(window.heron.transportCommand).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          target: expect.objectContaining({ kind: "transport" }),
          expectedRevision: 0,
          mutation: expect.any(Object)
        }),
        { type: "set-loop", enabled: false, range: null }
      )
      expect(window.heron.transportCommand).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          target: expect.objectContaining({ kind: "transport" }),
          expectedRevision: 1,
          mutation: expect.any(Object)
        }),
        { type: "pause" }
      )
      expect(window.heron.closeProject).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ kind: "project-session" }),
          mutation: expect.any(Object)
        }),
        "discard"
      )
      expect(window.heron.executeApplicationWindowCommand).toHaveBeenCalledWith(
        expect.any(Object),
        command
      )
    }
  )

  it("closes a clean project before closing the macOS window", async () => {
    Object.defineProperty(window.heron, "platform", {
      configurable: true,
      value: "darwin"
    })
    window.heron.closeProject = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "close",
      value: { closed: true, snapshot: closedBootstrap() },
      warnings: []
    })
    const { pinia } = createHarness()
    useProjectStore(pinia).applyWorkspace(workspace(session))
    const { activeDialog } = useGlobalDialog()

    nativeCommandListener?.(rpcEvent("window.close"))
    await vi.waitFor(() => expect(window.heron.closeProject).toHaveBeenCalledOnce())

    expect(activeDialog.value).toBeNull()
    expect(window.heron.executeApplicationWindowCommand).toHaveBeenCalledWith(
      expect.any(Object),
      "window.close"
    )
  })

  it("keeps the current dirty project when switching projects is cancelled", async () => {
    window.heron.prepareOpenProject = vi.fn()
    const { pinia } = createHarness()
    const projectStore = useProjectStore(pinia)
    projectStore.applyWorkspace(workspace({ ...session, dirty: true }))
    const { activeDialog, dismissDialog } = useGlobalDialog()

    nativeCommandListener?.(rpcEvent("project.open"))
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    dismissDialog()
    await flushPromises()

    expect(window.heron.closeProject).not.toHaveBeenCalled()
    expect(window.heron.prepareOpenProject).not.toHaveBeenCalled()
    expect(projectStore.session?.path).toBe(session.path)
  })

  it("dispatches project, edit, transport, view, recording, and help commands", async () => {
    const { pinia, router } = createHarness()
    const projectStore = useProjectStore(pinia)
    const mixerStore = useMixerStore(pinia)
    const pianoRollStore = usePianoRollStore(pinia)
    const transportStore = useTransportStore(pinia)
    const workflowStore = useStudioWorkflowStore(pinia)
    const workspaceStore = useStudioWorkspaceStore(pinia)
    const applicationWindowStore = useApplicationWindowStore(pinia)
    const projectWorkspace = workspace(session)
    const create = vi.spyOn(projectStore, "create").mockResolvedValue(projectWorkspace)
    const open = vi.spyOn(projectStore, "open").mockResolvedValue(projectWorkspace)
    const save = vi.spyOn(workflowStore, "saveProject").mockResolvedValue(true)
    const close = vi.spyOn(workflowStore, "closeProject").mockResolvedValue(true)
    const undo = vi.spyOn(mixerStore, "undo").mockResolvedValue(undefined)
    const redo = vi.spyOn(mixerStore, "redo").mockResolvedValue(undefined)
    const edit = vi.spyOn(pianoRollStore, "executeEditCommand")
    const toggle = vi.spyOn(transportStore, "toggle").mockResolvedValue(undefined)
    const goToStart = vi.spyOn(transportStore, "goToStart").mockResolvedValue(undefined)
    const selectAndReveal = vi.spyOn(transportStore, "selectAndRevealClip")
    const toggleRecording = vi
      .spyOn(workflowStore, "toggleRecording")
      .mockResolvedValue({ id: "recorded-clip" } as never)
    const toggleMixerDock = vi.spyOn(workspaceStore, "toggleMixerDock")
    const openBenchmark = vi.spyOn(useAudioBenchmarkStore(pinia), "open")
    const openGraph = vi.spyOn(useCompiledEffectGraphStore(pinia), "open")
    const executeWindowCommand = vi
      .spyOn(applicationWindowStore, "execute")
      .mockResolvedValue(undefined)

    nativeCommandListener?.(rpcEvent("project.new"))
    await flushPromises()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: expect.any(String) }))

    await router.push({ name: "welcome" })
    nativeCommandListener?.(rpcEvent("project.open"))
    await flushPromises()
    expect(open).toHaveBeenCalled()

    projectStore.applyWorkspace(projectWorkspace)
    mixerStore.hydrate(projectWorkspace.graph)
    nativeCommandListener?.(rpcEvent("project.save"))
    nativeCommandListener?.(rpcEvent("edit.undo"))
    nativeCommandListener?.(rpcEvent("edit.redo"))
    await flushPromises()
    expect(save).toHaveBeenCalled()
    expect(undo).toHaveBeenCalled()
    expect(redo).toHaveBeenCalled()

    edit.mockReturnValueOnce(true).mockReturnValueOnce(false)
    nativeCommandListener?.(rpcEvent("edit.copy"))
    nativeCommandListener?.(rpcEvent("edit.paste"))
    await flushPromises()
    expect(edit).toHaveBeenNthCalledWith(1, "copy")
    expect(edit).toHaveBeenNthCalledWith(2, "paste")
    expect(executeWindowCommand).toHaveBeenCalledWith("edit.paste")

    await router.push({ name: "studio" })
    nativeCommandListener?.(rpcEvent("view.toggle-mixer-dock"))
    nativeCommandListener?.(rpcEvent("transport.toggle-playback"))
    nativeCommandListener?.(rpcEvent("transport.go-to-start"))
    nativeCommandListener?.(rpcEvent("recording.toggle"))
    nativeCommandListener?.(rpcEvent("view.toggle-full-screen"))
    nativeCommandListener?.(rpcEvent("help.audio-benchmark"))
    nativeCommandListener?.(rpcEvent("help.effect-chain-graph"))
    await flushPromises()
    expect(toggleMixerDock).toHaveBeenCalled()
    expect(toggle).toHaveBeenCalled()
    expect(goToStart).toHaveBeenCalled()
    expect(toggleRecording).toHaveBeenCalled()
    expect(selectAndReveal).toHaveBeenCalledWith("recorded-clip")
    expect(executeWindowCommand).toHaveBeenCalledWith("view.toggle-full-screen")
    expect(openBenchmark).toHaveBeenCalled()
    expect(openGraph).toHaveBeenCalled()

    nativeCommandListener?.(rpcEvent("project.close"))
    await flushPromises()
    expect(close).toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe("welcome")
  })
})
