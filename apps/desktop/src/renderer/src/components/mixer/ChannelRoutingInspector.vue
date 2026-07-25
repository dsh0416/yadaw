<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { Plus, Trash2, X } from "@lucide/vue"
import type { MixerSendPatch, MixerSendState } from "@yadaw/contracts"
import { useParameterGesture } from "../../composables/useParameterGesture"
import { useMixerStore } from "../../stores/mixer"

const mixerStore = useMixerStore()
const newSendTarget = shallowRef("")
const inputOptions = Array.from({ length: 32 }, (_, index) => index + 1)
const channel = computed(() => mixerStore.selectedChannel)
const sends = computed(() =>
  channel.value ? mixerStore.sendsFor(channel.value.id) : []
)
const outputs = computed(() =>
  channel.value ? mixerStore.availableOutputs(channel.value.id) : []
)
const sendTargets = computed(() =>
  channel.value ? mixerStore.availableSendTargets(channel.value.id) : []
)

watch(() => channel.value?.id, () => {
  newSendTarget.value = sendTargets.value[0]?.id ?? ""
}, { immediate: true })

function numberValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function stringValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}

function updateSend(send: MixerSendState, patch: MixerSendPatch): void {
  void mixerStore.updateSend(send.id, patch)
}

const sendGestures = new Map<string, ReturnType<typeof useParameterGesture>>()

function sendGesture(send: MixerSendState, parameter: "levelDb" | "pan") {
  const key = `${send.id}:${parameter}`
  let gesture = sendGestures.get(key)
  if (!gesture) {
    gesture = useParameterGesture({
      currentValue: () => {
        const current = mixerStore.graph.sends.find((candidate) => candidate.id === send.id)
        return current?.[parameter] ?? send[parameter]
      },
      preview: (value) => mixerStore.preview({
        target: "send",
        id: send.id,
        parameter,
        value
      }),
      commit: (value) => updateSend(send, { [parameter]: value })
    })
    sendGestures.set(key, gesture)
  }
  return gesture
}

function updateInput(index: number, event: Event): void {
  if (!channel.value) return
  const inputs = [...channel.value.inputChannels]
  inputs[index] = numberValue(event)
  void mixerStore.updateChannel(channel.value.id, { inputChannels: inputs })
}

function changeInputFormat(event: Event): void {
  if (!channel.value) return
  const inputFormat = stringValue(event) as "mono" | "stereo"
  void mixerStore.updateChannel(channel.value.id, {
    inputFormat,
    inputChannels: inputFormat === "mono"
      ? [channel.value.inputChannels[0] ?? 1]
      : [channel.value.inputChannels[0] ?? 1, channel.value.inputChannels[1] ?? 2]
  })
}

function updateHardwareOutput(index: number, event: Event): void {
  if (!channel.value) return
  const hardwareOutputChannels = [...channel.value.hardwareOutputChannels]
  hardwareOutputChannels[index] = numberValue(event)
  void mixerStore.updateChannel(channel.value.id, { hardwareOutputChannels })
}

function createSend(): void {
  if (!channel.value || !newSendTarget.value) return
  void mixerStore.addSend(channel.value.id, newSendTarget.value)
}

function removeChannel(): void {
  if (!channel.value || channel.value.kind === "master") return
  if (window.confirm(`Delete ${channel.value.name}? Its clips will be removed from the timeline, but media assets will be kept.`)) {
    void mixerStore.deleteChannel(channel.value.id)
  }
}

function clearMeterClips(): void {
  void mixerStore.clearMeterClips()
}
</script>

