<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Clock3, FileAudio, FolderCog, Music2, Save, SlidersHorizontal } from "@lucide/vue"
import type { ProjectConfiguration } from "@heron/contracts"
import SettingsContainer from "../settings/SettingsContainer.vue"
import type { SettingsCategory } from "../settings/settings"
import ProjectGeneralSettings from "./ProjectGeneralSettings.vue"

const { t } = useI18n()

const props = defineProps<{
  configuration: ProjectConfiguration
  saving: boolean
  error: string
  saved: boolean
}>()

const emit = defineEmits<{
  save: [configuration: ProjectConfiguration]
  close: []
}>()

const categories = computed<readonly SettingsCategory[]>(() => [
  {
    id: "project",
    label: t("settings.project.categories.project.label"),
    description: t("settings.project.categories.project.description"),
    icon: FolderCog,
    pages: [
      {
        id: "general",
        label: t("settings.project.pages.general.label"),
        description: t("settings.project.pages.general.description"),
        icon: SlidersHorizontal
      }
    ]
  },
  {
    id: "timing",
    label: t("settings.project.categories.timing.label"),
    description: t("settings.project.categories.timing.description"),
    icon: Clock3,
    badge: t("common.soon"),
    pages: [
      {
        id: "tempo-map",
        label: t("settings.project.pages.tempoMap.label"),
        description: t("settings.project.pages.tempoMap.description"),
        icon: Clock3,
        disabled: true,
        badge: t("common.soon")
      },
      {
        id: "clock",
        label: t("settings.project.pages.clock.label"),
        description: t("settings.project.pages.clock.description"),
        icon: Clock3,
        disabled: true,
        badge: t("common.soon")
      }
    ]
  },
  {
    id: "media",
    label: t("settings.project.categories.media.label"),
    description: t("settings.project.categories.media.description"),
    icon: FileAudio,
    badge: t("common.soon"),
    pages: [
      {
        id: "import-defaults",
        label: t("settings.project.pages.importDefaults.label"),
        description: t("settings.project.pages.importDefaults.description"),
        icon: FileAudio,
        disabled: true,
        badge: t("common.soon")
      },
      {
        id: "render-defaults",
        label: t("settings.project.pages.renderDefaults.label"),
        description: t("settings.project.pages.renderDefaults.description"),
        icon: FileAudio,
        disabled: true,
        badge: t("common.soon")
      }
    ]
  },
  {
    id: "musical",
    label: t("settings.project.categories.musical.label"),
    description: t("settings.project.categories.musical.description"),
    icon: Music2,
    badge: t("common.soon"),
    pages: [
      {
        id: "tuning",
        label: t("settings.project.pages.tuning.label"),
        description: t("settings.project.pages.tuning.description"),
        icon: Music2,
        disabled: true,
        badge: t("common.soon")
      },
      {
        id: "notation",
        label: t("settings.project.pages.notation.label"),
        description: t("settings.project.pages.notation.description"),
        icon: Music2,
        disabled: true,
        badge: t("common.soon")
      }
    ]
  }
])

const activePage = shallowRef("general")
const draft = shallowRef<ProjectConfiguration>({ ...props.configuration })

watch(
  () => props.configuration,
  (value) => {
    draft.value = { ...value }
  }
)

const dirty = computed(
  () =>
    draft.value.name !== props.configuration.name ||
    draft.value.sampleRate !== props.configuration.sampleRate ||
    draft.value.timeSignatureNumerator !== props.configuration.timeSignatureNumerator ||
    draft.value.timeSignatureDenominator !== props.configuration.timeSignatureDenominator ||
    draft.value.waveformDisplayMode !== props.configuration.waveformDisplayMode
)

function save(): void {
  emit("save", { ...draft.value })
}
</script>

<template>
  <SettingsContainer
    :title="t('settings.project.title')"
    :scope-label="t('settings.project.scopeLabel')"
    :back-label="t('common.backToStudio')"
    :categories="categories"
    :active-page="activePage"
    @back="emit('close')"
    @update:active-page="activePage = $event"
  >
    <template #actions>
      <span v-if="error" role="alert" class="save-error">{{ error }}</span>
      <span v-else-if="saved && !dirty" role="status" class="save-status">{{
        t("common.changesSaved")
      }}</span>
      <button
        class="settings-action settings-action-primary"
        type="submit"
        form="project-settings-form"
        :disabled="saving || !dirty"
      >
        <Save :size="14" />
        {{ saving ? t("common.saving") : t("common.saveChanges") }}
      </button>
    </template>

    <form id="project-settings-form" class="project-settings-form" @submit.prevent="save">
      <ProjectGeneralSettings v-model="draft" />
    </form>
  </SettingsContainer>
</template>

<style scoped>
.project-settings-form {
  display: contents;
}

.settings-action {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.save-status,
.save-error {
  max-width: 280px;
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}

.save-status {
  color: var(--signal-cyan);
}

.save-error {
  color: var(--record);
}
</style>
