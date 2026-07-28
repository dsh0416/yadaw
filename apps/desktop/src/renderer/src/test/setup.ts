import { config } from "@vue/test-utils"
import { afterEach, vi } from "vitest"
import type { YadawDesktopApi } from "@yadaw/contracts"
import { i18n } from "../i18n"

const api = {
  platform: "win32",
  subscribeOperations: vi.fn(() => () => undefined),
  subscribeApplicationCommands: vi.fn(() => () => undefined),
  executeApplicationWindowCommand: vi.fn(),
  setApplicationWindowTheme: vi.fn()
} as unknown as YadawDesktopApi

Object.defineProperty(window, "yadaw", { configurable: true, value: api })

config.global.plugins.push(i18n)

afterEach(() => {
  document.body.innerHTML = ""
})
