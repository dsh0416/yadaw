import { beforeEach, describe, expect, it, vi } from "vitest"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type { ProjectSession, RecordingSession } from "@yadaw/contracts"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

import { LifecycleCoordinator } from "./lifecycle-coordinator"

const project: ProjectSession = {
  id: "project",
  path: "project.yadaw",
  configuration: {
    name: "Project",
    sampleRate: 48_000,
    tempo: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

const recording: RecordingSession = {
  id: "recording",
  startedAt: 1,
  swapPath: "recording.partial.bwf",
  startFrame: 0,
  trackIds: ["audio-1"]
}

describe("LifecycleCoordinator", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects overlapping project transitions and rolls failures back", () => {
    const lifecycle = new LifecycleCoordinator(null)
    lifecycle.beginProject("opening")
    expect(() => lifecycle.beginProject("creating")).toThrow(/Close the current project/)
    lifecycle.failProject(new Error("broken archive"))
    expect(lifecycle.snapshot().project).toEqual({ status: "closed", error: "broken archive" })
  })

  it("restores an open project after a cancelled close", () => {
    const lifecycle = new LifecycleCoordinator(project)
    lifecycle.beginProject("closing")
    lifecycle.cancelProject()
    expect(lifecycle.snapshot().project).toMatchObject({ status: "open", session: project })
  })

  it("makes recording authoritative across project, audio, transport and mixer guards", () => {
    const lifecycle = new LifecycleCoordinator(project, {
      ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
      state: "running",
      sampleRate: 48_000
    })
    lifecycle.beginRecordingStart()
    lifecycle.completeRecordingStart(recording)

    expect(() => lifecycle.beginProject("saving")).toThrow(/Stop recording/)
    expect(() => lifecycle.beginAudio("stopping")).toThrow(/Stop recording/)
    expect(() => lifecycle.assertTransportAllowed({ type: "seek", positionFrames: 1 }))
      .toThrow(/recording workflow/)
    expect(() => lifecycle.assertMixerCommandAllowed({
      type: "delete-channel",
      channelId: "audio-1"
    })).toThrow(/cannot change/)
    expect(() => lifecycle.assertMixerCommandAllowed({
      type: "update-channel",
      channelId: "audio-1",
      patch: { gainDb: -3 }
    })).not.toThrow()
  })

  it("leaves a recoverable idle state when finalization fails", () => {
    const lifecycle = new LifecycleCoordinator(project, {
      ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
      state: "running"
    })
    lifecycle.beginRecordingStart()
    lifecycle.completeRecordingStart(recording)
    lifecycle.beginRecordingStop()
    lifecycle.markRecordingFinalizing(recording)
    lifecycle.failRecordingStop(new Error("disk full"))

    expect(lifecycle.snapshot().recording).toEqual({ status: "idle", error: "disk full" })
  })
})
