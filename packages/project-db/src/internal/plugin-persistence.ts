import { eq } from "drizzle-orm"
import type { PluginInstancePatch, ProjectCommand } from "@heron/contracts"
import { pluginInstances, pluginSidechainRoutes } from "../schema"
import type { ProjectTransaction } from "./database-types"

type PluginCommand = Extract<
  ProjectCommand,
  {
    type: "create-plugin" | "delete-plugin" | "update-plugin" | "move-plugin" | "replace-plugin"
  }
>

function pluginPatch(patch: PluginInstancePatch): Partial<typeof pluginInstances.$inferInsert> {
  const result: Partial<typeof pluginInstances.$inferInsert> = {}
  if (patch.slotOrder !== undefined) result.slotOrder = patch.slotOrder
  if (patch.enabled !== undefined) result.enabled = patch.enabled
  if (patch.descriptor !== undefined) result.descriptorSnapshot = JSON.stringify(patch.descriptor)
  if (patch.componentState !== undefined) result.componentState = patch.componentState
  if (patch.controllerState !== undefined) result.controllerState = patch.controllerState
  if (patch.araDocumentState !== undefined) result.araDocumentState = patch.araDocumentState
  return result
}

function pluginValue(
  plugin: Extract<ProjectCommand, { type: "create-plugin" }>["plugin"]
): typeof pluginInstances.$inferInsert {
  return {
    id: plugin.id,
    channelId: plugin.channelId,
    role: plugin.role,
    slotOrder: plugin.slotOrder,
    classId: plugin.classId,
    descriptorSnapshot: JSON.stringify(plugin.descriptor),
    audioMode: plugin.audioMode,
    enabled: plugin.enabled,
    componentState: plugin.componentState,
    controllerState: plugin.controllerState,
    araDocumentState: plugin.araDocumentState ?? new Uint8Array()
  }
}

async function replaceSidechainRoutes(
  tx: ProjectTransaction,
  pluginId: string,
  routes: readonly { inputBusIndex: number; sourceChannelId: string }[]
): Promise<void> {
  await tx.delete(pluginSidechainRoutes).where(eq(pluginSidechainRoutes.pluginId, pluginId))
  if (routes.length > 0) {
    await tx.insert(pluginSidechainRoutes).values(
      routes.map((route) => ({
        pluginId,
        inputBusIndex: route.inputBusIndex,
        sourceChannelId: route.sourceChannelId
      }))
    )
  }
}

export function isPluginCommand(command: ProjectCommand): command is PluginCommand {
  return [
    "create-plugin",
    "delete-plugin",
    "update-plugin",
    "move-plugin",
    "replace-plugin"
  ].includes(command.type)
}

export async function persistPluginCommand(
  tx: ProjectTransaction,
  command: PluginCommand
): Promise<void> {
  switch (command.type) {
    case "create-plugin":
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      await replaceSidechainRoutes(tx, command.plugin.id, command.plugin.sidechainInputs)
      return
    case "delete-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      return
    case "update-plugin": {
      const patch = pluginPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(pluginInstances).set(patch).where(eq(pluginInstances.id, command.pluginId))
      }
      if (command.patch.sidechainInputs !== undefined) {
        await replaceSidechainRoutes(tx, command.pluginId, command.patch.sidechainInputs)
      }
      return
    }
    case "move-plugin": {
      const rows = await tx
        .select({
          id: pluginInstances.id,
          channelId: pluginInstances.channelId,
          role: pluginInstances.role,
          slotOrder: pluginInstances.slotOrder
        })
        .from(pluginInstances)
      const moving = rows.find((plugin) => plugin.id === command.pluginId)
      if (!moving) throw new Error(`Plugin instance '${command.pluginId}' was not found`)
      const source = rows
        .filter(
          (plugin) =>
            plugin.id !== moving.id &&
            plugin.channelId === moving.channelId &&
            plugin.role === moving.role
        )
        .sort((left, right) => left.slotOrder - right.slotOrder)
      const destination = rows
        .filter(
          (plugin) =>
            plugin.id !== moving.id &&
            plugin.channelId === command.channelId &&
            plugin.role === command.role
        )
        .sort((left, right) => left.slotOrder - right.slotOrder)
      if (command.role === "instrument" && destination.length > 0) {
        throw new Error("Replace the assigned instrument instead of moving into an occupied slot")
      }
      const insertionIndex =
        command.role === "instrument"
          ? 0
          : Math.max(0, Math.min(command.slotOrder, destination.length))
      destination.splice(insertionIndex, 0, {
        ...moving,
        channelId: command.channelId,
        role: command.role,
        slotOrder: insertionIndex
      })

      const affected = new Set([
        moving.id,
        ...source.map((plugin) => plugin.id),
        ...destination.map((plugin) => plugin.id)
      ])
      let temporarySlot = 1_000_000
      for (const id of affected) {
        await tx
          .update(pluginInstances)
          .set({ slotOrder: temporarySlot++ })
          .where(eq(pluginInstances.id, id))
      }
      for (const [index, plugin] of source.entries()) {
        await tx
          .update(pluginInstances)
          .set({
            channelId: moving.channelId,
            role: moving.role,
            slotOrder: moving.role === "instrument" ? 0 : index
          })
          .where(eq(pluginInstances.id, plugin.id))
      }
      for (const [index, plugin] of destination.entries()) {
        await tx
          .update(pluginInstances)
          .set({
            channelId: command.channelId,
            role: command.role,
            slotOrder: command.role === "instrument" ? 0 : index
          })
          .where(eq(pluginInstances.id, plugin.id))
      }
      return
    }
    case "replace-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      await replaceSidechainRoutes(tx, command.plugin.id, command.plugin.sidechainInputs)
  }
}
