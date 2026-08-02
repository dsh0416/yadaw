import { beforeEach, describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type {
  PluginInstanceState,
  ProjectGraphRef,
  ProjectGraphSnapshot,
  RpcRequestMeta
} from "@yadaw/contracts"
import { AudioHostGraphTransactions } from "./audio-host-graph-transactions"
import type {
  AudioHostGraph,
  ControlResponse,
  GraphDeploymentSnapshot,
  GraphTransactionValue
} from "./audio-host-wire"

const projectGraph: ProjectGraphRef = {
  kind: "project-graph",
  id: "project:graph",
  epoch: "epoch-1",
  generation: 1
}

const engine = {
  kind: "audio-engine" as const,
  id: "engine",
  epoch: "helper-epoch",
  generation: 1
}

function meta(overrides: Partial<RpcRequestMeta> = {}): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "request-1",
    mutation: { operationId: "op-1", idempotencyKey: "idem-1" },
    ...overrides
  }
}

function snapshot(overrides: Partial<GraphDeploymentSnapshot> = {}): GraphDeploymentSnapshot {
  return {
    helperEpoch: "helper-epoch",
    engine,
    status: "empty",
    committedProjectGraph: null,
    committedRevision: 3,
    observedRevision: 3,
    candidate: null,
    lastOperation: null,
    ...overrides
  }
}

function transactionResponse(
  requestId: string,
  value: GraphTransactionValue,
  operationId = "op-1"
): ControlResponse {
  return {
    request_id: 1,
    result: {
      type: "graph-transaction",
      result: {
        ok: true,
        requestId,
        operationId,
        resourceRevision: 3,
        value,
        warnings: []
      }
    }
  }
}

function project(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [],
    channels: [],
    audioClips: [],
    sends: [],
    plugins: [
      {
        id: "plugin-1",
        channelId: "audio-1",
        role: "insert",
        slotOrder: 0,
        classId: "class-1",
        descriptor: {
          source: { kind: "external" },
          classId: "class-1",
          modulePath: "/plugins/Effect.vst3",
          name: "Effect",
          vendor: "YADAW",
          version: "1.0",
          categories: ["Fx"],
          kind: "effect",
          architecture: "x86_64",
          buses: [],
          supportedAudioModes: ["stereo"],
          hasEditor: false,
          compatibility: "compatible",
          compatibilityReason: null
        },
        audioMode: "stereo",
        enabled: true,
        componentState: new Uint8Array(),
        controllerState: new Uint8Array()
      } satisfies PluginInstanceState
    ],
    midiClips: [],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    },
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
  }
}

function runtimeGraph(): AudioHostGraph {
  return {
    sample_rate: 48_000,
    channels: [],
    sends: [],
    clips: [],
    plugins: [
      {
        instance_id: "plugin-1",
        channel_id: "audio-1",
        role: "insert",
        slot_order: 0,
        audio_mode: "stereo",
        enabled: true,
        latency_samples: 0,
        tail_samples: 0
      }
    ],
    midi_clips: [],
    tempo_events: [],
    time_signature_events: []
  }
}