<template>
  <aside class="routing-inspector" aria-label="Channel routing inspector">
    <header>
      <span>CHANNEL</span>
      <strong>{{ channel?.name ?? "No selection" }}</strong>
      <button
        v-if="channel && channel.kind !== 'master'"
        aria-label="Delete selected channel"
        @click="removeChannel"
      ><Trash2 :size="13" /></button>
    </header>

    <template v-if="channel">
      <section class="identity-section">
        <label>
          <span>Name</span>
          <input
            :value="channel.name"
            aria-label="Channel name"
            @change="mixerStore.updateChannel(channel.id, { name: stringValue($event) })"
          >
        </label>
        <label>
          <span>Color</span>
          <input
            type="color"
            :value="channel.color"
            aria-label="Channel color"
            @change="mixerStore.updateChannel(channel.id, { color: stringValue($event).toUpperCase() })"
          >
        </label>
      </section>

      <section v-if="channel.kind === 'audio'">
        <div class="section-heading"><span>INPUT</span><b>{{ channel.recordArmed ? "ARMED" : "SAFE" }}</b></div>
        <label>
          <span>Input format</span>
          <select :value="channel.inputFormat ?? 'stereo'" aria-label="Input format" @change="changeInputFormat">
            <option value="mono">Mono</option>
            <option value="stereo">Stereo</option>
          </select>
        </label>
        <div class="input-grid">
          <label v-for="(_, index) in channel.inputChannels" :key="index">
            <span>{{ channel.inputFormat === "mono" ? "Input" : index === 0 ? "Left" : "Right" }}</span>
            <select
              :value="channel.inputChannels[index]"
              :aria-label="`${channel.name} input channel ${index + 1}`"
              @change="updateInput(index, $event)"
            >
              <option v-for="input in inputOptions" :key="input" :value="input">Input {{ input }}</option>
            </select>
          </label>
        </div>
      </section>

      <section v-if="channel.kind === 'output'">
        <div class="section-heading"><span>HARDWARE OUTPUT</span><b>STEREO PAIR</b></div>
        <div class="input-grid">
          <label v-for="(_, index) in channel.hardwareOutputChannels" :key="index">
            <span>{{ index === 0 ? "Left" : "Right" }}</span>
            <select
              :value="channel.hardwareOutputChannels[index]"
              :aria-label="`${channel.name} hardware output ${index + 1}`"
              @change="updateHardwareOutput(index, $event)"
            >
              <option v-for="output in inputOptions" :key="output" :value="output">Output {{ output }}</option>
            </select>
          </label>
        </div>
      </section>

      <section v-if="channel.kind === 'audio' || channel.kind === 'bus'">
        <div class="section-heading"><span>OUTPUT</span><b>MAIN PATH</b></div>
        <label>
          <span>Destination</span>
          <select
            :value="channel.outputChannelId ?? ''"
            aria-label="Channel output destination"
            @change="mixerStore.updateChannel(channel.id, { outputChannelId: stringValue($event) })"
          >
            <option v-for="output in outputs" :key="output.id" :value="output.id">{{ output.name }}</option>
          </select>
        </label>
      </section>

      <section v-if="channel.kind === 'audio' || channel.kind === 'bus'" class="send-section">
        <div class="section-heading"><span>SENDS</span><b>{{ sends.length }}</b></div>
        <article v-for="send in sends" :key="send.id" class="send-card">
          <div class="send-card-head">
            <button
              :class="{ enabled: send.enabled }"
              :aria-pressed="send.enabled"
              :aria-label="`${send.enabled ? 'Disable' : 'Enable'} send`"
              @click="updateSend(send, { enabled: !send.enabled })"
            >{{ send.enabled ? "ON" : "OFF" }}</button>
            <select
              :value="send.targetChannelId"
              aria-label="Send target"
              @change="updateSend(send, { targetChannelId: stringValue($event) })"
            >
              <option
                v-for="bus in mixerStore.buses"
                :key="bus.id"
                :value="bus.id"
                :disabled="bus.id !== send.targetChannelId && !sendTargets.some((target) => target.id === bus.id)"
              >{{ bus.name }}</option>
            </select>
            <button aria-label="Delete send" @click="mixerStore.deleteSend(send.id)"><X :size="12" /></button>
          </div>
          <div class="send-mode">
            <button
              :class="{ active: send.tap === 'pre' }"
              @click="updateSend(send, { tap: 'pre' })"
            >PRE</button>
            <button
              :class="{ active: send.tap === 'post' }"
              @click="updateSend(send, { tap: 'post' })"
            >POST</button>
          </div>
          <label>
            <span>Level <b>{{ send.levelDb <= -90 ? "−∞" : `${send.levelDb.toFixed(1)} dB` }}</b></span>
            <input
              type="range"
              min="-90"
              max="12"
              step="0.1"
              :value="send.levelDb"
              aria-label="Send level"
              @pointerdown="sendGesture(send, 'levelDb').begin"
              @input="sendGesture(send, 'levelDb').preview"
              @change="sendGesture(send, 'levelDb').commit"
              @keydown="sendGesture(send, 'levelDb').keydown"
              @dblclick="sendGesture(send, 'levelDb').reset(-90)"
            >
            <input
              type="number"
              min="-90"
              max="12"
              step="0.1"
              :value="send.levelDb"
              aria-label="Send level value in decibels"
              @change="sendGesture(send, 'levelDb').reset(numberValue($event))"
            >
          </label>
          <label>
            <span>Pan <b>{{ Math.round(send.pan * 100) }}</b></span>
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              :value="send.pan"
              aria-label="Send pan"
              @pointerdown="sendGesture(send, 'pan').begin"
              @input="sendGesture(send, 'pan').preview"
              @change="sendGesture(send, 'pan').commit"
              @keydown="sendGesture(send, 'pan').keydown"
              @dblclick="sendGesture(send, 'pan').reset(0)"
            >
            <input
              type="number"
              min="-1"
              max="1"
              step="0.01"
              :value="send.pan"
              aria-label="Send pan value"
              @change="sendGesture(send, 'pan').reset(numberValue($event))"
            >
          </label>
        </article>
        <div v-if="sendTargets.length" class="add-send">
          <select v-model="newSendTarget" aria-label="New send target">
            <option v-for="target in sendTargets" :key="target.id" :value="target.id">{{ target.name }}</option>
          </select>
          <button aria-label="Add send" @click="createSend"><Plus :size="12" />Add</button>
        </div>
        <p v-else class="empty-copy">Create another Bus to add a send.</p>
      </section>

      <button class="clear-clips" @click="clearMeterClips">
        Clear meter clips
      </button>
    </template>
    <p v-else class="empty-copy">Select a channel to edit routing and sends.</p>
  </aside>
