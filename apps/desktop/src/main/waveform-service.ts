import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { WaveformPeakWindow, WaveformWindowRequest } from "@yadaw/contracts"
import { analyzeWaveform } from "@yadaw/dsp-node"
import type { ApplicationSettingsStore } from "./application-settings"
import type { ProjectService } from "./project-service"

function validateRequest(request: WaveformWindowRequest): void {
  if (!request.id || request.id.length > 256) throw new TypeError("Invalid waveform source id")
  if (!Number.isSafeInteger(request.startFrame) || request.startFrame < 0) {
    throw new TypeError("Waveform start frame must be a non-negative integer")
  }
  if (!Number.isSafeInteger(request.endFrame) || request.endFrame < request.startFrame) {
    throw new TypeError("Waveform end frame must not precede its start")
  }
  if (!Number.isInteger(request.maxBuckets) || request.maxBuckets < 1 || request.maxBuckets > 4_096) {
    throw new TypeError("Waveform bucket count must be between 1 and 4096")
  }
}

type WaveformWindowPayload = Omit<WaveformPeakWindow, "id">

function isValidWindow(
  window: WaveformWindowPayload | null
): window is WaveformWindowPayload {
  if (!window) return false
  return (
    window.sampleRate > 0 &&
    window.channels > 0 &&
    window.framesPerBucket > 0 &&
    window.bucketCount >= 0 &&
    window.peaks.byteLength === window.bucketCount * window.channels * 8
  )
}

export class WaveformService {
  private readonly rebuilding = new Map<string, Promise<void>>()

  constructor(
    private readonly settings: ApplicationSettingsStore,
    private readonly projects: ProjectService
  ) {}

  private async rebuild(assetId: string): Promise<void> {
    const projectId = this.projects.current?.id
    if (!projectId) throw new Error("No project is open")
    const rebuildKey = `${projectId}:${assetId}`
    const existing = this.rebuilding.get(rebuildKey)
    if (existing) return existing
    const task = (async () => {
      const settings = await this.settings.get()
      const path = join(settings.swapDirectory, `.waveform-${randomUUID()}.bwf`)
      try {
        await mkdir(settings.swapDirectory, { recursive: true })
        await writeFile(path, await this.projects.readAssetAudio(assetId))
        const analyzed = await analyzeWaveform(path)
        if (this.projects.current?.id !== projectId) return
        await this.projects.storeAssetWaveform(assetId, {
          sampleRate: analyzed.sampleRate,
          channels: analyzed.channels,
          frameCount: BigInt(analyzed.frameCount),
          levels: analyzed.waveformLevels.map((level) => ({
            framesPerBucket: level.framesPerBucket,
            bucketCount: level.bucketCount,
            peaks: new Uint8Array(level.peaks)
          }))
        })
      } finally {
        await rm(path, { force: true })
      }
    })().finally(() => this.rebuilding.delete(rebuildKey))
    this.rebuilding.set(rebuildKey, task)
    return task
  }

  rebuildMissingInBackground(): void {
    const projectId = this.projects.current?.id
    if (!projectId) return
    void (async () => {
      const missing = await this.projects.query({
        sql: `SELECT asset.id
              FROM assets AS asset
              WHERE NOT EXISTS (
                SELECT 1 FROM asset_waveform_levels AS waveform
                WHERE waveform.asset_id = asset.id AND waveform.cache_version = 1
              )
              ORDER BY asset.created_at`,
        params: [],
        method: "all"
      })
      for (const row of missing.rows) {
        if (this.projects.current?.id !== projectId) return
        try {
          await this.rebuild(String(row[0]))
        } catch {
          // Derived caches never prevent a project from opening or playing.
        }
      }
    })().catch(() => {
      // A damaged/missing cache remains an unavailable waveform, not an open failure.
    })
  }

  async readAsset(request: WaveformWindowRequest): Promise<WaveformPeakWindow> {
    validateRequest(request)
    let window = await this.projects.readAssetWaveform(
      request.id,
      request.startFrame,
      request.endFrame,
      request.maxBuckets
    )
    if (!isValidWindow(window)) {
      await this.rebuild(request.id)
      window = await this.projects.readAssetWaveform(
        request.id,
        request.startFrame,
        request.endFrame,
        request.maxBuckets
      )
    }
    if (!isValidWindow(window)) throw new Error("Waveform cache could not be generated")
    return { id: request.id, ...window }
  }
}
