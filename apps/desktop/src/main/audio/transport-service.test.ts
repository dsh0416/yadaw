import { describe, expect, it, vi } from "vitest"
import type { TransportCommand, TransportSnapshot } from "@heron/contracts"
import type { AudioHostService } from "../audio-host"
import type { ProjectService } from "../project"
import { TransportService } from "./transport-service"

describe("TransportService", () => {
  it("serializes play and pause mutations through a FIFO", async () => {
    let releaseFirst!: (value: TransportSnapshot) => void
    const first = new Promise<TransportSnapshot>((resolve) => {
      releaseFirst = resolve
    })
    const commands: TransportCommand[] = []
    const transport = vi.fn(async (command: TransportCommand) => {
      commands.push(command)
      if (commands.length === 1) return first
      return {
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: 48_000,
        loopEnabled: false,
        loopRange: null
      }
    })
    const service = new TransportService(
      { current: null } as unknown as ProjectService,
      { transport } as unknown as AudioHostService
    )

    const play = service.command({ type: "play" })
    const pause = service.command({ type: "pause" })
    await Promise.resolve()

    expect(commands).toEqual([{ type: "play" }])
    releaseFirst({
      state: "playing",
      positionFrames: 0,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    })
    await Promise.all([play, pause])

    expect(commands).toEqual([{ type: "play" }, { type: "pause" }])
  })
})
