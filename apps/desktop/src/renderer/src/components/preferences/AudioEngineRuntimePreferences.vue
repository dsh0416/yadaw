<script setup lang="ts">
import { computed, reactive, watch } from "vue"
import type {
  AudioHostRuntimePreferences,
  ResolvedAudioHostRuntimePreferences
} from "@yadaw/contracts"

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
  <section class="engine-runtime-preferences">
    <div class="settings-intro">
      <span class="section-kicker">Audio <b>/</b> Engine</span>
      <h2>Runtime scheduling</h2>
      <p>
        Bound helper concurrency without changing the real-time callback. Changes restart only the
        audio helper, then restore devices, plug-ins, graph and transport.
      </p>
    </div>

    <div class="runtime-strip" aria-label="Resolved audio helper threads">
      <span>RESOLVED</span>
      <b>{{ resolved?.workerThreads ?? "—" }} workers</b>
      <i />
      <b>{{ resolved?.maxBlockingThreads ?? "—" }} blocking</b>
      <i />
      <b>{{ resolved?.egressConcurrency ?? "—" }} egress</b>
    </div>

    <section class="runtime-setting">
      <div>
        <h3>Async worker threads</h3>
        <p>Runs protocol, Engine, background I/O and telemetry tasks. VST3 stays thread-affine.</p>
      </div>
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
    </section>

    <section class="runtime-setting">
      <div>
        <h3>Blocking thread ceiling</h3>
        <p>Caps synchronous IPC sends, arena copies and other controlled blocking jobs.</p>
      </div>
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
    </section>

    <section class="runtime-setting">
      <div>
        <h3>IPC egress concurrency</h3>
        <p>
          Allows independent responses to encode and send concurrently; runtime events stay ordered.
        </p>
      </div>
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
    </section>

    <div class="restart-note">
      <span>CONTROLLED RESTART</span>
      <p>
        Unavailable while recording, finalizing or recovering. Playback is paused briefly and
        resumes at the same sample frame after the new graph is published.
      </p>
      <button :disabled="applying || !dirty" @click="emit('apply', { ...draft })">
        {{ applying ? "Restarting helper…" : "Apply runtime settings" }}
      </button>
    </div>
    <p v-if="error" class="runtime-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.engine-runtime-preferences {
  min-width: 0;
  overflow: auto;
  padding: 38px clamp(30px, 4.5vw, 68px) 60px;
  background: radial-gradient(circle at 72% 0, #173b3a24, transparent 32%), var(--canvas);
}
.settings-intro,
.runtime-strip,
.runtime-setting,
.restart-note,
.runtime-error {
  max-width: 900px;
}
.section-kicker {
  color: var(--accent);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.17em;
}
.section-kicker b {
  color: #465267;
}
.settings-intro h2 {
  margin: 8px 0 6px;
  font: 560 27px var(--font-display);
}
.settings-intro p,
.runtime-setting p,
.restart-note p {
  margin: 0;
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.55;
}
.runtime-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line-soft));
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
  font: 8px var(--font-utility);
}
.runtime-strip span {
  color: var(--accent);
  letter-spacing: 0.13em;
}
.runtime-strip b {
  color: var(--text-secondary);
  font-weight: 600;
}
.runtime-strip i {
  width: 1px;
  height: 11px;
  background: var(--line-strong);
}
.runtime-setting {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(330px, 1fr);
  gap: 48px;
  padding: 24px 0;
  border-bottom: 1px solid var(--line-soft);
}
.runtime-setting h3 {
  margin: 0 0 6px;
  font: 600 11px var(--font-display);
}
.thread-control {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) 92px 32px;
  align-items: center;
  gap: 8px;
}
.thread-control select,
.thread-control input,
.restart-note button {
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-3);
  font: 9px var(--font-utility);
}
.thread-control select,
.thread-control input {
  padding: 0 10px;
}
.thread-control small {
  color: var(--text-faint);
  font: 7px var(--font-utility);
}
.restart-note {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  margin-top: 24px;
  padding: 14px;
  border: 1px solid #d7a94b42;
  border-radius: 8px;
  background: #2a2416;
}
.restart-note > span {
  color: var(--warning);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.12em;
}
.restart-note button {
  padding: 0 14px;
  cursor: pointer;
}
.restart-note button:disabled {
  opacity: 0.45;
  cursor: default;
}
.runtime-error {
  padding: 11px;
  border-radius: 7px;
  color: #ff9dab;
  background: #321923;
  font-size: 9px;
}
@media (max-width: 1120px) {
  .runtime-setting {
    grid-template-columns: 1fr;
    gap: 17px;
  }
  .restart-note {
    grid-template-columns: 1fr;
  }
}
</style>
