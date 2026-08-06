import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vue()],
  test: {
    // Node 26 exposes its own file-backed Web Storage globals. Disable them in
    // test workers so happy-dom can install its isolated in-memory storage.
    execArgv: ["--no-experimental-webstorage"],
    environment: "happy-dom",
    include: ["fonts.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/**/*.test.ts", "src/**/*.stories.ts"]
    }
  }
})
