import { readFileSync } from "node:fs"

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string }

export const appVersionDefine = JSON.stringify(version)
