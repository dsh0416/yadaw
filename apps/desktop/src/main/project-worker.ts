import { parentPort } from "node:worker_threads"
import type { ProjectDatabase as ProjectDatabaseInstance } from "@yadaw/project-db/node"
import type { WorkerProgress, WorkerRequest, WorkerResponse } from "@yadaw/project-db/protocol"

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

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "create":
      await closeCurrentDatabase()
      const { ProjectDatabase } = await loadProjectDatabase()
      database = await ProjectDatabase.create(request.dataDir, {
        name: request.name,
        sampleRate: request.sampleRate,
        tempo: request.tempo,
        numerator: request.numerator,
        denominator: request.denominator
      })
      return null
    case "open":
      await closeCurrentDatabase()
      database = await (await loadProjectDatabase()).ProjectDatabase.open(request.dataDir, request.archivePath)
      return null
    case "query":
      return requireDatabase().query(request.query)
    case "transaction":
      return requireDatabase().transaction(request.request)
    case "dump":
      await requireDatabase().dumpTo(request.outputPath)
      return null
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
    case "cancel":
      cancelledOperations.add(request.operationId)
      return null
    case "close":
      await closeCurrentDatabase()
      return null
  }
}

let queue = Promise.resolve()

function respond(request: WorkerRequest): Promise<void> {
  return handle(request).then(
    (value) => {
      const response: WorkerResponse = { id: request.id, ok: true, value }
      port.postMessage(response)
    },
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: {
          message: normalized.message,
          stack: normalized.stack,
          code: typeof (normalized as Error & { code?: unknown }).code === "string"
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
    const response: WorkerResponse = { id: request.id, ok: true, value: null }
    port.postMessage(response)
    return
  }
  queue = queue.then(() => respond(request))
})
