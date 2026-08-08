<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"
import { storeToRefs } from "pinia"
import { FileAudio, FileMusic, Import, Play, Search, Square, X } from "@lucide/vue"
import type { ProjectAssetSummary } from "@heron/contracts"
import { useI18n } from "vue-i18n"
import { useProjectStore } from "../../stores/project"
import { useMidiImportStore } from "../../stores/midiImport"
import { useMediaBrowserStore } from "../../stores/mediaBrowser"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import { writeProjectMediaDrag } from "../../utils/mediaDrag"

type AssetFilter = "all" | ProjectAssetSummary["kind"]

const { t } = useI18n()
const projectStore = useProjectStore()
const midiImportStore = useMidiImportStore()
const mediaBrowserStore = useMediaBrowserStore()
const workspaceStore = useStudioWorkspaceStore()
const { projectAssets } = storeToRefs(projectStore)
const { selectedAssetId, auditioningAssetId, auditionFailed } = storeToRefs(mediaBrowserStore)
const query = shallowRef("")
const filter = shallowRef<AssetFilter>("all")
const busy = shallowRef(false)

const assets = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return projectAssets.value.filter(
    (asset) =>
      (filter.value === "all" || asset.kind === filter.value) &&
      (!needle || asset.name.toLocaleLowerCase().includes(needle))
  )
})

watch(projectAssets, (next) => {
  mediaBrowserStore.reconcileAssets(next)
})

function detail(asset: ProjectAssetSummary): string {
  if (asset.kind === "midi") return t("studio.mediaBrowser.midiDetail", { size: asset.byteLength })
  const duration = asset.sampleRate > 0 ? Number(asset.frameCount) / asset.sampleRate : 0
  return t("studio.mediaBrowser.audioDetail", {
    channels: asset.channels,
    rate: Math.round(asset.sampleRate / 100) / 10,
    duration: duration.toFixed(1)
  })
}

async function importAudio(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const selected = await projectStore.importAudio()
    selectedAssetId.value = selected.at(-1) ?? selectedAssetId.value
  } finally {
    busy.value = false
  }
}

async function importMidi(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await midiImportStore.prepare()
  } finally {
    busy.value = false
  }
}

function startDrag(event: DragEvent, asset: ProjectAssetSummary): void {
  if (event.dataTransfer) writeProjectMediaDrag(event.dataTransfer, asset)
}

onBeforeUnmount(() => {
  void mediaBrowserStore.reset()
})
</script>

<template>
  <aside class="media-browser" data-media-browser :aria-label="t('studio.mediaBrowser.ariaLabel')">
    <header class="browser-header">
      <div>
        <span>{{ t("studio.mediaBrowser.eyebrow") }}</span>
        <h2>{{ t("studio.mediaBrowser.title") }}</h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :aria-label="t('studio.mediaBrowser.close')"
        @click="workspaceStore.closeRightPanel"
      >
        <X :size="15" />
      </button>
    </header>

    <div class="import-row">
      <button type="button" :disabled="busy" @click="importAudio">
        <Import :size="14" />
        {{ t("studio.mediaBrowser.importAudio") }}
      </button>
      <button type="button" :disabled="busy" @click="importMidi">
        <FileMusic :size="14" />
        {{ t("studio.mediaBrowser.importMidi") }}
      </button>
    </div>

    <label class="search-field">
      <Search :size="12" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        :aria-label="t('studio.mediaBrowser.search')"
        :placeholder="t('studio.mediaBrowser.search')"
      />
    </label>

    <div class="filter-row" role="group" :aria-label="t('studio.mediaBrowser.filterAria')">
      <button
        v-for="value in ['all', 'audio', 'midi'] as const"
        :key="value"
        type="button"
        :class="{ active: filter === value }"
        @click="filter = value"
      >
        {{ t(`studio.mediaBrowser.filter.${value}`) }}
      </button>
    </div>

    <div class="asset-list" role="listbox" :aria-label="t('studio.mediaBrowser.assets')">
      <div
        v-for="asset in assets"
        :key="asset.id"
        class="asset-row"
        :class="{ selected: selectedAssetId === asset.id }"
        role="option"
        tabindex="0"
        :aria-selected="selectedAssetId === asset.id"
        draggable="true"
        @click="mediaBrowserStore.select(asset.id)"
        @focus="mediaBrowserStore.select(asset.id)"
        @keydown.enter="mediaBrowserStore.select(asset.id)"
        @dragstart="startDrag($event, asset)"
      >
        <span class="kind-mark" :data-kind="asset.kind">
          <FileAudio v-if="asset.kind === 'audio'" :size="14" />
          <FileMusic v-else :size="14" />
        </span>
        <span class="asset-copy">
          <strong>{{ asset.name }}</strong>
          <small>{{ detail(asset) }}</small>
        </span>
        <button
          v-if="asset.kind === 'audio'"
          class="audition-button"
          type="button"
          :aria-label="
            auditioningAssetId === asset.id
              ? t('studio.mediaBrowser.stopAudition', { name: asset.name })
              : t('studio.mediaBrowser.startAudition', { name: asset.name })
          "
          @click.stop="mediaBrowserStore.toggleAudition(asset)"
        >
          <Square v-if="auditioningAssetId === asset.id" :size="11" fill="currentColor" />
          <Play v-else :size="12" fill="currentColor" />
        </button>
      </div>
      <div v-if="assets.length === 0" class="empty-state">
        <strong>{{ t("studio.mediaBrowser.emptyTitle") }}</strong>
        <span>{{ t("studio.mediaBrowser.emptyDetail") }}</span>
      </div>
    </div>
    <p v-if="auditionFailed" class="browser-error" role="alert">
      {{ t("studio.mediaBrowser.auditionFailed") }}
    </p>
  </aside>
