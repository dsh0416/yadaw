import { useEventListener } from "@vueuse/core"
import { computed, onMounted, onUnmounted } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import {
  APPLICATION_COMMAND_IDS,
  formatKeyboardShortcut,
  keyboardBindingMatches,
  resolveKeyboardShortcuts
} from "@heron/contracts"
import type {
  ApplicationCommandId,
  CreateProjectRequest,
  KeyboardShortcutBinding,
  MidiControlEvent
} from "@heron/contracts"
import type { UiMenubarMenu } from "@heron/ui"
import { useAudioBenchmarkStore } from "../stores/audioBenchmark"
import { useAboutStore } from "../stores/about"
import { useCompiledEffectGraphStore } from "../stores/compiledEffectGraph"
import { useApplicationWindowStore } from "../stores/applicationWindow"
import { useMixerStore } from "../stores/mixer"
import { useProjectStore } from "../stores/project"
import { useStudioWorkflowStore } from "../stores/studioWorkflow"
import { usePianoRollStore } from "../stores/pianoRoll"
import { useApplicationSettingsStore } from "../stores/applicationSettings"
import { useMidiInputStore } from "../stores/midiInput"
import { useMediaBrowserStore } from "../stores/mediaBrowser"
import { useRecordingStore } from "../stores/recording"
import { useStudioWorkspaceStore } from "../stores/studioWorkspace"
import { useTransportStore } from "../stores/transport"
import { planAudioClipSplit, planMidiClipSplits } from "../utils/clipEditing"
import { secondsToTick } from "../utils/tempoMap"
import { defaultCycleRange } from "../utils/cycleRange"

