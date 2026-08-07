import { dialog } from "electron"
import { randomUUID } from "node:crypto"
import { rename, unlink } from "node:fs/promises"
import path from "node:path"
import { IPC_CHANNELS, rpcFailure } from "@heron/contracts"
import type {
  BounceFormatSettings,
  BounceOutputRequest,
  AudioRuntimeSnapshot,
  OperationPhase,
  ProjectGraphSnapshot,
  TransportSnapshot,
  RpcError,
  RpcRequestMeta
} from "@heron/contracts"
import type { AudioHostBounceRequest, AudioHostBounceStatus } from "../audio-host"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"
import { validateMutationTarget, validationFailure } from "./resource-validation"
import { t } from "../settings"

function safeFilePart(value: string): string {
  return (
    Array.from(value, (character) => (character.charCodeAt(0) < 32 ? "-" : character))
      .join("")
      .replace(/[<>:"/\\|?*]/g, "-")
      .replace(/[. ]+$/g, "")
      .trim() || "Output"
  )
}

function extension(format: BounceFormatSettings): "wav" | "flac" | "mp3" {
  return format.format
}

function targetPathWithExtension(filePath: string, expected: string): string {
  const current = path.extname(filePath)
  return current.toLowerCase() === `.${expected}`
    ? filePath
    : path.join(path.dirname(filePath), `${path.basename(filePath, current)}.${expected}`)
}

function validateRequest(value: unknown, projectSampleRate: number): BounceOutputRequest | null {
  if (!value || typeof value !== "object") return null
  const request = value as BounceOutputRequest
  if (
    typeof request.outputChannelId !== "string" ||
    !["stereo", "mono"].includes(request.channelMode) ||
    !Number.isSafeInteger(request.startBar) ||
    !Number.isSafeInteger(request.endBar) ||
    request.startBar < 1 ||
    request.endBar < request.startBar ||
    typeof request.includeTail !== "boolean" ||
    !request.format ||
    !["wav", "flac", "mp3"].includes(request.format.format) ||
    !request.normalization ||
    !["off", "overload-protection", "true-peak"].includes(request.normalization.mode)
  )
    return null
  const targetRate = request.sampleRate === "project" ? projectSampleRate : request.sampleRate
  if (
    request.sampleRate !== "project" &&
    ![44_100, 48_000, 88_200, 96_000].includes(request.sampleRate)
  )
    return null
  if (request.format.format === "mp3" && ![44_100, 48_000].includes(targetRate)) return null
  if (
    request.format.format === "wav" &&
    (!["pcm16", "pcm24", "float32"].includes(request.format.bitDepth) ||
      !["off", "tpdf"].includes(request.format.dither) ||
      (request.format.bitDepth === "float32" && request.format.dither !== "off"))
  )
    return null
  if (
    request.format.format === "flac" &&
    (!["pcm16", "pcm24"].includes(request.format.bitDepth) ||
      !["off", "tpdf"].includes(request.format.dither) ||
      !Number.isInteger(request.format.compressionLevel) ||
      request.format.compressionLevel < 0 ||
      request.format.compressionLevel > 8)
  )
    return null
  if (request.format.format === "mp3") {
    const bitrate = request.format.bitrate
    if (!bitrate || typeof bitrate !== "object") return null
    if (bitrate.mode === "cbr") {
      if (![128, 192, 256, 320].includes(bitrate.kbps)) return null
    } else if (
      bitrate.mode !== "vbr" ||
      !Number.isInteger(bitrate.quality) ||
      bitrate.quality < 0 ||
      bitrate.quality > 9
    ) {
      return null
    }
  }
  if (
    request.normalization.mode === "true-peak" &&
    (!Number.isFinite(request.normalization.targetDbtp) ||
      request.normalization.targetDbtp < -12 ||
      request.normalization.targetDbtp > 0)
  )
    return null
  return structuredClone(request)
}

function nextBarBoundaryTick(graph: ProjectGraphSnapshot, tick: number): number {
  let signature = graph.tempoMap.timeSignatureEvents[0] ?? {
    tick: 0,
    numerator: 4,
    denominator: 4
  }
  for (const event of graph.tempoMap.timeSignatureEvents) {
    if (event.tick > tick) break
    signature = event
  }
  const length = Math.max(
    1,
    Math.round((signature.numerator * graph.tempoMap.ticksPerQuarter * 4) / signature.denominator)
  )
  const nextSignature = graph.tempoMap.timeSignatureEvents.find((event) => event.tick > tick)
  return nextSignature && nextSignature.tick < tick + length ? nextSignature.tick : tick + length
}

function barBoundaryTick(graph: ProjectGraphSnapshot, bar: number): number {
  let tick = 0
  for (let currentBar = 1; currentBar < bar; currentBar += 1) {
    tick = nextBarBoundaryTick(graph, tick)
  }
  return tick
}

function tickToFrame(graph: ProjectGraphSnapshot, targetTick: number): number {
  let seconds = 0
  let previousTick = 0
  let bpm = graph.tempoMap.tempoEvents[0]?.beatsPerMinute ?? 120
  for (const event of graph.tempoMap.tempoEvents.slice(1)) {
    if (event.tick >= targetTick) break
    seconds += (((event.tick - previousTick) / graph.tempoMap.ticksPerQuarter) * 60) / bpm
    previousTick = event.tick
    bpm = event.beatsPerMinute
  }
  seconds += (((targetTick - previousTick) / graph.tempoMap.ticksPerQuarter) * 60) / bpm
  return Math.max(0, Math.round(seconds * graph.sampleRate))
}

function encoding(format: BounceFormatSettings): AudioHostBounceRequest["encoding"] {
  if (format.format === "wav") {
    return format.bitDepth === "float32"
      ? { type: "wav-float" }
      : { type: "wav-pcm", bits: format.bitDepth === "pcm16" ? 16 : 24, dither: format.dither }
  }
  if (format.format === "flac")
    return {
      type: "flac",
      bits: format.bitDepth === "pcm16" ? 16 : 24,
      compression: format.compressionLevel,
      dither: format.dither
    }
  return format.bitrate.mode === "cbr"
    ? { type: "mp3-cbr", kbps: format.bitrate.kbps }
    : { type: "mp3-vbr", quality: format.bitrate.quality }
}

function operationFailure(meta: RpcRequestMeta, message: string): RpcError {
  void message
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: `bounce-${meta.requestId}`,
    userMessageKey: "errors.operationFailed",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "resource-unavailable", component: "audio-host", dispatched: true }
  }
}

