<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { Search } from "@lucide/vue"
import { UiPopover } from "@yadaw/ui"
import { pluginDescriptorKey, type PluginDescriptor } from "@yadaw/contracts"

const props = defineProps<{
  plugins: PluginDescriptor[]
  title: string
  searchLabel: string
  emptyMessage: string
}>()

const emit = defineEmits<{
  select: [descriptor: PluginDescriptor]
}>()

const open = shallowRef(false)
const query = shallowRef("")
const filteredPlugins = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return [...props.plugins]
    .filter((plugin) =>
      `${plugin.name} ${plugin.vendor} ${plugin.category}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
    .sort(
      (left, right) =>
        left.vendor.localeCompare(right.vendor) || left.name.localeCompare(right.name)
    )
})

watch(open, (isOpen) => {
  if (!isOpen) query.value = ""
})

function selectPlugin(descriptor: PluginDescriptor): void {
  emit("select", descriptor)
  open.value = false
}
</script>

<template>
  <UiPopover v-model="open" side="top" align="start" :side-offset="7" :collision-padding="8">
    <template #trigger>
      <slot />
    </template>
    <div class="plugin-picker">
      <header>
        <span>VST3</span><strong>{{ title }}</strong>
      </header>
      <label>
        <Search :size="12" aria-hidden="true" />
        <input v-model="query" :aria-label="searchLabel" placeholder="Search plug-ins" />
      </label>
      <div class="plugin-list">
        <button
          v-for="plugin in filteredPlugins"
          :key="pluginDescriptorKey(plugin)"
          type="button"
          :aria-label="`Add ${plugin.name}`"
          @click="selectPlugin(plugin)"
        >
          <b>{{ plugin.name }}</b>
          <small
            >{{ plugin.source.kind === "builtin" ? "Built-in · " : "" }}{{ plugin.vendor }} ·
            {{ plugin.category }}</small
          >
        </button>
        <p v-if="filteredPlugins.length === 0">
          {{ plugins.length === 0 ? emptyMessage : "No plug-ins match this search." }}
        </p>
      </div>
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
  font: 700 7px var(--font-utility);
  letter-spacing: 0.14em;
}
.plugin-picker header strong {
  margin-top: 3px;
  font-size: 10px;
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
  font-size: 8px;
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
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-list small {
  overflow: hidden;
  color: var(--text-faint);
  font: 6px var(--font-utility);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-list p {
  margin: 4px 2px;
  color: var(--text-faint);
  font-size: 8px;
  line-height: 1.45;
}
</style>