</template>

<style scoped>
.routing-inspector{min-width:0;overflow-y:auto;border-left:1px solid var(--line-soft);background:var(--surface-panel);color:var(--text-primary)}.routing-inspector>header{position:sticky;z-index:3;top:0;display:grid;grid-template-columns:1fr auto;align-items:center;padding:14px 13px 12px;border-bottom:1px solid var(--line-strong);background:var(--surface-1)}.routing-inspector>header span,.routing-inspector>header strong{display:block;grid-column:1}.routing-inspector>header span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}.routing-inspector>header strong{margin-top:4px;overflow:hidden;font-family:var(--font-display);font-size:13px;text-overflow:ellipsis;white-space:nowrap}.routing-inspector>header button{grid-column:2;grid-row:1/3;display:grid;place-items:center;width:27px;height:27px;padding:0;border:1px solid color-mix(in srgb,var(--record) 32%,var(--line-strong));border-radius:4px;color:var(--record);background:color-mix(in srgb,var(--record) 10%,var(--daw-control));cursor:pointer}.routing-inspector section{display:grid;gap:9px;padding:13px;border-bottom:1px solid var(--line-soft)}.identity-section{grid-template-columns:1fr 42px}.routing-inspector label{display:grid;gap:5px;color:var(--text-muted);font:7px var(--font-utility);letter-spacing:.05em}.routing-inspector label>span{display:flex;justify-content:space-between}.routing-inspector label b{color:var(--text-secondary);font-weight:500}.routing-inspector input:not([type=range]),.routing-inspector select{min-width:0;height:29px;padding:0 7px;border:1px solid var(--line-strong);border-radius:4px;color:var(--text-primary);background:var(--daw-control);font-size:8px}.routing-inspector input[type=color]{width:100%;padding:3px}.routing-inspector input[type=range]{width:100%;accent-color:var(--accent)}.section-heading{display:flex;align-items:center;justify-content:space-between;color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.14em}.section-heading b{color:var(--text-faint);font-size:6px}.input-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.send-section{align-content:start}.send-card{display:grid;gap:8px;padding:9px;border:1px solid var(--line-soft);border-radius:5px;background:var(--surface-1)}.send-card-head{display:grid;grid-template-columns:auto 1fr auto;gap:5px}.send-card-head button,.send-mode button,.add-send button{display:flex;align-items:center;justify-content:center;gap:3px;height:25px;padding:0 6px;border:1px solid var(--line-strong);border-radius:3px;color:var(--text-muted);background:var(--daw-control);font:700 6px var(--font-utility);cursor:pointer}.send-card-head button.enabled{border-color:color-mix(in srgb,var(--signal-cyan) 55%,var(--line-strong));color:var(--signal-cyan);background:color-mix(in srgb,var(--signal-cyan) 10%,var(--daw-control))}.send-card-head select{height:25px}.send-mode{display:grid;grid-template-columns:1fr 1fr;gap:4px}.send-mode button.active{border-color:var(--accent-strong);color:var(--text-primary);background:var(--surface-active)}.add-send{display:grid;grid-template-columns:1fr auto;gap:5px}.add-send select{height:27px}.empty-copy{margin:8px 0;color:var(--text-faint);font-size:8px;line-height:1.5}.clear-clips{margin:13px;width:calc(100% - 26px);height:29px;border:1px solid var(--line-strong);border-radius:4px;color:var(--text-muted);background:var(--daw-control);font-size:8px;cursor:pointer}.routing-inspector button:focus-visible,.routing-inspector select:focus-visible,.routing-inspector input:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
</style>