function defaultProject(name: string): CreateProjectRequest {
  return {
    name,
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

export function useApplicationCommands() {
  const { t } = useI18n()
  const router = useRouter()
  const projectStore = useProjectStore()
  const mixerStore = useMixerStore()
  const studioWorkflowStore = useStudioWorkflowStore()
  const pianoRollStore = usePianoRollStore()
  const benchmarkStore = useAudioBenchmarkStore()
  const aboutStore = useAboutStore()
  const compiledEffectGraphStore = useCompiledEffectGraphStore()
  const applicationWindowStore = useApplicationWindowStore()
  const applicationSettingsStore = useApplicationSettingsStore()
  const midiInputStore = useMidiInputStore()
  const mediaBrowserStore = useMediaBrowserStore()
  const recordingStore = useRecordingStore()
  const workspaceStore = useStudioWorkspaceStore()
  const transportStore = useTransportStore()
  const { lifecycle, session, busy: projectBusy } = storeToRefs(projectStore)
  const { canUndo, canRedo } = storeToRefs(mixerStore)
  const { active: activeRecording, busy: recordingBusy } = storeToRefs(recordingStore)
  let unsubscribe: (() => void) | null = null
  let unsubscribeMidi: (() => void) | null = null
  const activeMidiControls = new Set<string>()

  const projectReady = computed(() => lifecycle.value.status === "open")
  const keyboardShortcuts = computed(() =>
    resolveKeyboardShortcuts(
      applicationWindowStore.platform,
      applicationSettingsStore.settings?.shortcuts ?? { keyboard: {}, midi: {} }
    )
  )
  const shortcutLabel = (command: ApplicationCommandId): string | undefined => {
    const binding = keyboardShortcuts.value[command]
    return binding ? formatKeyboardShortcut(binding, applicationWindowStore.platform) : undefined
  }
  const menus = computed<UiMenubarMenu[]>(() => [
    {
      value: "file",
      label: t("menu.file"),
      items: [
        {
          value: "project.new",
          label: t("menu.newProject"),
          shortcut: shortcutLabel("project.new")
        },
        {
          value: "project.open",
          label: t("menu.openProject"),
          shortcut: shortcutLabel("project.open")
        },
        {
          value: "project.save",
          label: t("menu.saveProject"),
          shortcut: shortcutLabel("project.save"),
          separatorBefore: true,
          disabled: !projectReady.value
        },
        {
          value: "project.close",
          label: t("menu.closeProject"),
          shortcut: shortcutLabel("project.close"),
          disabled: !projectReady.value
        },
        {
          value: "project.settings",
          label: t("menu.projectSettings"),
          shortcut: shortcutLabel("project.settings"),
          separatorBefore: true,
          disabled: !projectReady.value
        }
      ]
    },
    {
      value: "edit",
      label: t("menu.edit"),
      items: [
        {
          value: "edit.undo",
          label: t("menu.undo"),
          shortcut: shortcutLabel("edit.undo"),
          disabled: !projectReady.value || !canUndo.value
        },
        {
          value: "edit.redo",
          label: t("menu.redo"),
          shortcut: shortcutLabel("edit.redo"),
          disabled: !projectReady.value || !canRedo.value
        },
        {
          value: "edit.cut",
          label: t("menu.cut"),
          shortcut: shortcutLabel("edit.cut"),
          separatorBefore: true
        },
        { value: "edit.copy", label: t("menu.copy"), shortcut: shortcutLabel("edit.copy") },
        { value: "edit.paste", label: t("menu.paste"), shortcut: shortcutLabel("edit.paste") },
        {
          value: "edit.select-all",
          label: t("menu.selectAll"),
          shortcut: shortcutLabel("edit.select-all")
        },
        {
          value: "edit.split-at-playhead",
          label: t("menu.splitAtPlayhead"),
          shortcut: shortcutLabel("edit.split-at-playhead"),
          separatorBefore: true,
          disabled: !projectReady.value
        },
        {
          value: "application.preferences",
          label: t("menu.preferences"),
          shortcut: shortcutLabel("application.preferences"),
          separatorBefore: true
        }
      ]
    },
    {
      value: "view",
      label: t("menu.view"),
      items: [
        {
          value: "view.toggle-full-screen",
          label: t("menu.toggleFullScreen"),
          shortcut: shortcutLabel("view.toggle-full-screen")
        }
      ]
    },
    {
      value: "help",
      label: t("menu.help"),
      items: [
        {
          value: "help.audio-benchmark",
          label: t("menu.audioBenchmark")
        },
        {
          value: "help.effect-chain-graph",
          label: t("menu.effectChainGraph")
        },
        {
          value: "application.about",
          label: t("app.about"),
          separatorBefore: true
        }
      ]
    }
  ])

  async function leaveCurrentProject(): Promise<boolean> {
    if (!session.value) return true
    const closed = await studioWorkflowStore.closeProject()
    if (closed) await router.push({ name: "welcome" })
    return closed
  }

  async function createProject(): Promise<void> {
    if (projectBusy.value || !(await leaveCurrentProject())) return
    const workspace = await projectStore.create(
      structuredClone(defaultProject(t("welcome.untitledProject")))
    )
    if (!workspace) return
    mixerStore.hydrate(workspace.graph)
    await router.push({ name: "studio" })
  }

  async function openProject(): Promise<void> {
    if (projectBusy.value || !(await leaveCurrentProject())) return
    const workspace = await projectStore.open()
    if (!workspace) return
    mixerStore.hydrate(workspace.graph)
    await router.push({ name: "studio" })
  }

  async function closeProject(): Promise<void> {
    if (!projectReady.value || !(await studioWorkflowStore.closeProject())) return
    await router.push({ name: "welcome" })
  }

  async function closeApplication(command: "application.quit" | "window.close"): Promise<void> {
    if (session.value && !(await studioWorkflowStore.closeProject())) return
    await applicationWindowStore.execute(command)
  }

  async function toggleRecording(): Promise<void> {
    if (recordingBusy.value || router.currentRoute.value.name !== "studio") return
    const completed = await studioWorkflowStore.toggleRecording()
    if (completed) transportStore.selectAndRevealClip(completed.id)
  }

  async function execute(command: ApplicationCommandId): Promise<void> {
    switch (command) {
      case "project.new":
        await createProject()
        break
      case "project.open":
        await openProject()
        break
      case "project.save":
        if (projectReady.value) await studioWorkflowStore.saveProject()
        break
      case "project.close":
        await closeProject()
        break
      case "project.settings":
        if (projectReady.value) await router.push({ name: "project-settings" })
        break
      case "edit.undo":
        if (isEditableTarget(document.activeElement)) {
          await applicationWindowStore.execute(command)
        } else if (projectReady.value) {
          await mixerStore.undo()
        }
        break
      case "edit.redo":
        if (isEditableTarget(document.activeElement)) {
          await applicationWindowStore.execute(command)
        } else if (projectReady.value) {
          await mixerStore.redo()
        }
        break
      case "edit.cut":
      case "edit.copy":
      case "edit.paste":
      case "edit.select-all": {
        const handled = pianoRollStore.executeEditCommand(
          command.slice("edit.".length) as "cut" | "copy" | "paste" | "select-all"
        )
        if (!handled) await applicationWindowStore.execute(command)
        break
      }
      case "edit.split-at-playhead": {
        if (!projectReady.value || router.currentRoute.value.name !== "studio") break
        const playheadFrame = Math.round(
          transportStore.playheadSeconds * mixerStore.graph.sampleRate
        )
        const audioClip = mixerStore.graph.audioClips.find(
          (clip) => clip.id === transportStore.selectedClipId
        )
        const split = audioClip
          ? planAudioClipSplit(audioClip, playheadFrame)
          : planMidiClipSplits(
              mixerStore.graph.midiClips.filter((clip) =>
                pianoRollStore.arrangementClipIds.includes(clip.id)
              ),
              Math.round(secondsToTick(mixerStore.graph.tempoMap, transportStore.playheadSeconds))
            )
        if (split) await mixerStore.execute(split)
        break
      }
      case "application.preferences":
        await router.push({ name: "system-settings" })
        break
      case "application.quit":
      case "window.close":
        await closeApplication(command)
        break
      case "view.toggle-full-screen":
        await applicationWindowStore.execute(command)
        break
      case "application.about":
        aboutStore.open()
        break
      case "view.toggle-mixer-dock":
        if (router.currentRoute.value.name === "studio") workspaceStore.toggleMixerDock()
        break
      case "transport.toggle-playback":
        if (isEditableTarget(document.activeElement)) break
        if (
          router.currentRoute.value.name === "studio" &&
          workspaceStore.mediaBrowserOpen &&
          (await mediaBrowserStore.toggleSelectedAudition())
        ) {
          break
        }
        if (router.currentRoute.value.name === "studio" && !activeRecording.value) {
          await transportStore.toggle()
        }
        break
      case "transport.toggle-loop":
        if (
          router.currentRoute.value.name === "studio" &&
          transportStore.snapshot.clockSource !== "external"
        ) {
          const range =
            transportStore.loopRange ??
            defaultCycleRange(
              mixerStore.graph.tempoMap,
              secondsToTick(mixerStore.graph.tempoMap, transportStore.playheadSeconds)
            )
          await transportStore.setLoop(
            !transportStore.loopEnabled || transportStore.loopRange === null,
            range
          )
        }
        break
      case "transport.go-to-start":
        if (router.currentRoute.value.name === "studio") await transportStore.goToStart()
        break
      case "recording.toggle":
        await toggleRecording()
        break
      case "help.audio-benchmark":
        benchmarkStore.open()
        break
      case "help.effect-chain-graph":
        compiledEffectGraphStore.open()
        break
    }
  }

  function handleShortcut(event: KeyboardEvent): void {
    if (event.repeat) return
    const match = APPLICATION_COMMAND_IDS.map((command) => ({
      command,
      binding: keyboardShortcuts.value[command]
    })).find(
      (
        entry
      ): entry is {
        command: ApplicationCommandId
        binding: KeyboardShortcutBinding
      } =>
        Boolean(
          entry.binding &&
          keyboardBindingMatches(entry.binding, event, applicationWindowStore.platform)
        )
    )
    if (!match) return
    if (
      isEditableTarget(event.target) &&
      !match.binding.modifiers.some((modifier) => ["primary", "control", "alt"].includes(modifier))
    ) {
      return
    }
    event.preventDefault()
    void execute(match.command)
  }

  function handleMidiControl(event: MidiControlEvent): void {
    if (midiInputStore.learning) return
    const midi = applicationSettingsStore.settings?.shortcuts.midi ?? {}
    const command = APPLICATION_COMMAND_IDS.find((candidate) => {
      const binding = midi[candidate]
      return (
        binding?.portId === event.portId &&
        binding.channel === event.channel &&
        binding.type === event.type &&
        binding.number === event.number
      )
    })
    if (!command) return
    const key = `${event.portId}:${event.channel}:${event.type}:${event.number}`
    if (event.type === "control-change") {
      if (event.value < 64) {
        activeMidiControls.delete(key)
        return
      }
      if (activeMidiControls.has(key)) return
      activeMidiControls.add(key)
    }
    void execute(command)
  }

  useEventListener(window, "keydown", handleShortcut)

  onMounted(() => {
    unsubscribe = applicationWindowStore.subscribeCommands((command) => {
      void execute(command)
    })
    unsubscribeMidi = midiInputStore.subscribeControls(handleMidiControl)
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
    unsubscribeMidi?.()
    unsubscribeMidi = null
  })

  return {
    platform: applicationWindowStore.platform,
    menus,
    execute
  }
}
