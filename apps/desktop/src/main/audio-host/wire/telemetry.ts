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
  requests: [normalPending: number, priorityPending: number, capacity: number, timeouts: number],
  sharedMemory: [
    outstandingLeases: number,
    outstandingBytes: number,
    maxLeases: number,
    maxBytes: number,
    inlinePackets: number,
    inlineBytes: number,
    sharedPackets: number,
    sharedRegions: number,
    sharedBytes: number
  ],
  eventQueueDepth: number,
  telemetry: [
    epoch: string,
    capacity: number,
    graphRevision: number,
    callbackGeneration: number,
    meterSlots: number,
    fallbackReads: number
  ],
  parameterRing: [
    used: number,
    capacity: number,
    softFull: number,
    hardFull: number,
    boundaryFallbacks: number,
    staleEpoch: number
  ],
  closing: boolean,
  runtimeAndArena: [
    workerThreads: number,
    maxBlockingThreads: number,
    egressConcurrency: number,
    arenaRegions: number,
    arenaCapacityBytes: number,
    arenaUsedBytes: number,
    arenaHighWaterBytes: number,
    arenaOffers: number,
    arenaBusy: number,
    arenaQuarantinedRegions: number,
    copiedBytes: number
  ],
  persistentPages: [active: boolean, activationFailures: number]
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
