<script setup lang="ts">
import { computed } from "vue"
import { UiButton, UiDialog, UiStatusNotice } from "@yadaw/ui"
import type { MidiImportTrackTarget } from "@yadaw/contracts"
import { useMidiImportStore } from "../../stores/midiImport"
import { useMixerStore } from "../../stores/mixer"
import { usePluginStore } from "../../stores/plugins"

const midiImportStore = useMidiImportStore()
const mixerStore = useMixerStore()
const pluginStore = usePluginStore()
const instrumentTracks = computed(() => mixerStore.instrumentTracks)
const open = computed({
  get: () => midiImportStore.open,
  set: (value: boolean) => {
    if (!value) midiImportStore.close()
  }
})
const sourceFileName = computed(
  () => midiImportStore.preview?.path.split(/[\\/]/).at(-1) ?? "Import MIDI file"
)
const description = computed(
  () =>
    `${sourceFileName.value} · ${
      midiImportStore.preview?.sourceTiming ?? "Unknown timing"
    } · Format ${midiImportStore.preview?.format ?? "—"}`
)

function targetValue(sourceTrack: number, sequence: number): string {
  const target = midiImportStore.targetFor(sourceTrack, sequence)
  if (target.type === "ignore" || target.type === "new") return target.type
  return `existing:${target.channelId}`
}

function updateTarget(sourceTrack: number, sequence: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  let target: MidiImportTrackTarget
  if (value === "new") target = { type: "new" }
  else if (value.startsWith("existing:")) {
    target = { type: "existing", channelId: value.slice("existing:".length) }
  } else target = { type: "ignore" }
  midiImportStore.setTarget(sourceTrack, sequence, target)
}

function instrumentValue(sourceTrack: number, sequence: number): string {
  const target = midiImportStore.targetFor(sourceTrack, sequence)
  return target.type === "ignore" ? "" : (target.instrumentClassId ?? "")
}

function updateInstrument(sourceTrack: number, sequence: number, event: Event): void {
  const current = midiImportStore.targetFor(sourceTrack, sequence)
  if (current.type === "ignore") return
  const instrumentClassId = (event.target as HTMLSelectElement).value || undefined
  midiImportStore.setTarget(sourceTrack, sequence, { ...current, instrumentClassId })
}
</script>

<template>
  <UiDialog
    v-model="open"
    eyebrow="MIDI import"
    title="Import MIDI"
    :description="description"
    size="lg"
    :dismissible="!midiImportStore.busy"
  >
    <div class="midi-dialog-content">
      <div class="mapping-list">
        <article
          v-for="track in midiImportStore.preview?.tracks"
          :key="`${track.sequence}:${track.sourceTrack}`"
        >
          <div>
            <strong>{{ track.name }}</strong
            ><small
              >{{ track.noteCount }} notes · {{ track.eventCount }} events<span
                v-if="midiImportStore.preview?.format === 2"
              >
                · sequence {{ track.sequence + 1 }}</span
              ></small
            >
          </div>
          <select
            :value="targetValue(track.sourceTrack, track.sequence)"
            :aria-label="`${track.name} target`"
            @change="updateTarget(track.sourceTrack, track.sequence, $event)"
          >
            <option value="ignore">Ignore</option>
            <option value="new">New Instrument track</option>
            <option
              v-for="target in instrumentTracks"
              :key="target.id"
              :value="`existing:${target.id}`"
            >
              {{ target.name }}
            </option>
          </select>
          <select
            :value="instrumentValue(track.sourceTrack, track.sequence)"
            :disabled="targetValue(track.sourceTrack, track.sequence) === 'ignore'"
            :aria-label="`${track.name} VST3 instrument`"
            @change="updateInstrument(track.sourceTrack, track.sequence, $event)"
          >
            <option value="">No instrument assigned</option>
            <option
              v-for="plugin in pluginStore.compatibleInstruments"
              :key="plugin.classId"
              :value="plugin.classId"
            >
              {{ plugin.name }} · {{ plugin.vendor }}
            </option>
          </select>
          <small v-for="warning in track.warnings" :key="warning" class="warning">{{
            warning
          }}</small>
        </article>
      </div>
      <fieldset class="tempo-choice">
        <legend>Tempo for imported MIDI</legend>
        <label :class="{ selected: midiImportStore.tempoMode === 'project' }">
          <input v-model="midiImportStore.tempoMode" type="radio" value="project" />
          <span>
            <strong>Keep the project Tempo Track</strong>
            <small
              >Place the MIDI at the playhead and follow the current project Tempo Track.</small
            >
          </span>
        </label>
        <label :class="{ selected: midiImportStore.tempoMode === 'midi' }">
          <input v-model="midiImportStore.tempoMode" type="radio" value="midi" />
          <span>
            <strong>Import MIDI tempo into project</strong>
            <small
              >Start at tick 0 and replace the project Tempo Track with the MIDI tempo map.</small
            >
          </span>
        </label>
      </fieldset>
      <UiStatusNotice
        v-for="warning in midiImportStore.preview?.warnings"
        :key="warning"
        tone="warning"
      >
        {{ warning }}
      </UiStatusNotice>
      <UiStatusNotice v-if="midiImportStore.error" tone="danger" live="assertive">
        {{ midiImportStore.error }}
      </UiStatusNotice>
    </div>
    <template #actions>
      <UiButton :disabled="midiImportStore.busy" @click="midiImportStore.close">Cancel</UiButton>
      <UiButton
        variant="primary"
        :loading="midiImportStore.busy"
        loading-label="Importing MIDI"
        @click="midiImportStore.commit"
      >
        Import MIDI
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
:global(.midi-overlay) {
  position: fixed;
  z-index: var(--ui-z-overlay);
  inset: 0;
  background: var(--ui-domain-color-05070bbb);
  backdrop-filter: blur(3px);
}
:global(.midi-dialog) {
  position: fixed;
  z-index: var(--ui-z-dialog);
  top: 50%;
  left: 50%;
  display: grid;
  width: min(760px, calc(100vw - 40px));
  max-height: min(720px, calc(100vh - 40px));
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: var(--ui-shadow-lg);
  transform: translate(-50%, -50%);
}
.midi-dialog > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.midi-dialog header span,
.midi-dialog header h2 {
  display: block;
  margin: 0;
}
.midi-dialog header span {
  color: var(--ui-domain-color-73d6a2);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}
