<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { MixerChannelPatch, MixerChannelState } from "@heron/contracts"
import { UiMixerStateButton } from "@heron/ui"

const props = defineProps<{
  channel: MixerChannelState
  monitoringAvailable: boolean
  monitoringActive: boolean
}>()
const supportsRecording = computed(
  () =>
    props.channel.kind === "audio" ||
    (props.channel.kind === "instrument" && props.channel.systemRole === null)
)
const supportsMonitoring = computed(
  () =>
    props.channel.kind === "audio" ||
    props.channel.kind === "aux" ||
    (props.channel.kind === "instrument" && props.channel.systemRole === null)
)

const emit = defineEmits<{
  updateChannel: [patch: MixerChannelPatch]
  bounceOutput: []
}>()

const { t } = useI18n()
</script>

<template>
  <div :class="['channel-actions', { 'has-input': supportsRecording }]">
    <div class="input-actions">
      <UiMixerStateButton
        v-if="channel.kind === 'output'"
        size="wide"
        tone="bounce"
        :label="t('mixer.channelControls.bounce', { name: channel.name })"
        :title="t('mixer.channelControls.bounceOutput')"
        @click.stop="emit('bounceOutput')"
      >
        Bnc
      </UiMixerStateButton>
      <template v-if="supportsRecording">
        <UiMixerStateButton
          size="narrow"
          tone="record"
          joined="start"
          :pressed="channel.recordArmed"
          :label="t('mixer.channelControls.arm', { name: channel.name })"
          :title="t('mixer.channelControls.recordEnable')"
          @click.stop="emit('updateChannel', { recordArmed: !channel.recordArmed })"
        >
          R
        </UiMixerStateButton>
      </template>
      <template v-if="supportsMonitoring">
        <UiMixerStateButton
          size="narrow"
          tone="input"
          :joined="supportsRecording ? 'end' : undefined"
          :label="t('mixer.channelControls.monitor', { name: channel.name })"
          :pressed="channel.inputMonitoring"
          :active="monitoringActive"
          :title="
            monitoringAvailable
              ? t('mixer.channelControls.inputMonitoring')
              : t('mixer.channelControls.inputMonitoringDisabled')
          "
          :disabled="!monitoringAvailable"
          @click.stop="emit('updateChannel', { inputMonitoring: !channel.inputMonitoring })"
        >
          I
        </UiMixerStateButton>
      </template>
    </div>
    <div class="mix-actions">
      <UiMixerStateButton
        tone="mute"
        :pressed="channel.muted"
        :label="t('mixer.channelControls.mute', { name: channel.name })"
        @click.stop="emit('updateChannel', { muted: !channel.muted })"
      >
        M
      </UiMixerStateButton>
      <UiMixerStateButton
        v-if="channel.kind !== 'master'"
        tone="solo"
        :pressed="channel.soloed"
        :label="t('mixer.channelControls.solo', { name: channel.name })"
        @click.stop="emit('updateChannel', { soloed: !channel.soloed })"
      >
        S
      </UiMixerStateButton>
    </div>
  </div>
</template>

<style scoped>
.channel-actions {
  display: grid;
  grid-template-rows: 20px 24px;
  align-content: center;
  justify-items: center;
  gap: 4px;
  border-top: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-525252);
}
.input-actions,
.mix-actions {
  display: flex;
  align-items: center;
  justify-content: center;
}
.input-actions {
  justify-self: end;
  gap: 0;
  min-height: 20px;
  margin-right: 6px;
}
.mix-actions {
  gap: 5px;
}
</style>
