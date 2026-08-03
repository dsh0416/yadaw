import type { HeronDesktopApi } from "@heron/contracts"

declare global {
  interface Window {
    heron: HeronDesktopApi
  }
}

export {}
