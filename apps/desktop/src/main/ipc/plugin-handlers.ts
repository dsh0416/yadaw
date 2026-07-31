import type { IpcHandlerContext } from "./context"
import { registerPluginRpcHandlers } from "./plugin-rpc-handlers"

export function registerPluginHandlers(context: IpcHandlerContext): void {
  registerPluginRpcHandlers(context)
}
