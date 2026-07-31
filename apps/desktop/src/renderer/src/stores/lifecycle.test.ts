import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type {
  ApplicationBootstrapSnapshot,
  DesktopLifecycleSnapshot,
  ProjectSession
} from "@yadaw/contracts"
import { useLifecycleStore } from "./lifecycle"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useProjectStore } from "./project"

const session: ProjectSession = {
  id: "project",
  path: "new.yadaw",
  configuration: {
    name: "New",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

function snapshot(revision: number): DesktopLifecycleSnapshot {
  return {
    revision,
    project: { status: "closed", error: null },
    audio: {
      status: "stopped",
      runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT },
      error: null
    },
    recording: { status: "idle", error: null }
  }
}

function bootstrap(lifecycle: DesktopLifecycleSnapshot): ApplicationBootstrapSnapshot {
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
    revision: lifecycle.revision,
    lifecycle,
    settings: {} as ApplicationBootstrapSnapshot["settings"],
    workspace: null
  }
}

describe("lifecycle store", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("subscribes before hydrating and ignores an older snapshot", async () => {
    let listener: Parameters<typeof window.yadaw.subscribeLifecycle>[0] = () => undefined
    window.yadaw.subscribeLifecycle = vi.fn((next) => {
      listener = next
      return vi.fn()
    })
    let resolveSnapshot!: (value: ApplicationBootstrapSnapshot) => void
    window.yadaw.bootstrap = vi.fn(() =>
      new Promise<ApplicationBootstrapSnapshot>((resolve) => {
        resolveSnapshot = resolve
      }).then((value) => ({ ok: true as const, requestId: "request", value, warnings: [] }))
    )
    const lifecycle = useLifecycleStore()
    const project = useProjectStore()
    const audio = useAudioRuntimeStore()

    const initializing = lifecycle.initialize()
    listener({ type: "project", revision: 2, state: { status: "open", session, error: null } })
    const olderSnapshot = snapshot(1)
    olderSnapshot.audio = {
      status: "running",
      runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running", sampleRate: 48_000 },
      error: null
    }
    resolveSnapshot(bootstrap(olderSnapshot))
    await initializing

    expect(project.session?.path).toBe("new.yadaw")
    expect(audio.runtime.state).toBe("running")
    expect(lifecycle.ready).toBe(true)
  })

  it("disposes its single native subscription", async () => {
    const unsubscribe = vi.fn()
    window.yadaw.subscribeLifecycle = vi.fn(() => unsubscribe)
    window.yadaw.bootstrap = vi.fn().mockResolvedValue({
      ok: true,
      requestId: "request",
      value: bootstrap(snapshot(0)),
      warnings: []
    })
    const lifecycle = useLifecycleStore()

    await lifecycle.initialize()
    lifecycle.dispose()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(lifecycle.ready).toBe(false)
  })
})
