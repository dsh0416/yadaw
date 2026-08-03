import { encode } from "@msgpack/msgpack"
import type { AudioHostIpcClient } from "@heron/audio-host-client"
import { describe, expect, it } from "vitest"
import { AudioHostGateway } from "./audio-host-gateway"

describe("AudioHostGateway", () => {
  it("preserves structured audio-host errors and request context", async () => {
    const client = {
      request: async () => ({
        body: Buffer.from(
          encode({
            request_id: 1,
            result: {
              type: "error",
              error: {
                code: "invariant-violation",
                category: "invariant-violation",
                outcome: "quarantined",
                retry: "after-reconcile",
                correlationId: "audio-host-42",
                userMessageKey: "errors.audioEngineUnavailable",
                details: { type: "invariant-violation", component: "audio-host" }
              }
            }
          })
        ),
        attachments: []
      })
    } as unknown as AudioHostIpcClient
    const gateway = new AudioHostGateway(
      () => client,
      () => null,
      async () => {},
      new Set()
    )

    const request = gateway.request({ type: "load-plugin" })

    await expect(request).rejects.toMatchObject({
      name: "AudioHostRequestError",
      commandType: "load-plugin",
      message: "errors.audioEngineUnavailable (load-plugin, invariant-violation, audio-host-42)",
      rpcError: {
        correlationId: "audio-host-42",
        details: { type: "invariant-violation", component: "audio-host" }
      }
    })
  })
})
