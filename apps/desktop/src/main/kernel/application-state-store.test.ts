import { describe, expect, it, vi } from "vitest"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type { ProjectGraphRef, ProjectSession, ProjectSessionRef } from "@yadaw/contracts"
import { ApplicationStateStore } from "./application-state-store"
import { OperationRegistry } from "./operation-registry"

const project: ProjectSession = {
  id: "project",
  path: "project.yadaw",
  configuration: {
    name: "Project",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

describe("ApplicationStateStore", () => {
  it("creates committed desktop and settings roots in one main epoch", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null
    })

    expect(created).toMatchObject({
      ok: true,
      value: {
        desktopSession: {
          kind: "desktop-session",
          epoch: "epoch-1",
          generation: 1
        },
        applicationSettings: {
          kind: "application-settings",
          epoch: "epoch-1",
          generation: 1
        }
      }
    })
    if (!created.ok) throw new Error("test setup failed")
    expect(created.value.resources.resolve(created.value.applicationSettings).ok).toBe(true)
  })

  it("owns revisioned lifecycle state and publishes cloned projections", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null
    })
    if (!created.ok) throw new Error("test setup failed")
    const store = created.value
    const listener = vi.fn()
    store.subscribe(listener)

    store.setProject({ status: "open", session: project, error: null })
    project.configuration.name = "Mutated outside"

    expect(store.lifecycleSnapshot()).toMatchObject({
      revision: 1,
      project: {
        status: "open",
        session: { configuration: { name: "Project" } }
      }
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "project", revision: 1 }))
  })

  it("produces a complete main snapshot with operation retention metrics", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null,
      runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running" }
    })
    if (!created.ok) throw new Error("test setup failed")
    const operations = new OperationRegistry()
    operations.begin({
      operationId: "operation-1",
      idempotencyKey: "start",
      target: created.value.desktopSession
    })

    expect(created.value.snapshot(operations)).toMatchObject({
      protocolVersion: 2,
      mainEpoch: "epoch-1",
      lifecycle: {
        audio: { status: "running" }
      },
      operations: {
        active: 1,
        retainedTerminal: 0
      }
    })
  })

  it("invalidates the previous engine generation and revisions transport atomically", async () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null
    })
    if (!created.ok) throw new Error("test setup failed")
    const store = created.value
    const runtime = { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running" as const }

    const first = await store.commitAudioEngine(runtime)
    expect(first).toMatchObject({
      engine: { kind: "audio-engine", generation: 1 },
      transport: { kind: "transport", generation: 1 },
      revision: 1
    })
    const firstEngine = first.engine
    const firstTransport = first.transport
    if (!firstEngine || !firstTransport) throw new Error("test setup failed")

    expect(
      store.advanceTransport(1, {
        state: "playing",
        positionFrames: 0,
        sampleRate: 48_000
      })
    ).toBe(2)
    expect(() =>
      store.advanceTransport(1, {
        state: "stopped",
        positionFrames: 0,
        sampleRate: 48_000
      })
    ).toThrow("revision-conflict")

    const second = await store.commitAudioEngine(runtime)
    expect(second).toMatchObject({
      engine: { generation: 2 },
      transport: { generation: 2 },
      revision: 1
    })
    expect(store.resources.resolve(firstEngine)).toMatchObject({
      ok: false,
      error: { reason: "parent-invalid" }
    })
    expect(store.resources.resolve(firstTransport)).toMatchObject({
      ok: false,
      error: { reason: "parent-invalid" }
    })
  })

  it("rotates the entire audio subtree when the helper epoch changes", async () => {
    const created = ApplicationStateStore.create({
      epoch: "main-epoch",
      audioHostEpoch: "helper-1",
      project: null
    })
    if (!created.ok) throw new Error("test setup failed")
    const store = created.value
    const runtime = { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running" as const }
    const previous = await store.commitAudioEngine(runtime)

    const next = await store.reconcileAudioHost("helper-2")

    expect(next).toMatchObject({
      host: { epoch: "helper-2", generation: 2 },
      engine: null,
      transport: null,
      revision: 0
    })
    expect(store.resources.resolve(previous.host)).toMatchObject({
      ok: false,
      error: { reason: "parent-invalid" }
    })
    expect(store.resources.resolve(previous.engine!)).toMatchObject({
      ok: false,
      error: { reason: "parent-invalid" }
    })
    expect(store.resources.resolve(previous.transport!)).toMatchObject({
      ok: false,
      error: { reason: "parent-invalid" }
    })
  })

  it("binds a recording ref to project, graph, and engine generations", async () => {
    const created = ApplicationStateStore.create({
      epoch: "main-epoch",
      audioHostEpoch: "helper-epoch",
      project
    })
    if (!created.ok) throw new Error("test setup failed")
    const store = created.value
    const projectCandidate = store.resources.create({
      kind: "project-session",
      id: project.id,
      parent: store.desktopSession
    })
    if (!projectCandidate.ok) throw new Error("test setup failed")
    const committedProject = store.resources.commit(projectCandidate.value.ref, project)
    if (!committedProject.ok) throw new Error("test setup failed")
    const graphCandidate = store.resources.create({
      kind: "project-graph",
      id: "graph",
      parent: committedProject.value.ref
    })
    if (!graphCandidate.ok) throw new Error("test setup failed")
    const committedGraph = store.resources.commit(graphCandidate.value.ref, { revision: 1 })
    if (!committedGraph.ok) throw new Error("test setup failed")
    const audio = await store.commitAudioEngine({
      ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
      state: "running"
    })
    if (!audio.engine) throw new Error("test setup failed")

    const recording = store.commitRecording(
      {
        id: "recording",
        startedAt: 1,
        swapPath: "recording.partial.bwf",
        startFrame: 0,
        trackIds: ["audio-1"]
      },
      {
        project: committedProject.value.ref as ProjectSessionRef,
        projectGraph: committedGraph.value.ref as ProjectGraphRef,
        audioEngine: audio.engine
      }
    )

    expect(recording).toMatchObject({
      recording: { kind: "recording-session", generation: 1 },
      project: { id: project.id },
      projectGraph: { id: "graph" },
      audioEngine: { epoch: "helper-epoch" }
    })
    await store.resources.drop(committedGraph.value.ref)
    expect(store.recordingResourceSnapshot()).toBeNull()
  })
})
