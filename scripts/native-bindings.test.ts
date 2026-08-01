import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

type NativeBindings = {
  analyzeWaveform: (path: string) => Promise<{
    channels: number
    frameCount: number
    sampleRate: number
    waveformLevels: unknown[]
  }>
  engineInfo: () => { backend: string; nodeApi: number; version: string }
  processGain: (samples: number[], gain: number) => { samples: number[]; peak: number }
  writeDeterministicTestRecording: (
    config: {
      path: string
      assetId: string
      originator: string
      originationDate: string
      originationTime: string
      timeReference: number
    },
    sampleRate: number,
    frameCount: number
  ) => { channels: number; frameCount: number; sampleRate: number }
}

const require = createRequire(import.meta.url)
const { analyzeWaveform, engineInfo, processGain, writeDeterministicTestRecording } =
  require("../crates/dsp-node") as NativeBindings
const expectedVersion = (await readFile(new URL("../VERSION", import.meta.url), "utf8")).trim()

await test("native DSP binding processes values across the napi boundary", () => {
  assert.deepEqual(engineInfo(), {
    backend: "rust+napi-rs",
    nodeApi: 8,
    version: expectedVersion
  })
  assert.deepEqual(processGain([1, -0.5, 0], 2), { samples: [2, -1, 0], peak: 2 })
})

await test("native DSP binding writes and analyzes a deterministic recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yadaw-native-bindings-"))
  try {
    const path = join(directory, "recording.bwf")
    const recording = writeDeterministicTestRecording(
      {
        path,
        assetId: "coverage-fixture",
        originator: "YADAW tests",
        originationDate: "2026-01-01",
        originationTime: "00:00:00",
        timeReference: 0
      },
      48_000,
      128
    )
    assert.equal(recording.channels, 2)
    assert.equal(recording.frameCount, 128)
    assert.equal(recording.sampleRate, 48_000)

    const waveform = await analyzeWaveform(path)
    assert.equal(waveform.channels, 2)
    assert.equal(waveform.frameCount, 128)
    assert.equal(waveform.sampleRate, 48_000)
    assert.ok(waveform.waveformLevels.length > 0)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
