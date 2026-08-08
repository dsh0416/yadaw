<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Trash2 } from "@lucide/vue"
import { UiCascadingSelect, UiPopover, UiRotaryControl } from "@heron/ui"
import type {
  MixerBusState,
  MixerChannelState,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState,
  MixerSendTap
} from "@heron/contracts"
import { mixerRouteGroups } from "./mixer-route-groups"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
  buses: readonly MixerBusState[]
  outputs: MixerChannelState[]
  sendTargets: MixerRouteTarget[]
  slotRows: number
}>()

const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateSend: [sendId: string, patch: MixerSendPatch]
  addSend: [target: MixerRouteTarget]
  deleteSend: [sendId: string]
}>()

const { t } = useI18n()

const supportsSends = computed(() => ["audio", "instrument", "aux"].includes(props.channel.kind))
const emptyRows = computed(() => Math.max(0, props.slotRows - props.sends.length))
const canAddSend = computed(() => props.sendTargets.length > 0)
const alignmentRows = computed(() => Math.max(0, emptyRows.value - (canAddSend.value ? 1 : 0)))
const sendTargetGroups = computed(() =>
  mixerRouteGroups(props.sendTargets, props.buses, props.outputs, t)
)
const destinationTargetGroups = computed(
  () =>
    new Map(
      props.sends.map((send) => {
        const currentTarget = targetForSend(send)
        const targets = currentTarget
          ? [
              currentTarget,
              ...props.sendTargets.filter(
                (candidate) => targetValue(candidate) !== targetValue(currentTarget)
              )
            ]
          : props.sendTargets
        return [send.id, mixerRouteGroups(targets, props.buses, props.outputs, t)] as const
      })
    )
)

function targetName(send: MixerSendState): string {
  if (send.targetChannelId) {
    return (
      props.outputs.find((output) => output.id === send.targetChannelId)?.name ??
      t("mixer.sendSection.missingOutput")
    )
  }
  return (
    props.buses.find((bus) => bus.channel === send.targetBus)?.name ??
    t("mixer.sendSection.missingBus")
  )
}

function targetValue(target: MixerRouteTarget): string {
  return target.kind === "output" ? `output:${target.channelId}` : `bus:${target.bus}`
}

function sendTargetValue(send: MixerSendState): string {
  return send.targetChannelId ? `output:${send.targetChannelId}` : `bus:${send.targetBus}`
}

function targetForSend(send: MixerSendState): MixerRouteTarget | null {
  if (send.targetChannelId) return { kind: "output", channelId: send.targetChannelId }
  return send.targetBus === null || send.targetBus === undefined
    ? null
    : { kind: "bus", bus: send.targetBus }
}

function parseTarget(value: string): MixerRouteTarget {
  const separator = value.indexOf(":")
  const kind = value.slice(0, separator)
  const target = value.slice(separator + 1)
  return kind === "output"
    ? { kind: "output", channelId: target }
    : { kind: "bus", bus: Number(target) }
}

function targetPatch(value: string): MixerSendPatch {
  const target = parseTarget(value)
  return {
    targetChannelId: target.kind === "output" ? target.channelId : null,
    targetBus: target.kind === "bus" ? target.bus : null
  }
}

function tapLabel(tap: MixerSendTap): string {
  if (tap === "pre") return t("mixer.sendSection.tapPre")
  if (tap === "post") return t("mixer.sendSection.tapPost")
  return t("mixer.sendSection.tapPan")
}

function formatSendLevel(value: number): string {
  return value <= -90 ? "−∞" : value.toFixed(1)
}

function updateSend(send: MixerSendState, patch: MixerSendPatch): void {
  emit("updateSend", send.id, patch)
}

function sendAccent(tap: MixerSendTap): string {
  return tap === "post-pan" ? "var(--ui-signal-meter-safe)" : "var(--ui-color-action)"
}

function previewSendLevel(send: MixerSendState, value: number): void {
  emit("preview", {
    target: "send",
    id: send.id,
    parameter: "levelDb",
    value
  })
}

function createSend(value: string): void {
  emit("addSend", parseTarget(value))
}
</script>

