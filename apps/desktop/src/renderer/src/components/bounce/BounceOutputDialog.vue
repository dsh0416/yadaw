<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { UiButton, UiDialog, UiSelect } from "@heron/ui"
import { useProjectStore } from "../../stores/project"
import { useBounceStore } from "../../stores/bounce"
import BounceFormatForm from "./BounceFormatForm.vue"
import BounceNormalizationForm from "./BounceNormalizationForm.vue"
import BounceRangeForm from "./BounceRangeForm.vue"

const store = useBounceStore()
const projectStore = useProjectStore()
const { t } = useI18n()
</script>

<template>
  <UiDialog
    v-model="store.open"
    size="md"
    :eyebrow="t('bounce.eyebrow')"
    :title="t('bounce.title', { output: store.targetOutput?.name ?? '' })"
    :description="t('bounce.description')"
    :close-label="t('bounce.actions.close')"
    :dismissible="!store.starting"
  >
    <form class="bounce-form" @submit.prevent="store.start">
      <BounceFormatForm
        :settings="store.format"
        :sample-rate="store.sampleRate"
        :project-sample-rate="projectStore.session?.configuration.sampleRate ?? 48_000"
        @update-settings="store.setFormat"
        @update-sample-rate="store.sampleRate = $event"
      />
      <fieldset class="bounce-fieldset">
        <legend>{{ t("bounce.sections.channels") }}</legend>
        <label>
          <span>{{ t("bounce.fields.channels") }}</span>
          <UiSelect
            v-model="store.channelMode"
            :options="[
              { value: 'stereo', label: t('bounce.channels.stereo') },
              { value: 'mono', label: t('bounce.channels.mono') }
            ]"
          />
        </label>
        <p v-if="store.channelMode === 'mono'">{{ t("bounce.monoHelp") }}</p>
      </fieldset>
      <BounceNormalizationForm v-model="store.normalization" />
      <BounceRangeForm
        :start-bar="store.startBar"
        :end-bar="store.endBar"
        :maximum-bar="store.maximumBar"
        :include-tail="store.includeTail"
        @update-start-bar="store.startBar = $event"
        @update-end-bar="store.endBar = $event"
        @update-include-tail="store.includeTail = $event"
      />
      <p v-if="store.error" class="bounce-error" role="alert">{{ store.error }}</p>
    </form>
    <template #actions>
      <UiButton variant="ghost" :disabled="store.starting" @click="store.close">
        {{ t("bounce.actions.cancel") }}
      </UiButton>
      <UiButton
        variant="primary"
        :disabled="!store.valid"
        :loading="store.starting"
        :loading-label="t('bounce.actions.starting')"
        @click="store.start"
      >
        {{ t("bounce.actions.export") }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.bounce-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
:deep(.bounce-fieldset) {
  display: grid;
  align-content: start;
  gap: 9px;
  min-width: 0;
  margin: 0;
  padding: 13px;
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-color-canvas-subtle);
}
:deep(.bounce-fieldset legend) {
  padding: 0 5px;
  color: var(--mixer-bounce);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}
:deep(.bounce-fieldset > label) {
  display: grid;
  grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1.2fr);
  align-items: center;
  gap: 9px;
  color: var(--ui-color-text-muted);
  font-size: var(--ui-font-size-xs);
}
:deep(.bounce-tail-option .ui-checkbox) {
  align-items: flex-start;
}
:deep(.bounce-fieldset p) {
  margin: 0;
  color: var(--ui-color-text-subtle);
  font-size: var(--ui-font-size-xs);
  line-height: var(--ui-type-leading-normal);
}
.bounce-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ui-color-danger);
  font-size: var(--ui-font-size-sm);
}
@media (max-width: 660px) {
  .bounce-form {
    grid-template-columns: 1fr;
  }
}
</style>
