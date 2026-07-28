import { computed, onMounted, onUnmounted } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type { ApplicationCommandId, CreateProjectRequest } from "@yadaw/contracts"
import type { UiMenubarMenu } from "@yadaw/ui"
import { useAudioBenchmarkStore } from "../stores/audioBenchmark"
import { useCompiledEffectGraphStore } from "../stores/compiledEffectGraph"
import { useApplicationWindowStore } from "../stores/applicationWindow"
import { useMixerStore } from "../stores/mixer"
import { useProjectStore } from "../stores/project"
import { useStudioWorkflowStore } from "../stores/studioWorkflow"

const DEFAULT_PROJECT: CreateProjectRequest = {
  name: "Untitled project",
  sampleRate: 48_000,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
  waveformDisplayMode: "separate"
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

export function useApplicationCommands() {
  const router = useRouter()
  const projectStore = useProjectStore()
  const mixerStore = useMixerStore()
  const studioWorkflowStore = useStudioWorkflowStore()
  const benchmarkStore = useAudioBenchmarkStore()
  const compiledEffectGraphStore = useCompiledEffectGraphStore()
  const applicationWindowStore = useApplicationWindowStore()
  const { lifecycle, session, busy: projectBusy } = storeToRefs(projectStore)
  const { canUndo, canRedo } = storeToRefs(mixerStore)
  let unsubscribe: (() => void) | null = null

  const projectReady = computed(() => lifecycle.value.status === "open")
  const menus = computed<UiMenubarMenu[]>(() => [
    {
      value: "file",
      label: "File",
      items: [
        { value: "project.new", label: "New Project", shortcut: "Ctrl+N" },
        { value: "project.open", label: "Open Project…", shortcut: "Ctrl+O" },
        {
          value: "project.save",
          label: "Save Project",
          shortcut: "Ctrl+S",
          separatorBefore: true,
          disabled: !projectReady.value
        },
        {
          value: "project.close",
          label: "Close Project",
          shortcut: "Ctrl+W",
          disabled: !projectReady.value
        },
        {
          value: "project.settings",
          label: "Project Settings…",
          shortcut: "Ctrl+Shift+,",
          separatorBefore: true,
          disabled: !projectReady.value
        }
      ]
    },
    {
      value: "edit",
      label: "Edit",
      items: [
        {
          value: "edit.undo",
          label: "Undo",
          shortcut: "Ctrl+Z",
          disabled: !projectReady.value || !canUndo.value
        },
        {
          value: "edit.redo",
          label: "Redo",
          shortcut: "Ctrl+Shift+Z",
          disabled: !projectReady.value || !canRedo.value
        },
        {
          value: "edit.cut",
          label: "Cut",
          shortcut: "Ctrl+X",
          separatorBefore: true
        },
        { value: "edit.copy", label: "Copy", shortcut: "Ctrl+C" },
        { value: "edit.paste", label: "Paste", shortcut: "Ctrl+V" },
        { value: "edit.select-all", label: "Select All", shortcut: "Ctrl+A" },
        {
          value: "application.preferences",
          label: "Preferences…",
          shortcut: "Ctrl+,",
          separatorBefore: true
        }
      ]
    },
    {
      value: "view",
      label: "View",
      items: [
        {
          value: "view.toggle-full-screen",
          label: "Toggle Full Screen",
          shortcut: "F11"
        }
      ]
    },
    {
      value: "help",
      label: "Help",
      items: [
        {
          value: "help.audio-benchmark",
          label: "Audio Performance Benchmark…"
        },
        {
          value: "help.effect-chain-graph",
          label: "Effect Chain Graph…"
        },
        {
          value: "application.about",
          label: "About YADAW",
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
    const workspace = await projectStore.create(structuredClone(DEFAULT_PROJECT))
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
    if (projectBusy.value) return
    if (session.value && !(await studioWorkflowStore.closeProject())) return
    await applicationWindowStore.execute(command)
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
      case "edit.select-all":
        await applicationWindowStore.execute(command)
        break
      case "application.preferences":
        await router.push({ name: "system-settings" })
        break
      case "application.quit":
      case "window.close":
        await closeApplication(command)
        break
      case "view.toggle-full-screen":
      case "application.about":
        await applicationWindowStore.execute(command)
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
    if (applicationWindowStore.platform === "darwin" || event.repeat) return
    if (event.code === "F11") {
      event.preventDefault()
      void execute("view.toggle-full-screen")
      return
    }
    if (!event.ctrlKey || event.altKey || event.metaKey) return

    let command: ApplicationCommandId | null = null
    if (event.code === "KeyN") command = "project.new"
    else if (event.code === "KeyO") command = "project.open"
    else if (event.code === "KeyS") command = "project.save"
    else if (event.code === "KeyW") command = "project.close"
    else if (event.code === "Comma")
      command = event.shiftKey ? "project.settings" : "application.preferences"
    else if (
      !isEditableTarget(event.target) &&
      (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey))
    )
      command = "edit.redo"
    else if (!isEditableTarget(event.target) && event.code === "KeyZ") command = "edit.undo"

    if (!command) return
    event.preventDefault()
    void execute(command)
  }

  onMounted(() => {
    unsubscribe = applicationWindowStore.subscribeCommands((command) => {
      void execute(command)
    })
    window.addEventListener("keydown", handleShortcut)
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
    window.removeEventListener("keydown", handleShortcut)
  })

  return {
    platform: applicationWindowStore.platform,
    menus,
    execute
  }
}
