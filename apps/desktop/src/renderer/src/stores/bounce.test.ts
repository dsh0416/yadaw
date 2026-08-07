import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { MixerChannelState, ProjectWorkspaceSnapshot } from "@heron/contracts"
import { useBounceStore } from "./bounce"
import { useMixerStore } from "./mixer"
import { useProjectStore } from "./project"

const output: MixerChannelState = {
  id: "output-1-2",
  kind: "output",
  systemRole: null,
  name: "Output 1–2",
  color: "#73d6c9",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: [1, 2]
}

describe("bounce store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const mixer = useMixerStore()
    const workspace: ProjectWorkspaceSnapshot = {
      project: { kind: "project-session", id: "project", epoch: "test", generation: 1 },
      projectGraph: { kind: "project-graph", id: "graph", epoch: "test", generation: 1 },
      revision: 4,
      session: {
        id: "project",
        path: "mix.heron",
        dirty: false,
        recoveredWorkingCopy: false,
        configuration: {
          name: "Mix",
          sampleRate: 96_000,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          waveformDisplayMode: "separate"
        }
      },
      graph: {
        ...structuredClone(mixer.graph),
        projectEndTick: 7_680,
        sampleRate: 96_000,
        channels: [...mixer.graph.channels.filter((channel) => channel.kind !== "output"), output]
      },
      assets: []
    }
    useProjectStore().applyWorkspace(workspace)
    mixer.hydrate(workspace.graph)
    Object.assign(window.heron, { startBounceOutput: vi.fn() })
  })

  it("opens with safe WAV defaults and the full project range", () => {
    const store = useBounceStore()
    store.openFor(output)
    expect(store.open).toBe(true)
    expect(store.format).toEqual({ format: "wav", bitDepth: "pcm24", dither: "tpdf" })
    expect(store.normalization).toEqual({ mode: "overload-protection" })
    expect(store.startBar).toBe(1)
    expect(store.endBar).toBe(2)
    expect(store.includeTail).toBe(true)
  })

  it("enforces MP3 sample rates and keeps the dialog open when save selection is cancelled", async () => {
    const store = useBounceStore()
    store.openFor(output)
    store.setFormat({ format: "mp3", bitrate: { mode: "cbr", kbps: 320 } })
    expect(store.valid).toBe(false)
    store.sampleRate = 48_000
    store.includeTail = false
    expect(store.valid).toBe(true)
    vi.mocked(window.heron.startBounceOutput).mockResolvedValue({
      ok: true,
      requestId: "request",
      operationId: "operation",
      warnings: [],
      value: null
    })
    expect(await store.start()).toBe(false)
    expect(window.heron.startBounceOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeTail: false })
    )
    expect(store.open).toBe(true)
  })

  it("ignores non-Output channels and prevents closing while a start is pending", () => {
    const store = useBounceStore()
    store.openFor({ ...output, kind: "audio", hardwareOutputChannels: [] })
    expect(store.open).toBe(false)

    store.openFor(output)
    store.starting = true
    store.close()
    expect(store.open).toBe(true)

    store.starting = false
    store.close()
    expect(store.open).toBe(false)
  })

  it("clamps an explicit high sample rate when switching to MP3", () => {
    const store = useBounceStore()
    store.openFor(output)
    store.sampleRate = 96_000

    store.setFormat({ format: "mp3", bitrate: { mode: "vbr", quality: 2 } })

    expect(store.sampleRate).toBe(48_000)
  })

  it("shows typed RPC failures and closes after a successful start", async () => {
    const store = useBounceStore()
    store.openFor(output)
    store.sampleRate = 48_000
    vi.mocked(window.heron.startBounceOutput).mockResolvedValueOnce({
      ok: false,
      requestId: "request",
      error: {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: "correlation",
        userMessageKey: "errors.unavailable",
        details: { type: "resource-unavailable", component: "main", dispatched: true }
      }
    })

    expect(await store.start()).toBe(false)
    expect(store.error).not.toBe("")
    expect(store.starting).toBe(false)
    expect(store.open).toBe(true)

    vi.mocked(window.heron.startBounceOutput).mockResolvedValueOnce({
      ok: true,
      requestId: "request",
      operationId: "operation",
      warnings: [],
      value: { operationId: "operation", filePath: "mix.wav" }
    })
    expect(await store.start()).toBe(true)
    expect(store.open).toBe(false)
    expect(store.starting).toBe(false)
  })
})
