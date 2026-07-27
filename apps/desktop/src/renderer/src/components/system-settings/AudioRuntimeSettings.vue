<script setup lang="ts">
import { computed, reactive, watch } from "vue"
import type {
  AudioHostRuntimePreferences,
  ResolvedAudioHostRuntimePreferences
} from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"

const props = defineProps<{
  modelValue: AudioHostRuntimePreferences
  resolved: ResolvedAudioHostRuntimePreferences | null
  applying: boolean
  error: string
}>()

const emit = defineEmits<{
  apply: [preferences: AudioHostRuntimePreferences]
}>()

const draft = reactive<AudioHostRuntimePreferences>({ ...props.modelValue })

watch(
  () => props.modelValue,
  (value) => Object.assign(draft, value),
  { deep: true }
)

const dirty = computed(
  () =>
    draft.workerThreads !== props.modelValue.workerThreads ||
    draft.maxBlockingThreads !== props.modelValue.maxBlockingThreads ||
    draft.egressConcurrency !== props.modelValue.egressConcurrency
)

function setMode(key: keyof AudioHostRuntimePreferences, event: Event, fallback: number): void {
  const mode = (event.target as HTMLSelectElement).value
  draft[key] = mode === "auto" ? "auto" : fallback
}

function setNumber(
  key: keyof AudioHostRuntimePreferences,
  event: Event,
  minimum: number,
  maximum: number
): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isInteger(value)) draft[key] = Math.min(maximum, Math.max(minimum, value))
}
</script>

<template>
  <SettingsPage
    category="System"
    page="Engine"
    title="Runtime scheduling"
    description="Bound helper concurrency without changing the real-time callback. Changes restart only the audio helper, then restore devices, plug-ins, graph and transport."
  >
    <div class="runtime-strip" aria-label="Resolved audio helper threads">
      <span>Resolved</span>
      <b>{{ resolved?.workerThreads ?? "—" }} workers</b>
      <i />
      <b>{{ resolved?.maxBlockingThreads ?? "—" }} blocking</b>
      <i />
      <b>{{ resolved?.egressConcurrency ?? "—" }} egress</b>
    </div>

    <SettingsSection
      title="Async worker threads"
      description="Runs protocol, engine, background I/O and telemetry tasks. VST3 stays thread-affine."
    >
      <div class="thread-control">
        <select
          aria-label="Worker thread mode"
          :value="draft.workerThreads === 'auto' ? 'auto' : 'manual'"
          @change="setMode('workerThreads', $event, resolved?.workerThreads ?? 2)"
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
        <input
          v-if="draft.workerThreads !== 'auto'"
          type="number"
          min="1"
          max="8"
          :value="draft.workerThreads"
          aria-label="Worker threads"
          @input="setNumber('workerThreads', $event, 1, 8)"
        />
        <small>1–8</small>
      </div>
    </SettingsSection>

    <SettingsSection
      title="Blocking thread ceiling"
      description="Caps synchronous IPC sends, arena copies and other controlled blocking jobs."
    >
      <div class="thread-control">
        <select
          aria-label="Blocking thread mode"
          :value="draft.maxBlockingThreads === 'auto' ? 'auto' : 'manual'"
          @change="setMode('maxBlockingThreads', $event, resolved?.maxBlockingThreads ?? 4)"
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
        <input
          v-if="draft.maxBlockingThreads !== 'auto'"
          type="number"
          min="2"
          max="16"
          :value="draft.maxBlockingThreads"
          aria-label="Blocking threads"
          @input="setNumber('maxBlockingThreads', $event, 2, 16)"
        />
        <small>2–16</small>
      </div>
    </SettingsSection>

    <SettingsSection
      title="IPC egress concurrency"
      description="Allows independent responses to encode and send concurrently; runtime events stay ordered."
    >
      <div class="thread-control">
        <select
          aria-label="Egress concurrency mode"
          :value="draft.egressConcurrency === 'auto' ? 'auto' : 'manual'"
          @change="setMode('egressConcurrency', $event, resolved?.egressConcurrency ?? 2)"
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
        <input
          v-if="draft.egressConcurrency !== 'auto'"
          type="number"
          min="1"
          max="4"
          :value="draft.egressConcurrency"
          aria-label="Egress concurrency"
          @input="setNumber('egressConcurrency', $event, 1, 4)"
        />
        <small>1–4</small>
      </div>
    </SettingsSection>

    <div class="runtime-actions">
      <button type="button" :disabled="applying || !dirty" @click="emit('apply', { ...draft })">
        {{ applying ? "Restarting helper…" : "Apply runtime settings" }}
      </button>
    </div>
    <p v-if="error" class="runtime-error" role="alert">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.runtime-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 1px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-secondary);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.runtime-strip span {
  color: var(--accent);
  font-weight: var(--ui-type-weight-bold);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.runtime-strip b {
  font-weight: var(--ui-type-weight-semibold);
}

.runtime-strip i {
  width: 1px;
  height: 11px;
  background: var(--line-strong);
}

.thread-control {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) 92px 32px;
  align-items: center;
  gap: 8px;
}

.thread-control select,
.thread-control input,
.runtime-actions button {
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-3);
  font: var(--ui-type-size-body-compact) var(--ui-type-family-data);
}

.thread-control select,
.thread-control input {
  min-width: 0;
  padding: 0 10px;
}

.thread-control small {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.runtime-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
}

.runtime-actions button {
  padding: 0 14px;
  cursor: pointer;
}

.runtime-actions button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.runtime-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}

.runtime-error {
  padding: 11px;
  border-radius: 7px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 9%, var(--surface-1));
  font-size: var(--ui-type-size-body-compact);
}
</style>
