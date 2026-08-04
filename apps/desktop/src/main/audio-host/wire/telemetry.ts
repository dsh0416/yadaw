export type TelemetryWire = [
  epoch: number,
  graphRevision: number,
  callbackGeneration: number,
  transportState: number,
  positionFrames: number,
  sampleRate: number,
  meters: Array<
    [
      runtimeHandle: number,
      preLeft: number,
      preRight: number,
      postLeft: number,
      postRight: number,
      heldLeft: number,
      heldRight: number,
      clipped: boolean
    ]
  >
]

export type TransportDiagnosticsWire = [
  sessionEpoch: string,
  requests: [pending: number, capacity: number, slowRequests: number],
  eventQueueDepth: number,
  telemetry: [epoch: string, graphRevision: number, callbackGeneration: number, meterSlots: number],
  parameterRing: [capacity: number, hardFull: number, staleEpoch: number],
  runtime: [workerThreads: number, maxBlockingThreads: number]
]

export function stableRuntimeHandle(namespace: number, id: string): number {
  let value = (2_166_136_261 ^ namespace) >>> 0
  for (const byte of Buffer.from(id)) {
    value ^= byte
    value = Math.imul(value, 16_777_619) >>> 0
  }
  return Math.max(1, value)
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round(Math.max(0, Math.min(1, fraction)) * (sorted.length - 1))] ?? 0
}
