import { afterEach, vi } from "vitest"
import type { YadawDesktopApi } from "@yadaw/contracts"

const api = {
  subscribeOperations: vi.fn(() => () => undefined)
} as unknown as YadawDesktopApi

Object.defineProperty(window, "yadaw", { configurable: true, value: api })

afterEach(() => {
  document.body.innerHTML = ""
})
