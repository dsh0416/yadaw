import { describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION, rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  ProjectGraphSnapshot,
  ProjectSession,
  RpcRequestMeta,
  RpcResult
} from "@heron/contracts"
import { LifecycleCoordinator } from "./lifecycle-coordinator"
import { OperationRegistry } from "./kernel/operation-registry"
import { OperationService } from "./operation-service"
import { ProjectLifecycleService } from "./project-lifecycle-service"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

const session: ProjectSession = {
  id: "healthy",
  path: "Healthy.heron",
  configuration: {
    name: "Healthy",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

const graph: ProjectGraphSnapshot = {
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
}

function mutation(target: RpcRequestMeta["target"], suffix: string): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: `request-${suffix}`,
    target,
    mutation: {
      operationId: `operation-${suffix}`,
      idempotencyKey: `idempotency-${suffix}`
    }
  }
}

function fixture() {
  const lifecycle = new LifecycleCoordinator(null)
  let candidate: ProjectSession | null = null
  const prepareOpen = vi
    .fn()
    .mockImplementation(
      async (
        _path: string,
        recover: boolean,
        onProgress: (progress: {
          phase: "loading-project-archive" | "loading-project-database"
          completedUnits: number
        }) => void
      ) => {
        onProgress({
          phase: recover ? "loading-project-database" : "loading-project-archive",
          completedUnits: 0
        })
        candidate = structuredClone(session)
        return structuredClone(session)
      }
    )
  const prepareCreate = vi.fn().mockImplementation(async () => {
    candidate = structuredClone(session)
    return structuredClone(session)
  })
  const projects = {
    prepareCreate,
    prepareOpen,
    candidateMixerSnapshot: vi.fn(async () => structuredClone(graph)),
    candidateAssets: vi.fn(async () => []),
    commitCandidate: vi.fn(() => {
      if (!candidate) throw new Error("missing candidate")
      const committed = candidate
      candidate = null
      return structuredClone(committed)
    }),
    abortCandidate: vi.fn(async () => {
      candidate = null
    }),
    recordCurrentAsRecent: vi.fn(async () => undefined)
  }
  const prepared = {
    graph: structuredClone(graph),
    revision: 1,
    native: null
  }
  const projectGraph = {
    prepareCandidate: vi.fn<(meta: RpcRequestMeta) => Promise<RpcResult<typeof prepared>>>((meta) =>
      Promise.resolve(rpcSuccess(meta, prepared))
    ),
    activateCandidate: vi.fn<(meta: RpcRequestMeta) => Promise<RpcResult<ProjectGraphSnapshot>>>(
      (meta) => Promise.resolve(rpcSuccess(meta, structuredClone(graph)))
    ),
    abortCandidate: vi.fn(async () => undefined),
    commitCandidate: vi.fn()
  }
  const operations = new OperationService(
    new OperationRegistry(),
    lifecycle.applicationState.desktopSession
  )
  const service = new ProjectLifecycleService(
    projects as never,
    projectGraph as never,
    lifecycle,
    operations,
    { get: vi.fn(async () => ({})) } as never,
    { prepareMissing: vi.fn(async () => undefined) } as never
  )
  return { lifecycle, operations, projects, projectGraph, service }
}

