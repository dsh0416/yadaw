import { config } from "@vue/test-utils"
import { afterEach, vi } from "vitest"
import type { HeronDesktopApi } from "@heron/contracts"
import { i18n } from "../i18n"
import { rpcSuccess, testBootstrap } from "./ipc"

const api = {
  platform: "win32",
  bootstrap: vi.fn(async () => rpcSuccess(testBootstrap())),
  subscribeOperations: vi.fn(() => () => undefined),
  subscribePluginScan: vi.fn(() => () => undefined),
  subscribePluginEditorClosed: vi.fn(() => () => undefined),
  subscribeExternalProjectCommands: vi.fn(() => () => undefined),
  cancelOperation: vi.fn(async () => rpcSuccess({ state: "cancelled" })),
  acknowledgeOperation: vi.fn(async () => rpcSuccess(undefined)),
  subscribeApplicationCommands: vi.fn(() => () => undefined),
  executeApplicationWindowCommand: vi.fn(),
  setApplicationWindowTheme: vi.fn()
} as unknown as HeronDesktopApi

Object.defineProperty(window, "heron", { configurable: true, value: api })

if (!config.global.plugins.includes(i18n)) {
  config.global.plugins.push(i18n)
}

afterEach(() => {
  document.body.innerHTML = ""
  window.localStorage?.clear()
})
