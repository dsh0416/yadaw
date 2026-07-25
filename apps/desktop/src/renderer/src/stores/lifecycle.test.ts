import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type { DesktopLifecycleSnapshot, ProjectSession } from "@yadaw/contracts"
import { useLifecycleStore } from "./lifecycle"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useProjectStore } from "./project"

const session: ProjectSession = {
  id: "project",
  path: "new.yadaw",
  configuration: {
    name: "New",
    sampleRate: 48_000,
    tempo: 120,
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

describe("lifecycle store", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("subscribes before hydrating and ignores an older snapshot", async () => {
    let listener: Parameters<typeof window.yadaw.subscribeLifecycle>[0] = () => undefined
    window.yadaw.subscribeLifecycle = vi.fn((next) => {
      listener = next
      return vi.fn()
    })
    let resolveSnapshot!: (value: DesktopLifecycleSnapshot) => void
    window.yadaw.lifecycleSnapshot = vi.fn(() => new Promise<DesktopLifecycleSnapshot>((resolve) => {
      resolveSnapshot = resolve
    }))
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
    resolveSnapshot(olderSnapshot)
    await initializing

    expect(project.session?.path).toBe("new.yadaw")
    expect(audio.runtime.state).toBe("running")
    expect(lifecycle.ready).toBe(true)
  })

  it("disposes its single native subscription", async () => {
    const unsubscribe = vi.fn()
    window.yadaw.subscribeLifecycle = vi.fn(() => unsubscribe)
    window.yadaw.lifecycleSnapshot = vi.fn().mockResolvedValue(snapshot(0))
    const lifecycle = useLifecycleStore()

    await lifecycle.initialize()
    lifecycle.dispose()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(lifecycle.ready).toBe(false)
  })
})
