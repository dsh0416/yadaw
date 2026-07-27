<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { Clock3, FileAudio, FolderCog, Music2, Save, SlidersHorizontal } from "@lucide/vue"
import type { ProjectConfiguration } from "@yadaw/contracts"
import SettingsContainer from "../settings/SettingsContainer.vue"
import type { SettingsCategory } from "../settings/settings"
import ProjectGeneralSettings from "./ProjectGeneralSettings.vue"

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

const categories: readonly SettingsCategory[] = [
  {
    id: "project",
    label: "Project",
    description: "Session definition",
    icon: FolderCog,
    pages: [
      {
        id: "general",
        label: "General",
        description: "Identity and session format",
        icon: SlidersHorizontal
      }
    ]
  },
  {
    id: "timing",
    label: "Timing",
    description: "Tempo and clock",
    icon: Clock3,
    badge: "Soon",
    pages: [
      {
        id: "tempo-map",
        label: "Tempo map",
        description: "Tempo events and transitions",
        icon: Clock3,
        disabled: true,
        badge: "Soon"
      },
      {
        id: "clock",
        label: "Clock",
        description: "Synchronization and timecode",
        icon: Clock3,
        disabled: true,
        badge: "Soon"
      }
    ]
  },
  {
    id: "media",
    label: "Media",
    description: "Import and render",
    icon: FileAudio,
    badge: "Soon",
    pages: [
      {
        id: "import-defaults",
        label: "Import defaults",
        description: "New asset handling",
        icon: FileAudio,
        disabled: true,
        badge: "Soon"
      },
      {
        id: "render-defaults",
        label: "Render defaults",
        description: "Export format and destination",
        icon: FileAudio,
        disabled: true,
        badge: "Soon"
      }
    ]
  },
  {
    id: "musical",
    label: "Musical",
    description: "Tuning and notation",
    icon: Music2,
    badge: "Soon",
    pages: [
      {
        id: "tuning",
        label: "Tuning",
        description: "Pitch reference and temperament",
        icon: Music2,
        disabled: true,
        badge: "Soon"
      },
      {
        id: "notation",
        label: "Notation",
        description: "Spelling and display defaults",
        icon: Music2,
        disabled: true,
        badge: "Soon"
      }
    ]
  }
]

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
    title="Project settings"
    scope-label="Yadaw / Project"
    back-label="Back to studio"
    :categories="categories"
    :active-page="activePage"
    @back="emit('close')"
    @update:active-page="activePage = $event"
  >
    <template #actions>
      <span v-if="error" role="alert" class="save-error">{{ error }}</span>
      <span v-else-if="saved && !dirty" role="status" class="save-status">Changes saved</span>
      <button
        class="settings-action settings-action-primary"
        type="submit"
        form="project-settings-form"
        :disabled="saving || !dirty"
      >
        <Save :size="14" />
        {{ saving ? "Saving…" : "Save changes" }}
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
