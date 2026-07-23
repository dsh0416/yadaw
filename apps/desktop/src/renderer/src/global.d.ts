import type { YadawDesktopApi } from "@yadaw/contracts"

declare global {
  interface Window {
    yadaw: YadawDesktopApi
  }
}

export {}

