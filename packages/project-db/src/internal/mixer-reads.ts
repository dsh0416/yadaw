import { asc, eq } from "drizzle-orm"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import type { MixerGraphSnapshot, ProjectConfiguration } from "@yadaw/contracts"
import {
  assets,
  keySignatureEvents,
  midiClips,
  midiEvents,
  midiNotes,
  mixerChannels,
  mixerSends,
  pluginInstances,
  tempoEvents,
  timelineClips,
  timeSignatureEvents
} from "../schema"
import * as schema from "../schema"
import { bytes, pluginDescriptor } from "./command-persistence"

type ProjectDb = PgliteDatabase<typeof schema>

export async function readMixerSnapshot(
  db: ProjectDb,
  configuration: ProjectConfiguration
): Promise<MixerGraphSnapshot> {
  const [
    channelRows,
    clipRows,
    sendRows,
    pluginRows,
    midiClipRows,
    midiNoteRows,
    midiEventRows,
    tempoRows,
    signatureRows,
    keySignatureRows
  ] = await Promise.all([
    db.select().from(mixerChannels).orderBy(asc(mixerChannels.sortOrder), asc(mixerChannels.id)),
    db
      .select({
        id: timelineClips.id,
        assetId: timelineClips.assetId,
        trackId: timelineClips.trackId,
        name: timelineClips.name,
        startFrame: timelineClips.startFrame,
        sourceOffsetFrames: timelineClips.sourceOffsetFrames,
        lengthFrames: timelineClips.lengthFrames,
        assetSampleRate: assets.sampleRate,
        assetChannels: assets.channels
      })
      .from(timelineClips)
      .innerJoin(assets, eq(assets.id, timelineClips.assetId))
      .orderBy(asc(timelineClips.startFrame), asc(timelineClips.id)),
    db
      .select()
      .from(mixerSends)
      .orderBy(asc(mixerSends.sourceChannelId), asc(mixerSends.sortOrder), asc(mixerSends.id)),
    db
      .select()
      .from(pluginInstances)
      .orderBy(
        asc(pluginInstances.channelId),
        asc(pluginInstances.role),
        asc(pluginInstances.slotOrder),
        asc(pluginInstances.id)
      ),
    db.select().from(midiClips).orderBy(asc(midiClips.startTick), asc(midiClips.id)),
    db
      .select()
      .from(midiNotes)
      .orderBy(asc(midiNotes.clipId), asc(midiNotes.startTick), asc(midiNotes.id)),
    db
      .select()
      .from(midiEvents)
      .orderBy(asc(midiEvents.clipId), asc(midiEvents.tick), asc(midiEvents.id)),
    db.select().from(tempoEvents).orderBy(asc(tempoEvents.tick)),
    db.select().from(timeSignatureEvents).orderBy(asc(timeSignatureEvents.tick)),
    db.select().from(keySignatureEvents).orderBy(asc(keySignatureEvents.tick))
  ])

  const kindOrder = new Map([
    ["audio", 0],
    ["instrument", 1],
    ["aux", 2],
    ["master", 3],
    ["output", 4]
  ])
  channelRows.sort(
    (left, right) =>
      (kindOrder.get(left.kind) ?? 5) - (kindOrder.get(right.kind) ?? 5) ||
      left.sortOrder - right.sortOrder ||
      left.id.localeCompare(right.id)
  )

  const notesByClip = new Map<string, MixerGraphSnapshot["midiClips"][number]["notes"]>()
  for (const note of midiNoteRows) {
    const notes = notesByClip.get(note.clipId) ?? []
    notes.push({
      id: note.id,
      startTick: note.startTick,
      durationTicks: note.durationTicks,
      channel: note.channel,
      key: note.key,
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity
    })
    notesByClip.set(note.clipId, notes)
  }
  const eventsByClip = new Map<string, MixerGraphSnapshot["midiClips"][number]["events"]>()
  for (const event of midiEventRows) {
    const events = eventsByClip.get(event.clipId) ?? []
    events.push({
      id: event.id,
      tick: event.tick,
      channel: event.channel,
      kind: event.kind,
      data: bytes(event.data)
    })
    eventsByClip.set(event.clipId, events)
  }

  return {
    sampleRate: configuration.sampleRate,
    channels: channelRows.map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      systemRole: channel.systemRole,
      name: channel.name,
      color: channel.color,
      sortOrder: channel.sortOrder,
      inputSource: channel.inputSource,
      inputFormat: channel.inputFormat,
      gainDb: channel.gainDb,
      pan: channel.pan,
      muted: channel.muted,
      soloed: channel.soloed,
      outputChannelId: channel.outputChannelId,
      outputBus: channel.outputBus,
      recordArmed: channel.recordArmed,
      inputMonitoring: channel.inputMonitoring,
      inputChannels: channel.inputChannels,
      hardwareOutputChannels: channel.hardwareOutputChannels
    })),
    clips: clipRows.map((clip) => ({
      ...clip,
      startFrame: Number(clip.startFrame),
      sourceOffsetFrames: Number(clip.sourceOffsetFrames),
      lengthFrames: Number(clip.lengthFrames)
    })),
    sends: sendRows,
    plugins: pluginRows.map((plugin) => ({
      id: plugin.id,
      channelId: plugin.channelId,
      role: plugin.role,
      slotOrder: plugin.slotOrder,
      classId: plugin.classId,
      descriptor: pluginDescriptor(plugin.descriptorSnapshot),
      audioMode: plugin.audioMode,
      enabled: plugin.enabled,
      componentState: bytes(plugin.componentState),
      controllerState: bytes(plugin.controllerState)
    })),
    midiClips: midiClipRows.map((clip) => ({
      id: clip.id,
      sourceId: clip.sourceId,
      trackId: clip.trackId,
      name: clip.name,
      startTick: clip.startTick,
      lengthTicks: clip.lengthTicks,
      sourceOffsetTicks: clip.sourceOffsetTicks,
      notes: notesByClip.get(clip.id) ?? [],
      events: eventsByClip.get(clip.id) ?? []
    })),
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: tempoRows.map((event) => ({
        tick: event.tick,
        beatsPerMinute: event.beatsPerMinute
      })),
      timeSignatureEvents: signatureRows
    },
    keySignatureEvents: keySignatureRows.map((event) => ({
      ...event,
      mode: event.mode === "minor" ? "minor" : "major"
    }))
  }
}