describe("AudioHostGraphTransactions", () => {
  const client = { helperEpoch: "helper-epoch" }
  const dependencies = {
    client: vi.fn(() => client as never),
    request: vi.fn(),
    loadPlugin: vi.fn(async () => undefined),
    pluginStatus: vi.fn(() => ({ latencySamples: 64, tailSamples: 12 })),
    isPluginBypassed: vi.fn(() => false),
    commit: vi.fn(async () => undefined)
  }
  let transactions: AudioHostGraphTransactions

  beforeEach(() => {
    vi.clearAllMocks()
    dependencies.client.mockReturnValue(client as never)
    dependencies.loadPlugin.mockResolvedValue(undefined)
    dependencies.pluginStatus.mockReturnValue({ latencySamples: 64, tailSamples: 12 })
    dependencies.isPluginBypassed.mockReturnValue(false)
    transactions = new AudioHostGraphTransactions(dependencies)
  })

  it("prepares a graph deployment and applies plugin runtime status", async () => {
    dependencies.request
      .mockResolvedValueOnce(
        transactionResponse("request-1", { type: "snapshot", snapshot: snapshot() })
      )
      .mockResolvedValueOnce(
        transactionResponse("request-1", {
          type: "prepared",
          snapshot: snapshot({ status: "prepared", committedRevision: 3 })
        })
      )

    const result = await transactions.prepare(meta(), projectGraph, 4, project(), runtimeGraph())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.baseRevision).toBe(3)
    expect(result.value.graphRevision).toBe(4)
    expect(result.value.runtime.plugins[0]).toMatchObject({
      instance_id: "plugin-1",
      enabled: true,
      latency_samples: 64,
      tail_samples: 12
    })
    expect(dependencies.loadPlugin).toHaveBeenCalledOnce()
    expect(dependencies.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "prepare-graph" })
    )
  })

  it("returns dependency-failed when a plugin fails to load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    dependencies.loadPlugin.mockRejectedValue(new Error("load failed"))
    dependencies.request.mockResolvedValueOnce(
      transactionResponse("request-1", { type: "snapshot", snapshot: snapshot() })
    )

    const result = await transactions.prepare(meta(), projectGraph, 5, project(), runtimeGraph())

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "dependency-failed",
        details: {
          type: "dependency-failed",
          dependency: { kind: "plugin-instance", id: "plugin-1" }
        }
      }
    })
    expect(dependencies.loadPlugin).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("activates a prepared deployment and commits on success", async () => {
    const deployment = {
      meta: meta({ target: engine, expectedRevision: 3 }),
      projectGraph,
      baseRevision: 3,
      graphRevision: 4,
      project: project(),
      runtime: runtimeGraph()
    }
    const activated = snapshot({
      status: "active",
      committedRevision: 4,
      lastOperation: { operationId: "op-1", outcome: "committed", graphRevision: 4 }
    })
    dependencies.request.mockResolvedValueOnce(
      transactionResponse("request-1", { type: "activated", snapshot: activated })
    )

    const result = await transactions.activate(deployment)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ type: "activated", snapshot: activated })
    expect(dependencies.commit).toHaveBeenCalledWith(deployment)
  })

  it("reconciles activate timeouts when the last operation committed", async () => {
    const deployment = {
      meta: meta({ target: engine, expectedRevision: 3 }),
      projectGraph,
      baseRevision: 3,
      graphRevision: 4,
      project: project(),
      runtime: runtimeGraph()
    }
    const committed = snapshot({
      status: "active",
      committedRevision: 4,
      lastOperation: { operationId: "op-1", outcome: "committed", graphRevision: 4 }
    })
    dependencies.request
      .mockResolvedValueOnce({
        request_id: 1,
        result: {
          type: "graph-transaction",
          result: rpcFailure(deployment.meta, {
            code: "operation-timeout-unknown",
            category: "timeout-unknown",
            outcome: "unknown",
            retry: "after-reconcile",
            correlationId: "timeout-1",
            userMessageKey: "errors.operationTimeout",
            details: { type: "operation-timeout-unknown", dispatched: true }
          })
        }
      })
      .mockResolvedValueOnce(
        transactionResponse("request-1", { type: "snapshot", snapshot: committed })
      )

    const result = await transactions.activate(deployment)

    expect(result).toEqual(rpcSuccess(deployment.meta, { type: "activated", snapshot: committed }))
    expect(dependencies.commit).toHaveBeenCalledWith(deployment)
    expect(dependencies.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "graph-deployment-snapshot" })
    )
  })

  it("aborts a prepared deployment", async () => {
    const deployment = {
      meta: meta({ target: engine, expectedRevision: 3 }),
      projectGraph,
      baseRevision: 3,
      graphRevision: 4,
      project: project(),
      runtime: runtimeGraph()
    }
    const aborted = {
      type: "aborted" as const,
      operationId: "op-1",
      existed: true,
      snapshot: snapshot({
        status: "empty",
        lastOperation: { operationId: "op-1", outcome: "not-committed", graphRevision: 4 }
      })
    }
    dependencies.request.mockResolvedValueOnce(transactionResponse("request-1", aborted))

    const result = await transactions.abort(deployment)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(aborted)
    expect(dependencies.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "abort-graph" })
    )
    expect(dependencies.commit).not.toHaveBeenCalled()
  })
})
