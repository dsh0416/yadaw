import { usePreferredDark } from "@vueuse/core"
import { computed, watch } from "vue"
import type { Ref } from "vue"
import type { ThemePreference } from "@heron/contracts"

export type ResolvedTheme = Exclude<ThemePreference, "system">

export function useTheme(preference: Readonly<Ref<ThemePreference>>) {
  const systemDark = usePreferredDark()
  const resolvedTheme = computed<ResolvedTheme>(() =>
    preference.value === "system" ? (systemDark.value ? "dark" : "light") : preference.value
  )

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
