import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export class PluginCatalogCache {
  constructor(private readonly path: string) {}

  async load<T>(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T
    } catch {
      return null
    }
  }

  async store(value: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temporary, this.path)
  }
}
