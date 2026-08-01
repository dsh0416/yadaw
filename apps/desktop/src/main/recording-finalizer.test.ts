import { describe, expect, it, vi } from "vitest"

const { finalizeRecording } = vi.hoisted(() => ({
  finalizeRecording: vi.fn((request: { path: string }) => ({
    path: request.path,
    frames: 100
  }))
}))

vi.mock("@yadaw/dsp-node", () => ({
  finalizeRecording
}))

import { RecordingFinalizer } from "./recording-finalizer"

describe("RecordingFinalizer", () => {
  it("delegates finalize requests to the native binding", () => {
    const finalizer = new RecordingFinalizer()
    const request = { path: "/swap/take.partial.bwf", bitDepth: "float32" as const }

    expect(finalizer.finalize(request as never)).toEqual({
      path: "/swap/take.partial.bwf",
      frames: 100
    })
    expect(finalizeRecording).toHaveBeenCalledWith(request)
  })
})