describe("ProjectLifecycleService", () => {
  it.each([
    {
      kind: "create",
      suffix: "create-progress",
      title: "Creating project",
      description: "Healthy",
      initialPhase: "committing-database",
      run: (service: ProjectLifecycleService, meta: RpcRequestMeta) =>
        service.create(meta, {
          path: "Healthy.heron",
          ...session.configuration
        })
    },
    {
      kind: "open",
      suffix: "open-progress",
      title: "Opening project",
      description: "Healthy.heron",
      initialPhase: "preparing-project",
      run: (service: ProjectLifecycleService, meta: RpcRequestMeta) =>
        service.open(meta, "/projects/Healthy.heron", false)
    }
  ])(
    "publishes shared progress while a project is being $kind",
    async ({ suffix, title, description, initialPhase, run }) => {
      const { lifecycle, operations, service } = fixture()
      const upsert = vi.spyOn(operations, "upsert")
      const patch = vi.spyOn(operations, "patch")
      const requestMeta = mutation(lifecycle.applicationState.desktopSession, suffix)

      const result = await run(service, requestMeta)

      expect(result.ok).toBe(true)
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `operation-${suffix}`,
          title,
          description,
          phase: initialPhase,
          state: "running",
          completedUnits: 0,
          totalUnits: 5,
          cancellable: false
        }),
        true
      )
      expect(patch).toHaveBeenCalledWith(
        `operation-${suffix}`,
        expect.objectContaining({
          phase: "loading-project-assets",
          completedUnits: 3,
          totalUnits: 5
        }),
        true
      )
      expect(patch).toHaveBeenCalledWith(
        `operation-${suffix}`,
        expect.objectContaining({
          phase: "preparing-project-graph",
          completedUnits: 4,
          totalUnits: 5
        }),
        true
      )
      expect(patch).toHaveBeenLastCalledWith(
        `operation-${suffix}`,
        {
          state: "completed",
          completedUnits: 5,
          totalUnits: 5,
          error: null
        },
        true
      )
    }
  )

  it("reports database loading only after recovery is confirmed", async () => {
    const { lifecycle, operations, service } = fixture()
    const patch = vi.spyOn(operations, "patch")

    const result = await service.open(
      mutation(lifecycle.applicationState.desktopSession, "recover-progress"),
      "Recovered.heron",
      true
    )

    expect(result.ok).toBe(true)
    expect(patch).toHaveBeenCalledWith(
      "operation-recover-progress",
      {
        phase: "loading-project-database",
        completedUnits: 0,
        totalUnits: 5
      },
      true
    )
  })

  it("keeps a failed open isolated so the next healthy project can commit", async () => {
    const { lifecycle, operations, projects, service } = fixture()
    const desktop = lifecycle.applicationState.desktopSession
    const patch = vi.spyOn(operations, "patch")
    projects.prepareOpen.mockRejectedValueOnce(new Error("corrupt archive"))

    const failed = await service.open(mutation(desktop, "broken"), "Broken.heron", false)
    expect(failed).toMatchObject({
      ok: false,
      error: { outcome: "not-committed", details: { component: "project-worker" } }
    })
    expect(lifecycle.snapshot().project.status).toBe("closed")
    expect(lifecycle.applicationState.workspaceSnapshot()).toBeNull()
    expect(projects.abortCandidate).toHaveBeenCalledOnce()
    expect(patch).toHaveBeenCalledWith(
      "operation-broken",
      expect.objectContaining({ state: "failed", error: expect.anything() }),
      true
    )

    const opened = await service.open(mutation(desktop, "healthy"), "Healthy.heron", false)
    expect(opened).toMatchObject({
      ok: true,
      value: {
        project: { kind: "project-session", generation: 1 },
        projectGraph: { kind: "project-graph", generation: 1 },
        session: { path: "Healthy.heron" }
      }
    })
    expect(lifecycle.snapshot().project.status).toBe("open")
    expect(lifecycle.applicationState.workspaceSnapshot()?.session.path).toBe("Healthy.heron")
  })

  it.each([
    ["candidate graph read", "candidateMixerSnapshot"],
    ["candidate asset read", "candidateAssets"]
  ] as const)("recovers after the %s phase fails", async (_phase, method) => {
    const { lifecycle, projects, service } = fixture()
    projects[method].mockRejectedValueOnce(new Error(`${method} failed`))
    const desktop = lifecycle.applicationState.desktopSession

    const failed = await service.open(mutation(desktop, `${method}-failed`), "Broken.heron", false)
    expect(failed).toMatchObject({
      ok: false,
      error: { outcome: "not-committed", details: { component: "project-worker" } }
    })
    expect(lifecycle.applicationState.workspaceSnapshot()).toBeNull()

    const opened = await service.open(
      mutation(desktop, `${method}-healthy`),
      "Healthy.heron",
      false
    )
    expect(opened.ok).toBe(true)
    expect(lifecycle.applicationState.workspaceSnapshot()?.session.path).toBe("Healthy.heron")
  })

  it("does not commit worker or refs when native graph preparation fails", async () => {
    const { lifecycle, projects, projectGraph, service } = fixture()
    projectGraph.prepareCandidate.mockImplementationOnce((meta: RpcRequestMeta) =>
      Promise.resolve(
        rpcFailure(meta, {
          code: "dependency-failed",
          category: "dependency-failed",
          outcome: "not-committed",
          retry: "after-reconcile",
          correlationId: "native-prepare",
          userMessageKey: "errors.graphDependencyFailed",
          details: {
            type: "dependency-failed",
            dependency: lifecycle.applicationState.desktopSession
          }
        })
      )
    )

    const failed = await service.open(
      mutation(lifecycle.applicationState.desktopSession, "prepare-failure"),
      "Healthy.heron",
      false
    )

    expect(failed).toMatchObject({ ok: false, error: { code: "dependency-failed" } })
    expect(projects.commitCandidate).not.toHaveBeenCalled()
    expect(projects.abortCandidate).toHaveBeenCalledOnce()
    expect(lifecycle.applicationState.workspaceSnapshot()).toBeNull()

    const opened = await service.open(
      mutation(lifecycle.applicationState.desktopSession, "prepare-recovered"),
      "Healthy.heron",
      false
    )
    expect(opened.ok).toBe(true)
  })

  it("recovers after native graph activation fails", async () => {
    const { lifecycle, projectGraph, service } = fixture()
    projectGraph.activateCandidate.mockImplementationOnce((meta: RpcRequestMeta) =>
      Promise.resolve(
        rpcFailure(meta, {
          code: "dependency-failed",
          category: "dependency-failed",
          outcome: "not-committed",
          retry: "after-reconcile",
          correlationId: "native-activate",
          userMessageKey: "errors.graphDependencyFailed",
          details: {
            type: "dependency-failed",
            dependency: lifecycle.applicationState.desktopSession
          }
        })
      )
    )

    const failed = await service.open(
      mutation(lifecycle.applicationState.desktopSession, "activate-failure"),
      "Broken.heron",
      false
    )
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "dependency-failed", outcome: "not-committed" }
    })
    expect(lifecycle.applicationState.workspaceSnapshot()).toBeNull()

    const opened = await service.open(
      mutation(lifecycle.applicationState.desktopSession, "activate-recovered"),
      "Healthy.heron",
      false
    )
    expect(opened.ok).toBe(true)
  })
})
