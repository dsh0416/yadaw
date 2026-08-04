import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

type NativeHostResponse = {
  body: Buffer
}

type AudioHostRuntime = {
  request: (request: Buffer) => Promise<NativeHostResponse>
  heartbeat: (request: Buffer) => Promise<NativeHostResponse>
  close: () => void
}

type NativeBindings = {
  AudioHostRuntime: new (workerThreads?: number, maxBlockingThreads?: number) => AudioHostRuntime
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
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url))
const { decode, encode } = desktopRequire("@msgpack/msgpack") as {
  decode: (value: Uint8Array) => unknown
  encode: (value: unknown) => Uint8Array
}
const {
  AudioHostRuntime,
  analyzeWaveform,
  engineInfo,
  processGain,
  writeDeterministicTestRecording
} = require("../crates/dsp-node") as NativeBindings
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
  const directory = await mkdtemp(join(tmpdir(), "heron-native-bindings-"))
  try {
    const path = join(directory, "recording.bwf")
    const recording = writeDeterministicTestRecording(
      {
        path,
        assetId: "coverage-fixture",
        originator: "Heron tests",
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

await test("a pending UI request does not occupy the native async request path", async () => {
  const runtime = new AudioHostRuntime(2, 4)
  let requestId = 1
  const request = (command: unknown) =>
    runtime.request(Buffer.from(encode({ request_id: requestId++, command })))
  const pendingUiRequest = request({
    type: "configure-plugin-editor-appearance",
    appearance: { theme: "dark", locale: "en-US" }
  }).then(
    () => null,
    (error: unknown) => error
  )

  try {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const echo = await Promise.race([
      request({
        type: "benchmark-echo",
        payload: { storage: "inline", bytes: new Uint8Array([1, 2, 3]) }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("independent audio request was blocked")), 500)
      )
    ])
    const echoResponse = decode(echo.body) as { result: { type: string } }
    assert.equal(echoResponse.result.type, "benchmark-echo")

    const heartbeat = await Promise.race([
      runtime.heartbeat(
        Buffer.from(
          encode({
            request_id: requestId++,
            command: { type: "heartbeat" }
          })
        )
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("heartbeat was blocked by a control request")), 500)
      )
    ])
    const heartbeatResponse = decode(heartbeat.body) as { result: { type: string } }
    assert.equal(heartbeatResponse.result.type, "heartbeat")
  } finally {
    runtime.close()
  }

  assert.ok((await pendingUiRequest) instanceof Error)
})
