import { dialog, ipcMain } from "electron"
import { basename } from "node:path"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ProjectCloseDisposition } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { t } from "../i18n"
import {
  assertTrustedSender,
  normalizeAudioRuntime,
  validateCreateProject,
  validateProjectConfiguration
} from "./support"
export function registerProjectHandlers(context: IpcHandlerContext): void {
  const {
    projects,
    recordings,
    operations,
    waveforms,
    projectGraph,
    transport,
    lifecycle,
    audioHost: audioHostService,
    synchronizePluginStates
  } = context
  ipcMain.handle(IPC_CHANNELS.projectCreate, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.beginProject("creating")
    try {
      const request = validateCreateProject(value)
      let path = request.path
      path ??= process.env.YADAW_TEST_PROJECT_PATH
      if (!path) {
        const result = await dialog.showSaveDialog({
          title: t("dialog.createProject.title"),
          defaultPath: `${request.name}.yadaw`,
          filters: [{ name: t("dialog.createProject.filter"), extensions: ["yadaw"] }]
        })
        if (result.canceled || !result.filePath) {
          lifecycle.cancelProject()
          throw new Error("Project creation cancelled")
        }
        path = result.filePath
      }
      const created = await projects.create({ ...request, path })
      const graph = await projectGraph.load()
      const assets = await projects.listAssets()
      lifecycle.completeProject(created)
      return { session: created, graph, assets }
    } catch (error) {
      try {
        await projects.abortOpen()
      } catch {
        // Preserve the original create failure; shutdown will terminate a stuck worker.
      }
      await projectGraph.clearProject()
      if (lifecycle.snapshot().project.status === "creating") lifecycle.failProject(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectPrepareOpen, async (event, value: unknown) => {
    assertTrustedSender(event)
    let path = typeof value === "string" && value.trim() ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: t("dialog.openProject.title"),
        properties: ["openFile"],
        filters: [{ name: t("dialog.openProject.filter"), extensions: ["yadaw"] }]
      })
      path = result.filePaths[0]
      if (result.canceled || !path) return null
    }
    return {
      path,
      recoverableWorkingCopy: await projects.hasRecoverableWorkingCopy(path)
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectOpen, async (event, value: unknown, recoverValue: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("Project path must be a non-empty string")
    }
    if (recoverValue !== undefined && typeof recoverValue !== "boolean") {
      throw new TypeError("Project recovery choice must be a boolean")
    }
    const path = value
    const recover = recoverValue === true
    lifecycle.beginProject("opening")
    try {
      const operationId = "open-project"
      const projectName = basename(path).replace(/\.yadaw$/i, "")
      operations.upsert(
        {
          id: operationId,
          title: t("operation.openingProject"),
          description: projectName,
          phase: recover ? "loading-project-database" : "loading-project-archive",
          state: "running",
          completedUnits: 0,
          totalUnits: 5,
          cancellable: false,
          message: null,
          dropoutFrames: 0
        },
        true
      )
      const opened = await projects.open(path, recover, ({ phase, completedUnits }) => {
        operations.patch(operationId, { phase, completedUnits }, true)
      })
      operations.patch(
        operationId,
        {
          phase: "loading-mixer",
          completedUnits: 2
        },
        true
      )
      const graph = await projectGraph.load()
      operations.patch(
        operationId,
        {
          phase: "loading-project-assets",
          completedUnits: 3
        },
        true
      )
      const assets = await projects.listAssets()
      operations.patch(
        operationId,
        {
          phase: "preparing-waveforms",
          completedUnits: 4
        },
        true
      )
      await waveforms.prepareMissing()
      operations.patch(
        operationId,
        {
          state: "completed",
          completedUnits: 5
        },
        true
      )
      lifecycle.completeProject(opened)
      operations.remove(operationId)
      return { session: opened, graph, assets }
    } catch (error) {
      try {
        await projects.abortOpen()
      } catch {
        // Preserve the original open failure; shutdown will terminate a stuck worker.
      }
      await projectGraph.clearProject()
      lifecycle.failProject(error)
      const activeOperation = lifecycle.snapshot().project.status === "closed"
      if (activeOperation) {
        try {
          operations.patch(
            "open-project",
            {
              state: "failed",
              message: error instanceof Error ? error.message : String(error)
            },
            true
          )
        } catch {
          // The file chooser or recovery prompt may have failed before the operation existed.
        }
      }
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectSave, async (event, value: unknown) => {
    assertTrustedSender(event)
    const current = projects.current
    if (!current) return null
    lifecycle.beginProject("saving")
    const operationId = `save:${current.id}`
    operations.upsert(
      {
        id: operationId,
        title: t("operation.savingProject"),
        description: current.configuration.name,
        phase: "saving-archive",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        message: null,
        dropoutFrames: 0
      },
      true
    )
    try {
      await synchronizePluginStates()
      const saved = await projects.save(typeof value === "string" ? value : undefined)
      operations.patch(operationId, { phase: "cleaning-up" }, true)
      await recordings.cleanupCommittedForProject(saved.path)
      operations.patch(operationId, { state: "completed" }, true)
      lifecycle.completeProject(saved)
      return saved
    } catch (error) {
      lifecycle.failProject(error)
      operations.patch(
        operationId,
        {
          state: "failed",
          message: error instanceof Error ? error.message : String(error)
        },
        true
      )
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectClose, async (event, value: unknown) => {
    assertTrustedSender(event)
    const current = projects.current
    if (!current) return true
    lifecycle.beginProject("closing")
    try {
      let disposition = value as ProjectCloseDisposition | undefined
      if (current.dirty && !disposition) {
        lifecycle.cancelProject()
        return false
      }
      disposition ??= "discard"
      if (disposition !== "save" && disposition !== "discard" && disposition !== "cancel") {
        throw new TypeError("Invalid close disposition")
      }
      if (disposition === "save") await synchronizePluginStates()
      const closed = await projects.close(disposition)
      if (!closed) {
        lifecycle.cancelProject()
        return false
      }
      await projectGraph.clearProject()
      try {
        await transport.command({ type: "stop" })
      } catch {
        // The audio engine may already be stopped.
      }
      if (disposition === "save") await recordings.cleanupCommittedForProject(current.path)
      lifecycle.completeProject(null)
      return true
    } catch (error) {
      lifecycle.failProject(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectAssetsList, async (event) => {
    assertTrustedSender(event)
    return projects.listAssets()
  })

  ipcMain.handle(IPC_CHANNELS.projectConfigurationUpdate, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    const previous = projects.current
    if (!previous) throw new Error("No project is open")
    const configuration = validateProjectConfiguration(value)
    const sampleRateChanged = configuration.sampleRate !== previous.configuration.sampleRate
    const graphConfigurationChanged =
      sampleRateChanged ||
      configuration.timeSignatureNumerator !== previous.configuration.timeSignatureNumerator ||
      configuration.timeSignatureDenominator !== previous.configuration.timeSignatureDenominator
    const audioWasRunning = lifecycle.snapshot().audio.status === "running"
    if (sampleRateChanged && audioWasRunning) lifecycle.beginAudio("reconfiguring")
    let configurationUpdated = false
    try {
      const session = await projects.updateConfiguration(configuration)
      configurationUpdated = true
      await projectGraph.refreshFromDatabase(graphConfigurationChanged)
      lifecycle.syncProject(session)
      if (sampleRateChanged && audioWasRunning && audioHostService) {
        lifecycle.completeAudio(normalizeAudioRuntime(await audioHostService.audioEngineSnapshot()))
      }
      return session
    } catch (error) {
      if (!configurationUpdated) {
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.completeAudio(normalizeAudioRuntime(runtime))
        }
        throw error
      }
      try {
        const restored = await projects.updateConfiguration(previous.configuration)
        await projectGraph.refreshFromDatabase(graphConfigurationChanged)
        lifecycle.syncProject(restored)
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          let runtime = await audioHostService.audioEngineSnapshot()
          if (runtime.state !== "running") {
            runtime = await audioHostService.restoreAudioEngine()
          }
          lifecycle.completeAudio(normalizeAudioRuntime(runtime))
        }
      } catch (rollbackError) {
        console.error("Could not roll back the project sample-rate change", rollbackError)
        if (sampleRateChanged && audioWasRunning && audioHostService) {
          const runtime = await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
          lifecycle.failAudio(rollbackError, normalizeAudioRuntime(runtime))
        }
      }
      throw error
    }
  })
}
