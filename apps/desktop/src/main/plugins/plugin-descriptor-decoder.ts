export interface ProbeOutput {
  module?: {
    path?: string
    vendor?: string
    classes?: Array<Record<string, unknown>>
  }
}

/** Recover the probe JSON payload when plug-ins also write diagnostics to stdout. */
export function parseProbeStdout(stdout: string): ProbeOutput {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed) as ProbeOutput
  } catch {
    // Keep scanning reverse lines for the final JSON object emitted by the probe.
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      return JSON.parse(candidate) as ProbeOutput
    } catch {
      // Try earlier lines.
    }
  }
  throw new Error("VST3 probe returned an invalid descriptor")
}
