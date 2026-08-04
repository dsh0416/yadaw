<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UiDropdownMenu } from "@heron/ui"
import type { UiMenuEntry } from "@heron/ui"
import {
  pluginCategoriesLabel,
  pluginDescriptorKey,
  pluginLocator,
  type PluginDescriptor
} from "@heron/contracts"
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

const pickerMenu = computed(() => {
  const selections = new Map<string, PluginSelection>()
  const vendors = new Map<string, PluginDescriptor[]>()
  const compatiblePlugins = props.plugins
    .filter((plugin) =>
      plugin.supportedAudioModes.some(
        (mode) => pluginAudioModeInputWidth(mode) === props.inputWidth
      )
    )
    .sort(
      (left, right) =>
        vendorLabel(left).localeCompare(vendorLabel(right)) || left.name.localeCompare(right.name)
    )

  for (const plugin of compatiblePlugins) {
    const label = vendorLabel(plugin)
    const plugins = vendors.get(label)
    if (plugins) plugins.push(plugin)
    else vendors.set(label, [plugin])
  }

  const entries: UiMenuEntry[] = [...vendors].map(([vendor, plugins], vendorIndex) => ({
    kind: "submenu",
    id: `vendor:${vendorIndex}:${vendor}`,
    label: vendor,
    ariaLabel: t("mixer.pluginPicker.browseVendor", { vendor }),
    children: plugins.map((plugin) => {
      const descriptorKey = pluginDescriptorKey(plugin)
      const categoryLabel = pluginCategoriesLabel(plugin.categories)
      return {
        kind: "submenu",
        id: `plugin:${descriptorKey}`,
        label: plugin.name,
        ariaLabel: t("mixer.pluginPicker.choosePlugin", { name: plugin.name }),
        title: `${plugin.name} · ${pluginLocator(plugin).format.toUpperCase()} · ${plugin.vendor} · ${categoryLabel}`,
        children: pluginAudioModeOptions(plugin.kind, props.inputWidth, t).map((option) => {
          const id = JSON.stringify([descriptorKey, option.value])
          selections.set(id, { descriptor: plugin, audioMode: option.value })
          const supported = plugin.supportedAudioModes.includes(option.value)
          return {
            kind: "item",
            id,
            label: option.label,
            ariaLabel: `${plugin.name}: ${option.label}`,
            leading: option.badge,
            metadata: option.detail,
            keywords: [
              plugin.name,
              plugin.vendor,
              vendor,
              pluginLocator(plugin).format,
              categoryLabel,
              option.label
            ],
            disabled: !supported,
            disabledReason: supported
              ? undefined
              : t("mixer.pluginPicker.modeNotSupported", { mode: option.label }),
            title: supported
              ? t("mixer.pluginPicker.modeSupported", {
                  label: option.label,
                  detail: option.detail
                })
              : t("mixer.pluginPicker.modeNotSupported", { mode: option.label })
          } satisfies UiMenuEntry
        })
      } satisfies UiMenuEntry
    })
  }))

  return { entries, selections }
})

function vendorLabel(plugin: PluginDescriptor): string {
  if (plugin.source.kind === "builtin") return t("mixer.pluginPicker.builtin")
  return plugin.vendor.trim() || t("mixer.pluginPicker.unknownVendor")
}

function select(id: string): void {
  const selection = pickerMenu.value.selections.get(id)
  if (selection) emit("select", selection)
}
</script>

<template>
  <UiDropdownMenu
    :entries="pickerMenu.entries"
    :menu-label="props.title"
    :empty-message="
      props.plugins.length === 0 ? props.emptyMessage : t('mixer.pluginPicker.noSearchResults')
    "
    :search-options="{
      label: props.searchLabel,
      placeholder: t('mixer.pluginPicker.searchPlaceholder'),
      clearLabel: t('mixer.pluginPicker.clearSearch'),
      emptyMessage: t('mixer.pluginPicker.noSearchResults'),
      resultCountLabel: t('mixer.pluginPicker.searchResultCount')
    }"
    @select="select"
  >
    <slot />
  </UiDropdownMenu>
</template>
