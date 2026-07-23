import { describe, expect, it } from "vitest"
import type { Asset } from "@yadaw/project-db/schema"
import { assetsToTimelineClips } from "./transport"

function asset(id: string, frameCount: bigint, sampleRate = 48_000): Asset {
  return {
    id,
    name: `${id}.bwf`,
    mimeType: "audio/x-bwf",
    contentHash: `hash-${id}`,
    byteLength: 100n,
    sampleRate,
    channels: 2,
    bitDepth: "float32",
    frameCount,
    bwfTimeReference: 0n,
    largeObjectOid: 1,
    createdAt: new Date()
  }
}

describe("transport timeline", () => {
  it("lays project recordings out consecutively using their real frame durations", () => {
    const clips = assetsToTimelineClips([
      asset("take-one", 96_000n),
      asset("take-two", 24_000n)
    ])

    expect(clips).toMatchObject([
      {
        id: "take-one",
        name: "take-one",
        startSeconds: 0,
        durationSeconds: 2,
        endSeconds: 2
      },
      {
        id: "take-two",
        name: "take-two",
        startSeconds: 2,
        durationSeconds: 0.5,
        endSeconds: 2.5
      }
    ])
  })
})
