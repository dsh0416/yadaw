import prettier from "eslint-config-prettier"
import oxlintPlugin from "eslint-plugin-oxlint"
import vue from "eslint-plugin-vue"
import globals from "globals"
import tseslint from "typescript-eslint"

import oxlintConfig, { generatedAndBuildPaths } from "./oxlint.config.ts"

const vueFiles = ["**/*.vue"]
const scopeToVue = <Config extends object>(configs: Config[]) =>
  configs.map((config) => ({ ...config, files: vueFiles }))

export default tseslint.config(
  {
    ignores: generatedAndBuildPaths
  },
  ...scopeToVue(tseslint.configs.recommendedTypeChecked),
  ...scopeToVue(vue.configs["flat/recommended"]),
  {
    files: vueFiles,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        extraFileExtensions: [".vue"],
        parser: tseslint.parser,
        project: [
          "./apps/desktop/tsconfig.eslint.json",
          "./docs/tsconfig.json",
          "./packages/ui/tsconfig.json"
        ],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "no-dupe-args": "error",
      "no-octal": "error",
      "no-undef": "error",
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
    files: ["apps/desktop/src/renderer/**/*.vue"],
    languageOptions: {
      globals: {
        __APP_VERSION__: "readonly"
      }
    }
  },
  ...oxlintPlugin.buildFromOxlintConfig(oxlintConfig, { typeAware: false }),
  prettier
)
