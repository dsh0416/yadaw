import { drizzle } from "drizzle-orm/pg-proxy"
import type { RemoteCallback } from "drizzle-orm/pg-proxy"
import * as schema from "./schema"
import type { ProjectQueryMethod, ProjectQueryRequest, ProjectQueryResult, SerializableSqlParameter } from "./protocol"

export interface ProjectProxyTransport {
  query(request: ProjectQueryRequest): Promise<ProjectQueryResult>
}

export function createProjectDbProxy(transport: ProjectProxyTransport) {
  const callback: RemoteCallback = async (sql, params, method) => {
    const result = await transport.query({
      sql,
      params: params as SerializableSqlParameter[],
      method: method as ProjectQueryMethod
    })
    return { rows: result.rows }
  }

  return drizzle(callback, { schema })
}