.midi-dialog header h2 {
  margin-top: 4px;
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-font-size-sm);
}
.midi-dialog header button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  cursor: pointer;
}
.midi-dialog > p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
}
.mapping-list {
  display: grid;
  gap: 6px;
  min-height: 0;
  overflow: auto;
}
.mapping-list article {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) 165px 190px;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--surface-sunken);
}
.mapping-list strong,
.mapping-list small {
  display: block;
}
.mapping-list strong {
  font-size: var(--ui-type-size-body-compact);
}
.mapping-list small {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}
.mapping-list select {
  min-width: 0;
  height: 29px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-secondary);
  background: var(--daw-control);
  font-size: var(--ui-type-size-control);
}
.mapping-list .warning {
  grid-column: 1/-1;
}
.tempo-choice {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin: 0;
  padding: 0;
  border: 0;
}
.tempo-choice legend {
  grid-column: 1/-1;
  margin-bottom: 2px;
  color: var(--text-muted);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}
.tempo-choice label {
  display: grid;
  grid-template-columns: 17px 1fr;
  align-items: start;
  gap: 7px;
  padding: 9px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--surface-sunken);
  cursor: pointer;
}
.tempo-choice label.selected {
  border-color: color-mix(in srgb, var(--ui-domain-color-73d6a2) 58%, var(--line-strong));
  background: color-mix(in srgb, var(--ui-domain-color-73d6a2) 7%, var(--surface-sunken));
  box-shadow: var(--ui-shadow-selected-outline);
}
.tempo-choice input {
  margin: 2px 0 0;
  accent-color: var(--ui-domain-color-73d6a2);
}
.tempo-choice strong,
.tempo-choice small {
  display: block;
}
.tempo-choice strong {
  color: var(--text-primary);
  font-size: var(--ui-type-size-control);
}
.tempo-choice small {
  margin-top: 4px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-compact);
}
.warning {
  color: var(--warning) !important;
  font-size: var(--ui-type-size-caption) !important;
}
.error {
  color: var(--record) !important;
}
.midi-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
}
.midi-dialog footer button {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  font-size: var(--ui-type-size-control);
  cursor: pointer;
}
.midi-dialog footer .primary {
  border-color: color-mix(in srgb, var(--ui-domain-color-73d6a2) 55%, var(--line-strong));
  color: var(--ui-domain-color-08120d);
  background: var(--ui-domain-color-73d6a2);
  font-weight: var(--ui-type-weight-bold);
}
</style>
