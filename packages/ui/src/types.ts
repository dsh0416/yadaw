export type UiActionVariant = "primary" | "secondary" | "ghost" | "danger"
export type UiControlSize = "sm" | "md" | "lg"
export type UiSelectSize = "compact" | UiControlSize
export type UiNoticeTone = "neutral" | "info" | "success" | "warning" | "danger"

export interface UiSelectOption {
  label: string
  value: string
  disabled?: boolean
}

export interface UiSegmentedOption extends UiSelectOption {
  ariaLabel?: string
}

export interface UiSelectGroup {
  label: string
  options: readonly UiSelectOption[]
  separatorBefore?: boolean
}

export interface UiCascadingSelectGroup {
  label: string
  options: readonly UiSelectOption[]
  disabled?: boolean
}

export interface UiCascadingMenuItem {
  label: string
  value?: string
  ariaLabel?: string
  title?: string
  leading?: string
  trailing?: string
  disabled?: boolean
  children?: readonly UiCascadingMenuItem[]
}

export interface UiRadioOption extends UiSelectOption {
  description?: string
}

export interface UiAlertAction {
  value: string
  label: string
  variant?: UiActionVariant
  cancel?: boolean
}

export interface UiMenubarItem {
  value: string
  label: string
  shortcut?: string
  disabled?: boolean
  separatorBefore?: boolean
}

export interface UiMenubarMenu {
  value: string
  label: string
  items: UiMenubarItem[]
}
