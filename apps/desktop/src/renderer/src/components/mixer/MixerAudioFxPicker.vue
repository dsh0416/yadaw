<script setup lang="ts">
import { computed, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
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

const { t } = useI18n()

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
    ariaLabel: t("mixer.pluginPicker.browseVendor", { vendor }),
    children: plugins.map((plugin) => ({
      label: plugin.name,
      ariaLabel: t("mixer.pluginPicker.choosePlugin", { name: plugin.name }),
      title: `${plugin.name} · ${plugin.vendor} · ${pluginCategoriesLabel(plugin.categories)}`,
      children: pluginAudioModeOptions(plugin.kind, props.inputWidth, t).map((option) => {
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
            ? t("mixer.pluginPicker.modeSupported", {
                label: option.label,
                detail: option.detail
              })
            : t("mixer.pluginPicker.modeNotSupported", { mode: option.label })
        }
      })
    }))
  }))

  return { items, selections }
})
const noResultsMessage = computed(() =>
  props.plugins.length === 0 ? props.emptyMessage : t("mixer.pluginPicker.noSearchResults")
)

function vendorLabel(plugin: PluginDescriptor): string {
  if (plugin.source.kind === "builtin") return t("mixer.pluginPicker.builtin")
  return plugin.vendor.trim() || t("mixer.pluginPicker.unknownVendor")
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
    :search-placeholder="t('mixer.pluginPicker.searchPlaceholder')"
    :empty-message="noResultsMessage"
    @select="select"
  >
    <slot />
  </UiCascadingMenu>
</template>
