import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAssetSummary } from "@heron/contracts"
import { rpcFailure, rpcSuccess } from "../test/ipc"
import { useProjectStore } from "./project"
import { useMediaBrowserStore } from "./mediaBrowser"

const audio: ProjectAssetSummary = {
  id: "audio-1",
  kind: "audio",
  name: "Kick.wav",
  contentHash: "audio-hash",
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n
}

const midi: ProjectAssetSummary = {
  id: "midi-1",
  kind: "midi",
  name: "Bass.mid",
  contentHash: "midi-hash",
  byteLength: 128
}

function stores() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const project = useProjectStore()
  project.projectRef = {
    kind: "project-session",
    id: "project-1",
    epoch: "main",
    generation: 1
  }
  project.projectAssets = [audio, midi]
  return { project, media: useMediaBrowserStore() }
}

describe("media browser store", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.heron.startAssetAudition = vi.fn(async () => rpcSuccess(undefined))
    window.heron.stopAssetAudition = vi.fn(async () => rpcSuccess(undefined))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("keeps the active audition visible until the engine confirms stop", async () => {
    const { media } = stores()
    await media.toggleAudition(audio)
    expect(media.auditioningAssetId).toBe(audio.id)

    const stopFailure = rpcFailure("errors.audioEngineUnavailable")
    let resolveStop!: (value: typeof stopFailure) => void
    window.heron.stopAssetAudition = vi.fn(
      () =>
        new Promise<typeof stopFailure>((resolve) => {
          resolveStop = resolve
        })
    )
    const stopping = media.stopAudition()

    expect(media.auditioningAssetId).toBe(audio.id)
    resolveStop(stopFailure)
    await stopping

    expect(media.auditioningAssetId).toBe(audio.id)
    expect(media.auditionFailed).toBe(true)

    window.heron.stopAssetAudition = vi.fn(async () => rpcSuccess(undefined))
    await media.stopAudition()
    expect(media.auditioningAssetId).toBeNull()
  })

  it("only auditions selected audio and reconciles removed selections", async () => {
    const { media } = stores()
    media.select(midi.id)
    await expect(media.toggleSelectedAudition()).resolves.toBe(false)
    expect(window.heron.startAssetAudition).not.toHaveBeenCalled()

    media.select(audio.id)
    await expect(media.toggleSelectedAudition()).resolves.toBe(true)
    expect(media.selectedAsset).toEqual(audio)
    expect(media.auditioningAssetId).toBe(audio.id)

    media.reconcileAssets([midi])
    expect(media.selectedAssetId).toBeNull()
    await media.reset()
    expect(media.auditioningAssetId).toBeNull()
    expect(media.auditionFailed).toBe(false)
  })
})
