<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { Trash2 } from "@lucide/vue"
import { UiPopover } from "@yadaw/ui"
import type {
  MixerChannelState,
  MixerParameterPreview,
  MixerSendPatch,
  MixerSendState,
  MixerSendTap
} from "@yadaw/contracts"
import { useParameterGesture } from "../../composables/useParameterGesture"

const props = defineProps<{
  channel: MixerChannelState
  sends: MixerSendState[]
  buses: MixerChannelState[]
  sendTargets: MixerChannelState[]
  slotRows: number
}>()

const emit = defineEmits<{
  preview: [preview: MixerParameterPreview]
  updateSend: [sendId: string, patch: MixerSendPatch]
  addSend: [targetChannelId: string]
  deleteSend: [sendId: string]
}>()

const newSendTarget = shallowRef("")
const sendGestures = new Map<string, ReturnType<typeof useParameterGesture>>()
const supportsSends = computed(() => ["audio", "instrument", "bus"].includes(props.channel.kind))
const emptyRows = computed(() => Math.max(0, props.slotRows - props.sends.length))
const canAddSend = computed(() => props.sendTargets.length > 0)
const alignmentRows = computed(() => Math.max(0, emptyRows.value - (canAddSend.value ? 1 : 0)))

watch(
  () => [props.channel.id, props.sendTargets.map((target) => target.id).join("|")],
  () => {
    if (!props.sendTargets.some((target) => target.id === newSendTarget.value)) {
      newSendTarget.value = props.sendTargets[0]?.id ?? ""
    }
  },
  { immediate: true }
)

function targetName(send: MixerSendState): string {
  return props.buses.find((bus) => bus.id === send.targetChannelId)?.name ?? "Missing bus"
}

function tapLabel(tap: MixerSendTap): string {
  if (tap === "pre") return "PRE"
  if (tap === "post") return "POST"
  return "PAN"
}

function sendLevel(send: MixerSendState): string {
  return send.levelDb <= -90 ? "−∞" : send.levelDb.toFixed(1)
}

function updateSend(send: MixerSendState, patch: MixerSendPatch): void {
  emit("updateSend", send.id, patch)
}

function sendLevelGesture(send: MixerSendState) {
  let gesture = sendGestures.get(send.id)
  if (!gesture) {
    gesture = useParameterGesture({
      currentValue: () => {
        const current = props.sends.find((candidate) => candidate.id === send.id)
        return current?.levelDb ?? send.levelDb
      },
      preview: (value) =>
        emit("preview", {
          target: "send",
          id: send.id,
          parameter: "levelDb",
          value
        }),
      commit: (value) => updateSend(send, { levelDb: value })
    })
    sendGestures.set(send.id, gesture)
  }
  return gesture
}

function numberValue(event: Event): number {
  return Number((event.currentTarget as HTMLInputElement).value)
}

function createSend(): void {
  if (!newSendTarget.value) return
  emit("addSend", newSendTarget.value)
}
</script>

