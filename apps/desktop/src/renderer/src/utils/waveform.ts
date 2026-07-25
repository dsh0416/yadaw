import type { WaveformDisplayMode, WaveformPeakWindow } from "@yadaw/contracts"

export interface WaveformLine {
  x: number
  minimumY: number
  maximumY: number
  lane: number
}

export interface WaveformGeometry {
  lanes: number
  lines: WaveformLine[]
}

export function decodeWaveformPeaks(data: Uint8Array): Float32Array {
  if (data.byteLength % 4 !== 0) throw new RangeError("Waveform peak data is not Float32-aligned")
  const result = new Float32Array(data.byteLength / 4)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = view.getFloat32(index * 4, true)
  }
  return result
}

function finitePeak(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
}

export function aggregateWaveformPeaks(
  source: Float32Array,
  bucketCount: number,
  channels: number,
  targetBuckets: number
): Float32Array {
  if (bucketCount < 0 || channels < 1 || targetBuckets < 1) {
    throw new RangeError("Waveform aggregation dimensions must be positive")
  }
  const stride = channels * 2
  if (source.length < bucketCount * stride) throw new RangeError("Waveform peak data is incomplete")
  const outputBuckets = Math.min(bucketCount, targetBuckets)
  const result = new Float32Array(outputBuckets * stride)
  for (let output = 0; output < outputBuckets; output += 1) {
    const start = Math.floor(output * bucketCount / outputBuckets)
    const end = Math.max(start + 1, Math.ceil((output + 1) * bucketCount / outputBuckets))
    for (let channel = 0; channel < channels; channel += 1) {
      let minimum = 1
      let maximum = -1
      for (let bucket = start; bucket < end; bucket += 1) {
        const offset = bucket * stride + channel * 2
        minimum = Math.min(minimum, finitePeak(source[offset] ?? 0))
        maximum = Math.max(maximum, finitePeak(source[offset + 1] ?? 0))
      }
      const offset = output * stride + channel * 2
      result[offset] = minimum
      result[offset + 1] = maximum
    }
  }
  return result
}

export function mergeWaveformChannels(
  source: Float32Array,
  bucketCount: number,
  channels: number
): Float32Array {
  if (bucketCount < 0 || channels < 1) {
    throw new RangeError("Waveform channel dimensions must be positive")
  }
  const stride = channels * 2
  if (source.length < bucketCount * stride) throw new RangeError("Waveform peak data is incomplete")
  const result = new Float32Array(bucketCount * 2)
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    let minimum = 1
    let maximum = -1
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = bucket * stride + channel * 2
      minimum = Math.min(minimum, finitePeak(source[offset] ?? 0))
      maximum = Math.max(maximum, finitePeak(source[offset + 1] ?? 0))
    }
    result[bucket * 2] = minimum
    result[bucket * 2 + 1] = maximum
  }
  return result
}

export function buildWaveformGeometry(
  window: WaveformPeakWindow,
  displayMode: WaveformDisplayMode,
  width: number,
  height: number,
  amplitudeScale: number
): WaveformGeometry {
  const channels = Math.max(1, window.channels)
  const lanes = displayMode === "aggregate" ? 1 : channels
  if (window.bucketCount === 0 || width <= 0 || height <= 0) return { lanes, lines: [] }
  const columns = Math.max(1, Math.min(window.bucketCount, Math.floor(width)))
  const decoded = decodeWaveformPeaks(window.peaks)
  const channelValues = displayMode === "aggregate"
    ? mergeWaveformChannels(decoded, window.bucketCount, channels)
    : decoded
  const geometryChannels = displayMode === "aggregate" ? 1 : channels
  const values = aggregateWaveformPeaks(
    channelValues,
    window.bucketCount,
    geometryChannels,
    columns
  )
  const stride = geometryChannels * 2
  const laneHeight = height / lanes
  const lines: WaveformLine[] = []

  for (let column = 0; column < columns; column += 1) {
    for (let lane = 0; lane < geometryChannels; lane += 1) {
      const offset = column * stride + lane * 2
      const minimum = finitePeak(values[offset] ?? 0)
      const maximum = finitePeak(values[offset + 1] ?? 0)
      const center = lane * laneHeight + laneHeight / 2
      const radius = laneHeight / 2
      lines.push({
        x: (column + 0.5) / columns * width,
        minimumY: center - Math.max(-1, Math.min(1, minimum * amplitudeScale)) * radius,
        maximumY: center - Math.max(-1, Math.min(1, maximum * amplitudeScale)) * radius,
        lane
      })
    }
  }
  return { lanes, lines }
}

export function buildWarpedWaveformGeometry(
  window: WaveformPeakWindow,
  displayMode: WaveformDisplayMode,
  width: number,
  height: number,
  amplitudeScale: number,
  frameAtX: (x: number) => number
): WaveformGeometry {
  const channels = Math.max(1, window.channels)
  const lanes = displayMode === "aggregate" ? 1 : channels
  if (window.bucketCount === 0 || width <= 0 || height <= 0) return { lanes, lines: [] }
  const columns = Math.max(1, Math.floor(width))
  const decoded = decodeWaveformPeaks(window.peaks)
  const channelValues = displayMode === "aggregate"
    ? mergeWaveformChannels(decoded, window.bucketCount, channels)
    : decoded
  const geometryChannels = displayMode === "aggregate" ? 1 : channels
  const stride = geometryChannels * 2
  const framesPerBucket = Math.max(1, window.framesPerBucket)
  const laneHeight = height / lanes
  const lines: WaveformLine[] = []

  for (let column = 0; column < columns; column += 1) {
    const xStart = column / columns * width
    const xEnd = (column + 1) / columns * width
    const mappedStart = frameAtX(xStart)
    const mappedEnd = frameAtX(xEnd)
    const frameStart = Math.max(window.startFrame, Math.min(mappedStart, mappedEnd))
    const frameEnd = Math.min(window.endFrame, Math.max(mappedStart, mappedEnd))
    if (frameEnd <= window.startFrame || frameStart >= window.endFrame) continue
    const firstBucket = Math.max(
      0,
      Math.min(
        window.bucketCount - 1,
        Math.floor((frameStart - window.startFrame) / framesPerBucket)
      )
    )
    const endBucket = Math.max(
      firstBucket + 1,
      Math.min(
        window.bucketCount,
        Math.ceil((frameEnd - window.startFrame) / framesPerBucket)
      )
    )

    for (let lane = 0; lane < geometryChannels; lane += 1) {
      let minimum = 1
      let maximum = -1
      for (let bucket = firstBucket; bucket < endBucket; bucket += 1) {
        const offset = bucket * stride + lane * 2
        minimum = Math.min(minimum, finitePeak(channelValues[offset] ?? 0))
        maximum = Math.max(maximum, finitePeak(channelValues[offset + 1] ?? 0))
      }
      const center = lane * laneHeight + laneHeight / 2
      const radius = laneHeight / 2
      lines.push({
        x: (column + 0.5) / columns * width,
        minimumY: center - Math.max(-1, Math.min(1, minimum * amplitudeScale)) * radius,
        maximumY: center - Math.max(-1, Math.min(1, maximum * amplitudeScale)) * radius,
        lane
      })
    }
  }
  return { lanes, lines }
}
