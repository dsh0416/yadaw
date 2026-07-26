import type { Component } from "vue"

export interface SettingsPageDefinition {
  id: string
  label: string
  description: string
  icon: Component
  disabled?: boolean
  badge?: string
}

export interface SettingsCategory {
  id: string
  label: string
  description: string
  icon: Component
  pages: readonly SettingsPageDefinition[]
  disabled?: boolean
  badge?: string
}
