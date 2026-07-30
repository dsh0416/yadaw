<script setup lang="ts">
import { computed, reactive, watch } from "vue"
import { useI18n } from "vue-i18n"
import { UiSelect } from "@yadaw/ui"
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

const { t } = useI18n()
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

function resolvedCount(value: number | undefined): string {
  return value === undefined ? t("common.notAvailable") : String(value)
}

function setMode(key: keyof AudioHostRuntimePreferences, mode: string, fallback: number): void {
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
    :category="t('settings.audio.engine.category')"
    :page="t('settings.audio.engine.page')"
    :title="t('settings.audio.engine.title')"
    :description="t('settings.audio.engine.description')"
  >
    <div class="runtime-strip" :aria-label="t('settings.audio.engine.resolvedAria')">
      <span>{{ t("common.resolved") }}</span>
      <b>{{
        t("settings.audio.engine.resolvedWorkers", { count: resolvedCount(resolved?.workerThreads) })
      }}</b>
      <i />
      <b>{{
        t("settings.audio.engine.resolvedBlocking", {
          count: resolvedCount(resolved?.maxBlockingThreads)
        })
      }}</b>
      <i />
      <b>{{
        t("settings.audio.engine.resolvedEgress", { count: resolvedCount(resolved?.egressConcurrency) })
      }}</b>
    </div>

    <SettingsSection
      :title="t('settings.audio.engine.workerThreads.title')"
      :description="t('settings.audio.engine.workerThreads.description')"
    >
      <div class="thread-control">
        <UiSelect
          :aria-label="t('settings.audio.engine.workerThreads.modeAria')"
          :model-value="draft.workerThreads === 'auto' ? 'auto' : 'manual'"
          size="sm"
          @update:model-value="setMode('workerThreads', $event, resolved?.workerThreads ?? 2)"
        >
          <option value="auto">{{ t("common.auto") }}</option>
          <option value="manual">{{ t("common.manual") }}</option>
        </UiSelect>
        <input
          v-if="draft.workerThreads !== 'auto'"
          type="number"
          min="1"
          max="8"
          :value="draft.workerThreads"
          :aria-label="t('settings.audio.engine.workerThreads.countAria')"
          @input="setNumber('workerThreads', $event, 1, 8)"
        />
        <small>{{ t("settings.audio.engine.workerThreads.range") }}</small>
      </div>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.engine.blockingThreads.title')"
      :description="t('settings.audio.engine.blockingThreads.description')"
    >
      <div class="thread-control">
        <UiSelect
          :aria-label="t('settings.audio.engine.blockingThreads.modeAria')"
          :model-value="draft.maxBlockingThreads === 'auto' ? 'auto' : 'manual'"
          size="sm"
          @update:model-value="
            setMode('maxBlockingThreads', $event, resolved?.maxBlockingThreads ?? 4)
          "
        >
          <option value="auto">{{ t("common.auto") }}</option>
          <option value="manual">{{ t("common.manual") }}</option>
        </UiSelect>
        <input
          v-if="draft.maxBlockingThreads !== 'auto'"
          type="number"
          min="2"
          max="16"
          :value="draft.maxBlockingThreads"
          :aria-label="t('settings.audio.engine.blockingThreads.countAria')"
          @input="setNumber('maxBlockingThreads', $event, 2, 16)"
        />
        <small>{{ t("settings.audio.engine.blockingThreads.range") }}</small>
      </div>
    </SettingsSection>

    <SettingsSection
      :title="t('settings.audio.engine.egressConcurrency.title')"
      :description="t('settings.audio.engine.egressConcurrency.description')"
    >
      <div class="thread-control">
        <UiSelect
          :aria-label="t('settings.audio.engine.egressConcurrency.modeAria')"
          :model-value="draft.egressConcurrency === 'auto' ? 'auto' : 'manual'"
          size="sm"
          @update:model-value="
            setMode('egressConcurrency', $event, resolved?.egressConcurrency ?? 2)
          "
        >
          <option value="auto">{{ t("common.auto") }}</option>
          <option value="manual">{{ t("common.manual") }}</option>
        </UiSelect>
        <input
          v-if="draft.egressConcurrency !== 'auto'"
          type="number"
          min="1"
          max="4"
          :value="draft.egressConcurrency"
          :aria-label="t('settings.audio.engine.egressConcurrency.countAria')"
          @input="setNumber('egressConcurrency', $event, 1, 4)"
        />
        <small>{{ t("settings.audio.engine.egressConcurrency.range") }}</small>
      </div>
    </SettingsSection>

    <div class="runtime-actions">
      <button type="button" :disabled="applying || !dirty" @click="emit('apply', { ...draft })">
        {{
          applying
            ? t("settings.audio.engine.apply.restarting")
            : t("settings.audio.engine.apply.label")
        }}
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

.thread-control input,
.runtime-actions button {
  height: 36px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--surface-3);
  font: var(--ui-type-size-body-compact) var(--ui-type-family-data);
}

.thread-control input {
  min-width: 0;
  padding: 0 10px;
}

.thread-control :deep(.ui-select-shell) {
  min-width: 0;
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
