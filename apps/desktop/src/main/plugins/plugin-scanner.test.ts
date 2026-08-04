import { describe, expect, it, vi } from "vitest"
import { PluginScanner } from "./plugin-scanner"

describe("PluginScanner", () => {
  it("runs a scan to completion", async () => {
    const scanner = new PluginScanner<string, number>()
    const scan = vi.fn(async (request: string) => request.length)

    await expect(scanner.run("abc", scan)).resolves.toBe(3)
    expect(scan).toHaveBeenCalledWith("abc")
  })

  it("coalesces concurrent scans onto the in-flight promise", async () => {
    const scanner = new PluginScanner<string, string>()
    let resolveScan!: (value: string) => void
    const scan = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveScan = resolve
        })
    )

    const first = scanner.run("one", scan)
    const second = scanner.run("two", scan)
    expect(scan).toHaveBeenCalledOnce()
    resolveScan("done")
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"])
  })

  it("allows a new scan after the previous one settles", async () => {
    const scanner = new PluginScanner<number, number>()
    const scan = vi.fn(async (value: number) => value * 2)

    await expect(scanner.run(2, scan)).resolves.toBe(4)
    await expect(scanner.run(3, scan)).resolves.toBe(6)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it("clears the pending slot when a scan rejects", async () => {
    const scanner = new PluginScanner<string, string>()
    const failing = vi.fn(async () => {
      throw new Error("scan failed")
    })
    const succeeding = vi.fn(async () => "ok")

    await expect(scanner.run("a", failing)).rejects.toThrow("scan failed")
    await expect(scanner.run("b", succeeding)).resolves.toBe("ok")
  })
})
