import { defineConfig } from "oxfmt"

export default defineConfig({
  arrowParens: "always",
  endOfLine: "lf",
  printWidth: 100,
  proseWrap: "preserve",
  semi: false,
  singleQuote: false,
  sortPackageJson: false,
  tabWidth: 2,
  trailingComma: "none",
  useTabs: false,
  vueIndentScriptAndStyle: false,
  ignorePatterns: [
    ".agents/skills/",
    ".pnpm-store/",
    "apm_modules/",
    "**/node_modules/",
    "**/.vitepress/cache/",
    "**/dist/",
    "**/out/",
    "**/playwright-report/",
    "**/release/",
    "**/target/",
    "**/test-results/",
    "**/third_party/",
    "**/*.toml",
    "Cargo.lock",
    "apm.lock.yaml",
    "mise.lock",
    "pnpm-lock.yaml",
    "crates/audio-host-client/index.d.ts",
    "crates/audio-host-client/index.js",
    "crates/dsp-node/index.d.ts",
    "crates/dsp-node/index.js",
    "packages/project-db/drizzle/meta/"
  ]
})
