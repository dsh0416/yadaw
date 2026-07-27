<script setup lang="ts">
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview
} from "@yadaw/contracts"
import { FADER_MIN_DB } from "../../../utils/mixerDbScale"
import TrackGainControl from "../TrackGainControl.vue"

const props = defineProps<{
  channel: MixerChannelState | null
  meter: MixerChannelMeter
}>()
const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateChannel: [channelId: string, patch: MixerChannelPatch]
}>()

function previewGain(value: number): void {
  if (!props.channel) return
  emit("preview", {
    target: "channel",
    id: props.channel.id,
    parameter: "gainDb",
    value
  })
}

function commitGain(value: number): void {
  if (!props.channel) return
  emit("updateChannel", props.channel.id, { gainDb: value })
}
</script>

<template>
  <section class="master-control" aria-label="Master output">
    <TrackGainControl
      channel-name="Master"
      :value="channel?.gainDb ?? FADER_MIN_DB"
      :meter="meter"
      :disabled="!channel"
      @preview="previewGain"
      @commit="commitGain"
    />
  </section>
</template>

<style scoped>
.master-control {
  flex: none;
  width: clamp(112px, 10vw, 148px);
  min-width: 0;
  -webkit-app-region: no-drag;
}

@media (max-width: 1279px) {
  .master-control {
    width: 112px;
  }
}
</style>
