import type { IpcHandlerContext } from "./context"
import { registerMidiRpcHandlers } from "./midi-rpc-handlers"

export function registerMidiHandlers(context: IpcHandlerContext): void {
  registerMidiRpcHandlers(context)
}
