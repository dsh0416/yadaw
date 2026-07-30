import { defineConfig } from "vitest/config"

// PGlite create/migrate/archive work regularly takes several seconds on CI
// (especially Windows). Keep the suite above Vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__tests__/**"]
    }
  }
})
