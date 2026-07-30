<script setup lang="ts">
import { computed, reactive, watch } from "vue"
import { UiSelect } from "@yadaw/ui"
import type { MidiInputSnapshot, MidiSyncPreferences, MidiSyncState } from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"

const props = defineProps<{
  preferences: MidiSyncPreferences
  snapshot: MidiInputSnapshot
  applying: boolean
  error: string
}>()

const emit = defineEmits<{
  apply: [preferences: MidiSyncPreferences]
}>()

function copyPreferences(value: MidiSyncPreferences): MidiSyncPreferences {
  return {
    enabled: value.enabled,
    sourcePortId: value.sourcePortId,
    sourcePortName: value.sourcePortName,
    inputOffsetsMs: { ...value.inputOffsetsMs }
  }
}

const draft = reactive<MidiSyncPreferences>(copyPreferences(props.preferences))

watch(
  () => props.preferences,
  (value) => Object.assign(draft, copyPreferences(value)),
  { deep: true }
)

const dirty = computed(() => JSON.stringify(draft) !== JSON.stringify(props.preferences))
const stateLabels: Record<MidiSyncState, string> = {
  internal: "Internal",
  waiting: "Waiting",
  locking: "Locking",
  locked: "Locked",
  freewheel: "Freewheel",
  lost: "Lost"
}

function selectClockSource(portId: string): void {
  const port = props.snapshot.ports.find((candidate) => candidate.id === portId)
  draft.sourcePortId = port?.id ?? null
  draft.sourcePortName = port?.name ?? null
}

function setOffset(portId: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) {
    draft.inputOffsetsMs[portId] = Math.max(-500, Math.min(500, value))
  }
}

function apply(): void {
  emit("apply", copyPreferences(draft))
}
</script>

<template>
  <SettingsPage
    category="MIDI"
    page="Input & sync"
    title="MIDI input and external clock"
    description="Connect controllers to Instrument tracks and optionally slave the transport to one MIDI Clock source."
  >
    <div class="sync-strip" :data-state="snapshot.sync.state">
      <b>{{ stateLabels[snapshot.sync.state] }}</b>
      <span>{{ snapshot.sync.effectiveBpm?.toFixed(2) ?? "—" }} BPM</span>
      <span>{{ snapshot.sync.jitterMicroseconds?.toFixed(0) ?? "—" }} µs jitter</span>
      <span>{{ snapshot.sync.droppedEvents }} dropped</span>
    </div>

    <SettingsSection
      title="External clock slave"
      description="Local Play and Record wait for Start or Continue. Clock loss freewheels for 500 ms, then pauses."
    >
      <div class="stacked-control">
        <label class="toggle-row">
          <input v-model="draft.enabled" type="checkbox" />
          <span>Follow external MIDI Clock</span>
        </label>
        <UiSelect
          aria-label="MIDI clock source"
          :model-value="draft.sourcePortId ?? ''"
          size="sm"
          @update:model-value="selectClockSource($event)"
        >
          <option value="">No clock source</option>
          <option v-for="port in snapshot.ports" :key="port.id" :value="port.id">
            {{ port.name }}{{ port.connected ? "" : " — Missing" }}
          </option>
        </UiSelect>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Input timing offsets"
      description="Apply a signed per-port correction before events are mapped to session frames and ticks."
    >
      <div v-if="snapshot.ports.length" class="port-list">
        <label v-for="port in snapshot.ports" :key="port.id" class="port-row">
          <span>
            <b>{{ port.name }}</b>
            <small>{{ port.connected ? "Connected" : "Missing" }}</small>
          </span>
          <input
            type="number"
            min="-500"
            max="500"
            step="0.1"
            :value="draft.inputOffsetsMs[port.id] ?? 0"
            :aria-label="`${port.name} timing offset in milliseconds`"
            @input="setOffset(port.id, $event)"
          />
          <em>ms</em>
        </label>
      </div>
      <p v-else class="empty">No MIDI input ports detected.</p>
    </SettingsSection>

    <div class="actions">
      <button type="button" :disabled="applying || !dirty" @click="apply">
        {{ applying ? "Applying…" : "Apply MIDI settings" }}
      </button>
    </div>
    <p v-if="error || snapshot.sync.error" class="error" role="alert">
      {{ error || snapshot.sync.error }}
    </p>
  </SettingsPage>
</template>

<style scoped>
.sync-strip,
.port-row,
.stacked-control,
.actions {
  display: flex;
  align-items: center;
}
.sync-strip {
  gap: 16px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-secondary);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}
.sync-strip b {
  color: var(--accent);
}
.sync-strip[data-state="lost"] b,
.sync-strip[data-state="freewheel"] b {
  color: var(--mixer-record);
}
.stacked-control {
  align-items: stretch;
  flex-direction: column;
  gap: 12px;
}
.toggle-row {
  display: flex;
  gap: 9px;
  align-items: center;
}
.port-list {
  display: grid;
  gap: 7px;
}
.port-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px 24px;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
}
.port-row span {
  display: grid;
}
.port-row small,
.port-row em,
.empty {
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
}
.port-row input {
  width: 100%;
}
.actions {
  justify-content: flex-end;
  padding-top: 18px;
}
.actions button {
  padding: 7px 13px;
}
.error {
  color: var(--mixer-record);
}
</style>
