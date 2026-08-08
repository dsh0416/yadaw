import type { ProjectAssetSummary } from "@heron/contracts"

export const PROJECT_MEDIA_DRAG_TYPE = "application/x-heron-project-media"

export interface ProjectMediaDragPayload {
  assetId: string
  kind: ProjectAssetSummary["kind"]
}

export function writeProjectMediaDrag(transfer: DataTransfer, asset: ProjectAssetSummary): void {
  transfer.effectAllowed = "copy"
  transfer.setData(
    PROJECT_MEDIA_DRAG_TYPE,
    JSON.stringify({ assetId: asset.id, kind: asset.kind } satisfies ProjectMediaDragPayload)
  )
}

export function readProjectMediaDrag(
  transfer: DataTransfer | null
): ProjectMediaDragPayload | null {
  if (!transfer) return null
  const value = transfer.getData(PROJECT_MEDIA_DRAG_TYPE)
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ProjectMediaDragPayload>
    return typeof parsed.assetId === "string" && (parsed.kind === "audio" || parsed.kind === "midi")
      ? { assetId: parsed.assetId, kind: parsed.kind }
      : null
  } catch {
    return null
  }
}
