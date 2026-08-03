import type { MeterPeakHold, MeterReturnRate } from "@heron/contracts"

export interface MixerStripDisplayOptions {
  meterPeakHold: MeterPeakHold
  meterReturnRate: MeterReturnRate
  softwareMonitoringEnabled: boolean
}
