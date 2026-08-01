<script setup lang="ts">
import { useEventListener } from "@vueuse/core"
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import {
  APPLICATION_COMMAND_IDS,
  formatKeyboardShortcut,
  resolveKeyboardShortcuts
} from "@yadaw/contracts"
import type {
  ApplicationCommandId,
  KeyboardShortcutBinding,
  MidiControlEvent,
  ShortcutModifier,
  ShortcutPreferences
} from "@yadaw/contracts"
import SettingsPage from "../settings/SettingsPage.vue"
import SettingsSection from "../settings/SettingsSection.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"
import { useApplicationWindowStore } from "../../stores/applicationWindow"
import { useMidiInputStore } from "../../stores/midiInput"

const { t } = useI18n()
const settingsStore = useApplicationSettingsStore()
const windowStore = useApplicationWindowStore()
const midiInputStore = useMidiInputStore()
const { settings, error } = storeToRefs(settingsStore)
const capturingKeyboard = shallowRef<ApplicationCommandId | null>(null)
const learningMidi = shallowRef<ApplicationCommandId | null>(null)
let unsubscribeControls: (() => void) | null = null

const resolvedKeyboard = computed(() =>
  resolveKeyboardShortcuts(
    windowStore.platform,
    settings.value?.shortcuts ?? { keyboard: {}, midi: {} }
  )
)

const commandGroups = computed(() => [
  {
    label: t("settings.shortcuts.groups.project"),
    commands: APPLICATION_COMMAND_IDS.filter((command) => command.startsWith("project."))
  },
  {
    label: t("settings.shortcuts.groups.edit"),
    commands: APPLICATION_COMMAND_IDS.filter((command) => command.startsWith("edit."))
  },
  {
    label: t("settings.shortcuts.groups.transport"),
    commands: APPLICATION_COMMAND_IDS.filter(
      (command) => command.startsWith("transport.") || command.startsWith("recording.")
    )
  },
  {
    label: t("settings.shortcuts.groups.application"),
    commands: APPLICATION_COMMAND_IDS.filter(
      (command) =>
        command.startsWith("application.") ||
        command.startsWith("window.") ||
        command.startsWith("view.") ||
        command.startsWith("help.")
    )
  }
])

function currentPreferences(): ShortcutPreferences {
  return structuredClone(settings.value?.shortcuts ?? { keyboard: {}, midi: {} })
}

function sameKeyboardBinding(
  left: KeyboardShortcutBinding,
  right: KeyboardShortcutBinding
): boolean {
  return (
    left.code === right.code &&
    left.modifiers.length === right.modifiers.length &&
    left.modifiers.every((modifier) => right.modifiers.includes(modifier))
  )
}

async function assignKeyboard(
  command: ApplicationCommandId,
  binding: KeyboardShortcutBinding | null
): Promise<void> {
  const next = currentPreferences()
  if (binding) {
    for (const candidate of APPLICATION_COMMAND_IDS) {
      const candidateBinding = resolvedKeyboard.value[candidate]
      if (
        candidate !== command &&
        candidateBinding &&
        sameKeyboardBinding(candidateBinding, binding)
      ) {
        next.keyboard[candidate] = null
      }
    }
  }
  next.keyboard[command] = binding
  await settingsStore.configureShortcuts(next)
}

function keyboardModifiers(event: KeyboardEvent): ShortcutModifier[] {
  const modifiers: ShortcutModifier[] = []
  const primary = windowStore.platform === "darwin" ? event.metaKey : event.ctrlKey
  const control = windowStore.platform === "darwin" ? event.ctrlKey : event.metaKey
  if (primary) modifiers.push("primary")
  if (control) modifiers.push("control")
  if (event.altKey) modifiers.push("alt")
  if (event.shiftKey) modifiers.push("shift")
  return modifiers
}

function captureKeyboard(event: KeyboardEvent): void {
  const command = capturingKeyboard.value
  if (!command) return
  event.preventDefault()
  event.stopPropagation()
  if (event.code === "Escape") {
    capturingKeyboard.value = null
    return
  }
  if (
    (event.code === "Backspace" || event.code === "Delete") &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey
  ) {
    capturingKeyboard.value = null
    void assignKeyboard(command, null)
    return
  }
  if (
    [
      "ControlLeft",
      "ControlRight",
      "AltLeft",
      "AltRight",
      "ShiftLeft",
      "ShiftRight",
      "MetaLeft",
      "MetaRight"
    ].includes(event.code)
  ) {
    return
  }
  capturingKeyboard.value = null
  void assignKeyboard(command, {
    code: event.code,
    modifiers: keyboardModifiers(event)
  })
}

async function startMidiLearn(command: ApplicationCommandId): Promise<void> {
  if (await midiInputStore.beginLearning()) learningMidi.value = command
}

async function handleMidiControl(event: MidiControlEvent): Promise<void> {
  const command = learningMidi.value
  if (!command) return
  const next = currentPreferences()
  for (const candidate of APPLICATION_COMMAND_IDS) {
    const binding = next.midi[candidate]
    if (
      candidate !== command &&
      binding?.portId === event.portId &&
      binding.channel === event.channel &&
      binding.type === event.type &&
      binding.number === event.number
    ) {
      delete next.midi[candidate]
    }
  }
  next.midi[command] = {
    portId: event.portId,
    portName: event.portName,
    channel: event.channel,
    type: event.type,
    number: event.number
  }
  learningMidi.value = null
  try {
    await settingsStore.configureShortcuts(next)
  } finally {
    await midiInputStore.endLearning()
  }
}