<template>
  <section class="send-section" data-section="sends" :aria-label="t('mixer.sendSection.ariaLabel')">
    <template v-if="supportsSends">
      <div
        v-for="send in sends"
        :key="send.id"
        :class="['send-row', `tap-${send.tap}`, { disabled: !send.enabled }]"
        :data-tap="send.tap"
      >
        <UiRotaryControl
          class="send-level"
          size="compact"
          :value="send.levelDb"
          :min="-90"
          :max="12"
          :step="0.1"
          :default-value="-90"
          :drag-range-pixels="180"
          :accent="sendAccent(send.tap)"
          ring-weight="emphasized"
          :disabled="!send.enabled"
          :label="t('mixer.sendSection.sendLevelFor', { target: targetName(send) })"
          :value-label="t('mixer.sendSection.sendLevelValueFor', { target: targetName(send) })"
          :value-text="formatSendLevel"
          @preview="previewSendLevel(send, $event)"
          @commit="updateSend(send, { levelDb: $event })"
        />
        <UiPopover side="top" :side-offset="7">
          <template #trigger>
            <button
              class="send-config"
              type="button"
              :title="`${targetName(send)} · ${tapLabel(send.tap)} · ${formatSendLevel(send.levelDb)} dB`"
              :aria-label="t('mixer.sendSection.editSend', { target: targetName(send) })"
            >
              <span>{{ targetName(send) }}</span>
            </button>
          </template>
          <div class="send-popover">
            <header>
              <div>
                <span>{{ t("mixer.sendSection.header") }}</span
                ><strong>{{ targetName(send) }}</strong>
              </div>
              <button
                class="delete-send"
                :aria-label="t('mixer.sendSection.deleteSend', { target: targetName(send) })"
                @click="emit('deleteSend', send.id)"
              >
                <Trash2 :size="12" />
              </button>
            </header>
            <label class="toggle-row">
              <span>{{ t("mixer.sendSection.enabled") }}</span>
              <button
                :class="{ active: send.enabled }"
                :aria-label="
                  send.enabled
                    ? t('mixer.sendSection.disableSend')
                    : t('mixer.sendSection.enableSend')
                "
                :aria-pressed="send.enabled"
                @click="updateSend(send, { enabled: !send.enabled })"
              >
                {{ send.enabled ? t("mixer.sendSection.on") : t("mixer.sendSection.off") }}
              </button>
            </label>
            <label>
              <span>{{ t("mixer.sendSection.destination") }}</span>
              <UiCascadingSelect
                :model-value="sendTargetValue(send)"
                :groups="destinationTargetGroups.get(send.id) ?? []"
                size="compact"
                :aria-label="t('mixer.sendSection.sendTarget')"
                @update:model-value="updateSend(send, targetPatch($event))"
              />
            </label>
            <div class="tap-options" :aria-label="t('mixer.sendSection.sendPosition')">
              <button
                v-for="option in ['pre', 'post', 'post-pan'] as MixerSendTap[]"
                :key="option"
                :class="{ active: send.tap === option }"
                :aria-pressed="send.tap === option"
                @click="updateSend(send, { tap: option })"
              >
                {{ tapLabel(option) }}
              </button>
            </div>
          </div>
        </UiPopover>
      </div>

      <div v-if="emptyRows > 0 && canAddSend" class="send-row empty empty-slot">
        <UiCascadingSelect
          model-value=""
          :groups="sendTargetGroups"
          placeholder=""
          size="compact"
          appearance="embedded"
          hover-treatment="host-tint"
          class="send-target-picker"
          :aria-label="t('mixer.sendSection.addSend')"
          @update:model-value="createSend"
        />
      </div>
      <span
        v-for="index in alignmentRows"
        :key="`alignment-${index}`"
        class="send-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
    <template v-else>
      <span class="send-row empty disabled">{{ t("mixer.sendSection.noSend") }}</span>
      <span
        v-for="index in Math.max(0, slotRows - 1)"
        :key="index"
        class="send-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
  </section>
</template>

<style scoped>
.send-section {
  display: grid;
  grid-auto-rows: 26px;
  align-content: start;
  min-width: 0;
  padding: 6px 7px;
  border-bottom: 1px solid var(--ui-domain-color-444);
  background: var(--ui-domain-color-585858);
}
.send-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  width: 100%;
  height: 25px;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--ui-domain-color-4a6b80);
  border-radius: 4px;
  color: var(--ui-domain-color-f5f5f5);
  background: linear-gradient(var(--ui-domain-color-4f83a4), var(--ui-domain-color-3f6b87));
  font-size: var(--ui-type-size-caption);
}
.send-row.tap-post,
.send-row.tap-post-pan {
  grid-template-columns: minmax(0, 1fr) 24px;
}
.send-row.tap-post .send-level,
.send-row.tap-post-pan .send-level {
  order: 2;
}
.send-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  width: 100%;
  height: 23px;
  min-width: 0;
  padding: 0 3px;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.send-config span {
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.send-row.disabled {
  filter: saturate(0.2);
  opacity: 0.62;
}
.send-row.empty {
  display: grid;
  grid-template-columns: 1fr;
  place-items: center;
  border-color: var(--ui-domain-color-494949);
  color: var(--ui-domain-color-929292);
  background: var(--ui-domain-color-4d4d4d);
  box-shadow: 0 1px 2px var(--ui-domain-color-00000038) inset;
  font: var(--ui-type-size-micro) var(--ui-type-family-data);
  cursor: default;
}
.send-row.empty-slot {
  overflow: hidden;
  padding: 0;
  cursor: pointer;
}
/* The 1px row border leaves a 23px content box; override embedded's 26px default. */
.send-row.empty-slot .send-target-picker {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.send-row.empty-slot:hover {
  border-color: var(--ui-domain-color-4e8dbf);
  color: var(--ui-domain-color-b7d9f3);
}
.send-row.alignment-spacer {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
}
.send-config:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.send-popover {
  display: grid;
  width: 250px;
  gap: 10px;
  padding: 11px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.send-popover header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.send-popover header span,
.send-popover header strong {
  display: block;
}
.send-popover header span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
}
.send-popover header strong {
  margin-top: 3px;
  font-size: var(--ui-type-size-label);
}
.delete-send {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  color: var(--record);
  background: var(--daw-control);
  cursor: pointer;
}
.send-popover label {
  display: grid;
  gap: 5px;
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
}
.send-popover label > span {
  display: flex;
  justify-content: space-between;
}
.toggle-row {
  grid-template-columns: 1fr auto;
  align-items: center;
}
.toggle-row button {
  width: 48px;
  height: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-faint);
  background: var(--daw-control);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
}
.toggle-row button.active,
.tap-options button.active {
  border-color: var(--ui-domain-color-4d8fc0);
  color: var(--ui-domain-color-fff);
  background: var(--ui-domain-color-377aa8);
}
.tap-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.tap-options button {
  height: 25px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-muted);
  background: var(--daw-control);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  cursor: pointer;
}
</style>