function operationPhase(status: AudioHostBounceStatus): OperationPhase {
  if (status.phase === "rendering") return "rendering-offline"
  if (status.phase === "analyzing") return "analyzing-bounce"
  if (status.phase === "encoding") return "encoding-bounce"
  return "preparing-bounce"
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function registerBounceHandlers(context: IpcHandlerContext): void {
  const { lifecycle, operations, audioHost, projectGraph, transport, synchronizePluginStates } =
    context
  let activeOperationId: string | null = null

  registerRpcHandler(IPC_CHANNELS.bounceOutputStart, async ({ meta }, value: unknown) => {
    let workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace) return validationFailure(meta, "target")
    const invalidTarget = validateMutationTarget(meta, workspace.projectGraph, workspace.revision)
    if (invalidTarget) return invalidTarget
    const request = validateRequest(value, workspace.graph.sampleRate)
    if (!request) return validationFailure(meta, "request")
    let output = workspace.graph.channels.find((channel) => channel.id === request.outputChannelId)
    if (!output || output.kind !== "output") return validationFailure(meta, "outputChannelId")
    const maximumBar = Math.max(
      1,
      (() => {
        let bar = 1
        let tick = 0
        const end = Math.max(1, workspace.graph.projectEndTick ?? 1)
        while (bar < 100_000) {
          const next = nextBarBoundaryTick(workspace.graph, tick)
          if (next >= end) return bar
          tick = next
          bar += 1
        }
        return tick > 0 ? bar : 1
      })()
    )
    if (request.endBar > maximumBar) return validationFailure(meta, "endBar")
    if (activeOperationId || operations.activeCount > 0) {
      return rpcFailure(meta, {
        code: "resource-busy",
        category: "busy",
        outcome: "not-committed",
        retry: "safe",
        correlationId: randomUUID(),
        userMessageKey: "errors.resourceBusy",
        resource: workspace.projectGraph,
        details: { type: "resource-busy", ...(activeOperationId ? { activeOperationId } : {}) }
      })
    }
    const ext = extension(request.format)
    const defaultPath = `${safeFilePart(workspace.session.configuration.name)}-${safeFilePart(output.name)}.${ext}`
    const chosen = await dialog.showSaveDialog({
      title: t("dialog.bounceOutput.title"),
      defaultPath,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (chosen.canceled || !chosen.filePath) return null
    const currentWorkspace = lifecycle.applicationState.workspaceSnapshot()
    if (!currentWorkspace) return validationFailure(meta, "target")
    const staleTarget = validateMutationTarget(
      meta,
      currentWorkspace.projectGraph,
      currentWorkspace.revision
    )
    if (staleTarget) return staleTarget
    const currentOutput = currentWorkspace.graph.channels.find(
      (channel) => channel.id === request.outputChannelId
    )
    if (!currentOutput || currentOutput.kind !== "output")
      return validationFailure(meta, "outputChannelId")
    workspace = currentWorkspace
    output = currentOutput
    if (activeOperationId || operations.activeCount > 0) {
      return rpcFailure(meta, {
        code: "resource-busy",
        category: "busy",
        outcome: "not-committed",
        retry: "safe",
        correlationId: randomUUID(),
        userMessageKey: "errors.resourceBusy",
        resource: workspace.projectGraph,
        details: { type: "resource-busy", ...(activeOperationId ? { activeOperationId } : {}) }
      })
    }
    const finalPath = targetPathWithExtension(chosen.filePath, ext)
    const operationId = meta.mutation!.operationId
    const safeOperationId = operationId.replace(/[^a-zA-Z0-9_-]/g, "-")
    const encodedPath = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.${safeOperationId}.partial`
    )
    const scratchPath = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.${safeOperationId}.scratch`
    )
    try {
      lifecycle.beginExclusiveOfflineOperation(operationId)
    } catch {
      return validationFailure(meta, "operation")
    }
    const begun = operations.registry.begin({
      operationId,
      idempotencyKey: meta.mutation!.idempotencyKey,
      target: workspace.projectGraph,
      cancellable: true
    })
    if (!begun.ok || begun.value.disposition !== "started") {
      lifecycle.endExclusiveOfflineOperation(operationId)
      return validationFailure(meta, "operation")
    }
    activeOperationId = operationId
    let cancelRequested = false
    operations.upsert(
      {
        id: operationId,
        title: t("operation.bouncingOutput"),
        description: output.name,
        phase: "preparing-bounce",
        state: "running",
        completedUnits: 0,
        totalUnits: null,
        cancellable: true,
        error: null,
        dropoutFrames: 0
      },
      true
    )
    operations.setCancelHandler(operationId, async () => {
      cancelRequested = true
      try {
        const current = await audioHost.bounceOutputStatus(operationId)
        if (current.state === "running") await audioHost.cancelBounceOutput(operationId)
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const status = await audioHost.bounceOutputStatus(operationId)
          if (status.state !== "running") break
          await delay(10)
        }
      } catch {
        // The runtime may already be restarting after a completed render.
        // The commit gate below still honors the cancellation request.
      }
    })

    void (async () => {
      let transportBefore: TransportSnapshot | null = null
      let audioBefore: AudioRuntimeSnapshot | null = null
      let restored = false
      try {
        audioBefore = await audioHost.audioEngineSnapshot()
        transportBefore =
          audioBefore.state === "running"
            ? await transport.snapshot()
            : {
                state: "stopped",
                positionFrames: 0,
                sampleRate: workspace.graph.sampleRate,
                loopEnabled: false,
                loopRange: null
              }
        operations.patch(operationId, { phase: "synchronizing-plugin-state" }, true)
        await synchronizePluginStates()
        audioHost.refreshDesiredProjectGraph(await projectGraph.snapshot())
        operations.patch(operationId, { phase: "stopping-playback" }, true)
        if (transportBefore.state !== "stopped") await transport.command({ type: "pause" })
        if (audioBefore.state === "running") await audioHost.stopAudioEngine()
        await audioHost.prepareOfflineBounce()
        const targetRate =
          request.sampleRate === "project" ? workspace.graph.sampleRate : request.sampleRate
        await audioHost.startBounceOutput({
          operation_id: operationId,
          output_channel_id: request.outputChannelId,
          start_frame: tickToFrame(
            workspace.graph,
            barBoundaryTick(workspace.graph, request.startBar)
          ),
          end_frame: tickToFrame(
            workspace.graph,
            barBoundaryTick(workspace.graph, request.endBar + 1)
          ),
          target_sample_rate: targetRate,
          channel_mode: request.channelMode,
          include_tail: request.includeTail,
          encoding: encoding(request.format),
          normalization:
            request.normalization.mode === "true-peak"
              ? { mode: "true-peak", target_dbtp: request.normalization.targetDbtp }
              : { mode: request.normalization.mode },
          scratch_path: scratchPath,
          encoded_path: encodedPath
        })
        let status: AudioHostBounceStatus
        do {
          await delay(50)
          status = await audioHost.bounceOutputStatus(operationId)
          operations.patch(operationId, {
            phase: operationPhase(status),
            completedUnits: status.total_units > 0 ? status.completed_units : null,
            totalUnits: status.total_units > 0 ? status.total_units : null
          })
        } while (status.state === "running")
        if (status.state !== "completed") throw new Error(status.error ?? `bounce ${status.state}`)
        operations.patch(
          operationId,
          { phase: "restoring-audio", completedUnits: null, totalUnits: null },
          true
        )
        await audioHost.restartAfterOfflineBounce(audioBefore.state === "running")
        restored = true
        if (audioBefore.state === "running") {
          await transport.command({
            type: "set-loop",
            enabled: transportBefore.loopEnabled,
            range: transportBefore.loopRange
          })
          await transport.command({ type: "seek", positionFrames: transportBefore.positionFrames })
        }
        if (cancelRequested) throw new Error("bounce cancelled before commit")
        operations.setCancelHandler(operationId, null)
        operations.patch(operationId, { cancellable: false }, true)
        await rename(encodedPath, finalPath)
        operations.patch(
          operationId,
          {
            state: "completed",
            description: status.warnings.includes("tail-truncated")
              ? `${output.name} · ${t("operation.tailTruncated")}`
              : output.name,
            completedUnits: 1,
            totalUnits: 1
          },
          true
        )
      } catch (error) {
        await Promise.allSettled([unlink(scratchPath), unlink(encodedPath)])
        if (!restored && transportBefore && audioBefore) {
          try {
            operations.patch(
              operationId,
              { phase: "restoring-audio", completedUnits: null, totalUnits: null },
              true
            )
            await audioHost.restartAfterOfflineBounce(audioBefore.state === "running")
            if (audioBefore.state === "running") {
              await transport.command({
                type: "set-loop",
                enabled: transportBefore.loopEnabled,
                range: transportBefore.loopRange
              })
              await transport.command({
                type: "seek",
                positionFrames: transportBefore.positionFrames
              })
            }
          } catch (_restoreError) {
            operations.patch(
              operationId,
              {
                state: "failed",
                error: {
                  code: "invariant-violation",
                  category: "invariant-violation",
                  outcome: "quarantined",
                  retry: "after-reconcile",
                  correlationId: `bounce-restore-${meta.requestId}`,
                  userMessageKey: "errors.internalInvariant",
                  resource: workspace.projectGraph,
                  details: { type: "invariant-violation", component: "audio-host" }
                }
              },
              true
            )
            return
          }
        }
        const cancelled =
          String(error).includes("cancel") ||
          operations.operationStatus(operationId)?.state === "cancel-requested"
        operations.patch(
          operationId,
          {
            state: cancelled ? "cancelled" : "failed",
            error: cancelled ? null : operationFailure(meta, String(error))
          },
          true
        )
      } finally {
        activeOperationId = null
        lifecycle.endExclusiveOfflineOperation(operationId)
      }
    })()
    return { operationId, filePath: finalPath }
  })
}
