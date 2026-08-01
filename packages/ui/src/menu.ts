export type UiMenuDensity = "compact" | "standard"
export type UiMenuTone = "default" | "danger"

interface UiMenuEntryBase {
  id: string
  label: string
  ariaLabel?: string
  title?: string
  leading?: string
  metadata?: string
  shortcut?: string
  keywords?: readonly string[]
  disabled?: boolean
  disabledReason?: string
}

export interface UiMenuItem extends UiMenuEntryBase {
  kind: "item"
  tone?: UiMenuTone
}

export interface UiMenuCheckboxItem extends UiMenuEntryBase {
  kind: "checkbox"
  checked: boolean
}

export type UiMenuRadioOption = UiMenuEntryBase

export interface UiMenuRadioGroup {
  kind: "radio-group"
  id: string
  label?: string
  value: string
  options: readonly UiMenuRadioOption[]
}

export interface UiMenuSubmenu extends UiMenuEntryBase {
  kind: "submenu"
  children: readonly UiMenuEntry[]
}

export interface UiMenuGroup {
  kind: "group"
  id: string
  label?: string
  children: readonly UiMenuEntry[]
}

export interface UiMenuSeparator {
  kind: "separator"
  id: string
}

export type UiMenuEntry =
  UiMenuItem | UiMenuCheckboxItem | UiMenuRadioGroup | UiMenuSubmenu | UiMenuGroup | UiMenuSeparator

export interface UiMenuSearchOptions {
  label: string
  placeholder?: string
  clearLabel?: string
  emptyMessage: string
  resultCountLabel?: string
  maxResults?: number
}

export interface UiMenuSearchResults {
  entries: readonly UiMenuEntry[]
  total: number
}

interface UiMenuSearchCandidate {
  entry: UiMenuItem | UiMenuCheckboxItem | UiMenuRadioGroup
  label: string
  keywords: readonly string[]
  path: readonly string[]
  order: number
}

const wordBoundaryPattern = /[^\p{L}\p{N}]+/u
const combiningMarkPattern = /\p{M}/gu

export function normalizeMenuSearchText(value: string): string {
  return value.normalize("NFKD").replace(combiningMarkPattern, "").toLocaleLowerCase().trim()
}

export function searchMenuEntries(
  entries: readonly UiMenuEntry[],
  query: string,
  maxResults = 100
): UiMenuSearchResults {
  const normalizedQuery = normalizeMenuSearchText(query)
  if (!normalizedQuery) return { entries, total: countMenuTerminals(entries) }

  const candidates: UiMenuSearchCandidate[] = []
  collectSearchCandidates(entries, [], candidates)

  const matches = candidates
    .map((candidate) => ({
      candidate,
      rank: matchRank(candidate, normalizedQuery)
    }))
    .filter((match): match is { candidate: UiMenuSearchCandidate; rank: number } =>
      Number.isFinite(match.rank)
    )
    .sort((left, right) => left.rank - right.rank || left.candidate.order - right.candidate.order)

  return {
    total: matches.length,
    entries: matches.slice(0, Math.max(1, maxResults)).map(({ candidate }) => {
      const breadcrumb = candidate.path.join(" / ")
      const metadata =
        candidate.entry.kind === "radio-group"
          ? undefined
          : joinMetadata(candidate.entry.metadata, breadcrumb)

      if (candidate.entry.kind === "radio-group") {
        const option = candidate.entry.options[0]
        if (!option) return candidate.entry
        return {
          ...candidate.entry,
          id: `${candidate.entry.id}:search:${option.id}`,
          options: [
            {
              ...option,
              metadata: joinMetadata(option.metadata, breadcrumb)
            }
          ]
        }
      }

      return { ...candidate.entry, metadata }
    })
  }
}

export function countMenuTerminals(entries: readonly UiMenuEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.kind === "submenu" || entry.kind === "group") {
      return total + countMenuTerminals(entry.children)
    }
    if (entry.kind === "radio-group") return total + entry.options.length
    if (entry.kind === "separator") return total
    return total + 1
  }, 0)
}

export function menuHasDetails(entries: readonly UiMenuEntry[]): boolean {
  return entries.some((entry) => {
    if (entry.kind === "submenu" || entry.kind === "group") {
      return menuHasDetails(entry.children)
    }
    if (entry.kind === "radio-group") {
      return entry.options.some((option) =>
        Boolean(option.leading || option.metadata || option.shortcut)
      )
    }
    if (entry.kind === "separator") return false
    return Boolean(entry.leading || entry.metadata || entry.shortcut)
  })
}

function collectSearchCandidates(
  entries: readonly UiMenuEntry[],
  path: readonly string[],
  candidates: UiMenuSearchCandidate[]
): void {
  for (const entry of entries) {
    if (entry.kind === "separator") continue

    if (entry.kind === "submenu" || entry.kind === "group") {
      const nextPath = entry.label ? [...path, entry.label] : path
      collectSearchCandidates(entry.children, nextPath, candidates)
      continue
    }

    if (entry.kind === "radio-group") {
      const nextPath = entry.label ? [...path, entry.label] : path
      for (const option of entry.options) {
        candidates.push({
          entry: { ...entry, label: undefined, options: [option] },
          label: option.label,
          keywords: option.keywords ?? [],
          path: nextPath,
          order: candidates.length
        })
      }
      continue
    }

    candidates.push({
      entry,
      label: entry.label,
      keywords: entry.keywords ?? [],
      path,
      order: candidates.length
    })
  }
}

function matchRank(candidate: UiMenuSearchCandidate, query: string): number {
  const label = normalizeMenuSearchText(candidate.label)
  if (label.startsWith(query)) return 0
  if (label.split(wordBoundaryPattern).some((word) => word.startsWith(query))) return 1
  if (label.includes(query)) return 2

  const category = normalizeMenuSearchText(candidate.path.join(" "))
  if (category.includes(query)) return 3

  const keywordMatch = candidate.keywords.some((keyword) =>
    normalizeMenuSearchText(keyword).includes(query)
  )
  return keywordMatch ? 4 : Number.POSITIVE_INFINITY
}

function joinMetadata(metadata: string | undefined, breadcrumb: string): string | undefined {
  if (!breadcrumb) return metadata
  if (!metadata) return breadcrumb
  return `${metadata} · ${breadcrumb}`
}
