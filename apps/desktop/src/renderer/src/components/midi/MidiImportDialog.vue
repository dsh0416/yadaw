<script setup lang="ts">
import { computed } from "vue"
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"
import type { MidiImportTrackTarget } from "@yadaw/contracts"
import { useMidiImportStore } from "../../stores/midiImport"
import { useMixerStore } from "../../stores/mixer"
import { usePluginStore } from "../../stores/plugins"

const midiImportStore = useMidiImportStore()
const mixerStore = useMixerStore()
const pluginStore = usePluginStore()
const instrumentTracks = computed(() => mixerStore.instrumentTracks)

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
  return target.type === "ignore" ? "" : target.instrumentClassId ?? ""
}

function updateInstrument(sourceTrack: number, sequence: number, event: Event): void {
  const current = midiImportStore.targetFor(sourceTrack, sequence)
  if (current.type === "ignore") return
  const instrumentClassId = (event.target as HTMLSelectElement).value || undefined
  midiImportStore.setTarget(sourceTrack, sequence, { ...current, instrumentClassId })
}
</script>

<template>
  <DialogRoot :open="midiImportStore.open" @update:open="value => { if (!value) midiImportStore.close() }">
    <DialogPortal>
      <DialogOverlay class="midi-overlay" />
      <DialogContent class="midi-dialog" aria-describedby="midi-import-description">
        <header>
          <div><span>MIDI IMPORT</span><DialogTitle>{{ midiImportStore.preview?.path.split(/[\\/]/).at(-1) }}</DialogTitle></div>
          <DialogClose aria-label="Close MIDI import" :disabled="midiImportStore.busy">×</DialogClose>
        </header>
        <p id="midi-import-description">
          {{ midiImportStore.preview?.sourceTiming }} · Format {{ midiImportStore.preview?.format }}
        </p>
        <div class="mapping-list">
          <article v-for="track in midiImportStore.preview?.tracks" :key="`${track.sequence}:${track.sourceTrack}`">
            <div><strong>{{ track.name }}</strong><small>{{ track.noteCount }} notes · {{ track.eventCount }} events<span v-if="midiImportStore.preview?.format === 2"> · sequence {{ track.sequence + 1 }}</span></small></div>
            <select :value="targetValue(track.sourceTrack, track.sequence)" :aria-label="`${track.name} target`" @change="updateTarget(track.sourceTrack, track.sequence, $event)">
              <option value="ignore">Ignore</option>
              <option value="new">New Instrument track</option>
              <option v-for="target in instrumentTracks" :key="target.id" :value="`existing:${target.id}`">{{ target.name }}</option>
            </select>
            <select :value="instrumentValue(track.sourceTrack, track.sequence)" :disabled="targetValue(track.sourceTrack, track.sequence) === 'ignore'" :aria-label="`${track.name} VST3 instrument`" @change="updateInstrument(track.sourceTrack, track.sequence, $event)">
              <option value="">No instrument assigned</option>
              <option v-for="plugin in pluginStore.compatibleInstruments" :key="plugin.classId" :value="plugin.classId">{{ plugin.name }} · {{ plugin.vendor }}</option>
            </select>
            <small v-for="warning in track.warnings" :key="warning" class="warning">{{ warning }}</small>
          </article>
        </div>
        <label class="tempo-option"><input v-model="midiImportStore.importTempoMap" type="checkbox"><span>Import Tempo Map</span><small>Starts at tick 0 and replaces the project tempo map.</small></label>
        <p v-for="warning in midiImportStore.preview?.warnings" :key="warning" class="warning">{{ warning }}</p>
        <p v-if="midiImportStore.error" class="error" role="alert">{{ midiImportStore.error }}</p>
        <footer>
          <button :disabled="midiImportStore.busy" @click="midiImportStore.close">Cancel</button>
          <button class="primary" :disabled="midiImportStore.busy" @click="midiImportStore.commit">{{ midiImportStore.busy ? "Importing…" : "Import MIDI" }}</button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
:global(.midi-overlay){position:fixed;z-index:80;inset:0;background:#05070bbb;backdrop-filter:blur(3px)}:global(.midi-dialog){position:fixed;z-index:81;top:50%;left:50%;display:grid;width:min(760px,calc(100vw - 40px));max-height:min(720px,calc(100vh - 40px));gap:12px;padding:15px;border:1px solid var(--line-strong);border-radius:8px;color:var(--text-primary);background:var(--surface-1);box-shadow:0 24px 70px #000a;transform:translate(-50%,-50%)}.midi-dialog>header{display:flex;align-items:center;justify-content:space-between}.midi-dialog header span,.midi-dialog header h2{display:block;margin:0}.midi-dialog header span{color:#73D6A2;font:700 7px var(--font-utility);letter-spacing:.16em}.midi-dialog header h2{margin-top:4px;font-family:var(--font-display);font-size:14px}.midi-dialog header button{width:28px;height:28px;border:1px solid var(--line-soft);border-radius:4px;color:var(--text-secondary);background:var(--daw-control);cursor:pointer}.midi-dialog>p{margin:0;color:var(--text-muted);font-size:8px}.mapping-list{display:grid;gap:6px;min-height:0;overflow:auto}.mapping-list article{display:grid;grid-template-columns:minmax(130px,1fr) 165px 190px;align-items:center;gap:8px;padding:8px;border:1px solid var(--line-soft);border-radius:4px;background:var(--surface-sunken)}.mapping-list strong,.mapping-list small{display:block}.mapping-list strong{font-size:9px}.mapping-list small{margin-top:3px;color:var(--text-faint);font-size:7px}.mapping-list select{min-width:0;height:29px;border:1px solid var(--line-strong);border-radius:3px;color:var(--text-secondary);background:var(--daw-control);font-size:8px}.mapping-list .warning{grid-column:1/-1}.tempo-option{display:grid;grid-template-columns:16px 1fr;align-items:center;column-gap:7px;padding:9px;border:1px solid color-mix(in srgb,#73D6A2 30%,var(--line-soft));border-radius:4px;background:color-mix(in srgb,#73D6A2 6%,transparent)}.tempo-option input{grid-row:1/3}.tempo-option span{font-size:9px}.tempo-option small{color:var(--text-faint);font-size:7px}.warning{color:var(--warning)!important;font-size:7px!important}.error{color:var(--record)!important}.midi-dialog footer{display:flex;justify-content:flex-end;gap:7px}.midi-dialog footer button{height:30px;padding:0 12px;border:1px solid var(--line-strong);border-radius:4px;color:var(--text-secondary);background:var(--daw-control);font-size:8px;cursor:pointer}.midi-dialog footer .primary{border-color:color-mix(in srgb,#73D6A2 55%,var(--line-strong));color:#08120d;background:#73D6A2;font-weight:700}
</style>
