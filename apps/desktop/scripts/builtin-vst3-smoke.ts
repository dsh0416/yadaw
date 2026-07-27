import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

interface ProbeOutput {
  module?: {
    classes?: Array<{
      classId?: string
      initialized?: boolean
      sample32?: boolean
      hasEditor?: boolean
      audioInputs?: number
      audioOutputs?: number
      eventInputs?: number
    }>
  }
}

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const probePath = resolve(repositoryRoot, "target", "debug", `yadaw-vst3-probe${executableSuffix}`)

const expected = [
  {
    bundle: "YADAW Gain.vst3",
    classId: "59CABE21E605B9C9EE928D6C3B236BBF",
    audioInputs: 1,
    audioOutputs: 1,
    eventInputs: 0
  },
  {
    bundle: "YADAW Sine.vst3",
    classId: "F7BC8CA3E5E8B9C9EE928D7114950FBF",
    audioInputs: 0,
    audioOutputs: 1,
    eventInputs: 1
  },
  {
    bundle: "YADAW Metronome.vst3",
    classId: "F310A5DEDA34820C9E068A5753F83ADE",
    audioInputs: 0,
    audioOutputs: 1,
    eventInputs: 1
  }
] as const

for (const plugin of expected) {
  const bundlePath = resolve(repositoryRoot, "target", "bundles", plugin.bundle)
  const { stdout } = await execFileAsync(probePath, [bundlePath], {
    encoding: "utf8",
    timeout: 15_000
  })
  const output = JSON.parse(stdout) as ProbeOutput
  const descriptor = output.module?.classes?.find((entry) => entry.classId === plugin.classId)
  if (
    !descriptor?.initialized ||
    !descriptor.sample32 ||
    !descriptor.hasEditor ||
    descriptor.audioInputs !== plugin.audioInputs ||
    descriptor.audioOutputs !== plugin.audioOutputs ||
    descriptor.eventInputs !== plugin.eventInputs
  ) {
    throw new Error(`${plugin.bundle} did not match its committed VST3 contract`)
  }
}

console.log("Built-in VST3 probe smoke passed (stable IDs, buses, sample32, Iced editors)")
