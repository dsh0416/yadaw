<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { UiCascadingMenu } from "@yadaw/ui"
import type { UiCascadingMenuItem } from "@yadaw/ui"
import { pluginCategoriesLabel, pluginDescriptorKey, type PluginDescriptor } from "@yadaw/contracts"
import {
  pluginAudioModeInputWidth,
  pluginAudioModeOptions,
  type PluginSelection,
  type PluginSignalWidth
} from "../plugins/plugin-audio-mode"

const props = defineProps<{
  plugins: PluginDescriptor[]
  title: string
  searchLabel: string
  emptyMessage: string
  inputWidth: PluginSignalWidth
}>()

const emit = defineEmits<{
  select: [selection: PluginSelection]
}>()

const query = shallowRef("")
const filteredPlugins = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return [...props.plugins]
    .filter((plugin) =>
      plugin.supportedAudioModes.some(
        (mode) => pluginAudioModeInputWidth(mode) === props.inputWidth
      )
    )
    .filter((plugin) =>
      `${plugin.name} ${plugin.vendor} ${pluginCategoriesLabel(plugin.categories)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
    .sort(
      (left, right) =>
        vendorLabel(left).localeCompare(vendorLabel(right)) || left.name.localeCompare(right.name)
    )
})
const pickerMenu = computed(() => {
  const selections = new Map<string, PluginSelection>()
  const vendors = new Map<string, PluginDescriptor[]>()
  for (const plugin of filteredPlugins.value) {
    const label = vendorLabel(plugin)
    const plugins = vendors.get(label)
    if (plugins) plugins.push(plugin)
    else vendors.set(label, [plugin])
  }

  const items: UiCascadingMenuItem[] = [...vendors].map(([vendor, plugins]) => ({
    label: vendor,
    ariaLabel: `Browse ${vendor} plug-ins`,
    children: plugins.map((plugin) => ({
      label: plugin.name,
      ariaLabel: `Choose ${plugin.name}`,
      title: `${plugin.name} · ${plugin.vendor} · ${pluginCategoriesLabel(plugin.categories)}`,
      children: pluginAudioModeOptions(plugin.kind, props.inputWidth).map((option) => {
        const value = JSON.stringify([pluginDescriptorKey(plugin), option.value])
        selections.set(value, { descriptor: plugin, audioMode: option.value })
        const supported = plugin.supportedAudioModes.includes(option.value)
        return {
          label: option.label,
          value,
          ariaLabel: `${plugin.name}: ${option.label}`,
          leading: option.badge,
          trailing: option.detail,
          disabled: !supported,
          title: supported
            ? `${option.label}: ${option.detail}`
            : `${option.label} is not supported by this plug-in`
        }
      })
    }))
  }))

  return { items, selections }
})
const noResultsMessage = computed(() =>
  props.plugins.length === 0 ? props.emptyMessage : "No plug-ins match this search."
)

function vendorLabel(plugin: PluginDescriptor): string {
  if (plugin.source.kind === "builtin") return "Built-in"
  return plugin.vendor.trim() || "Unknown vendor"
}

function select(value: string): void {
  const selection = pickerMenu.value.selections.get(value)
  if (selection) emit("select", selection)
}
</script>

<template>
  <UiCascadingMenu
    v-model:search="query"
    :items="pickerMenu.items"
    :aria-label="title"
    :search-label="searchLabel"
    search-placeholder="Search plug-ins"
    :empty-message="noResultsMessage"
    @select="select"
  >
    <slot />
  </UiCascadingMenu>
</template>
