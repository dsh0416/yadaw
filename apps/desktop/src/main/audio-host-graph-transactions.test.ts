import { describe, expect, it, vi } from "vitest"
import { IPC_PROTOCOL_VERSION, rpcSuccess } from "@yadaw/contracts"
import type { ProjectGraphSnapshot, RpcRequestMeta } from "@yadaw/contracts"
import { AudioHostGraphTransactions } from "./audio-host-graph-transactions"
import type { ControlResponse } from "./audio-host-wire"

describe("AudioHostGraphTransactions.prepare", () => {
  it("returns dependency-failed when a plugin fails to load", async () => {
    const loadPlugin = vi.fn().mockRejectedValue(new Error("plugin missing"))
    const meta: RpcRequestMeta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "prepare-1",
      mutation: { operationId: "prepare-1", idempotencyKey: "prepare-1" }
    }
    const transactions = new AudioHostGraphTransactions({
      client: () =>
        ({
          helperEpoch: "helper-1"
        }) as never,
      request: vi.fn(async (command): Promise<ControlResponse> => {
        if (command.type === "graph-deployment-snapshot") {
          return {
            request_id: 1,
            result: {
              type: "graph-transaction",
              result: rpcSuccess(meta, {
                type: "snapshot",
                snapshot: {
                  committedRevision: 0,
                  lastOperation: null
                }
              })
            }
          } as ControlResponse
        }
        throw new Error(`unexpected command ${String(command.type)}`)
      }),
      loadPlugin,
      pluginStatus: () => undefined,
      isPluginBypassed: () => false,
      commit: vi.fn()
    })
    const project = {
      sampleRate: 48_000,
      plugins: [
        {
          id: "plugin-1",
          channelId: "instrument-1",
          role: "instrument",
          slotOrder: 0,
          classId: "missing",
          descriptor: { classId: "missing" },
          audioMode: "stereo",
          enabled: true,
          componentState: new Uint8Array(),
          controllerState: new Uint8Array()
        }
      ]
    } as unknown as ProjectGraphSnapshot
    const result = await transactions.prepare(
      meta,
      {
        kind: "project-graph",
        id: "project:graph",
        epoch: "main",
        generation: 1
      },
      1,
      project,
      {
        sample_rate: 48_000,
        channels: [],
        sends: [],
        clips: [],
        plugins: [
          {
            instance_id: "plugin-1",
            enabled: true,
            latency_samples: 0,
            tail_samples: 0
          }
        ],
        midi_clips: [],
        tempo_events: [],
        time_signature_events: []
      } as never
    )
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
    expect(loadPlugin).toHaveBeenCalledOnce()
  })
})
