import { parentPort } from "node:worker_threads"
import { randomUUID } from "node:crypto"
import type { ProjectDatabase as ProjectDatabaseInstance } from "@heron/project-db/node"
import type {
  PreparedProjectCommand,
  ProjectCommandTransactionStatus,
  ProjectCommandTransactionToken,
  WorkerProgress,
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerResultMap
} from "@heron/project-db/protocol"
import { applyToGraph, validateGraph } from "@heron/project-model"

if (!parentPort) throw new Error("Project worker requires a parent port")
const port = parentPort

let database: ProjectDatabaseInstance | null = null
let projectDatabaseModule: Promise<typeof import("@heron/project-db/node")> | null = null
const cancelledOperations = new Set<string>()
const preparedCommands = new Map<
  string,
  {
    token: ProjectCommandTransactionToken
    command: Parameters<ProjectDatabaseInstance["applyCommand"]>[0]
    fallbackOutputId: string
    graph: PreparedProjectCommand["graph"]
  }
>()
const committedCommands = new Map<string, WorkerResultMap["commit-project-command"]>()

function loadProjectDatabase(): Promise<typeof import("@heron/project-db/node")> {
  projectDatabaseModule ??= import("@heron/project-db/node")
  return projectDatabaseModule
}

async function closeCurrentDatabase(): Promise<void> {
  preparedCommands.clear()
  committedCommands.clear()
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
    case "prepare-project-command": {
      const committed = committedCommands.get(request.operationId)
      if (committed) {
        return {
          token: structuredClone(committed.token),
          graph: structuredClone(committed.graph)
        }
      }
      if (committedCommands.size >= 2_048) {
        throw new Error("Project command terminal retention limit reached")
      }
      const existing = [...preparedCommands.values()].find(
        (candidate) => candidate.token.operationId === request.operationId
      )
      if (existing) {
        return {
          token: structuredClone(existing.token),
          graph: structuredClone(existing.graph)
        }
      }
      const before = await requireDatabase().mixerSnapshot()
      const graph = applyToGraph(before, request.command)
      validateGraph(graph)
      const token: ProjectCommandTransactionToken = {
        id: randomUUID(),
        operationId: request.operationId,
        baseRevision: request.baseRevision
      }
      preparedCommands.set(token.id, {
        token,
        command: structuredClone(request.command),
        fallbackOutputId: request.fallbackOutputId,
        graph: structuredClone(graph)
      })
      return { token: structuredClone(token), graph }
    }
    case "commit-project-command": {
      const prepared = preparedCommands.get(request.token.id)
      if (
        !prepared ||
        prepared.token.operationId !== request.token.operationId ||
        prepared.token.baseRevision !== request.token.baseRevision
      ) {
        throw new Error("Project command transaction token is stale")
      }
      await requireDatabase().applyCommand(prepared.command, prepared.fallbackOutputId)
      const result = {
        token: structuredClone(prepared.token),
        graph: await requireDatabase().mixerSnapshot()
      }
      preparedCommands.delete(request.token.id)
      committedCommands.set(prepared.token.operationId, structuredClone(result))
      return result
    }
    case "abort-project-command":
      preparedCommands.delete(request.token.id)
      return
    case "project-command-status": {
      const committed = committedCommands.get(request.operationId)
      if (committed) {
        const status: ProjectCommandTransactionStatus = {
          state: "committed",
          result: structuredClone(committed)
        }
        return status
      }
      const prepared = [...preparedCommands.values()].find(
        (candidate) => candidate.token.operationId === request.operationId
      )
      return prepared
        ? { state: "prepared", token: structuredClone(prepared.token) }
        : { state: "absent" }
    }
    case "import-midi":
      return requireDatabase().importMidi(request.source, request.command, request.fallbackOutputId)
    case "read-midi-source":
      return requireDatabase().readMidiSource(request.sourceId)
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
      const correlationId = randomUUID()
      console.error(`[project-worker] ${correlationId} request failed`, error)
      const response: WorkerResponse = {
        id: request.id,
        type: request.type,
        ok: false,
        error: {
          code: "invariant-violation",
          category: "invariant-violation",
          outcome: "quarantined",
          retry: "after-reconcile",
          correlationId,
          userMessageKey: "errors.projectWorkerFailed",
          details: {
            type: "invariant-violation",
            component: "project-worker"
          }
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
  queue = queue.then(
    () => respond(request),
    () => respond(request)
  )
})
