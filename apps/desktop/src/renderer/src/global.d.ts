import type { HeronDesktopApi, HeronSplashApi } from "@heron/contracts"

declare global {
  interface Window {
    heron: HeronDesktopApi
    heronSplash: HeronSplashApi
  }
}

export {}
