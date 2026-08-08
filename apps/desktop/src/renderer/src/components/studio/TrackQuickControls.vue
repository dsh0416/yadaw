<script setup lang="ts">
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview
} from "@heron/contracts"
import TrackGainControl from "./TrackGainControl.vue"
import TrackPanControl from "./TrackPanControl.vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()

const props = defineProps<{
  channel: MixerChannelState
  meter?: MixerChannelMeter
}>()

const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateChannel: [channelId: string, patch: MixerChannelPatch]
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
const monitoringAvailable = computed(
  () =>
    (props.channel.kind === "instrument" && props.channel.systemRole === null) ||
    ((props.channel.kind === "audio" || props.channel.kind === "aux") &&
      (props.channel.inputSource === "hardware" ||
        (props.channel.inputSource === "application" && props.channel.applicationCapture != null)))
)
const monitoringActive = computed(() => monitoringAvailable.value && props.channel.inputMonitoring)

function preview(parameter: "gainDb" | "pan", value: number): void {
  emit("preview", {
    target: "channel",
    id: props.channel.id,
    parameter,
    value
  })
}
</script>

<template>
  <div
    class="track-quick-controls"
    :aria-label="t('studio.trackControls.ariaLabel', { name: channel.name })"
  >
    <button
      :class="['mute', { active: channel.muted }]"
      :aria-pressed="channel.muted"
      :aria-label="t('studio.trackControls.muteAria', { name: channel.name })"
      :title="t('studio.trackControls.mute')"
      @click.stop="emit('updateChannel', channel.id, { muted: !channel.muted })"
    >
      M
    </button>
    <button
      :class="['solo', { active: channel.soloed }]"
      :aria-pressed="channel.soloed"
      :aria-label="t('studio.trackControls.soloAria', { name: channel.name })"
      :title="t('studio.trackControls.solo')"
      @click.stop="emit('updateChannel', channel.id, { soloed: !channel.soloed })"
    >
      S
    </button>
    <button
      v-if="supportsRecording"
      :class="['record', { active: channel.recordArmed }]"
      :aria-pressed="channel.recordArmed"
      :aria-label="t('studio.trackControls.armAria', { name: channel.name })"
      :title="t('studio.trackControls.recordEnable')"
      @click.stop="emit('updateChannel', channel.id, { recordArmed: !channel.recordArmed })"
    >
      R
    </button>
    <button
      v-if="supportsMonitoring"
      :class="['monitor', { active: monitoringActive }]"
      :aria-label="t('studio.trackControls.monitorAria', { name: channel.name })"
      :aria-pressed="channel.inputMonitoring"
      :title="
        monitoringAvailable
          ? t('studio.trackControls.inputMonitoring')
          : t('studio.trackControls.inputMonitoringDisabled')
      "
      :disabled="!monitoringAvailable"
      @click.stop="emit('updateChannel', channel.id, { inputMonitoring: !channel.inputMonitoring })"
    >
      I
    </button>

    <TrackGainControl
      :channel-name="channel.name"
      :channel-id="channel.id"
      :value="channel.gainDb"
      :meter="meter"
      @preview="preview('gainDb', $event)"
      @commit="emit('updateChannel', channel.id, { gainDb: $event })"
    />
    <TrackPanControl
      :channel-name="channel.name"
      :value="channel.pan"
      @preview="preview('pan', $event)"
      @commit="emit('updateChannel', channel.id, { pan: $event })"
    />
  </div>
</template>

<style scoped>
.track-quick-controls {
  display: grid;
  grid-template-columns: repeat(4, 17px) minmax(64px, 1fr) 23px;
  align-items: center;
  gap: 2px;
  min-width: 0;
  height: 23px;
}

.track-quick-controls button {
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text-muted);
  background: var(--daw-control);
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff12) inset;
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  cursor: pointer;
}

.track-quick-controls .mute {
  color: color-mix(in srgb, var(--mixer-mute) 76%, var(--text-secondary));
}

.track-quick-controls .solo {
  color: color-mix(in srgb, var(--mixer-solo) 78%, var(--text-secondary));
}

.track-quick-controls .record {
  color: color-mix(in srgb, var(--mixer-record) 76%, var(--text-secondary));
}

.track-quick-controls .monitor {
  color: var(--mixer-input);
}

.track-quick-controls .mute.active {
  border-color: color-mix(in srgb, var(--mixer-mute) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-mute);
}

.track-quick-controls .solo.active {
  border-color: color-mix(in srgb, var(--mixer-solo) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-solo);
}

.track-quick-controls .record.active {
  border-color: color-mix(in srgb, var(--mixer-record) 72%, white);
  color: var(--ui-domain-color-fff);
  background: var(--mixer-record);
}

.track-quick-controls .monitor.active {
  border-color: color-mix(in srgb, var(--mixer-input) 72%, white);
  color: var(--ui-domain-color-221c08);
  background: var(--mixer-input);
}

.track-quick-controls .monitor:disabled {
  border-color: color-mix(in srgb, var(--mixer-input) 35%, var(--line-strong));
  background: color-mix(in srgb, var(--mixer-input) 8%, var(--daw-control));
  cursor: not-allowed;
  opacity: 0.7;
}

.track-quick-controls button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
