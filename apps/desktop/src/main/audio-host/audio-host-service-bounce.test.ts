import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot } from "@heron/contracts"
import type { AudioHostBounceStatus } from "./wire"
import { AudioHostService, fakeHost, graph, resetFakeHost } from "./audio-host-service.fixture"

const automaticRuntime = {
  workerThreads: "auto" as const,
  maxBlockingThreads: "auto" as const
}

const completed: AudioHostBounceStatus = {
  operation_id: "bounce-1",
  state: "completed",
  phase: "encoding",
  completed_units: 512,
  total_units: 512,
  sample_peak: 0.5,
  true_peak: 0.6,
  normalization_gain: 1,
  warnings: []
}

const bounceRequest = {
  operation_id: "bounce-1",
  output_channel_id: "output",
  start_frame: 0,
  end_frame: 512,
  target_sample_rate: 48_000,
  channel_mode: "stereo" as const,
  include_tail: true,
  encoding: { type: "wav-float" as const },
  normalization: { mode: "off" as const },
  scratch_path: "bounce.scratch",
  encoded_path: "bounce.wav"
}

function createService() {
  return new AudioHostService(
    automaticRuntime,
    undefined,
    () => {},
    async () => {}
  )
}

function installGraph(service: InstanceType<typeof AudioHostService>) {
  const desired = graph(48_000)
  ;(
    service as unknown as {
      session: {
        graph: { revision: number; project: ProjectGraphSnapshot; runtime: object } | null
      }
    }
  ).session.graph = { revision: 7, project: desired.project, runtime: desired.runtime }
  return desired
}

describe("AudioHostService bounce", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeHost()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("attaches the committed graph and exposes start, status, and cancellation", async () => {
    const service = createService()
    const desired = installGraph(service)
    const request = vi.fn(async (command: { type: string }) => ({
      request_id: 1,
      result:
        command.type === "cancel-bounce-output"
          ? { type: "bounce-output" as const }
          : { type: "bounce-output" as const, status: completed }
    }))
    ;(service as unknown as { request: typeof request }).request = request

    await expect(service.startBounceOutput(bounceRequest)).resolves.toEqual(completed)
    await expect(service.bounceOutputStatus("bounce-1")).resolves.toEqual(completed)
    await expect(service.cancelBounceOutput("bounce-1")).resolves.toBeUndefined()
    expect(request.mock.calls[0]?.[0]).toEqual({
      type: "start-bounce-output",
      request: { ...bounceRequest, graph_revision: 7, graph: desired.runtime }
    })
    expect(request.mock.calls.slice(1).map(([command]) => command)).toEqual([
      { type: "bounce-output-status", operation_id: "bounce-1" },
      { type: "cancel-bounce-output", operation_id: "bounce-1" }
    ])
  })

  it("rejects unavailable graphs, invalid host responses, and plug-in topology changes", async () => {
    const service = createService()
    await expect(service.startBounceOutput(bounceRequest)).rejects.toThrow("graph is unavailable")
    expect(() =>
      service.refreshDesiredProjectGraph({ plugins: [] } as unknown as ProjectGraphSnapshot)
    ).toThrow("graph is unavailable")

    const desired = installGraph(service)
    const request = vi.fn(async () => ({ request_id: 1, result: { type: "accepted" as const } }))
    ;(service as unknown as { request: typeof request }).request = request
    await expect(service.startBounceOutput(bounceRequest)).rejects.toThrow(
      "audio host rejected bounce"
    )
    await expect(service.bounceOutputStatus("bounce-1")).rejects.toThrow(
      "bounce status is unavailable"
    )
    await expect(service.cancelBounceOutput("bounce-1")).rejects.toThrow(
      "bounce cancellation failed"
    )

    const refreshed = structuredClone(desired.project)
    refreshed.sampleRate = 96_000
    service.refreshDesiredProjectGraph(refreshed)
    expect(
      (
        service as unknown as {
          session: { graph: { project: ProjectGraphSnapshot } | null }
        }
      ).session.graph?.project.sampleRate
    ).toBe(96_000)
    expect(() =>
      service.refreshDesiredProjectGraph({
        ...refreshed,
        plugins: [{ id: "new-plugin" }]
      } as unknown as ProjectGraphSnapshot)
    ).toThrow("plug-in topology changed")
  })

  it("restarts an isolated runtime and delegates offline preparation", async () => {
    const service = createService()
    await service.restartAfterOfflineBounce(false)
    expect(fakeHost.Client.instances).toHaveLength(1)

    const restart = vi.spyOn(service, "restartAfterOfflineBounce").mockResolvedValue()
    await service.prepareOfflineBounce()
    expect(restart).toHaveBeenCalledWith(false)
    await service.stop()
  })
})
