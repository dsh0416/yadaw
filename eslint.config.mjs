import eslint from "@eslint/js"
import prettier from "eslint-config-prettier"
import vue from "eslint-plugin-vue"
import globals from "globals"
import tseslint from "typescript-eslint"

const generatedAndBuildPaths = [
  ".agents/skills/",
  ".pnpm-store/",
  "apm_modules/",
  "**/node_modules/",
  "**/dist/",
  "**/out/",
  "**/playwright-report/",
  "**/release/",
  "**/target/",
  "**/test-results/",
  "**/third_party/",
  "crates/audio-host-client/index.d.ts",
  "crates/audio-host-client/index.js",
  "crates/dsp-node/index.d.ts",
  "crates/dsp-node/index.js",
  "packages/project-db/drizzle/meta/"
]

const disableTypeCheckedForJavaScript = {
  ...tseslint.configs.disableTypeChecked,
  files: ["**/*.{cjs,js,mjs}"]
}

export default tseslint.config(
  {
    ignores: generatedAndBuildPaths
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,vue}"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".vue"],
        project: [
          "./apps/desktop/tsconfig.eslint.json",
          "./packages/audio-engine/tsconfig.json",
          "./packages/contracts/tsconfig.json",
          "./packages/project-db/tsconfig.eslint.json"
        ],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".vue"],
        parser: tseslint.parser
      }
    }
  },
  disableTypeCheckedForJavaScript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    files: ["**/*.{spec,test}.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "vue/one-component-per-file": "off"
    }
  },
  {
    files: ["apps/desktop/src/renderer/src/main.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off"
    }
  },
  {
    files: [
      "*.config.{cjs,js,mjs,ts}",
      "apps/desktop/e2e/**/*.ts",
      "apps/desktop/scripts/**/*.{cjs,js,mjs,ts}",
      "apps/desktop/src/main/**/*.ts",
      "apps/desktop/src/preload/**/*.ts",
      "packages/project-db/**/*.ts"
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,vue}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  prettier
)
