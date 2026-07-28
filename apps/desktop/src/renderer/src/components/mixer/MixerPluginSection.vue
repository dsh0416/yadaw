<script setup lang="ts">
import { computed, onUnmounted, shallowRef } from "vue"
import { Power, Trash2 } from "@lucide/vue"
import type {
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus
} from "@yadaw/contracts"
import {
  claimPluginDropPreview,
  clearActivePluginDropPreview,
  PLUGIN_DRAG_TYPE,
  readPluginDrag,
  releasePluginDropPreview,
  writePluginDrag
} from "../plugins/plugin-drag"
import PluginAudioModeMenu from "../plugins/PluginAudioModeMenu.vue"
import {
  pluginAudioModeBadge,
  pluginAudioModeOutputWidth,
  type PluginSelection,
  type PluginSignalWidth
} from "../plugins/plugin-audio-mode"
import MixerAudioFxPicker from "./MixerAudioFxPicker.vue"

const props = defineProps<{
  channel: MixerChannelState
  inserts: PluginInstanceState[]
  runtime: Record<string, PluginRuntimeStatus>
  effectPlugins: PluginDescriptor[]
  slotRows: number
  initialInputWidth: PluginSignalWidth
}>()

const emit = defineEmits<{
  open: [instanceId: string]
  toggle: [instanceId: string, enabled: boolean]
  remove: [instanceId: string]
  insert: [selection: PluginSelection, slotOrder: number]
  move: [instanceId: string, slotOrder: number]
}>()

const orderedInserts = computed(() =>
  [...props.inserts].sort((left, right) => left.slotOrder - right.slotOrder)
)
const emptyRows = computed(() => Math.max(0, props.slotRows - orderedInserts.value.length))
const alignmentRows = computed(() => Math.max(0, emptyRows.value - 1))
const acceptsPlugins = computed(() => props.channel.kind !== "master")
const pendingDrop = shallowRef<{ descriptor: PluginDescriptor; slotOrder: number } | null>(null)
const dropPreviewSlot = shallowRef<number | null>(null)
const draggedInstanceId = shallowRef<string | null>(null)
const previewSlotNumber = computed(() => {
  if (dropPreviewSlot.value === null) return null
  if (!draggedInstanceId.value) return dropPreviewSlot.value + 1
  return adjustedMoveSlot(draggedInstanceId.value, dropPreviewSlot.value) + 1
})

onUnmounted(clearDropPreview)

function inputWidthAt(slotOrder: number): PluginSignalWidth {
  let width = props.initialInputWidth
  const preceding = orderedInserts.value.slice(0, Math.max(0, slotOrder))
  for (const plugin of preceding) width = pluginAudioModeOutputWidth(plugin.audioMode)
  return width
}

function pluginState(plugin: PluginInstanceState): PluginRuntimeStatus["state"] {
  return props.runtime[plugin.id]?.state ?? (plugin.enabled ? "active" : "bypassed")
}

function accepts(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(PLUGIN_DRAG_TYPE)
}

function allowDrop(event: DragEvent): boolean {
  if (!acceptsPlugins.value || !accepts(event)) return false
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  return true
}

function adjustedMoveSlot(instanceId: string, slotOrder: number): number {
  const currentIndex = orderedInserts.value.findIndex((plugin) => plugin.id === instanceId)
  return currentIndex >= 0 && currentIndex < slotOrder ? slotOrder - 1 : slotOrder
}

function startRackDrag(event: DragEvent, instanceId: string): void {
  clearActivePluginDropPreview()
  draggedInstanceId.value = instanceId
  writePluginDrag(event, { source: "rack", instanceId })
}

function showDropPreview(slotOrder: number): void {
  claimPluginDropPreview(clearDropPreview)
  dropPreviewSlot.value = slotOrder
}

function previewDropAtRow(event: DragEvent, rowIndex: number): void {
  if (!allowDrop(event)) return
  const row = event.currentTarget
  if (!(row instanceof HTMLElement)) return
  const bounds = row.getBoundingClientRect()
  showDropPreview(event.clientY < bounds.top + bounds.height / 2 ? rowIndex : rowIndex + 1)
}

function previewDropAtEnd(event: DragEvent): void {
  if (!allowDrop(event)) return
  showDropPreview(orderedInserts.value.length)
}

function clearDropPreview(): void {
  dropPreviewSlot.value = null
  releasePluginDropPreview(clearDropPreview)
}

function finishRackDrag(): void {
  draggedInstanceId.value = null
  clearActivePluginDropPreview()
}

