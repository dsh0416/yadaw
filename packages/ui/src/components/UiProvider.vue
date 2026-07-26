<script setup lang="ts">
import { ConfigProvider, TooltipProvider } from "reka-ui"

withDefaults(
  defineProps<{
    dir?: "ltr" | "rtl"
    locale?: string
    tooltipDelay?: number
    tooltipSkipDelay?: number
    disableTooltipHoverableContent?: boolean
  }>(),
  {
    dir: "ltr",
    locale: "en",
    tooltipDelay: 500,
    tooltipSkipDelay: 300,
    disableTooltipHoverableContent: false
  }
)
</script>

<template>
  <ConfigProvider :dir="dir" :locale="locale">
    <TooltipProvider
      :delay-duration="tooltipDelay"
      :skip-delay-duration="tooltipSkipDelay"
      :disable-hoverable-content="disableTooltipHoverableContent"
    >
      <slot />
    </TooltipProvider>
  </ConfigProvider>
</template>
