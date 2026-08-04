import { Worker } from "node:worker_threads"
import type { WorkerProgress, WorkerResponse } from "@heron/project-db/protocol"

export interface ProjectWorkerPort {
  onMessage(listener: (message: WorkerResponse | WorkerProgress) => void): void
  onError(listener: (error: unknown) => void): void
  onExit(listener: (code: number) => void): void
  postMessage(message: unknown): void
  terminate(): Promise<number>
}

export type ProjectWorkerFactory = (workerUrl: URL) => ProjectWorkerPort

class ThreadProjectWorkerPort implements ProjectWorkerPort {
  private readonly worker: Worker

  constructor(workerUrl: URL) {
    // Electron's Playwright/DevTools inspector flags are inherited by Node workers by
    // default and can leave an ESM worker paused before its module body executes.
    this.worker = new Worker(workerUrl, { execArgv: [] })
  }

  onMessage(listener: (message: WorkerResponse | WorkerProgress) => void): void {
    this.worker.on("message", listener)
  }

  onError(listener: (error: unknown) => void): void {
    this.worker.on("error", listener)
  }

  onExit(listener: (code: number) => void): void {
    this.worker.on("exit", listener)
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message)
  }

  terminate(): Promise<number> {
    return this.worker.terminate()
  }
}

export const createProjectWorkerPort: ProjectWorkerFactory = (workerUrl) =>
  new ThreadProjectWorkerPort(workerUrl)
