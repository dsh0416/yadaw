import { computed, shallowRef } from "vue"
import type {
  KeySignatureEventState,
  MixerGraphSnapshot,
  ProjectCommand,
  TempoMapSnapshot
} from "@yadaw/contracts"
import { keySignatureValue, parseKeySignatureValue } from "../../utils/keySignatures"

interface GlobalLaneSelectionOptions {
  graph: () => MixerGraphSnapshot
  execute: (command: ProjectCommand) => Promise<boolean>
}

export function useGlobalLaneSelection(options: GlobalLaneSelectionOptions) {
  const selectedTempoTick = shallowRef<number | null>(0)
  const selectedMeterTick = shallowRef<number | null>(0)
  const selectedKeyTick = shallowRef<number | null>(0)
  const selectedTempo = computed(
    () =>
      options
        .graph()
        .tempoMap.tempoEvents.find((event) => event.tick === selectedTempoTick.value) ??
      options.graph().tempoMap.tempoEvents[0] ?? { tick: 0, beatsPerMinute: 120 }
  )
  const selectedMeter = computed(
    () =>
      options
        .graph()
        .tempoMap.timeSignatureEvents.find((event) => event.tick === selectedMeterTick.value) ??
      options.graph().tempoMap.timeSignatureEvents[0] ?? {
        tick: 0,
        numerator: 4,
        denominator: 4
      }
  )
  const selectedKey = computed(
    () =>
      options.graph().keySignatureEvents.find((event) => event.tick === selectedKeyTick.value) ??
      options.graph().keySignatureEvents[0] ?? { tick: 0, fifths: 0, mode: "major" as const }
  )
  const selectedKeyValue = computed(() =>
    keySignatureValue(selectedKey.value.fifths, selectedKey.value.mode)
  )

  function replaceTempoMap(tempoMap: TempoMapSnapshot): void {
    void options.execute({ type: "replace-tempo-map", tempoMap })
  }

  function updateSelectedTempo(beatsPerMinute: number): void {
    const graph = options.graph()
    const tick = selectedTempo.value.tick
    replaceTempoMap({
      ...graph.tempoMap,
      tempoEvents: graph.tempoMap.tempoEvents.map((event) =>
        event.tick === tick ? { ...event, beatsPerMinute } : event
      )
    })
  }

  function updateSelectedMeter(patch: { numerator?: number; denominator?: number }): void {
    const graph = options.graph()
    const tick = selectedMeter.value.tick
    replaceTempoMap({
      ...graph.tempoMap,
      timeSignatureEvents: graph.tempoMap.timeSignatureEvents.map((event) =>
        event.tick === tick ? { ...event, ...patch } : event
      )
    })
  }

  function replaceKeySignatureMap(events: KeySignatureEventState[]): void {
    void options.execute({ type: "replace-key-signature-map", events })
  }

  function updateSelectedKey(value: string): void {
    const choice = parseKeySignatureValue(value)
    if (!choice) return
    const graph = options.graph()
    const tick = selectedKey.value.tick
    replaceKeySignatureMap(
      graph.keySignatureEvents.map((event) =>
        event.tick === tick ? { ...event, ...choice } : event
      )
    )
  }

  return {
    selectedTempoTick,
    selectedMeterTick,
    selectedKeyTick,
    selectedTempo,
    selectedMeter,
    selectedKeyValue,
    replaceTempoMap,
    updateSelectedTempo,
    updateSelectedMeter,
    replaceKeySignatureMap,
    updateSelectedKey
  }
}
