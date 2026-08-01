import { describe, expect, it, vi } from "vitest"
import { assertProjectCommandAllowed } from "../internal/command-validation"

function selectChain(rows: unknown[]) {
  const limit = vi.fn(async () => rows)
  const where = vi.fn(() => ({ limit }))
  const innerJoin = vi.fn(() => ({
    where,
    innerJoin: vi.fn(() => ({ where })),
    leftJoin: vi.fn(() => ({ where }))
  }))
  const leftJoin = vi.fn(() => ({ where }))
  const from = vi.fn(() => ({ innerJoin, leftJoin, where }))
  return {
    select: vi.fn(() => ({ from })),
    limit,
    rows
  }
}

describe("assertProjectCommandAllowed", () => {
  it("rejects deleting system channels via delete-track", async () => {
    const tx = selectChain([{ systemRole: "metronome" }])
    await expect(
      assertProjectCommandAllowed(tx as never, { type: "delete-track", trackId: "t1" })
    ).rejects.toThrow(/System channels cannot be deleted/)
  })

  it("allows deleting ordinary tracks", async () => {
    const tx = selectChain([{ systemRole: null }])
    await expect(
      assertProjectCommandAllowed(tx as never, { type: "delete-track", trackId: "t1" })
    ).resolves.toBeUndefined()
  })

  it("rejects delete-channel for track-owned channels", async () => {
    const tx = selectChain([{ systemRole: null, trackId: "track-1" }])
    await expect(
      assertProjectCommandAllowed(tx as never, { type: "delete-channel", channelId: "c1" })
    ).rejects.toThrow(/Track-owned channels/)
  })

  it("rejects clips on system channels", async () => {
    const tx = selectChain([{ systemRole: "metronome" }])
    await expect(
      assertProjectCommandAllowed(
        tx as never,
        {
          type: "create-audio-clip",
          clip: { trackId: "t1" }
        } as never
      )
    ).rejects.toThrow(/System channels cannot contain clips/)
  })

  it("validates midi source metadata", async () => {
    const tx = selectChain([])
    await expect(
      assertProjectCommandAllowed(
        tx as never,
        {
          type: "create-midi-source",
          source: { id: "", name: " ", contentHash: "", rawBytes: null }
        } as never
      )
    ).rejects.toThrow(/MIDI source metadata is invalid/)
  })

  it("rejects missing midi clips for note edits", async () => {
    const tx = selectChain([])
    await expect(
      assertProjectCommandAllowed(
        tx as never,
        {
          type: "create-midi-notes",
          clipId: "missing",
          notes: []
        } as never
      )
    ).rejects.toThrow(/was not found/)
  })

  it("validates rebase offsets", async () => {
    const tx = selectChain([{ clipId: "clip-1", systemRole: null }])
    await expect(
      assertProjectCommandAllowed(
        tx as never,
        {
          type: "rebase-midi-clip-content",
          clipId: "clip-1",
          deltaTicks: 1.5
        } as never
      )
    ).rejects.toThrow(/integer resolution/)
  })

  it("walks nested batch commands", async () => {
    const tx = selectChain([{ systemRole: null }])
    await expect(
      assertProjectCommandAllowed(tx as never, {
        type: "batch",
        commands: [{ type: "delete-track", trackId: "t1" }]
      })
    ).resolves.toBeUndefined()
  })
})
