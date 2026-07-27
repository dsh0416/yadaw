import { acceptHMRUpdate, defineStore } from "pinia"
import type { PendingRecording } from "@yadaw/contracts"
import { useArrangementViewStore } from "./arrangementView"
import { useMixerStore } from "./mixer"
import { useProjectStore } from "./project"
import { useRecordingStore } from "./recording"
import { useTransportStore } from "./transport"
import { useWaveformStore } from "./waveform"

export const useStudioWorkflowStore = defineStore("studio-workflow", () => {
  const projectStore = useProjectStore()
  const recordingStore = useRecordingStore()
  const mixerStore = useMixerStore()
  const transportStore = useTransportStore()
  const arrangementViewStore = useArrangementViewStore()
  const waveformStore = useWaveformStore()

  async function startRecording(): Promise<boolean> {
    if (recordingStore.lifecycle.status !== "idle") return false
    if (mixerStore.audioTracks.length === 0) {
      if (!(await mixerStore.createAudioTrack("stereo"))) return false
    }
    if (!mixerStore.audioTracks.some((track) => track.recordArmed)) {
      const target =
        mixerStore.audioTracks.find((track) => track.id === mixerStore.selectedChannelId) ??
        mixerStore.audioTracks[0]
      if (target && !(await mixerStore.updateChannel(target.id, { recordArmed: true })))
        return false
    }
    return Boolean(await recordingStore.start())
  }

  async function stopRecording(): Promise<PendingRecording | null> {
    const session = recordingStore.active
    if (!session) return null
    const completed = await recordingStore.stop()
    if (!completed) return null

    await projectStore.refreshAssets()
    if (completed.recordedTracks.length > 0) {
      await mixerStore.execute({
        type: "batch",
        commands: completed.recordedTracks.map((asset) => ({
          type: "create-clip" as const,
          clip: {
            id: asset.assetId,
            assetId: asset.assetId,
            trackId: asset.trackId,
            name: asset.name,
            startFrame: session.startFrame,
            sourceOffsetFrames: 0,
            lengthFrames: Math.max(
              1,
              Math.round((asset.frameCount * mixerStore.graph.sampleRate) / asset.sampleRate)
            ),
            assetSampleRate: asset.sampleRate,
            assetChannels: asset.channels
          }
        }))
      })
    }
    projectStore.markDirty()
    await recordingStore.refreshPending()
    return completed
  }

  async function toggleRecording(): Promise<PendingRecording | null> {
    if (recordingStore.active) return stopRecording()
    await startRecording()
    return null
  }

  async function prepareToLeaveStudio(): Promise<boolean> {
    if (recordingStore.active) await stopRecording()
    return !recordingStore.active
  }

  async function saveProject(): Promise<boolean> {
    if (!(await prepareToLeaveStudio())) return false
    await projectStore.save()
    return projectStore.lifecycle.status === "open" && !projectStore.error
  }

  async function closeProject(): Promise<boolean> {
    if (!(await prepareToLeaveStudio())) return false
    await transportStore.stop()
    if (!(await projectStore.close())) return false
    transportStore.reset()
    mixerStore.reset()
    arrangementViewStore.reset()
    waveformStore.clear()
    return true
  }

  async function recoverRecording(recording: PendingRecording): Promise<boolean> {
    if (projectStore.session?.path !== recording.projectPath) {
      if (projectStore.session && !(await closeProject())) return false
      const workspace = await projectStore.open(recording.projectPath)
      if (!workspace) return false
      mixerStore.hydrate(workspace.graph)
    }
    if (!(await recordingStore.recover(recording))) return false
    await projectStore.refreshAssets()
    projectStore.markDirty()
    await mixerStore.reload()
    return true
  }

  return {
    startRecording,
    stopRecording,
    toggleRecording,
    prepareToLeaveStudio,
    saveProject,
    closeProject,
    recoverRecording
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStudioWorkflowStore, import.meta.hot))
}
