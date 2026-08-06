import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process"
import { promisify } from "node:util"
import type { PluginDescriptor } from "@heron/contracts"
import { descriptorFromProbe } from "./plugin-descriptor-normalizer"
import { parseProbeStdout } from "./plugin-descriptor-decoder"

const execFileAsync = promisify(execFile)

export type PluginProbeMode = "soft" | "deep"

export type PluginProbeCommandRunner = (
  executable: string,
  arguments_: string[],
  options: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string }>

const runProbeCommand: PluginProbeCommandRunner = async (executable, arguments_, options) => {
  const result = await execFileAsync(executable, arguments_, options)
  return { stdout: result.stdout }
}

export class PluginProbeClient {
  constructor(
    private readonly vst3Executable: string,
    private readonly runner: PluginProbeCommandRunner = runProbeCommand,
    private readonly clapExecutable = vst3Executable.replace("vst3-probe", "clap-probe")
  ) {}

  async probe(bundlePath: string, mode: PluginProbeMode = "deep"): Promise<PluginDescriptor[]> {
    const clap = bundlePath.toLocaleLowerCase().endsWith(".clap")
    const { stdout } = await this.runner(
      clap ? this.clapExecutable : this.vst3Executable,
      mode === "soft" ? ["--soft", bundlePath] : [bundlePath],
      {
        timeout: 600_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(mode === "soft"
            ? clap
              ? { HERON_CLAP_PROBE_MODE: "soft" }
              : { HERON_VST3_PROBE_MODE: "soft" }
            : {})
        }
      }
    )
    const parsed = parseProbeStdout(stdout)
    const module = parsed.module
    if (!module || !Array.isArray(module.classes)) {
      throw new Error("AudioPlugin probe returned an invalid descriptor")
    }
    const factoryVendor = typeof module.vendor === "string" ? module.vendor.trim() : ""
    const descriptors = module.classes.flatMap((classInfo) => {
      const descriptor = descriptorFromProbe(bundlePath, factoryVendor, classInfo)
      return descriptor ? [descriptor] : []
    })
    if (descriptors.length === 0) throw new Error("Artifact has no supported audio plug-ins")
    return descriptors
  }
}
