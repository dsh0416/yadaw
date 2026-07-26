import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const workspace = resolve(import.meta.dirname, "../../../..")
const roots = [
  "packages/project-db/src",
  "packages/contracts/src",
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "apps/desktop/src/renderer/src"
]
const allowedSqlFiles = new Set([
  resolve(workspace, "packages/project-db/src/schema.ts"),
  resolve(workspace, "packages/project-db/src/large-object.ts"),
  resolve(workspace, "packages/project-db/src/maintenance.ts")
])
const forbiddenApi = [
  "ProjectQueryRequest",
  "ProjectTransactionRequest",
  "createProjectDbProxy",
  "projectQuery",
  "projectTransaction"
]
const sqlStatement =
  /(?:\bSELECT\b[\s\S]{0,200}\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b)/i
const lowLevelDatabaseCall = /\.(?:query|exec)\s*\(/

function containsSqlLiteral(source: string, file: string): boolean {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      sqlStatement.test(node.getText(sourceFile))
    ) {
      found = true
      return
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : typescriptFiles(path)
      }
      return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) ? [path] : []
    })
  )
  return nested.flat()
}

describe("project database architecture boundary", () => {
  it("keeps generic database APIs and handwritten SQL out of production code", async () => {
    const files = (
      await Promise.all(roots.map((root) => typescriptFiles(resolve(workspace, root))))
    ).flat()
    const violations: string[] = []

    for (const file of files) {
      const source = await readFile(file, "utf8")
      for (const identifier of forbiddenApi) {
        if (source.includes(identifier)) violations.push(`${file}: ${identifier}`)
      }
      if (!allowedSqlFiles.has(file) && containsSqlLiteral(source, file)) {
        violations.push(`${file}: handwritten SQL statement`)
      }
      if (!allowedSqlFiles.has(file) && lowLevelDatabaseCall.test(source)) {
        violations.push(`${file}: low-level database call`)
      }
    }

    expect(violations).toEqual([])
  })
})
