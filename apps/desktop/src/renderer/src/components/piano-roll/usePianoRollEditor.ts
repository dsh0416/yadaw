import { computed, inject, watch, type ComputedRef, type InjectionKey, type Ref } from "vue"
import type { CSSProperties } from "vue"
import { storeToRefs } from "pinia"
import type {
  MidiClipState,
  MidiNoteState,
  MixerChannelState,
  MixerGraphSnapshot,
  ProjectCommand
} from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import { usePianoRollStore } from "../../stores/pianoRoll"
import { useTransportStore } from "../../stores/transport"
import { midiNoteName, noteGlobalStart, planExistingNoteEdits } from "../../utils/pianoRoll"
import {
  barTicksThroughTick,
  beatTicksThroughTick,
  secondsToTick,
  tickToSeconds
} from "../../utils/tempoMap"
import {
  createPianoRollGestures,
  type NoteGestureItem,
  type PianoRollGestures,
  type PianoRollNoteEdit
} from "./usePianoRollGestures"
import { createPianoRollEditing, type PianoRollEditing } from "./usePianoRollEditing"

export interface PianoRollEditor extends PianoRollGestures, PianoRollEditing {
  pianoRollStore: ReturnType<typeof usePianoRollStore>
  graph: Ref<MixerGraphSnapshot>
  openClips: ComputedRef<MidiClipState[]>
  activeClip: ComputedRef<MidiClipState | null>
  visibleNotes: ComputedRef<NoteGestureItem[]>
  selectedItems: ComputedRef<NoteGestureItem[]>
  pixelsPerTick: ComputedRef<number>
  gridWidth: ComputedRef<number>
  canvasHeight: ComputedRef<number>
  barTicks: ComputedRef<number[]>
  beatTicks: ComputedRef<number[]>
  playheadTick: ComputedRef<number>
  mixerError: ComputedRef<string>
  trackColor: (clip: MidiClipState) => string
  clipStyle: (clip: MidiClipState) => CSSProperties
  noteStyle: (clip: MidiClipState, note: MidiNoteState) => CSSProperties
  keyStyle: (key: number) => CSSProperties
  isBlackKey: (key: number) => boolean
  displayedNoteValues: (
    clip: MidiClipState,
    note: MidiNoteState
  ) => { globalStartTick: number; durationTicks: number; key: number }
  noteAriaLabel: (clip: MidiClipState, note: MidiNoteState) => string
  seekToTick: (tick: number) => void
  batch: (commands: ProjectCommand[]) => Promise<boolean>
  commandsForEdits: (values: PianoRollNoteEdit[]) => ProjectCommand[]
}

export const pianoRollEditorKey: InjectionKey<PianoRollEditor> = Symbol("piano-roll-editor")

export function usePianoRollEditor(): PianoRollEditor {
  const editor = inject(pianoRollEditorKey, null)
  if (!editor) throw new Error("Piano roll editor context is not provided")
  return editor
}

