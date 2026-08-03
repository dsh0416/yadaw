import type { MeterPeakHold, MeterReturnRate } from "@yadaw/contracts"

export interface MixerStripDisplayOptions {
  meterPeakHold: MeterPeakHold
  meterReturnRate: MeterReturnRate
  softwareMonitoringEnabled: boolean
}
