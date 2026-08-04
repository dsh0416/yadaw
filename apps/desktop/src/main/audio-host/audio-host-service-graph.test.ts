import { IPC_PROTOCOL_VERSION } from "@heron/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AudioHostService,
  fakeHost,
  graph,
  pluginInstance,
  resetFakeHost
} from "./audio-host-service.fixture"

describe("AudioHostService graph", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeHost()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not update the committed recovery graph until candidate activation", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const candidate = graph(48_000)
    const meta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "open-project",
      mutation: {
        operationId: "open-project-operation",
        idempotencyKey: "open-project-idempotency"
      }
    }
    const projectGraph = {
      kind: "project-graph" as const,
      id: "project:graph",
      epoch: "main-epoch",
      generation: 1
    }

    const prepared = await service.prepareGraphDeployment(
      meta,
      projectGraph,
      1,
      candidate.project,
      candidate.runtime
    )
    expect(prepared.ok).toBe(true)
    expect(
      (
        service as unknown as {
          lastGraph: { revision: number } | null
        }
      ).lastGraph
    ).toBeNull()
    if (!prepared.ok) throw new Error("test setup failed")

    const activated = await service.activateGraphDeployment(prepared.value)
    expect(activated).toMatchObject({ ok: true, value: { type: "activated" } })
    expect(
      (
        service as unknown as {
          lastGraph: { revision: number } | null
        }
      ).lastGraph?.revision
    ).toBe(1)

    await service.stop()
  })

  it("does not unload removed plugins until graph activation", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const plugin = pluginInstance()
    await service.loadPlugin(plugin, 48_000)
    const candidate = graph(48_000)

    await service.commitDesiredGraph({
      meta: {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "remove-plugin"
      },
      projectGraph: {
        kind: "project-graph",
        id: "project:graph",
        epoch: "main-epoch",
        generation: 1
      },
      baseRevision: 1,
      graphRevision: 2,
      project: candidate.project,
      runtime: candidate.runtime
    })

    const client = fakeHost.Client.instances[0]!
    expect(client.commands.filter((command) => command.type === "unload-plugin")).toEqual([])
    await service.stop()
  })

  it("unloads plugin instances removed from the committed graph after activation", async () => {
    const service = new AudioHostService(
      "audio-host",
      "crash-marker",
      {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      undefined,
      () => {},
      async () => {}
    )
    service.start()
    const plugin = pluginInstance()
    await service.loadPlugin(plugin, 48_000)
    const candidate = graph(48_000)
    const prepared = await service.prepareGraphDeployment(
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "remove-plugin"
      },
      {
        kind: "project-graph",
        id: "project:graph",
        epoch: "main-epoch",
        generation: 1
      },
      2,
      candidate.project,
      candidate.runtime
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error("test setup failed")

    const activated = await service.activateGraphDeployment(prepared.value)
    expect(activated).toMatchObject({ ok: true, value: { type: "activated" } })

    const client = fakeHost.Client.instances[0]!
    expect(client.commands.filter((command) => command.type === "unload-plugin")).toEqual([
      { type: "unload-plugin", instance_id: plugin.id }
    ])
    await service.stop()
  })
})