function clearMidi(command: ApplicationCommandId): void {
  const next = currentPreferences()
  delete next.midi[command]
  void settingsStore.configureShortcuts(next)
}

function resetAll(): void {
  capturingKeyboard.value = null
  learningMidi.value = null
  void midiInputStore.endLearning()
  void settingsStore.configureShortcuts({ keyboard: {}, midi: {} })
}

function midiLabel(command: ApplicationCommandId): string {
  const binding = settings.value?.shortcuts.midi[command]
  if (!binding) return t("settings.shortcuts.midiLearn")
  const message =
    binding.type === "note"
      ? t("settings.shortcuts.note", { number: binding.number })
      : t("settings.shortcuts.controlChange", { number: binding.number })
  return `${binding.portName} · ${t("settings.shortcuts.channel", {
    channel: binding.channel + 1
  })} · ${message}`
}

useEventListener(window, "keydown", captureKeyboard, { capture: true })

onMounted(() => {
  unsubscribeControls = midiInputStore.subscribeControls((event) => {
    void handleMidiControl(event)
  })
  if (!settings.value) void settingsStore.load()
  void midiInputStore.load()
})

onBeforeUnmount(() => {
  unsubscribeControls?.()
  void midiInputStore.endLearning()
})
</script>

<template>
  <SettingsPage
    :category="t('settings.shortcuts.category')"
    :page="t('settings.shortcuts.page')"
    :title="t('settings.shortcuts.title')"
    :description="t('settings.shortcuts.description')"
  >
    <div class="shortcut-toolbar">
      <p>{{ t("settings.shortcuts.instructions") }}</p>
      <button type="button" @click="resetAll">{{ t("settings.shortcuts.resetAll") }}</button>
    </div>

    <SettingsSection
      v-for="group in commandGroups"
      :key="group.label"
      :title="group.label"
      :description="t('settings.shortcuts.groupDescription')"
    >
      <div class="shortcut-list">
        <div v-for="command in group.commands" :key="command" class="shortcut-row">
          <div class="shortcut-command">
            <strong>{{ t(`settings.shortcuts.commands.${command}`) }}</strong>
            <small>{{ command }}</small>
          </div>
          <button
            class="binding-button"
            type="button"
            :class="{ capturing: capturingKeyboard === command }"
            @click="capturingKeyboard = command"
          >
            {{
              capturingKeyboard === command
                ? t("settings.shortcuts.pressKeys")
                : resolvedKeyboard[command]
                  ? formatKeyboardShortcut(resolvedKeyboard[command]!, windowStore.platform)
                  : t("settings.shortcuts.unassigned")
            }}
          </button>
          <div class="midi-binding">
            <button
              class="binding-button"
              type="button"
              :class="{ capturing: learningMidi === command }"
              @click="startMidiLearn(command)"
            >
              {{
                learningMidi === command
                  ? t("settings.shortcuts.moveMidiControl")
                  : midiLabel(command)
              }}
            </button>
            <button
              v-if="settings?.shortcuts.midi[command]"
              class="clear-button"
              type="button"
              :aria-label="t('settings.shortcuts.clearMidi')"
              @click="clearMidi(command)"
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>

    <p v-if="error" class="shortcut-error" role="alert">{{ error }}</p>
  </SettingsPage>
</template>

<style scoped>
.shortcut-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--text-secondary);
  font-size: var(--ui-type-size-body-compact);
}

.shortcut-toolbar p {
  margin: 0;
}

.shortcut-toolbar button,
.binding-button,
.clear-button {
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  color: var(--text-secondary);
  background: var(--surface-1);
  cursor: pointer;
}

.shortcut-toolbar button {
  padding: 7px 10px;
}

.shortcut-list {
  display: grid;
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--line-soft);
}

.shortcut-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(120px, 0.65fr) minmax(220px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  background: var(--surface-1);
}

.shortcut-command strong,
.shortcut-command small {
  display: block;
}

.shortcut-command strong {
  font-size: var(--ui-type-size-body-compact);
}

.shortcut-command small {
  margin-top: 2px;
  color: var(--text-faint);
  font-size: var(--ui-type-size-caption);
}

.binding-button {
  min-height: 32px;
  padding: 6px 9px;
  text-align: left;
}

.binding-button:hover,
.shortcut-toolbar button:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
}

.binding-button.capturing {
  border-color: var(--accent);
  color: var(--text-primary);
  box-shadow: var(--ui-focus-ring);
}

.midi-binding {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px;
}

.clear-button {
  width: 32px;
  font-size: var(--ui-type-size-panel-title);
}

.shortcut-error {
  color: var(--record);
  font-size: var(--ui-type-size-body-compact);
}

@media (max-width: 1050px) {
  .shortcut-row {
    grid-template-columns: minmax(150px, 1fr) minmax(110px, 0.7fr);
  }

  .midi-binding {
    grid-column: 1 / -1;
  }
}
</style>
