import { finalizeRecording } from "@yadaw/dsp-node"

export class RecordingFinalizer {
  finalize(request: Parameters<typeof finalizeRecording>[0]) {
    return finalizeRecording(request)
  }
}
