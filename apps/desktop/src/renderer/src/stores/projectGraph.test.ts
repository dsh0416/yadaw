import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ProjectCommandResult,
  ProjectGraphSnapshot,
  ProjectWorkspaceSnapshot,
  RpcResult
} from "@heron/contracts"
import { EMPTY_PROJECT_GRAPH, useProjectGraphStore } from "./projectGraph"
import { useProjectStore } from "./project"

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [{ id: "track:audio", channelId: "audio", sortOrder: 0 }],
    channels: [
      {
        id: "audio",
        kind: "audio",
        systemRole: null,
        name: "Audio",
        color: "#8C83FF",
        sortOrder: 0,
        inputSource: "hardware",
        inputFormat: "stereo",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "master",
        kind: "master",
        systemRole: null,
        name: "Master",
        color: "#67D9E7",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output",
        color: "#73D6A2",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    audioClips: [],
    sends: [],
    plugins: [],
    midiClips: [],
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  }
}

function workspace(value: ProjectGraphSnapshot): ProjectWorkspaceSnapshot {
  return {
    project: {
      kind: "project-session",
      id: "project",
      epoch: "test-main",
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: "project:graph",
      epoch: "test-main",
      generation: 1
    },
    revision: 1,
    session: {
      id: "project",
      path: "project.heron",
      configuration: {
        name: "Graph store",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    },
    graph: structuredClone(value),
    assets: []
  }
}

function success<T>(value: T, resourceRevision = 2): RpcResult<T> {
  return {
    ok: true,
    requestId: "test-request",
    operationId: "test-operation",
    resourceRevision,
    value,
    warnings: []
  }
}

function failure(retry: "safe" | "after-reconcile" = "safe"): RpcResult<never> {
  if (retry === "after-reconcile") {
    return {
      ok: false,
      requestId: "test-request",
      error: {
        code: "revision-conflict",
        category: "conflict",
        outcome: "not-committed",
        retry: "after-reconcile",
        correlationId: "test-correlation",
        userMessageKey: "errors.conflict",
        details: {
          type: "revision-conflict",
          expectedRevision: 1,
          actualRevision: 2
        }
      }
    }
  }
  return {
    ok: false,
    requestId: "test-request",
    error: {
      code: "resource-unavailable",
      category: "unavailable",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "test-correlation",
      userMessageKey: "errors.unavailable",
      details: {
        type: "resource-unavailable",
        component: "main",
        dispatched: true
      }
    }
  }
}

describe("project graph store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().applyWorkspace(workspace(graph()))
  })

  it("hydrates, replaces, and resets local graph state", () => {
    const store = useProjectGraphStore()
    const next = graph()
    next.channels[0]!.gainDb = -3
    store.hydrate(next)
    expect(store.graph.channels[0]?.gainDb).toBe(-3)
    expect(store.error).toBe("")

    store.error = "stale"
    store.acceptExternalResult({
      graph: graph(),
      inverse: { type: "batch", commands: [] }
    } satisfies ProjectCommandResult)
    expect(store.graph.channels[0]?.gainDb).toBe(0)
    expect(useProjectStore().session?.dirty).toBe(true)

    store.reset()
    expect(store.graph).toEqual(EMPTY_PROJECT_GRAPH)
    expect(store.loading).toBe(false)
  })

  it("loads and reloads the remote graph through the mutation queue", async () => {
    const store = useProjectGraphStore()
    const loaded = graph()
    loaded.channels[0]!.name = "Loaded"
    window.heron.loadProjectGraph = vi.fn().mockResolvedValue(success(loaded, 3))
    window.heron.reloadProjectGraph = vi.fn().mockResolvedValue(
      success(
        {
          ...loaded,
          channels: loaded.channels.map((channel) => ({ ...channel, name: "Reloaded" }))
        },
        4
      )
    )

    await store.load()
    expect(store.graph.channels[0]?.name).toBe("Loaded")
    expect(useProjectStore().projectRevision).toBe(3)

    await store.reload()
    expect(store.graph.channels[0]?.name).toBe("Reloaded")
    expect(useProjectStore().projectRevision).toBe(4)
  })

  it("accepts the next external revision and reloads on a revision gap", async () => {
    const store = useProjectGraphStore()
    const external = graph()
    external.channels[0]!.name = "Native side-chain commit"
    const result = {
      graph: external,
      inverse: { type: "batch", commands: [] }
    } satisfies ProjectCommandResult

    await expect(store.reconcileExternalResult(result, 2)).resolves.toBe("accepted")
    expect(store.graph.channels[0]?.name).toBe("Native side-chain commit")
    expect(useProjectStore().projectRevision).toBe(2)

    const reloaded = graph()
    reloaded.channels[0]!.name = "Reloaded after gap"
    window.heron.reloadProjectGraph = vi.fn().mockResolvedValue(success(reloaded, 5))
    await expect(store.reconcileExternalResult(result, 4)).resolves.toBe("reloaded")
    expect(store.graph.channels[0]?.name).toBe("Reloaded after gap")
    expect(useProjectStore().projectRevision).toBe(5)
  })

  it("records load failures without throwing", async () => {
    const store = useProjectGraphStore()
    window.heron.loadProjectGraph = vi.fn().mockResolvedValue(failure())
    await store.load()
    expect(store.error.length).toBeGreaterThan(0)
    expect(store.loading).toBe(false)
  })

  it("optimistically applies commands and commits remote results", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    const changed = graph()
    changed.channels[0]!.gainDb = -6
    window.heron.executeProjectCommand = vi.fn().mockResolvedValue(
      success(
        {
          graph: changed,
          inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: 0 } }
        },
        5
      )
    )

    const result = await store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -6 }
    })
    expect(result?.graph.channels[0]?.gainDb).toBe(-6)
    expect(store.graph.channels[0]?.gainDb).toBe(-6)
    expect(useProjectStore().projectRevision).toBe(5)
    expect(useProjectStore().session?.dirty).toBe(true)
  })

  it("rolls back optimistic state when a command fails", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    window.heron.executeProjectCommand = vi.fn().mockResolvedValue(failure())
    window.heron.loadProjectGraph = vi.fn().mockResolvedValue(success(graph(), 1))

    const result = await store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -12 }
    })
    expect(result).toBeNull()
    expect(store.graph.channels[0]?.gainDb).toBe(0)
    expect(store.error.length).toBeGreaterThan(0)
  })

  it("reconciles after retry-after-reconcile command failures", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    const reconciled = graph()
    reconciled.channels[0]!.gainDb = -1
    window.heron.executeProjectCommand = vi.fn().mockResolvedValue(failure("after-reconcile"))
    window.heron.loadProjectGraph = vi.fn().mockResolvedValue(success(reconciled, 9))

    await store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -9 }
    })
    expect(store.graph.channels[0]?.gainDb).toBe(-1)
    expect(window.heron.loadProjectGraph).toHaveBeenCalled()
  })

  it("recovers from thrown execute errors by reloading", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    const recovered = graph()
    recovered.channels[0]!.name = "Recovered"
    window.heron.executeProjectCommand = vi.fn().mockRejectedValue(new Error("boom"))
    window.heron.loadProjectGraph = vi.fn().mockResolvedValue(success(recovered, 2))

    const result = await store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { muted: true }
    })
    expect(result).toBeNull()
    // loadNow clears error after the catch path reloads successfully.
    expect(store.error).toBe("")
    expect(store.graph.channels[0]?.name).toBe("Recovered")
    expect(window.heron.loadProjectGraph).toHaveBeenCalled()
  })

  it("queues mixer previews and flushes them before the next mutation", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    window.heron.previewMixerParameter = vi.fn().mockResolvedValue(success(undefined))
    window.heron.executeProjectCommand = vi.fn().mockResolvedValue(
      success({
        graph: graph(),
        inverse: { type: "batch", commands: [] }
      })
    )

    store.preview({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -3
    })
    expect(store.graph.channels[0]?.gainDb).toBe(0)

    store.preview({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -4
    })
    await store.flushPreviews()
    expect(window.heron.previewMixerParameter).toHaveBeenCalled()
    const previewCalls = vi.mocked(window.heron.previewMixerParameter).mock.calls
    expect(previewCalls.at(-1)?.[1]).toMatchObject({
      target: "channel",
      id: "audio",
      parameter: "gainDb",
      value: -4
    })

    await store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { pan: 0.25 }
    })
    expect(window.heron.previewMixerParameter).toHaveBeenCalled()
  })

  it("surfaces preview flush failures", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    window.heron.previewMixerParameter = vi.fn().mockResolvedValue(failure())
    store.preview({
      target: "channel",
      id: "audio",
      parameter: "pan",
      value: 0.5
    })
    await store.flushPreviews()
    expect(store.error.length).toBeGreaterThan(0)
  })

  it("serializes overlapping mutations through the enqueue tail", async () => {
    const store = useProjectGraphStore()
    store.hydrate(graph())
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    window.heron.executeProjectCommand = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("first-start")
        await firstGate
        order.push("first-end")
        return success({
          graph: graph(),
          inverse: { type: "batch", commands: [] }
        })
      })
      .mockImplementationOnce(async () => {
        order.push("second")
        return success({
          graph: graph(),
          inverse: { type: "batch", commands: [] }
        })
      })

    const first = store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -1 }
    })
    const second = store.execute({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: -2 }
    })
    await vi.waitFor(() => {
      expect(order).toEqual(["first-start"])
    })
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])
  })
})