<template>
  <section class="send-section" data-section="sends" aria-label="Channel sends">
    <template v-if="supportsSends">
      <UiPopover v-for="send in sends" :key="send.id" side="top" :side-offset="7">
        <template #trigger>
          <button
            :class="['send-row', { disabled: !send.enabled }]"
            :aria-label="`Edit send to ${targetName(send)}`"
          >
            <i aria-hidden="true" />
            <span>{{ targetName(send) }}</span>
            <b>{{ tapLabel(send.tap) }}</b>
            <output>{{ sendLevel(send) }}</output>
          </button>
        </template>
        <div class="send-popover">
          <header>
            <div>
              <span>SEND</span><strong>{{ targetName(send) }}</strong>
            </div>
            <button
              class="delete-send"
              :aria-label="`Delete send to ${targetName(send)}`"
              @click="emit('deleteSend', send.id)"
            >
              <Trash2 :size="12" />
            </button>
          </header>
          <label class="toggle-row">
            <span>Enabled</span>
            <button
              :class="{ active: send.enabled }"
              :aria-label="send.enabled ? 'Disable send' : 'Enable send'"
              :aria-pressed="send.enabled"
              @click="updateSend(send, { enabled: !send.enabled })"
            >
              {{ send.enabled ? "ON" : "OFF" }}
            </button>
          </label>
          <label>
            <span>Destination</span>
            <select
              :value="send.targetChannelId"
              aria-label="Send target"
              @change="
                updateSend(send, {
                  targetChannelId: ($event.currentTarget as HTMLSelectElement).value
                })
              "
            >
              <option
                v-for="bus in buses"
                :key="bus.id"
                :value="bus.id"
                :disabled="
                  bus.id !== send.targetChannelId &&
                  !sendTargets.some((target) => target.id === bus.id)
                "
              >
                {{ bus.name }}
              </option>
            </select>
          </label>
          <div class="tap-options" aria-label="Send position">
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
          <label class="parameter-row">
            <span
              >Level <b>{{ sendLevel(send) }} dB</b></span
            >
            <input
              type="range"
              min="-90"
              max="12"
              step="0.1"
              :value="send.levelDb"
              aria-label="Send level"
              @pointerdown="sendLevelGesture(send).begin"
              @input="sendLevelGesture(send).preview"
              @change="sendLevelGesture(send).commit"
              @keydown="sendLevelGesture(send).keydown"
              @dblclick="sendLevelGesture(send).reset(-90)"
            />
            <input
              type="number"
              min="-90"
              max="12"
              step="0.1"
              :value="send.levelDb"
              aria-label="Send level value in decibels"
              @change="sendLevelGesture(send).reset(numberValue($event))"
            />
          </label>
        </div>
      </UiPopover>

      <UiPopover v-if="emptyRows > 0 && canAddSend" side="top" :side-offset="7">
        <template #trigger>
          <button class="send-row empty empty-slot" aria-label="Add send in empty slot">
            EMPTY SEND
          </button>
        </template>
        <div class="add-send-popover">
          <strong>Add send</strong>
          <select v-model="newSendTarget" aria-label="New send target">
            <option v-for="target in sendTargets" :key="target.id" :value="target.id">
              {{ target.name }}
            </option>
          </select>
          <button :disabled="!newSendTarget" @click="createSend">Add</button>
        </div>
      </UiPopover>
      <span
        v-for="index in alignmentRows"
        :key="`alignment-${index}`"
        class="send-row alignment-spacer"
        aria-hidden="true"
      />
    </template>
    <template v-else>
      <span class="send-row empty disabled">NO SEND</span>
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
  grid-template-columns: 5px minmax(0, 1fr) 25px 28px;
  align-items: center;
  width: 100%;
  height: 25px;
  min-width: 0;
  padding: 0 3px;
  border: 1px solid var(--ui-domain-color-4a6b80);
  border-radius: 4px;
  color: var(--ui-domain-color-f5f5f5);
  background: linear-gradient(var(--ui-domain-color-4f83a4), var(--ui-domain-color-3f6b87));
  font-size: 7px;
  cursor: pointer;
}
.send-row i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ui-domain-color-86e7ff);
  box-shadow: 0 0 4px var(--ui-domain-color-86e7ff);
}
.send-row span {
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.send-row b {
  font: 700 6px var(--font-utility);
}
.send-row output {
  color: var(--ui-domain-color-dceeff);
  font: 6px var(--font-utility);
  text-align: right;
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
  font: 6px var(--font-utility);
  cursor: default;
}
.send-row.empty-slot {
  cursor: pointer;
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
.send-row:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.send-popover,
.add-send-popover {
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
  font: 700 7px var(--font-utility);
  letter-spacing: 0.14em;
}
.send-popover header strong {
  margin-top: 3px;
  font-size: 10px;
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
  font-size: 8px;
}
.send-popover label > span {
  display: flex;
  justify-content: space-between;
}
.send-popover select,
.add-send-popover select,
.parameter-row input[type="number"] {
  height: 25px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-primary);
  background: var(--daw-control);
  font-size: 8px;
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
  font: 700 7px var(--font-utility);
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
  font: 700 7px var(--font-utility);
  cursor: pointer;
}
.parameter-row {
  grid-template-columns: minmax(0, 1fr) 54px;
}
.parameter-row span {
  grid-column: 1 / -1;
}
.parameter-row input[type="range"] {
  min-width: 0;
  accent-color: var(--accent);
}
.parameter-row input[type="number"] {
  width: 54px;
  min-width: 0;
  padding: 0 4px;
}
.add-send-popover {
  grid-template-columns: minmax(0, 1fr) 52px;
  width: 220px;
}
.add-send-popover strong {
  grid-column: 1 / -1;
  font-size: 10px;
}
.add-send-popover button {
  border: 1px solid var(--ui-domain-color-4d8fc0);
  border-radius: 3px;
  color: var(--ui-domain-color-fff);
  background: var(--ui-domain-color-377aa8);
  font-size: 8px;
  cursor: pointer;
}
</style>
