import type { AudioHostService } from "../audio-host-service"
import type { LifecycleCoordinator } from "../lifecycle-coordinator"
import type { RecordingService } from "../recording-service"

export async function reconcileAudioHostEpoch(options: {
  audioHost: Pick<AudioHostService, "helperEpoch">
  lifecycle: Pick<LifecycleCoordinator, "applicationState">
  recordings: Pick<RecordingService, "abortStart">
}): Promise<void> {
  const state = options.lifecycle.applicationState
  const previousRecording = state.recordingResourceSnapshot()
  const helperEpoch = options.audioHost.helperEpoch()
  if (!helperEpoch) return
  await state.reconcileAudioHost(helperEpoch)
  if (previousRecording && !state.recordingResourceSnapshot()) {
    await options.recordings.abortStart()
  }
}
