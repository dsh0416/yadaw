import { describe, expect, it, vi } from "vitest"
import { PluginProbeClient } from "./plugin-probe-client"

describe("PluginProbeClient", () => {
  it("runs soft probes through an injected command runner", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        module: {
          vendor: "Acme",
          classes: [
            {
              classId: "effect-id",
              name: "Effect",
              categories: ["Fx"],
              initialized: true,
              sample32: true,
              supportedAudioModes: ["stereo"]
            }
          ]
        }
      })
    })
    const client = new PluginProbeClient("probe.exe", runner)

    const descriptors = await client.probe("effect.vst3", "soft")

    expect(runner).toHaveBeenCalledWith(
      "probe.exe",
      ["--soft", "effect.vst3"],
      expect.objectContaining({ windowsHide: true, encoding: "utf8" })
    )
    expect(descriptors[0]).toMatchObject({
      locator: { format: "vst3", artifactPath: "effect.vst3", nativeId: "effect-id" },
      vendor: "Acme"
    })
  })

  it("rejects probe payloads without audio module classes", async () => {
    const client = new PluginProbeClient(
      "probe.exe",
      vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ module: { vendor: "Acme", classes: [] } })
      })
    )

    await expect(client.probe("empty.vst3")).rejects.toThrow(
      "Artifact has no supported audio plug-ins"
    )
  })
})
