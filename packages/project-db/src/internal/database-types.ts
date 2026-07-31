import type { PgliteDatabase } from "drizzle-orm/pglite"
import * as schema from "../schema"

export type ProjectDb = PgliteDatabase<typeof schema>
export type ProjectTransaction = Parameters<Parameters<ProjectDb["transaction"]>[0]>[0]
