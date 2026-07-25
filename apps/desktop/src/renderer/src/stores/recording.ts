import { defineStore } from "pinia"
import { ref, shallowRef } from "vue"
import type { PendingRecording, RecordingSession } from "@yadaw/contracts"
import { useProjectStore } from "./project"
import { useMixerStore } from "./mixer"
import { useTransportStore } from "./transport"

export const useRecordingStore = defineStore("recording", () => {
  const projectStore = useProjectStore()
  const mixerStore = useMixerStore()
  const transportStore = useTransportStore()
  const active = ref<RecordingSession | null>(null)
  const pending = ref<PendingRecording[]>([])
  const error = shallowRef("")
  const busy = shallowRef(false)
  let recordingStartFrame = 0

  async function toggle(): Promise<PendingRecording | null> {
    if (busy.value) return null
    busy.value = true
    error.value = ""
    try {
      if (active.value) {
        const completed = await window.yadaw.stopRecording()
        active.value = null
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
                startFrame: recordingStartFrame,
                sourceOffsetFrames: 0,
                lengthFrames: Math.max(
                  1,
                  Math.round(
                    asset.frameCount * mixerStore.graph.sampleRate / asset.sampleRate
                  )
                ),
                assetSampleRate: asset.sampleRate,
                assetChannels: asset.channels
              }
            }))
          })
        }
        projectStore.markDirty()
        await refreshPending()
        return completed
      } else {
        if (mixerStore.audioTracks.length === 0) await mixerStore.createAudioTrack("stereo")
        if (!mixerStore.audioTracks.some((track) => track.recordArmed)) {
          const target = mixerStore.audioTracks.find((track) => track.id === mixerStore.selectedChannelId)
            ?? mixerStore.audioTracks[0]
          if (target) await mixerStore.updateChannel(target.id, { recordArmed: true })
        }
        recordingStartFrame = Math.round(
          transportStore.playheadSeconds * mixerStore.graph.sampleRate
        )
        active.value = await window.yadaw.startRecording()
        recordingStartFrame = active.value.startFrame
        return null
      }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Recording failed."
      return null
    } finally {
      busy.value = false
    }
  }

  async function refreshPending(): Promise<void> {
    pending.value = await window.yadaw.listPendingRecordings()
  }

  async function recover(recording: PendingRecording): Promise<void> {
    if (projectStore.session?.path !== recording.projectPath) {
      if (projectStore.session && !await projectStore.close()) return
      if (!await projectStore.open(recording.projectPath)) return
    }
    await window.yadaw.recoverRecording(recording.id)
    await projectStore.refreshAssets()
    projectStore.markDirty()
    await refreshPending()
  }

  async function remove(recording: PendingRecording): Promise<void> {
    await window.yadaw.deletePendingRecording(recording.id)
    await refreshPending()
  }

  return { active, pending, error, busy, toggle, refreshPending, recover, remove }
})
