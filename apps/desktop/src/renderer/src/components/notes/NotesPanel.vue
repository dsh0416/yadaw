<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { BookOpenText, Music2, X } from "@lucide/vue"
import { useMixerStore } from "../../stores/mixer"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import MarkdownNoteDocument from "./MarkdownNoteDocument.vue"

const { t } = useI18n()
const mixerStore = useMixerStore()
const workspaceStore = useStudioWorkspaceStore()
const editing = shallowRef(false)
const saving = shallowRef(false)
const draft = shallowRef("")

const selectedTrack = computed(() =>
  mixerStore.graph.tracks.find((track) => track.channelId === mixerStore.selectedChannelId)
)
const selectedTrackName = computed(
  () => mixerStore.selectedChannel?.name ?? t("studio.notes.noTrackTitle")
)
const content = computed(() =>
  workspaceStore.activeNotesTab === "project"
    ? (mixerStore.graph.projectNotes ?? "")
    : (selectedTrack.value?.notes ?? "")
)
const unavailableDescription = computed(() =>
  workspaceStore.activeNotesTab === "track" && !selectedTrack.value
    ? t("studio.notes.selectTrack")
    : undefined
)
const emptyTitle = computed(() =>
  workspaceStore.activeNotesTab === "project"
    ? t("studio.notes.emptyProjectTitle")
    : t("studio.notes.emptyTrackTitle")
)
const emptyDescription = computed(() =>
  workspaceStore.activeNotesTab === "project"
    ? t("studio.notes.emptyProjectDescription")
    : t("studio.notes.emptyTrackDescription", { name: selectedTrackName.value })
)

function selectTab(tab: "project" | "track"): void {
  if (editing.value) return
  workspaceStore.setActiveNotesTab(tab)
}

function beginEditing(): void {
  if (unavailableDescription.value) return
  draft.value = content.value
  editing.value = true
}

function cancelEditing(): void {
  editing.value = false
  draft.value = ""
}

async function save(): Promise<void> {
  if (saving.value || unavailableDescription.value) return
  saving.value = true
  try {
    const command =
      workspaceStore.activeNotesTab === "project"
        ? ({ type: "update-project-notes", notes: draft.value } as const)
        : selectedTrack.value
          ? ({
              type: "update-track",
              trackId: selectedTrack.value.id,
              patch: { notes: draft.value }
            } as const)
          : null
    if (command && (await mixerStore.execute(command))) cancelEditing()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <aside class="notes-panel" :aria-label="t('studio.notes.ariaLabel')">
    <header class="notes-heading">
      <div>
        <span>{{ t("studio.notes.eyebrow") }}</span>
        <strong>{{ t("studio.notes.title") }}</strong>
      </div>
      <button
        type="button"
        class="close-button"
        :aria-label="t('studio.notes.close')"
        @click="workspaceStore.closeNotesPanel"
      >
        <X :size="15" />
      </button>
    </header>

    <div class="notes-tabs" role="tablist" :aria-label="t('studio.notes.tabsAria')">
      <button
        type="button"
        role="tab"
        :aria-selected="workspaceStore.activeNotesTab === 'project'"
        :disabled="editing"
        @click="selectTab('project')"
      >
        <BookOpenText :size="14" aria-hidden="true" />
        {{ t("studio.notes.projectTab") }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="workspaceStore.activeNotesTab === 'track'"
        :disabled="editing"
        @click="selectTab('track')"
      >
        <Music2 :size="14" aria-hidden="true" />
        {{ t("studio.notes.trackTab") }}
      </button>
    </div>

    <div v-if="workspaceStore.activeNotesTab === 'track'" class="track-context">
      <i :style="{ background: mixerStore.selectedChannel?.color ?? 'var(--text-faint)' }" />
      <span>{{ selectedTrackName }}</span>
    </div>

    <MarkdownNoteDocument
      :content="content"
      :draft="draft"
      :editing="editing"
      :saving="saving"
      :empty-title="emptyTitle"
      :empty-description="emptyDescription"
      :unavailable-description="unavailableDescription"
      @edit="beginEditing"
      @cancel="cancelEditing"
      @save="save"
      @update-draft="draft = $event"
    />

    <p v-if="mixerStore.error" class="notes-error" role="alert">{{ mixerStore.error }}</p>
  </aside>
</template>

<style scoped>
.notes-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-left: 1px solid var(--line-soft);
  background: var(--surface-panel);
}

.notes-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 14px 12px 17px;
}

.notes-heading span,
.notes-heading strong {
  display: block;
}

.notes-heading span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}

.notes-heading strong {
  margin-top: 5px;
  color: var(--text-primary);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-type-size-panel-title);
  letter-spacing: var(--ui-type-tracking-wide);
}

.close-button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text-faint);
  background: transparent;
  cursor: pointer;
}

.close-button:hover,
.close-button:focus-visible {
  border-color: var(--line-soft);
  color: var(--text-primary);
  background: var(--daw-control);
}

.close-button:focus-visible,
.notes-tabs button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.notes-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0 14px;
  padding: 3px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: var(--surface-sunken);
}

.notes-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 6px;
  border: 0;
  border-radius: 5px;
  color: var(--text-faint);
  background: transparent;
  cursor: pointer;
  font-size: var(--ui-type-size-caption);
}

.notes-tabs button:hover:not(:disabled) {
  color: var(--text-secondary);
}

.notes-tabs button[aria-selected="true"] {
  color: var(--text-primary);
  background: var(--surface-active);
  box-shadow: var(--ui-shadow-highlight-inset);
}

.notes-tabs button[aria-selected="true"] svg {
  color: var(--accent-soft);
}

.notes-tabs button:disabled {
  cursor: default;
}

.track-context {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 11px 16px 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-muted);
  font-size: var(--ui-type-size-caption);
}

.track-context i {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}

.track-context span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-error {
  margin: 0 14px 12px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--record) 45%, var(--line-soft));
  border-radius: 5px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 8%, transparent);
  font-size: var(--ui-type-size-caption);
}
</style>