function leavePluginSection(event: DragEvent): void {
  const section = event.currentTarget
  const nextTarget = event.relatedTarget
  if (!(section instanceof HTMLElement)) return
  if (nextTarget instanceof Node && section.contains(nextTarget)) return
  const bounds = section.getBoundingClientRect()
  const pointerIsInside =
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom
  if (pointerIsInside) return
  clearDropPreview()
}

function dropInsert(event: DragEvent, fallbackSlotOrder: number): void {
  event.preventDefault()
  const slotOrder = dropPreviewSlot.value ?? fallbackSlotOrder
  clearDropPreview()
  const payload = readPluginDrag(event)
  if (!payload) return
  if (payload.source === "catalog") {
    if (payload.descriptor.kind === "effect") {
      pendingDrop.value = { descriptor: payload.descriptor, slotOrder }
    }
    return
  }
  emit("move", payload.instanceId, adjustedMoveSlot(payload.instanceId, slotOrder))
}

function confirmDrop(selection: PluginSelection): void {
  if (!pendingDrop.value) return
  emit("insert", selection, pendingDrop.value.slotOrder)
  pendingDrop.value = null
}
</script>

<template>
  <section
    class="plugin-section"
    data-section="plugins"
    aria-label="Audio effects"
    @dragleave="leavePluginSection"
  >
    <template v-if="acceptsPlugins">
      <template v-for="(plugin, index) in orderedInserts" :key="plugin.id">
        <div
          v-if="dropPreviewSlot === index"
          class="plugin-drop-preview"
          role="status"
          aria-live="polite"
          :aria-label="`Drop at effect slot ${previewSlotNumber}`"
          data-testid="plugin-drop-preview"
          @dragenter="allowDrop"
          @dragover="allowDrop"
          @drop="dropInsert($event, index)"
        />
        <article
          :class="[
            'plugin-row',
            pluginState(plugin),
            { 'drag-source': draggedInstanceId === plugin.id }
          ]"
          :aria-label="`${plugin.descriptor.name} plugin ${pluginState(plugin)}`"
          draggable="true"
          @dragstart="startRackDrag($event, plugin.id)"
          @dragend="finishRackDrag"
          @dragenter="previewDropAtRow($event, index)"
          @dragover="previewDropAtRow($event, index)"
          @drop="dropInsert($event, index)"
        >
          <button
            class="plugin-name"
            :title="`${plugin.descriptor.name} · ${plugin.descriptor.vendor}`"
            :aria-label="`Open ${plugin.descriptor.name} editor`"
            @click="emit('open', plugin.id)"
          >
            {{ plugin.descriptor.name }}
          </button>
          <span class="mode-badge" :title="`Audio mode: ${plugin.audioMode}`">{{
            pluginAudioModeBadge(plugin.audioMode)
          }}</span>
          <button
            :aria-label="`${plugin.enabled ? 'Bypass' : 'Enable'} ${plugin.descriptor.name}`"
            @click="emit('toggle', plugin.id, !plugin.enabled)"
          >
            <Power :size="9" />
          </button>
          <button
            :aria-label="`Remove ${plugin.descriptor.name}`"
            @click="emit('remove', plugin.id)"
          >
            <Trash2 :size="9" />
          </button>
        </article>
      </template>

      <div
        v-if="dropPreviewSlot === orderedInserts.length"
        class="plugin-drop-preview"
        role="status"
        aria-live="polite"
        :aria-label="`Drop at effect slot ${previewSlotNumber}`"
        data-testid="plugin-drop-preview"
        @dragenter="allowDrop"
        @dragover="allowDrop"
        @drop="dropInsert($event, orderedInserts.length)"
      />

      <MixerAudioFxPicker
        v-if="emptyRows > 0 && dropPreviewSlot === null"
        :plugins="effectPlugins"
        :input-width="inputWidthAt(orderedInserts.length)"
        title="Add audio effect"
        search-label="Search VST3 audio effects"
        empty-message="No compatible VST3 effects found. Rescan from the Sound Browser."
        @select="emit('insert', $event, orderedInserts.length)"
      >
        <button
          type="button"
          class="plugin-row empty picker-trigger"
          aria-label="Add VST3 audio effect"
          @dragenter="previewDropAtEnd"
          @dragover="previewDropAtEnd"
          @drop="dropInsert($event, orderedInserts.length)"
        />
      </MixerAudioFxPicker>
      <span
        v-for="index in alignmentRows"
        :key="`alignment-${index}`"
        class="plugin-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
    <template v-else>
      <article class="plugin-row empty disabled">
        <span>NO INSERT</span>
      </article>
      <span
        v-for="index in Math.max(0, slotRows - 1)"
        :key="index"
        class="plugin-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
    <div v-if="pendingDrop" class="drop-mode-menu">
      <PluginAudioModeMenu
        :descriptor="pendingDrop.descriptor"
        :input-width="inputWidthAt(pendingDrop.slotOrder)"
        @select="
          confirmDrop({
            descriptor: pendingDrop.descriptor,
            audioMode: $event
          })
        "
        @cancel="pendingDrop = null"
      />
    </div>
  </section>
