<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Plus, RotateCcw, RotateCw } from "@lucide/vue"
import { useGlobalDialog } from "../../composables/useGlobalDialog"
import { useMixerStore } from "../../stores/mixer"
import { usePluginStore } from "../../stores/plugins"
import { useLowLatencyModeStore } from "../../stores/lowLatencyMode"
import { useBounceStore } from "../../stores/bounce"
import type { PluginSelection } from "../plugins/plugin-audio-mode"
import MixerChannelStrip from "./MixerChannelStrip.vue"
import MixerSectionLabels from "./MixerSectionLabels.vue"
import BounceOutputDialog from "../bounce/BounceOutputDialog.vue"

const mixerStore = useMixerStore()
const pluginStore = usePluginStore()
const lowLatencyModeStore = useLowLatencyModeStore()
const bounceStore = useBounceStore()
const { confirm } = useGlobalDialog()
const { t } = useI18n()

const pluginSlotRows = computed(
  () =>
    Math.max(
      0,
      ...mixerStore.orderedChannels.map((channel) => {
        if (channel.kind === "master") return 0
        const insertCount = mixerStore.graph.plugins.filter(
          (plugin) => plugin.channelId === channel.id && plugin.role === "insert"
        ).length
        return insertCount
      })
    ) + 1
)
const sendSlotRows = computed(() =>
  Math.max(
    1,
    ...mixerStore.orderedChannels.map((channel) =>
      ["audio", "instrument", "aux"].includes(channel.kind)
        ? mixerStore.sendsFor(channel.id).length +
          (mixerStore.availableSendTargets(channel.id).length > 0 ? 1 : 0)
        : 0
    )
  )
)
const sectionStyle = computed(() => ({
  "--plugin-section-height": `${12 + pluginSlotRows.value * 24}px`,
  "--send-section-height": `${12 + sendSlotRows.value * 26}px`
}))

function pluginsFor(channelId: string) {
  return mixerStore.graph.plugins
    .filter((plugin) => plugin.channelId === channelId)
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === "instrument" ? -1 : 1
      return left.slotOrder - right.slotOrder
    })
}

function togglePlugin(instanceId: string, enabled: boolean): void {
  void mixerStore.setPluginEnabled(instanceId, enabled)
}

function removePlugin(instanceId: string): void {
  void mixerStore.execute({ type: "delete-plugin", pluginId: instanceId })
}

function insertPlugin(channelId: string, selection: PluginSelection, slotOrder: number): void {
  void pluginStore.addEffectAt(selection, channelId, slotOrder)
}

function movePlugin(instanceId: string, channelId: string, slotOrder: number): void {
  void pluginStore.moveInsert(instanceId, channelId, slotOrder)
}

async function assignInstrument(channelId: string, selection: PluginSelection): Promise<void> {
  const current = mixerStore.graph.plugins.find(
    (plugin) => plugin.channelId === channelId && plugin.role === "instrument"
  )
  if (current) {
    const confirmed = await confirm({
      eyebrow: t("mixer.console.replaceInstrument.eyebrow"),
      tone: "warning",
      title: t("mixer.console.replaceInstrument.title"),
      description: t("mixer.console.replaceInstrument.description", {
        current: current.descriptor.name,
        next: selection.descriptor.name
      }),
      detail: t("mixer.console.replaceInstrument.detail"),
      confirmLabel: t("mixer.console.replaceInstrument.confirm"),
      destructive: false
    })
    if (!confirmed) return
  }
  await pluginStore.assignInstrument(selection, channelId)
}

async function deleteChannel(channelId: string): Promise<void> {
  const channel = mixerStore.channels.find((candidate) => candidate.id === channelId)
  if (!channel || channel.kind === "master" || channel.systemRole !== null) return
  const confirmed = await confirm({
    eyebrow: t("mixer.console.deleteChannel.eyebrow"),
    tone: "danger",
    title: t("mixer.console.deleteChannel.title"),
    description: t("mixer.console.deleteChannel.description", { name: channel.name }),
    detail: t("mixer.console.deleteChannel.detail"),
    confirmLabel: t("mixer.console.deleteChannel.confirm"),
    destructive: true
  })
  if (confirmed) void mixerStore.deleteChannel(channel.id)
}
</script>

