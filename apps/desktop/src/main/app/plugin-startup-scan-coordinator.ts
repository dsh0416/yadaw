import { basename } from "node:path"
import type { PluginScanEvent, StartupProgressSnapshot } from "@heron/contracts"
import { t } from "../settings"

interface StartupProgressSink {
  update(next: Partial<StartupProgressSnapshot>): unknown
}

export class PluginStartupScanCoordinator {
  private total = 0
  private warnings = 0

  constructor(private readonly startup: StartupProgressSink) {}

  handle(event: PluginScanEvent): void {
    if (event.type === "started") {
      this.total = event.total
      this.startup.update({
        phase: "scanning-plugins",
        progress: 0.16,
        label: t("startup.scanningPlugins"),
        detail:
          event.total === 0
            ? t("startup.noBundles")
            : t("startup.foundBundles", { count: event.total }),
        completed: 0,
        total: event.total
      })
      return
    }
    if (event.type === "progress") {
      const ratio = event.total > 0 ? event.completed / event.total : 1
      this.startup.update({
        phase: "scanning-plugins",
        progress: 0.18 + ratio * 0.58,
        label: t("startup.scanningPlugins"),
        detail: basename(event.path),
        completed: event.completed,
        total: event.total
      })
      return
    }
    if (event.type === "quarantined") {
      this.warnings += 1
      this.startup.update({
        detail: t("startup.quarantined", { name: basename(event.path) }),
        warnings: this.warnings
      })
      return
    }
    this.startup.update({
      progress: 0.78,
      detail: t("startup.pluginsAvailable", { count: event.catalog.plugins.length }),
      completed: this.total,
      total: this.total
    })
  }

  fail(error: unknown): void {
    this.warnings += 1
    this.startup.update({
      progress: 0.78,
      detail:
        error instanceof Error
          ? t("startup.scanError", { message: error.message })
          : t("startup.scanUnknownError"),
      warnings: this.warnings
    })
  }
}
