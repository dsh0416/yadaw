import { resolve } from "node:path"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"
import { appVersionDefine } from "./build/app-version"

export default defineConfig({
  plugins: [
    vue(),
    VueI18nPlugin({
      strictMessage: false,
      runtimeOnly: true
    })
  ],
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
    include: ["src/renderer/src/**/*.test.ts", "src/main/**/*.test.ts", "src/shared/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/renderer/src/**/*.{ts,vue}", "src/main/**/*.ts", "src/shared/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/renderer/src/test/**",
        // Bundle-only entry points are exercised by build and E2E checks. Keeping
        // them out of uncovered-file remapping also avoids parsing raw TS as JS.
        "src/renderer/src/main.ts",
        "src/renderer/src/splash/main.ts",
        "src/main/**/*.d.ts",
        "src/renderer/src/**/*.d.ts"
      ]
    }
  }
})
