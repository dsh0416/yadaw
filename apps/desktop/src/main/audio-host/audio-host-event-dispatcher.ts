import { AraCallbackSequenceTracker } from "./audio-host-events"
import type {
  AraHostCallback,
  PluginSidechainRouteRequest,
  Vst3HostNotification
} from "./audio-host-events"

export interface AudioHostEventOperations {
  helperEpoch(): string | null
  rejectSidechainRoute(request: PluginSidechainRouteRequest): Promise<void>
}

export class AudioHostEventDispatcher {
  private readonly pending = new Set<Promise<void>>()
  private readonly araSequences = new AraCallbackSequenceTracker()
  private araHandler: (callback: AraHostCallback) => void | Promise<void> = () => {}
  private vst3Handler: (notification: Vst3HostNotification) => void | Promise<void> = () => {}
  private sidechainHandler: (request: PluginSidechainRouteRequest) => void | Promise<void> =
    () => {}

  constructor(private readonly operations: AudioHostEventOperations) {}

  setAraHandler(handler: (callback: AraHostCallback) => void | Promise<void>): void {
    this.araHandler = handler
  }

  setVst3Handler(handler: (notification: Vst3HostNotification) => void | Promise<void>): void {
    this.vst3Handler = handler
  }

  setSidechainHandler(
    handler: (request: PluginSidechainRouteRequest) => void | Promise<void>
  ): void {
    this.sidechainHandler = handler
  }

  dispatchAra(callback: AraHostCallback): void {
    if (callback.helperEpoch !== this.operations.helperEpoch()) return
    if (!this.araSequences.accept(callback.helperEpoch, callback.sequence)) return
    this.track(
      Promise.resolve()
        .then(() => this.araHandler(callback))
        .catch((error: unknown) => {
          console.error("Could not reconcile an ARA host callback", error)
        })
    )
  }

  dispatchVst3(notification: Vst3HostNotification): void {
    this.track(
      Promise.resolve()
        .then(() => this.vst3Handler(notification))
        .catch((error: unknown) => {
          console.error("Could not reconcile a VST3 host notification", error)
        })
    )
  }

  dispatchSidechain(request: PluginSidechainRouteRequest): void {
    this.track(
      Promise.resolve()
        .then(() => this.sidechainHandler(request))
        .catch(async (error: unknown) => {
          console.error("Could not commit a VST3 side-chain route", error)
          await this.operations.rejectSidechainRoute(request)
        })
    )
  }

  resetHelper(): void {
    this.araSequences.clear()
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending])
    this.araSequences.clear()
  }

  private track(pending: Promise<void>): void {
    this.pending.add(pending)
    void pending.finally(() => this.pending.delete(pending))
  }
}
