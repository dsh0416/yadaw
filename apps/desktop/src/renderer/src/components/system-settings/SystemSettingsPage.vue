<script setup lang="ts">
import { computed, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AudioLines, Cable, CircleDot, Gauge, Keyboard, Music2, Palette, Plug } from "@lucide/vue"
import type {
  AudioHostRuntimePreferences,
  AudioPreferences,
  AudioRuntimeSnapshot,
  MidiInputSnapshot,
  MidiSyncPreferences,
  ResolvedAudioHostRuntimePreferences
} from "@yadaw/contracts"
import SettingsContainer from "../settings/SettingsContainer.vue"
import type { SettingsCategory } from "../settings/settings"
import AudioDeviceSettings from "./AudioDeviceSettings.vue"
import AudioRuntimeSettings from "./AudioRuntimeSettings.vue"
import DisplaySettings from "./DisplaySettings.vue"
import MidiSettings from "./MidiSettings.vue"
import MixerDisplaySettings from "./MixerDisplaySettings.vue"
import MidiInputSettings from "./MidiInputSettings.vue"
import RecordingSettings from "./RecordingSettings.vue"
import ShortcutSettings from "./ShortcutSettings.vue"

type SystemSettingsPageId =
  | "engine"
  | "devices"
  | "recording"
  | "midi-general"
  | "midi-input"
  | "display-general"
  | "display-mixer"
  | "shortcuts"

const { t } = useI18n()

const props = defineProps<{
  modelValue: AudioPreferences
  runtime: AudioRuntimeSnapshot
  applyError: string
  applying: boolean
  audioHostRuntime: AudioHostRuntimePreferences
  resolvedAudioHostRuntime: ResolvedAudioHostRuntimePreferences | null
  audioHostRuntimeApplying: boolean
  audioHostRuntimeError: string
  midiPreferences: MidiSyncPreferences
  midiSnapshot: MidiInputSnapshot
  midiApplying: boolean
  midiError: string
  backLabel: string
}>()

const emit = defineEmits<{
  close: []
  applyAudio: [preferences: AudioPreferences]
  configureRuntime: [preferences: AudioHostRuntimePreferences]
  configureMidi: [preferences: MidiSyncPreferences]
}>()

const categories = computed<readonly SettingsCategory[]>(() => [
  {
    id: "system",
    label: t("settings.system.categories.system.label"),
    description: t("settings.system.categories.system.description"),
    icon: Gauge,
    pages: [
      {
        id: "engine",
        label: t("settings.system.pages.engine.label"),
        description: t("settings.system.pages.engine.description"),
        icon: Gauge
      }
    ]
  },
  {
    id: "audio",
    label: t("settings.system.categories.audio.label"),
    description: t("settings.system.categories.audio.description"),
    icon: AudioLines,
    pages: [
      {
        id: "devices",
        label: t("settings.system.pages.devices.label"),
        description: t("settings.system.pages.devices.description"),
        icon: Cable
      },
      {
        id: "recording",
        label: t("settings.system.pages.recording.label"),
        description: t("settings.system.pages.recording.description"),
        icon: CircleDot
      }
    ]
  },
  {
    id: "midi",
    label: t("settings.system.categories.midi.label"),
    description: t("settings.system.categories.midi.description"),
    icon: Music2,
    pages: [
      {
        id: "midi-general",
        label: t("settings.system.pages.midiGeneral.label"),
        description: t("settings.system.pages.midiGeneral.description"),
        icon: Music2
      },
      {
        id: "midi-input",
        label: "Input & sync",
        description: "Ports, timing and MIDI Clock",
        icon: Music2
      }
    ]
  },
  {
    id: "plugins",
    label: t("settings.system.categories.plugins.label"),
    description: t("settings.system.categories.plugins.description"),
    icon: Plug,
    badge: t("common.soon"),
    pages: []
  },
  {
    id: "display",
    label: t("settings.display.category"),
    description: t("settings.system.categories.display.description"),
    icon: Palette,
    pages: [
      {
        id: "display-general",
        label: t("settings.system.pages.displayGeneral.label"),
        description: t("settings.system.pages.displayGeneral.description"),
        icon: Palette
      },
      {
        id: "display-mixer",
        label: t("settings.system.pages.displayMixer.label"),
        description: t("settings.system.pages.displayMixer.description"),
        icon: Gauge
      }
    ]
  },
  {
    id: "keyboard",
    label: t("settings.system.categories.keyboard.label"),
    description: t("settings.system.categories.keyboard.description"),
    icon: Keyboard,
    pages: [
      {
        id: "shortcuts",
        label: t("settings.system.pages.shortcuts.label"),
        description: t("settings.system.pages.shortcuts.description"),
        icon: Keyboard
      }
    ]
  }
])

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
    :title="t('settings.system.title')"
    :scope-label="t('settings.system.scopeLabel')"
    :back-label="backLabel"
    :categories="categories"
    :active-page="activePage"
    @back="emit('close')"
    @update:active-page="selectPage"
  >
    <template #actions>
      <template v-if="activePage === 'devices'">
        <button class="settings-action" type="button" @click="emit('close')">
          {{ t("dialog.actions.cancel") }}
        </button>
        <button
          class="settings-action settings-action-primary"
          type="button"
          :disabled="applying || !audioCanApply"
          @click="applyAudio"
        >
          {{
            applying
              ? t("settings.system.actions.startingEngine")
              : t("settings.system.actions.applyAudio")
          }}
        </button>
      </template>
      <button
        v-else
        class="settings-action settings-action-primary"
        type="button"
        @click="emit('close')"
      >
        {{ t("common.done") }}
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
    <MidiSettings v-else-if="activePage === 'midi-general'" />
    <MidiInputSettings
      v-else-if="activePage === 'midi-input'"
      :preferences="midiPreferences"
      :snapshot="midiSnapshot"
      :applying="midiApplying"
      :error="midiError"
      @apply="emit('configureMidi', $event)"
    />
    <DisplaySettings v-else-if="activePage === 'display-general'" />
    <MixerDisplaySettings v-else-if="activePage === 'display-mixer'" />
    <ShortcutSettings v-else-if="activePage === 'shortcuts'" />
  </SettingsContainer>
</template>