<template>
  <section class="mixer-console" :aria-label="t('mixer.console.ariaLabel')">
    <header class="mixer-toolbar">
      <div>
        <span>{{ t("mixer.console.title") }}</span>
        <strong>{{
          t("mixer.console.summary", {
            audio: mixerStore.audioTracks.length,
            instrument: mixerStore.instrumentTracks.length,
            aux: mixerStore.auxChannels.length,
            outputs: mixerStore.outputs.length
          })
        }}</strong>
      </div>
      <nav :aria-label="t('mixer.console.actions.ariaLabel')">
        <button
          :aria-label="t('mixer.console.actions.addAudio')"
          @click="mixerStore.createAudioTrack()"
        >
          <Plus :size="12" />{{ t("mixer.console.actions.addAudioLabel") }}
        </button>
        <button
          :aria-label="t('mixer.console.actions.addInstrument')"
          @click="mixerStore.createInstrumentTrack"
        >
          <Plus :size="12" />{{ t("mixer.console.actions.addInstrumentLabel") }}
        </button>
        <button :aria-label="t('mixer.console.actions.addAux')" @click="mixerStore.createAux()">
          <Plus :size="12" />{{ t("mixer.console.actions.addAuxLabel") }}
        </button>
        <button :aria-label="t('mixer.console.actions.addOutput')" @click="mixerStore.createOutput">
          <Plus :size="12" />{{ t("mixer.console.actions.addOutputLabel") }}
        </button>
        <button
          :aria-label="t('mixer.console.actions.undo')"
          :disabled="!mixerStore.canUndo"
          @click="mixerStore.undo"
        >
          <RotateCcw :size="13" />
        </button>
        <button
          :aria-label="t('mixer.console.actions.redo')"
          :disabled="!mixerStore.canRedo"
          @click="mixerStore.redo"
        >
          <RotateCw :size="13" />
        </button>
      </nav>
    </header>
    <div class="channel-scroll" :style="sectionStyle">
      <MixerSectionLabels />
      <MixerChannelStrip
        v-for="channel in mixerStore.orderedChannels"
        :key="channel.id"
        :channel="channel"
        :sends="mixerStore.sendsFor(channel.id)"
        :meter="mixerStore.meterFor(channel.id)"
        :outputs="mixerStore.outputs"
        :buses="mixerStore.buses"
        :output-targets="mixerStore.availableOutputTargets(channel.id)"
        :send-targets="mixerStore.availableSendTargets(channel.id)"
        :plugins="pluginsFor(channel.id)"
        :plugin-runtime="pluginStore.runtime"
        :effect-plugins="pluginStore.compatibleEffects"
        :instrument-plugins="pluginStore.compatibleInstruments"
        :plugin-slot-rows="pluginSlotRows"
        :send-slot-rows="sendSlotRows"
        :selected="channel.id === mixerStore.selectedChannelId"
        :low-latency-target="channel.id === lowLatencyModeStore.targetOutputChannelId"
        :low-latency-target-disabled="!lowLatencyModeStore.canConfigure"
        @select="mixerStore.selectedChannelId = $event"
        @preview="mixerStore.preview"
        @update-channel="mixerStore.updateChannel"
        @update-send="mixerStore.updateSend"
        @add-send="mixerStore.addSend"
        @delete-send="mixerStore.deleteSend"
        @open-plugin="pluginStore.openEditor"
        @toggle-plugin="togglePlugin"
        @remove-plugin="removePlugin"
        @insert-plugin="insertPlugin"
        @move-plugin="movePlugin"
        @assign-instrument="assignInstrument"
        @delete-channel="deleteChannel"
        @reset-meter-clips="mixerStore.clearMeterClips"
        @select-low-latency-output="lowLatencyModeStore.selectOutput"
        @bounce-output="bounceStore.openFor"
      />
    </div>
    <p v-if="mixerStore.error" class="mixer-error" role="alert">{{ mixerStore.error }}</p>
    <BounceOutputDialog />
  </section>
</template>

<style scoped>
.mixer-console {
  position: relative;
  display: grid;
  grid-template-rows: 43px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: var(--daw-workspace);
  overflow: hidden;
}
.mixer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 11px 0 14px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-1);
}
.mixer-toolbar > div span,
.mixer-toolbar > div strong {
  display: block;
}
.mixer-toolbar > div span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}
.mixer-toolbar > div strong {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
  font-weight: var(--ui-type-weight-semibold);
}
.mixer-toolbar nav {
  display: flex;
  gap: 5px;
}
.mixer-toolbar button {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  background: var(--daw-control);
  font-size: var(--ui-type-size-caption);
  cursor: pointer;
}
.mixer-toolbar button:hover {
  color: var(--text-primary);
  background: var(--daw-control-hover);
}
.mixer-toolbar button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.mixer-toolbar button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.channel-scroll {
  display: flex;
  align-items: flex-start;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background-color: var(--ui-domain-color-4f4f4f);
  background-image: linear-gradient(
    90deg,
    color-mix(in srgb, var(--text-primary) 3%, transparent) 1px,
    transparent 1px
  );
  background-size: 112px 100%;
}
.mixer-error {
  position: absolute;
  right: 10px;
  bottom: 8px;
  margin: 0;
  padding: 6px 9px;
  border: 1px solid color-mix(in srgb, var(--record) 55%, var(--line-strong));
  border-radius: 4px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 14%, var(--surface-1));
  font-size: var(--ui-type-size-control);
}
</style>
