import type {
  MixerBusState,
  MixerChannelState,
  ProjectGraphSnapshot,
  MixerRouteTarget,
  MixerRuntimeSnapshot,
  MixerSendState
} from "@yadaw/contracts"
import { MIXER_BUS_COUNT } from "@yadaw/contracts"

export const MIXER_BUSES: readonly MixerBusState[] = Array.from(
  { length: MIXER_BUS_COUNT },
  (_, index) => ({
    channel: index + 1,
    name: `BUS ${index + 1}`
  })
)

export function patchMixerGraph(
  graph: ProjectGraphSnapshot,
  target: "channel" | "send",
  id: string,
  patch: Record<string, unknown>
): ProjectGraphSnapshot {
  const next = structuredClone(graph)
  const values = target === "channel" ? next.channels : next.sends
  const value = values.find((candidate) => candidate.id === id)
  if (value) Object.assign(value, patch)
  return next
}

export function audioTracks(channels: readonly MixerChannelState[]): MixerChannelState[] {
  return channels.filter((channel) => channel.kind === "audio" && channel.systemRole === null)
}

export function instrumentTracks(channels: readonly MixerChannelState[]): MixerChannelState[] {
  return channels.filter((channel) => channel.kind === "instrument" && channel.systemRole === null)
}

export function systemChannels(channels: readonly MixerChannelState[]): MixerChannelState[] {
  return channels.filter((channel) => channel.systemRole !== null)
}

export function sendsFor(graph: ProjectGraphSnapshot, channelId: string): MixerSendState[] {
  return graph.sends.filter((send) => send.sourceChannelId === channelId)
}

export function meterFor(runtime: MixerRuntimeSnapshot, channelId: string) {
  return (
    runtime.meters.find((meter) => meter.channelId === channelId) ?? {
      channelId,
      preFaderPeak: [0, 0] as [number, number],
      postFaderPeak: [0, 0] as [number, number],
      heldPeak: [0, 0] as [number, number],
      clipped: false
    }
  )
}

function tickToSeconds(graph: ProjectGraphSnapshot, tick: number): number {
  const map = graph.tempoMap
  let seconds = 0
  let previousTick = 0
  let beatsPerMinute = map.tempoEvents[0]?.beatsPerMinute ?? 120
  for (const event of map.tempoEvents.slice(1)) {
    if (event.tick >= tick) break
    seconds += (((event.tick - previousTick) / map.ticksPerQuarter) * 60) / beatsPerMinute
    previousTick = event.tick
    beatsPerMinute = event.beatsPerMinute
  }
  return (
    seconds +
    (((Math.max(previousTick, tick) - previousTick) / map.ticksPerQuarter) * 60) / beatsPerMinute
  )
}

export function projectContentEndSeconds(graph: ProjectGraphSnapshot): number {
  const sampleRate = graph.sampleRate
  const audioEnd = graph.audioClips.reduce(
    (latest, clip) =>
      Math.max(latest, sampleRate > 0 ? (clip.startFrame + clip.lengthFrames) / sampleRate : 0),
    0
  )
  const midiEnd = graph.midiClips.reduce(
    (latest, clip) => Math.max(latest, tickToSeconds(graph, clip.startTick + clip.lengthTicks)),
    0
  )
  return Math.max(audioEnd, midiEnd)
}

export function availableOutputTargets(
  graph: ProjectGraphSnapshot,
  channelId: string
): MixerRouteTarget[] {
  const source = graph.channels.find((channel) => channel.id === channelId)
  if (
    !source ||
    (source.kind !== "audio" && source.kind !== "instrument" && source.kind !== "aux")
  ) {
    return []
  }
  return routeTargets(graph).filter((target) => {
    const candidate = structuredClone(graph)
    const candidateSource = candidate.channels.find((channel) => channel.id === source.id)
    if (!candidateSource) return false
    candidateSource.outputChannelId = target.kind === "output" ? target.channelId : null
    candidateSource.outputBus = target.kind === "bus" ? target.bus : null
    return isAcyclic(candidate)
  })
}

export function availableSendTargets(
  graph: ProjectGraphSnapshot,
  channelId: string
): MixerRouteTarget[] {
  const source = graph.channels.find((channel) => channel.id === channelId)
  if (
    !source ||
    (source.kind !== "audio" && source.kind !== "instrument" && source.kind !== "aux")
  ) {
    return []
  }
  const existing = new Set(
    sendsFor(graph, channelId).map((send) =>
      send.targetChannelId ? `output:${send.targetChannelId}` : `bus:${send.targetBus}`
    )
  )
  return routeTargets(graph).filter((target) => {
    const key = target.kind === "output" ? `output:${target.channelId}` : `bus:${target.bus}`
    if (existing.has(key)) return false
    const candidate = structuredClone(graph)
    candidate.sends.push({
      id: "candidate",
      sourceChannelId: channelId,
      targetChannelId: target.kind === "output" ? target.channelId : null,
      targetBus: target.kind === "bus" ? target.bus : null,
      sortOrder: 0,
      enabled: false,
      tap: "post-pan",
      levelDb: -90
    })
    return isAcyclic(candidate)
  })
}

function routeTargets(graph: ProjectGraphSnapshot): MixerRouteTarget[] {
  return [
    ...MIXER_BUSES.map((bus) => ({ kind: "bus" as const, bus: bus.channel })),
    ...graph.channels
      .filter((channel) => channel.kind === "output")
      .map((output) => ({ kind: "output" as const, channelId: output.id }))
  ]
}

function isAcyclic(graph: ProjectGraphSnapshot): boolean {
  const edges = new Map(graph.channels.map((channel) => [channel.id, [] as string[]]))
  for (const channel of graph.channels) {
    if (channel.outputChannelId) edges.get(channel.id)?.push(channel.outputChannelId)
    if (channel.outputBus != null) {
      for (const consumer of graph.channels) {
        if (consumer.inputSource === "bus" && consumer.inputChannels.includes(channel.outputBus)) {
          edges.get(channel.id)?.push(consumer.id)
        }
      }
    }
  }
  for (const send of graph.sends) {
    if (send.targetChannelId) edges.get(send.sourceChannelId)?.push(send.targetChannelId)
    if (send.targetBus === null) continue
    for (const consumer of graph.channels) {
      if (consumer.inputSource === "bus" && consumer.inputChannels.includes(send.targetBus)) {
        edges.get(send.sourceChannelId)?.push(consumer.id)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (!visit(next)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return graph.channels.every((channel) => visit(channel.id))
}
