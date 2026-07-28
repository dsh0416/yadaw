import type { StartupProgressSnapshot } from "@yadaw/contracts"
import { t } from "./i18n"

type StartupProgressListener = (snapshot: StartupProgressSnapshot) => void

function initialProgress(): StartupProgressSnapshot {
  return {
    phase: "starting",
    progress: 0.02,
    label: t("startup.starting"),
    detail: t("startup.preparing"),
    completed: null,
    total: null,
    warnings: 0
  }
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export class StartupProgress {
  private current = initialProgress()
  private readonly listeners = new Set<StartupProgressListener>()

  snapshot(): StartupProgressSnapshot {
    return structuredClone(this.current)
  }

  subscribe(listener: StartupProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(next: Partial<StartupProgressSnapshot>): StartupProgressSnapshot {
    this.current = {
      ...this.current,
      ...next,
      progress: Math.max(
        this.current.progress,
        normalizeProgress(next.progress ?? this.current.progress)
      )
    }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  complete(detail: string): StartupProgressSnapshot {
    return this.update({
      phase: "ready",
      progress: 1,
      label: t("startup.ready"),
      detail,
      completed: this.current.total,
      total: this.current.total
    })
  }

  fail(error: unknown): StartupProgressSnapshot {
    const detail = error instanceof Error ? error.message : t("startup.failedDetail")
    return this.update({
      phase: "failed",
      label: t("startup.failed"),
      detail
    })
  }
}
