import { defineConfig } from "vitest/config"

// PGlite create/migrate/archive work regularly takes several seconds on CI
// (especially Windows). Keep the suite above Vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
})