</template>

<style scoped>
.media-browser {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  border-left: 1px solid var(--line-strong);
  background: var(--surface-1);
}
.browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 51px;
  padding: 8px 10px 7px 12px;
  border-bottom: 1px solid var(--line-strong);
}
.browser-header span {
  color: var(--text-faint);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
  text-transform: uppercase;
}
.browser-header h2 {
  margin: 1px 0 0;
  font-size: var(--ui-type-size-body-compact);
}
.icon-button,
.import-row button,
.filter-row button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  color: var(--text-secondary);
  background: var(--daw-control);
}
.icon-button {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
}
.import-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 9px 10px 6px;
}
.import-row button {
  gap: 5px;
  min-height: 29px;
  border-radius: 6px;
  font-size: var(--ui-type-size-caption);
}
.search-field {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  height: 27px;
  margin: 0 10px 6px;
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-faint);
  background: var(--daw-control);
}
.search-field:focus-within {
  border-color: var(--focus);
}
.search-field input {
  min-width: 0;
  width: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  appearance: none;
  color: var(--text-primary);
  background: transparent;
  font: var(--ui-type-size-control) var(--ui-type-family-interface);
  line-height: var(--ui-type-leading-normal);
}
.search-field input::placeholder {
  color: var(--text-faint);
  opacity: 1;
}
.search-field input::-webkit-search-cancel-button {
  display: none;
}
.filter-row {
  display: flex;
  gap: 2px;
  padding: 0 10px 8px;
  border-bottom: 1px solid var(--line-soft);
}
.filter-row button {
  min-height: 24px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: var(--ui-type-size-caption);
}
.filter-row button.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong));
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent) 20%, var(--daw-control));
}
.asset-list {
  min-height: 0;
  padding: 5px 6px 12px;
  flex: 1;
  overflow: auto;
}
.asset-row {
  display: grid;
  width: 100%;
  grid-template-columns: 27px minmax(0, 1fr) 25px;
  align-items: center;
  gap: 7px;
  padding: 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text-secondary);
  text-align: left;
  background: transparent;
}
.audition-button {
  display: grid;
  width: 23px;
  height: 23px;
  padding: 0;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 50%;
  color: var(--text-secondary);
  background: transparent;
}
.asset-row:hover .audition-button,
.asset-row.selected .audition-button {
  border-color: var(--line-strong);
  background: var(--daw-control);
}
.asset-row:hover {
  background: var(--surface-hover);
}
.asset-row.selected {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-2));
}
.kind-mark {
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  border-radius: 4px;
  color: var(--signal-cyan);
  background: color-mix(in srgb, var(--signal-cyan) 13%, var(--surface-3));
}
.kind-mark[data-kind="midi"] {
  color: var(--signal-green);
  background: color-mix(in srgb, var(--signal-green) 13%, var(--surface-3));
}
.asset-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.asset-copy strong,
.asset-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-copy strong {
  color: var(--text-primary);
  font-size: var(--ui-type-size-caption);
  font-weight: var(--ui-type-weight-medium);
}
.asset-copy small {
  color: var(--text-faint);
  font: var(--ui-type-weight-regular) var(--ui-type-size-caption) var(--ui-type-family-data);
}
.empty-state {
  display: flex;
  align-items: center;
  padding: 36px 20px;
  flex-direction: column;
  gap: 5px;
  color: var(--text-faint);
  text-align: center;
}
.empty-state strong {
  color: var(--text-secondary);
  font-size: var(--ui-type-size-body-compact);
}
.empty-state span {
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-normal);
}
.browser-error {
  margin: 0;
  padding: 7px 10px;
  border-top: 1px solid var(--danger);
  color: var(--danger);
  font-size: var(--ui-type-size-caption);
  background: color-mix(in srgb, var(--danger) 8%, var(--surface-1));
}
button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
button:disabled {
  opacity: 0.55;
}
</style>