</template>

<style scoped>
.plugin-section {
  position: relative;
  display: grid;
  grid-auto-rows: 24px;
  align-content: start;
  min-width: 0;
  padding: 6px 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-575757);
}
.plugin-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 18px 18px;
  align-items: center;
  min-width: 0;
  height: 23px;
  border: 1px solid var(--ui-domain-color-2e5d86);
  border-radius: 4px;
  color: var(--ui-domain-color-fff);
  background: linear-gradient(var(--ui-domain-color-3f91d4), var(--ui-domain-color-2871ae));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff28) inset;
}
.mode-badge {
  padding: 1px 3px;
  border: 1px solid var(--ui-domain-color-ffffff28);
  border-radius: 3px;
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
}
.plugin-drop-preview {
  min-width: 0;
  height: 23px;
  border: 1px solid var(--focus);
  border-radius: 4px;
  color: var(--ui-domain-color-fff);
  background:
    linear-gradient(90deg, transparent, var(--ui-domain-color-2871ae), transparent),
    repeating-linear-gradient(
      -45deg,
      var(--ui-domain-color-2e5d86),
      var(--ui-domain-color-2e5d86) 4px,
      var(--ui-domain-color-3f91d4) 4px,
      var(--ui-domain-color-3f91d4) 8px
    );
  box-shadow:
    0 0 0 1px var(--ui-domain-color-00000038) inset,
    0 0 9px var(--ui-domain-color-4e8dbf);
}
.drop-mode-menu {
  position: absolute;
  z-index: var(--ui-z-popover);
  top: 4px;
  left: 4px;
  width: 232px;
  padding: 9px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.plugin-row.bypassed {
  border-color: var(--ui-domain-color-505050);
  color: var(--ui-domain-color-a7a7a7);
  background: linear-gradient(var(--ui-domain-color-5b5b5b), var(--ui-domain-color-4b4b4b));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff12) inset;
}
.plugin-row.drag-source {
  border-style: dashed;
  opacity: 0.48;
}
.plugin-row.loading,
.plugin-row.unloaded {
  border-color: var(--ui-domain-color-566a78);
  color: var(--ui-domain-color-c5d0d7);
  background: linear-gradient(var(--ui-domain-color-617685), var(--ui-domain-color-526573));
}
.plugin-row.failed,
.plugin-row.missing,
.plugin-row.quarantined {
  border-color: var(--ui-domain-color-8d4a43);
  color: var(--ui-domain-color-ffd4ce);
  background: linear-gradient(var(--ui-domain-color-884f49), var(--ui-domain-color-6d3e39));
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff16) inset;
}
.plugin-row button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 20px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.plugin-row .plugin-name {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0 3px;
  overflow: hidden;
  font-size: var(--ui-type-size-control);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-row button:hover {
  background: var(--ui-domain-color-ffffff22);
}
.plugin-row button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-row.empty {
  display: grid;
  grid-template-columns: 1fr;
  place-items: center;
  border-color: var(--ui-domain-color-4c4c4c);
  color: var(--ui-domain-color-8f8f8f);
  background: var(--ui-domain-color-4d4d4d);
  box-shadow: 0 1px 2px var(--ui-domain-color-00000038) inset;
}
.plugin-row.empty span {
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wide);
}
.plugin-row.empty:not(.disabled):hover {
  border-color: var(--ui-domain-color-4e8dbf);
  color: var(--ui-domain-color-b7d9f3);
}
.plugin-row.picker-trigger {
  width: 100%;
  padding: 0;
  font: inherit;
  cursor: pointer;
}
.plugin-row.picker-trigger:focus-visible {
  border-color: var(--focus);
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.plugin-row.alignment-spacer {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
}
.plugin-row.disabled {
  opacity: 0.65;
}
</style>
