import { parentPort } from "node:worker_threads"
import type { ProjectDatabase as ProjectDatabaseInstance } from "@yadaw/project-db/node"
import type {
  WorkerProgress,
  WorkerRequest,
  WorkerResponse,
  WorkerResult
} from "@yadaw/project-db/protocol"

if (!parentPort) throw new Error("Project worker requires a parent port")
const port = parentPort

let database: ProjectDatabaseInstance | null = null
let projectDatabaseModule: Promise<typeof import("@yadaw/project-db/node")> | null = null
const cancelledOperations = new Set<string>()

function loadProjectDatabase(): Promise<typeof import("@yadaw/project-db/node")> {
  projectDatabaseModule ??= import("@yadaw/project-db/node")
  return projectDatabaseModule
}

async function closeCurrentDatabase(): Promise<void> {
  if (!database) return
  const current = database
  database = null
  await current.close()
}

function requireDatabase(): ProjectDatabaseInstance {
  if (!database) throw new Error("No project is open")
  return database
}

async function handle(request: WorkerRequest): Promise<WorkerResult> {
  switch (request.type) {
    case "create": {
      await closeCurrentDatabase()
      const { ProjectDatabase } = await loadProjectDatabase()
      database = await ProjectDatabase.create(request.dataDir, {
        name: request.name,
        sampleRate: request.sampleRate,
        numerator: request.numerator,
        denominator: request.denominator,
        waveformDisplayMode: request.waveformDisplayMode
      })
      return
    }
    case "open":
      await closeCurrentDatabase()
      database = await (
        await loadProjectDatabase()
      ).ProjectDatabase.open(request.dataDir, request.archivePath)
      return
    case "get-configuration":
      return requireDatabase().getConfiguration()
    case "update-configuration":
      return requireDatabase().updateConfiguration(request.configuration)
    case "list-assets":
      return requireDatabase().listAssets()
    case "mixer-snapshot":
      return requireDatabase().mixerSnapshot()
    case "apply-project-command":
      return requireDatabase().applyCommand(request.command, request.fallbackOutputId)
    case "import-midi":
      return requireDatabase().importMidi(request.source, request.command, request.fallbackOutputId)
    case "rollback-midi":
      return requireDatabase().rollbackMidi(
        request.sourceId,
        request.command,
        request.fallbackOutputId
      )
    case "save-plugin-states":
      return requireDatabase().savePluginStates(request.states)
    case "asset-content-hashes":
      return requireDatabase().assetContentHashes(request.ids)
    case "default-recording-track":
      return requireDatabase().defaultRecordingTrack()
    case "assets-missing-waveform":
      return requireDatabase().assetsMissingWaveform(request.cacheVersion)
    case "delete-assets":
      return requireDatabase().deleteAssets(request.ids)
    case "dump":
      await requireDatabase().dumpTo(request.outputPath)
      return
    case "import-large-object": {
      cancelledOperations.delete(request.operationId)
      try {
        return await requireDatabase().importLargeObject(
          request.filePath,
          request.asset,
          (completed, total) => {
            const progress: WorkerProgress = {
              type: "progress",
              operationId: request.operationId,
              completed,
              total
            }
            port.postMessage(progress)
          },
          () => cancelledOperations.has(request.operationId)
        )
      } finally {
        cancelledOperations.delete(request.operationId)
      }
    }
    case "read-large-object":
      return requireDatabase().readLargeObject(request.assetId)
    case "read-waveform":
      return requireDatabase().readWaveform(
        request.assetId,
        request.startFrame,
        request.endFrame,
        request.maxBuckets
      )
    case "store-waveform":
      await requireDatabase().storeWaveform(request.assetId, request.waveform)
      return
    case "cancel":
      cancelledOperations.add(request.operationId)
      return
    case "close":
      await closeCurrentDatabase()
      return
  }
}

let queue = Promise.resolve()

function respond(request: WorkerRequest): Promise<void> {
  return handle(request).then(
    (value) => {
      const response = {
        id: request.id,
        type: request.type,
        ok: true,
        value
      } as WorkerResponse
      port.postMessage(response)
    },
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      const response: WorkerResponse = {
        id: request.id,
        type: request.type,
        ok: false,
        error: {
          message: normalized.message,
          stack: normalized.stack,
          code:
            typeof (normalized as Error & { code?: unknown }).code === "string"
              ? (normalized as Error & { code: string }).code
              : undefined
        }
      }
      port.postMessage(response)
    }
  )
}

port.on("message", (request: WorkerRequest) => {
  if (request.type === "cancel") {
    cancelledOperations.add(request.operationId)
    const response: WorkerResponse = {
      id: request.id,
      type: request.type,
      ok: true,
      value: undefined
    }
    port.postMessage(response)
    return
  }
  queue = queue.then(() => respond(request))
})
