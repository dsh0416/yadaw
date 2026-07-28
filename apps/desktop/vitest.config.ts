import { resolve } from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"
import { appVersionDefine } from "./build/app-version"

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: appVersionDefine
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src/renderer/src")
    }
  },
  test: {
    environment: "happy-dom",
    setupFiles: [resolve(import.meta.dirname, "src/renderer/src/test/setup.ts")],
    include: ["src/renderer/src/**/*.test.ts", "src/main/**/*.test.ts"],
    restoreMocks: true
  }
})
