<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiButton, UiDialog, UiSelect, UiStatusNotice } from "@heron/ui"
import type { MidiImportTrackTarget } from "@heron/contracts"
import { pluginTypeKey } from "@heron/contracts"
import { useMidiImportStore } from "../../stores/midiImport"
import { useMixerStore } from "../../stores/mixer"
import { usePluginStore } from "../../stores/plugins"

const midiImportStore = useMidiImportStore()
const mixerStore = useMixerStore()
const pluginStore = usePluginStore()
const { t } = useI18n()
const instrumentTracks = computed(() =>
  mixerStore.graph.tracks.flatMap((track) => {
    const channel = mixerStore.graph.channels.find((candidate) => candidate.id === track.channelId)
    return channel?.kind === "instrument" && channel.systemRole === null
      ? [{ id: track.id, name: channel.name }]
      : []
  })
)
const open = computed({
  get: () => midiImportStore.open,
  set: (value: boolean) => {
    if (!value) midiImportStore.close()
  }
})
const sourceFileName = computed(
  () => midiImportStore.preview?.path.split(/[\\/]/).at(-1) ?? t("midiImport.defaultFileName")
)
const description = computed(() =>
  t("midiImport.description", {
    fileName: sourceFileName.value,
    timing: midiImportStore.preview?.sourceTiming ?? t("midiImport.unknownTiming"),
    format: midiImportStore.preview?.format ?? "—"
  })
)

function targetValue(sourceTrack: number, sequence: number): string {
  const target = midiImportStore.targetFor(sourceTrack, sequence)
  if (target.type === "ignore" || target.type === "new") return target.type
  return `existing:${target.trackId}`
}

function updateTarget(sourceTrack: number, sequence: number, value: string): void {
  let target: MidiImportTrackTarget
  if (value === "new") target = { type: "new" }
  else if (value.startsWith("existing:")) {
    target = { type: "existing", trackId: value.slice("existing:".length) }
  } else target = { type: "ignore" }
  midiImportStore.setTarget(sourceTrack, sequence, target)
}

function instrumentValue(sourceTrack: number, sequence: number): string {
  const target = midiImportStore.targetFor(sourceTrack, sequence)
  return target.type === "ignore" ? "" : (target.instrumentTypeKey ?? "")
}

function updateInstrument(sourceTrack: number, sequence: number, value: string): void {
  const current = midiImportStore.targetFor(sourceTrack, sequence)
  if (current.type === "ignore") return
  const instrumentTypeKey = value || undefined
  midiImportStore.setTarget(sourceTrack, sequence, { ...current, instrumentTypeKey })
}
</script>

<template>
  <UiDialog
    v-model="open"
    :eyebrow="t('midiImport.eyebrow')"
    :title="t('midiImport.title')"
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
            <strong>{{ track.name }}</strong>
            <small
              >{{ t("midiImport.notes", { count: track.noteCount }) }} ·
              {{ t("midiImport.events", { count: track.eventCount })
              }}<span v-if="midiImportStore.preview?.format === 2">
                · {{ t("midiImport.sequence", { n: track.sequence + 1 }) }}</span
              ></small
            >
          </div>
          <UiSelect
            :model-value="targetValue(track.sourceTrack, track.sequence)"
            size="compact"
            :aria-label="t('midiImport.targetAria', { name: track.name })"
            @update:model-value="updateTarget(track.sourceTrack, track.sequence, $event)"
          >
            <option value="ignore">{{ t("midiImport.ignore") }}</option>
            <option value="new">{{ t("midiImport.newTrack") }}</option>
            <option
              v-for="target in instrumentTracks"
              :key="target.id"
              :value="`existing:${target.id}`"
            >
              {{ target.name }}
            </option>
          </UiSelect>
          <UiSelect
            :model-value="instrumentValue(track.sourceTrack, track.sequence)"
            size="compact"
            :disabled="targetValue(track.sourceTrack, track.sequence) === 'ignore'"
            :aria-label="t('midiImport.instrumentAria', { name: track.name })"
            @update:model-value="updateInstrument(track.sourceTrack, track.sequence, $event)"
          >
            <option value="">{{ t("midiImport.noInstrument") }}</option>
            <option
              v-for="plugin in pluginStore.compatibleInstruments"
              :key="pluginTypeKey(plugin)"
              :value="pluginTypeKey(plugin)"
            >
              {{ plugin.name }} · {{ plugin.vendor }}
            </option>
          </UiSelect>
          <small v-for="warning in track.warnings" :key="warning" class="warning">{{
            warning
          }}</small>
        </article>
      </div>
      <fieldset class="tempo-choice">
        <legend>{{ t("midiImport.tempoLegend") }}</legend>
        <label :class="{ selected: midiImportStore.tempoMode === 'project' }">
          <input v-model="midiImportStore.tempoMode" type="radio" value="project" />
          <span>
            <strong>{{ t("midiImport.keepProjectTempo") }}</strong>
            <small>{{ t("midiImport.keepProjectTempoDetail") }}</small>
          </span>
        </label>
        <label :class="{ selected: midiImportStore.tempoMode === 'midi' }">
          <input v-model="midiImportStore.tempoMode" type="radio" value="midi" />
          <span>
            <strong>{{ t("midiImport.importMidiTempo") }}</strong>
            <small>{{ t("midiImport.importMidiTempoDetail") }}</small>
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
      <UiButton :disabled="midiImportStore.busy" @click="midiImportStore.close">{{
        t("dialog.actions.cancel")
      }}</UiButton>
      <UiButton
        variant="primary"
        :loading="midiImportStore.busy"
        :loading-label="t('midiImport.importing')"
        @click="midiImportStore.commit"
      >
        {{ t("midiImport.import") }}
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
