<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Search } from "@lucide/vue"
import { UiPopover } from "@heron/ui"
import {
  pluginCategoriesLabel,
  pluginDescriptorKey,
  pluginLocator,
  type PluginDescriptor
} from "@heron/contracts"
import PluginAudioModeMenu from "../plugins/PluginAudioModeMenu.vue"
import type { PluginSelection } from "../plugins/plugin-audio-mode"

const props = defineProps<{
  plugins: PluginDescriptor[]
  title: string
  searchLabel: string
  emptyMessage: string
}>()

const emit = defineEmits<{
  select: [selection: PluginSelection]
}>()

const { t } = useI18n()

const open = shallowRef(false)
const query = shallowRef("")
const selectedPlugin = shallowRef<PluginDescriptor | null>(null)
const filteredPlugins = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return [...props.plugins]
    .filter((plugin) =>
      `${plugin.name} ${plugin.vendor} ${pluginLocator(plugin).format} ${pluginCategoriesLabel(plugin.categories)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
    .sort(
      (left, right) =>
        left.vendor.localeCompare(right.vendor) || left.name.localeCompare(right.name)
    )
})

watch(open, (isOpen) => {
  if (!isOpen) {
    query.value = ""
    selectedPlugin.value = null
  }
})

function selectPlugin(descriptor: PluginDescriptor): void {
  selectedPlugin.value = descriptor
}

function selectMode(audioMode: PluginSelection["audioMode"]): void {
  if (!selectedPlugin.value) return
  emit("select", { descriptor: selectedPlugin.value, audioMode })
  open.value = false
}
</script>

<template>
  <UiPopover v-model="open" side="top" align="start" :side-offset="7" :collision-padding="8">
    <template #trigger>
      <slot />
    </template>
    <div class="plugin-picker">
      <PluginAudioModeMenu
        v-if="selectedPlugin"
        :descriptor="selectedPlugin"
        @select="selectMode"
        @cancel="selectedPlugin = null"
      />
      <template v-else>
        <header>
          <span>{{ t("mixer.pluginPicker.audioPlugins") }}</span
          ><strong>{{ title }}</strong>
        </header>
        <label>
          <Search :size="12" aria-hidden="true" />
          <input
            v-model="query"
            :aria-label="searchLabel"
            :placeholder="t('mixer.pluginPicker.searchPlaceholder')"
          />
        </label>
        <div class="plugin-list">
          <button
            v-for="plugin in filteredPlugins"
            :key="pluginDescriptorKey(plugin)"
            type="button"
            :aria-label="t('mixer.pluginPicker.addPlugin', { name: plugin.name })"
            @click="selectPlugin(plugin)"
          >
            <b
              >{{ plugin.name }} <em>{{ pluginLocator(plugin).format.toUpperCase() }}</em></b
            >
            <small
              >{{ plugin.source.kind === "builtin" ? `${t("mixer.pluginPicker.builtin")} · ` : ""
              }}{{ plugin.vendor }} · {{ pluginCategoriesLabel(plugin.categories) }}</small
            >
          </button>
          <p v-if="filteredPlugins.length === 0">
            {{ plugins.length === 0 ? emptyMessage : t("mixer.pluginPicker.noSearchResults") }}
          </p>
        </div>
      </template>
    </div>
  </UiPopover>
</template>

<style scoped>
.plugin-picker {
  display: grid;
  width: 240px;
  max-height: min(340px, var(--reka-popover-content-available-height));
  gap: 9px;
  padding: 10px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.plugin-picker header span,
.plugin-picker header strong {
  display: block;
}
.plugin-picker header span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.plugin-picker header strong {
  margin-top: 3px;
  font-size: var(--ui-type-size-label);
}
.plugin-picker > label {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-faint);
  background: var(--daw-control);
}
.plugin-picker > label:focus-within {
  border-color: var(--focus);
}
.plugin-picker input {
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--text-primary);
  background: transparent;
  font-size: var(--ui-type-size-control);
}
.plugin-list {
  display: grid;
  max-height: 235px;
  gap: 3px;
  overflow-y: auto;
}
.plugin-list button {
  display: grid;
  gap: 3px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.plugin-list button:hover {
  border-color: var(--line-soft);
  color: var(--text-primary);
  background: var(--daw-control-hover);
}
.plugin-list button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-list b {
  overflow: hidden;
  font-size: var(--ui-type-size-control);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-list em {
  margin-left: 4px;
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-micro) var(--ui-type-family-data);
  font-style: normal;
}
.plugin-list small {
  overflow: hidden;
  color: var(--text-faint);
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-list p {
  margin: 4px 2px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-control);
  line-height: var(--ui-type-leading-normal);
}
</style>
