import { describe, expect, it, vi } from "vitest"
import { AudioHostTransportClient } from "./audio-host-transport-client"
import type { ControlResponse } from "./wire"

function createClient(request: (command: Record<string, unknown>) => Promise<ControlResponse>) {
  const readTelemetry = vi.fn(() => {
    throw new Error("the fallback must not use unavailable direct telemetry")
  })
  const client = new AudioHostTransportClient(
    () => null,
    request,
    readTelemetry,
    () => 48_000,
    vi.fn(),
    () => false
  )
  return { client, readTelemetry }
}

describe("AudioHostTransportClient direct-telemetry fallback", () => {
  it("sends plug-in bypass previews over the control path", async () => {
    const request = vi.fn(
      async () => ({ request_id: 1, result: { type: "accepted" } }) satisfies ControlResponse
    )
    const { client } = createClient(request)

    await client.previewMixerParameter({
      target: "plugin",
      id: "effect",
      parameter: "enabled",
      value: 0
    })

    expect(request).toHaveBeenCalledWith({
      type: "preview-mixer-parameter",
      preview: { target: "plugin", id: "effect", parameter: "enabled", value: 0 }
    })
  })

  it("reads the authoritative transport snapshot over the control channel", async () => {
    const request = vi.fn(
      async () =>
        ({
          request_id: 1,
          result: {
            type: "transport-snapshot",
            transport: {
              state: "playing",
              position_frames: 96_000,
              position_ticks: 3_840,
              sample_rate: 48_000,
              effective_bpm: 120,
              clock_source: "internal",
              waiting_for: null,
              loop_enabled: false,
              loop_start_tick: null,
              loop_end_tick: null
            }
          }
        }) satisfies ControlResponse
    )
    const { client, readTelemetry } = createClient(request)

    await expect(client.transportSnapshot()).resolves.toMatchObject({
      state: "playing",
      positionFrames: 96_000,
      positionTicks: 3_840,
      sampleRate: 48_000
    })
    expect(request).toHaveBeenCalledWith({ type: "transport-snapshot" })
    expect(readTelemetry).not.toHaveBeenCalled()
  })

  it("reads mixer meters over the control channel", async () => {
    const request = vi.fn(
      async () =>
        ({
          request_id: 1,
          result: {
            type: "mixer-snapshot",
            meters: [
              {
                channel_id: "channel-1",
                pre_left: 0.5,
                pre_right: 0.4,
                post_left: 0.25,
                post_right: 0.2,
                held_left: 0.6,
                held_right: 0.55,
                clipped: false
              }
            ]
          }
        }) satisfies ControlResponse
    )
    const { client, readTelemetry } = createClient(request)

    await expect(client.mixerSnapshot()).resolves.toMatchObject({
      meters: [
        {
          channelId: "channel-1",
          preFaderPeak: [0.5, 0.4],
          postFaderPeak: [0.25, 0.2],
          heldPeak: [0.6, 0.55],
          clipped: false
        }
      ]
    })
    expect(request).toHaveBeenCalledWith({ type: "mixer-snapshot" })
    expect(readTelemetry).not.toHaveBeenCalled()
  })
})
