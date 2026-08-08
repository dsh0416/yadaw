import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import type {
  WorkerOperation,
  WorkerProgress,
  WorkerRequestInput,
  WorkerResponse,
  WorkerResult
} from "@heron/project-db/protocol"

const appDirectory = resolve(import.meta.dirname, "..")
const outputDirectory = resolve(appDirectory, "out")
const templatePath = resolve(outputDirectory, "project-template.pglite.gz")
const migrationsJournalPath = resolve(outputDirectory, "drizzle/meta/_journal.json")
const workerPath = resolve(outputDirectory, "main/project-worker.mjs")
const workingDirectory = await mkdtemp(join(tmpdir(), "heron-built-project-template-"))
const dataDir = join(workingDirectory, "pgdata")
const expectedConfiguration = {
  name: "Built template smoke",
  sampleRate: 48_000,
  timeSignatureNumerator: 7,
  timeSignatureDenominator: 8,
  waveformDisplayMode: "aggregate"
} as const
const worker = new Worker(pathToFileURL(workerPath))
let nextId = 1

function call(request: WorkerRequestInput<WorkerOperation>): Promise<WorkerResult> {
  const id = nextId++
  return new Promise((resolveCall, rejectCall) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectCall(new Error(`Built project worker timed out handling '${request.type}'`))
    }, 20_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      worker.off("error", onError)
      worker.off("message", onMessage)
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectCall(error)
    }
    const onMessage = (message: WorkerResponse | WorkerProgress): void => {
      if (!("id" in message) || message.id !== id) return
      cleanup()
      if (message.ok) resolveCall(message.value)
      else rejectCall(new Error(JSON.stringify(message.error)))
    }

    worker.on("error", onError)
    worker.on("message", onMessage)
    worker.postMessage({ id, ...request })
  })
}

try {
  await Promise.all([access(templatePath), access(migrationsJournalPath), access(workerPath)])
  await call({
    type: "create",
    dataDir,
    name: expectedConfiguration.name,
    sampleRate: expectedConfiguration.sampleRate,
    numerator: expectedConfiguration.timeSignatureNumerator,
    denominator: expectedConfiguration.timeSignatureDenominator,
    waveformDisplayMode: expectedConfiguration.waveformDisplayMode
  })
  assert.deepEqual(await call({ type: "get-configuration" }), expectedConfiguration)
  await call({ type: "close" })
  await call({ type: "open", dataDir })
  assert.deepEqual(await call({ type: "get-configuration" }), expectedConfiguration)
  await call({ type: "close" })
  process.stdout.write("Verified built project worker template creation and reopen.\n")
} finally {
  await worker.terminate()
  await rm(workingDirectory, { force: true, recursive: true })
}
