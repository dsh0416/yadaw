import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue"
import type { Ref } from "vue"
import type { ThemePreference } from "@yadaw/contracts"

export type ResolvedTheme = Exclude<ThemePreference, "system">

export function useTheme(preference: Readonly<Ref<ThemePreference>>) {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  const systemDark = shallowRef(mediaQuery.matches)
  const resolvedTheme = computed<ResolvedTheme>(() =>
    preference.value === "system"
      ? (systemDark.value ? "dark" : "light")
      : preference.value
  )
  function readSystemTheme(event?: MediaQueryListEvent): void {
    systemDark.value = event?.matches ?? mediaQuery.matches
  }

  onMounted(() => {
    mediaQuery.addEventListener("change", readSystemTheme)
  })

  onUnmounted(() => {
    mediaQuery.removeEventListener("change", readSystemTheme)
  })

  watch(
    resolvedTheme,
    (theme) => {
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    },
    { immediate: true }
  )

  return { resolvedTheme }
}
