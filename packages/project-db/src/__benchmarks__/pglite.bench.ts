import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { ProjectCommand } from "@yadaw/contracts"
import { afterAll, beforeAll, bench, describe } from "vitest"
import { ProjectDatabase } from "../node"

let database: ProjectDatabase
let directory: string
const graphLoadSamples: number[] = []
const waveformReadSamples: number[] = []

async function recordDuration(samples: number[], operation: () => Promise<unknown>): Promise<void> {
  const startedAt = performance.now()
  await operation()
  samples.push(performance.now() - startedAt)
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = (sorted.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

function formatPercentiles(samples: number[]): string {
  return `p50=${percentile(samples, 0.5).toFixed(4)}ms p95=${percentile(samples, 0.95).toFixed(4)}ms`
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "yadaw-pglite-bench-"))
  database = await ProjectDatabase.create(join(directory, "pgdata"), {
    name: "PGlite benchmark",
    sampleRate: 48_000,
    numerator: 4,
    denominator: 4,
    waveformDisplayMode: "separate"
  })

  const channelCommands: ProjectCommand[] = Array.from({ length: 64 }, (_, index) => ({
    type: "create-channel",
    channel: {
      id: `track-${index}`,
      kind: "instrument",
      systemRole: null,
      name: `Track ${index}`,
      color: "#4F8CFF",
      sortOrder: index + 1,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
  }))
  await database.applyCommand({ type: "batch", commands: channelCommands }, "output-1-2")

  const midiCommands: ProjectCommand[] = Array.from({ length: 32 }, (_, clipIndex) => ({
    type: "create-midi-clip",
    clip: {
      id: `clip-${clipIndex}`,
      sourceId: "source-1",
      trackId: `track-${clipIndex}`,
      name: `Clip ${clipIndex}`,
      startTick: clipIndex * 3_840,
      lengthTicks: 3_840,
      sourceOffsetTicks: 0,
      sourceLengthTicks: 3_840,
      notes: Array.from({ length: 1_000 }, (_, noteIndex) => ({
        id: `note-${clipIndex}-${noteIndex}`,
        startTick: noteIndex * 3,
        durationTicks: 2,
        channel: 0,
        key: 60 + (noteIndex % 12),
        velocity: 100,
        releaseVelocity: 0
      })),
      events: []
    }
  }))
  await database.importMidi(
    {
      id: "source-1",
      name: "Synthetic MIDI",
      contentHash: "source-hash",
      rawBytes: new Uint8Array([1])
    },
    { type: "batch", commands: midiCommands },
    "output-1-2"
  )

  const audioPath = join(directory, "empty.bwf")
  await writeFile(audioPath, new Uint8Array())
  await database.importLargeObject(audioPath, {
    id: "asset-1",
    name: "Ten-minute stereo waveform",
    mimeType: "audio/x-bwf",
    contentHash: "asset-hash",
    sampleRate: 48_000,
    channels: 2,
    bitDepth: "float32",
    frameCount: 28_800_000n,
    bwfTimeReference: 0n
  })
  const levels = []
  let framesPerBucket = 64
  while (true) {
    const bucketCount = Math.ceil(28_800_000 / framesPerBucket)
    levels.push({
      framesPerBucket,
      bucketCount,
      peaks: new Uint8Array(bucketCount * 2 * 8)
    })
    if (bucketCount <= 1) break
    framesPerBucket *= 4
  }
  await database.storeWaveform("asset-1", {
    sampleRate: 48_000,
    channels: 2,
    frameCount: 28_800_000n,
    levels
  })

  await database.mixerSnapshot()
  await database.readWaveform("asset-1", 1_000_000, 1_064_000, 1_000)
}, 60_000)

afterAll(async () => {
  process.stdout.write(
    [
      `initial graph load: ${formatPercentiles(graphLoadSamples)}`,
      `windowed waveform read: ${formatPercentiles(waveformReadSamples)}`
    ].join("\n") + "\n"
  )
  await database.close()
  await rm(directory, { recursive: true, force: true })
})

describe("PGlite representative project", () => {
  bench(
    "initial graph load: 68 channels and 32k MIDI notes",
    async () => {
      await recordDuration(graphLoadSamples, () => database.mixerSnapshot())
    },
    { iterations: 5, time: 0, warmupIterations: 0, warmupTime: 0 }
  )

  bench(
    "windowed waveform read: ten-minute stereo asset",
    async () => {
      await recordDuration(waveformReadSamples, () =>
        database.readWaveform("asset-1", 1_000_000, 1_064_000, 1_000)
      )
    },
    { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 }
  )
})
