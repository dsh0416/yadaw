import type { InjectionKey } from "vue"

/** Root searchable panel keydown handler; nested submenu portals must forward into it. */
export const uiMenuPanelKeydownKey: InjectionKey<(event: KeyboardEvent) => void> =
  Symbol("ui-menu-panel-keydown")
