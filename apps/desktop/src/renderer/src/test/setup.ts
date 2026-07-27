import { afterEach, vi } from "vitest"
import type { YadawDesktopApi } from "@yadaw/contracts"

const api = {
  platform: "win32",
  subscribeOperations: vi.fn(() => () => undefined),
  subscribeApplicationCommands: vi.fn(() => () => undefined),
  executeApplicationWindowCommand: vi.fn(),
  setApplicationWindowTheme: vi.fn()
} as unknown as YadawDesktopApi

Object.defineProperty(window, "yadaw", { configurable: true, value: api })

afterEach(() => {
  document.body.innerHTML = ""
})
