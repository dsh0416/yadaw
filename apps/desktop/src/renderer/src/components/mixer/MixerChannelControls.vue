<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { MixerChannelPatch, MixerChannelState } from "@heron/contracts"

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
}>()

const { t } = useI18n()
</script>

<template>
  <div :class="['channel-actions', { 'has-input': supportsRecording }]">
    <div class="input-actions">
      <template v-if="supportsRecording">
        <button
          :class="['record', { active: channel.recordArmed }]"
          :aria-pressed="channel.recordArmed"
          :aria-label="t('mixer.channelControls.arm', { name: channel.name })"
          :title="t('mixer.channelControls.recordEnable')"
          @click.stop="emit('updateChannel', { recordArmed: !channel.recordArmed })"
        >
          R
        </button>
      </template>
      <template v-if="supportsMonitoring">
        <button
          :class="['monitor', { active: monitoringActive }]"
          :aria-label="t('mixer.channelControls.monitor', { name: channel.name })"
          :aria-pressed="channel.inputMonitoring"
          :title="
            monitoringAvailable
              ? t('mixer.channelControls.inputMonitoring')
              : t('mixer.channelControls.inputMonitoringDisabled')
          "
          :disabled="!monitoringAvailable"
          @click.stop="emit('updateChannel', { inputMonitoring: !channel.inputMonitoring })"
        >
          I
        </button>
      </template>
    </div>
    <div class="mix-actions">
      <button
        :class="['mute', { active: channel.muted }]"
        :aria-pressed="channel.muted"
        :aria-label="t('mixer.channelControls.mute', { name: channel.name })"
        @click.stop="emit('updateChannel', { muted: !channel.muted })"
      >
        M
      </button>
      <button
        v-if="channel.kind !== 'master'"
        :class="['solo', { active: channel.soloed }]"
        :aria-pressed="channel.soloed"
        :aria-label="t('mixer.channelControls.solo', { name: channel.name })"
        @click.stop="emit('updateChannel', { soloed: !channel.soloed })"
      >
        S
      </button>
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
.channel-actions button {
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-muted);
  background: var(--daw-control);
  box-shadow:
    0 1px 0 var(--ui-domain-color-ffffff12) inset,
    0 1px 2px var(--shadow);
  font: var(--ui-type-weight-bold) var(--ui-type-size-body-compact) var(--ui-type-family-data);
  cursor: pointer;
}
.input-actions button {
  width: 21px;
  height: 19px;
  border-radius: 0;
  font-size: var(--ui-type-size-control);
}
.input-actions button:first-child {
  border-radius: 3px 0 0 3px;
}
.input-actions button:last-child {
  margin-left: -1px;
  border-radius: 0 3px 3px 0;
}
.mix-actions button {
  width: 34px;
  height: 25px;
}
.mute {
  color: color-mix(in srgb, var(--mixer-mute) 76%, var(--text-secondary));
}
.solo {
  color: color-mix(in srgb, var(--mixer-solo) 78%, var(--text-secondary));
}
.record {
  color: color-mix(in srgb, var(--mixer-record) 76%, var(--text-secondary));
}
.monitor {
  color: var(--mixer-input);
}
.mute.active {
  border-color: color-mix(in srgb, var(--mixer-mute) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-mute);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-mute) 46%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff40) inset;
}
.solo.active {
  border-color: color-mix(in srgb, var(--mixer-solo) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-solo);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-solo) 40%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff5c) inset;
}
.record.active {
  border-color: color-mix(in srgb, var(--mixer-record) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-record);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-record) 46%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff40) inset;
}
.monitor.active {
  border-color: color-mix(in srgb, var(--mixer-input) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-input);
  box-shadow:
    0 0 8px color-mix(in srgb, var(--mixer-input) 44%, transparent),
    0 1px 0 var(--ui-domain-color-ffffff5c) inset;
}
.monitor:disabled {
  border-color: color-mix(in srgb, var(--mixer-input) 45%, var(--line-strong));
  color: var(--mixer-input);
  background: color-mix(in srgb, var(--mixer-input) 10%, var(--daw-control));
  cursor: not-allowed;
  opacity: 0.78;
}
.channel-actions button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
