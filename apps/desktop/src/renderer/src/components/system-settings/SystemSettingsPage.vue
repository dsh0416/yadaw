<script setup lang="ts">
import { shallowRef, watch } from "vue"
import { AudioLines, Cable, CircleDot, Gauge, Keyboard, Music2, Palette, Plug } from "@lucide/vue"
import type {
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  ResolvedAudioHostRuntimePreferences
} from "@yadaw/contracts"
import SettingsContainer from "../settings/SettingsContainer.vue"
import type { SettingsCategory } from "../settings/settings"
import AudioDeviceSettings from "./AudioDeviceSettings.vue"
import AudioRuntimeSettings from "./AudioRuntimeSettings.vue"
import DisplaySettings from "./DisplaySettings.vue"
import MixerDisplaySettings from "./MixerDisplaySettings.vue"
import RecordingSettings from "./RecordingSettings.vue"

type SystemSettingsPageId = "engine" | "devices" | "recording" | "display-general" | "display-mixer"

const props = defineProps<{
  modelValue: AudioPreferences
  runtime: AudioRuntimeSnapshot
  applyError: string
  applying: boolean
  audioHostRuntime: AudioHostRuntimePreferences
  resolvedAudioHostRuntime: ResolvedAudioHostRuntimePreferences | null
  audioHostRuntimeApplying: boolean
  audioHostRuntimeError: string
  backLabel: string
}>()

const emit = defineEmits<{
  close: []
  applyAudio: [preferences: AudioPreferences]
  configureRuntime: [preferences: AudioHostRuntimePreferences]
}>()

const categories: readonly SettingsCategory[] = [
  {
    id: "system",
    label: "System",
    description: "Runtime",
    icon: Gauge,
    pages: [
      {
        id: "engine",
        label: "Engine",
        description: "Async workers and IPC egress",
        icon: Gauge
      }
    ]
  },
  {
    id: "audio",
    label: "Audio",
    description: "Signal path",
    icon: AudioLines,
    pages: [
      {
        id: "devices",
        label: "Devices",
        description: "Host, hardware I/O and latency",
        icon: Cable
      },
      {
        id: "recording",
        label: "Recording",
        description: "Swap, format and recovery",
        icon: CircleDot
      }
    ]
  },
  {
    id: "midi",
    label: "MIDI",
    description: "Controllers",
    icon: Music2,
    badge: "Soon",
    pages: []
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Discovery",
    icon: Plug,
    badge: "Soon",
    pages: []
  },
  {
    id: "display",
    label: "Display",
    description: "Workspace",
    icon: Palette,
    pages: [
      {
        id: "display-general",
        label: "General",
        description: "Light, dark and system",
        icon: Palette
      },
      {
        id: "display-mixer",
        label: "Mixer",
        description: "Meter hold and return",
        icon: Gauge
      }
    ]
  },
  {
    id: "keyboard",
    label: "Keyboard",
    description: "Shortcuts",
    icon: Keyboard,
    badge: "Soon",
    pages: []
  }
]

const activePage = shallowRef<SystemSettingsPageId>("devices")
const audioDraft = shallowRef<AudioPreferences>({ ...props.modelValue })
const audioCanApply = shallowRef(false)

watch(
  () => props.modelValue,
  (value) => {
    audioDraft.value = { ...value }
  }
)

function selectPage(page: string): void {
  activePage.value = page as SystemSettingsPageId
}

function applyAudio(): void {
  emit("applyAudio", { ...audioDraft.value })
}
</script>

<template>
  <SettingsContainer
    title="System settings"
    scope-label="Yadaw / System"
    :back-label="backLabel"
    :categories="categories"
    :active-page="activePage"
    @back="emit('close')"
    @update:active-page="selectPage"
  >
    <template #actions>
      <template v-if="activePage === 'devices'">
        <button class="settings-action" type="button" @click="emit('close')">Cancel</button>
        <button
          class="settings-action settings-action-primary"
          type="button"
          :disabled="applying || !audioCanApply"
          @click="applyAudio"
        >
          {{ applying ? "Starting engine…" : "Apply audio" }}
        </button>
      </template>
      <button
        v-else
        class="settings-action settings-action-primary"
        type="button"
        @click="emit('close')"
      >
        Done
      </button>
    </template>

    <AudioDeviceSettings
      v-if="activePage === 'devices'"
      v-model="audioDraft"
      :runtime="runtime"
      :apply-error="applyError"
      @validity-change="audioCanApply = $event"
    />
    <AudioRuntimeSettings
      v-else-if="activePage === 'engine'"
      :model-value="audioHostRuntime"
      :resolved="resolvedAudioHostRuntime"
      :applying="audioHostRuntimeApplying"
      :error="audioHostRuntimeError"
      @apply="emit('configureRuntime', $event)"
    />
    <RecordingSettings v-else-if="activePage === 'recording'" />
    <DisplaySettings v-else-if="activePage === 'display-general'" />
    <MixerDisplaySettings v-else />
  </SettingsContainer>
</template>