export function createPianoRollEditor(): PianoRollEditor {
  const mixerStore = useMixerStore()
  const pianoRollStore = usePianoRollStore()
  const transportStore = useTransportStore()
  const { graph } = storeToRefs(mixerStore)

  const openClips = computed(() =>
    pianoRollStore.openClipIds
      .map((id) => graph.value.midiClips.find((clip) => clip.id === id))
      .filter((clip): clip is MidiClipState => Boolean(clip))
  )
  const activeClip = computed(
    () => openClips.value.find((clip) => clip.id === pianoRollStore.activeClipId) ?? null
  )
  const pixelsPerTick = computed(
    () => pianoRollStore.pixelsPerQuarter / graph.value.tempoMap.ticksPerQuarter
  )
  const channelsById = computed(
    () => new Map<string, MixerChannelState>(graph.value.channels.map((channel) => [channel.id, channel]))
  )
  const visibleNotes = computed(() =>
    openClips.value.flatMap((clip) =>
      clip.notes
        .filter(
          (note) =>
            note.startTick + note.durationTicks > clip.sourceOffsetTicks &&
            note.startTick < clip.sourceOffsetTicks + clip.lengthTicks
        )
        .map((note) => ({ clip, note, globalStartTick: noteGlobalStart(clip, note) }))
    )
  )
  const selectedItems = computed(() => {
    const selected = pianoRollStore.selectedNoteKeys
    return visibleNotes.value.filter(({ clip, note }) => selected.has(`${clip.id}:${note.id}`))
  })
  const playheadTick = computed(() =>
    secondsToTick(graph.value.tempoMap, transportStore.playheadSeconds)
  )
  const mixerError = computed(() => mixerStore.error)

  function batch(commands: ProjectCommand[]): Promise<boolean> {
    const useful = commands.filter(
      (command) => command.type !== "batch" || command.commands.length > 0
    )
    if (useful.length === 0) return Promise.resolve(true)
    return mixerStore.execute(
      useful.length === 1 ? useful[0]! : { type: "batch", commands: useful }
    )
  }

  function commandsForEdits(values: PianoRollNoteEdit[]): ProjectCommand[] {
    const byClip = new Map<string, PianoRollNoteEdit[]>()
    for (const value of values) {
      const group = byClip.get(value.clip.id) ?? []
      group.push(value)
      byClip.set(value.clip.id, group)
    }
    return [...byClip.values()].flatMap(
      (group) =>
        planExistingNoteEdits(
          group[0]!.clip,
          group.map((value) => ({
            noteId: value.note.id,
            globalStartTick: value.globalStartTick,
            durationTicks: value.durationTicks,
            patch: value.patch
          }))
        ).commands
    )
  }

  const gestures = createPianoRollGestures({
    pianoRollStore,
    pixelsPerTick,
    visibleNotes,
    selectedItems,
    activeClip,
    trackColor,
    batch,
    commandsForEdits
  })
  const { gestureNotePreviews, gestureClipRanges } = gestures

  const maximumTick = computed(() =>
    Math.max(
      graph.value.tempoMap.ticksPerQuarter * 4,
      ...openClips.value.map((clip) => {
        const preview = gestureClipRanges.value.get(clip.id)
        return preview ? preview.startTick + preview.lengthTicks : clip.startTick + clip.lengthTicks
      })
    )
  )
  const gridWidth = computed(() => Math.max(640, maximumTick.value * pixelsPerTick.value + 240))
  const canvasHeight = computed(() => 28 + pianoRollStore.rowHeight * 128)
  const barTicks = computed(() => barTicksThroughTick(graph.value.tempoMap, maximumTick.value))
  const beatTicks = computed(() => beatTicksThroughTick(graph.value.tempoMap, maximumTick.value))

  function trackColor(clip: MidiClipState): string {
    return channelsById.value.get(clip.trackId)?.color ?? "var(--ui-signal-midi)"
  }

  function clipStyle(clip: MidiClipState): CSSProperties {
    const preview = gestureClipRanges.value.get(clip.id)
    const startTick = preview?.startTick ?? clip.startTick
    const lengthTicks = preview?.lengthTicks ?? clip.lengthTicks
    return {
      left: `${startTick * pixelsPerTick.value}px`,
      width: `${Math.max(1, lengthTicks * pixelsPerTick.value)}px`,
      "--clip-color": trackColor(clip)
    }
  }

  function noteStyle(clip: MidiClipState, note: MidiNoteState): CSSProperties {
    const preview = gestureNotePreviews.value.get(`${clip.id}:${note.id}`)
    const globalStartTick = preview?.globalStartTick ?? noteGlobalStart(clip, note)
    const durationTicks = preview?.durationTicks ?? note.durationTicks
    const key = preview?.key ?? note.key
    return {
      left: `${globalStartTick * pixelsPerTick.value}px`,
      top: `${(127 - key) * pianoRollStore.rowHeight + 1}px`,
      width: `${Math.max(2, durationTicks * pixelsPerTick.value)}px`,
      height: `${Math.max(4, pianoRollStore.rowHeight - 2)}px`,
      "--note-color": trackColor(clip),
      "--note-velocity": `${note.velocity / 127}`
    }
  }

  function displayedNoteValues(
    clip: MidiClipState,
    note: MidiNoteState
  ): { globalStartTick: number; durationTicks: number; key: number } {
    return (
      gestureNotePreviews.value.get(`${clip.id}:${note.id}`) ?? {
        globalStartTick: noteGlobalStart(clip, note),
        durationTicks: note.durationTicks,
        key: note.key
      }
    )
  }

  function noteAriaLabel(clip: MidiClipState, note: MidiNoteState): string {
    const value = displayedNoteValues(clip, note)
    return `${midiNoteName(value.key)}, start ${value.globalStartTick}, duration ${value.durationTicks}, velocity ${note.velocity}, ${clip.name}`
  }

  function keyStyle(key: number): CSSProperties {
    return {
      top: `${(127 - key) * pianoRollStore.rowHeight}px`,
      height: `${pianoRollStore.rowHeight}px`
    }
  }

  function isBlackKey(key: number): boolean {
    return [1, 3, 6, 8, 10].includes(key % 12)
  }

  function seekToTick(tick: number): void {
    void transportStore.seek(tickToSeconds(graph.value.tempoMap, tick))
  }

  const editing = createPianoRollEditing({
    pianoRollStore,
    graph,
    activeClip,
    visibleNotes,
    selectedItems,
    gestureNotePreviews,
    batch,
    commandsForEdits
  })

  watch(
    graph,
    (value) => {
      const clips = new Set(value.midiClips.map((clip) => clip.id))
      const notes = new Set(
        value.midiClips.flatMap((clip) => clip.notes.map((note) => `${clip.id}:${note.id}`))
      )
      pianoRollStore.reconcile(clips, notes)
    },
    { immediate: true }
  )

  return {
    ...gestures,
    ...editing,
    pianoRollStore,
    graph,
    openClips,
    activeClip,
    visibleNotes,
    selectedItems,
    pixelsPerTick,
    gridWidth,
    canvasHeight,
    barTicks,
    beatTicks,
    playheadTick,
    mixerError,
    trackColor,
    clipStyle,
    noteStyle,
    keyStyle,
    isBlackKey,
    displayedNoteValues,
    noteAriaLabel,
    seekToTick,
    batch,
    commandsForEdits
  }
}
