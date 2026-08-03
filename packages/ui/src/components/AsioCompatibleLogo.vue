<script setup lang="ts">
import logo from "../assets/ASIO_Compatible_Logo_Steinberg.svg"

const props = withDefaults(
  defineProps<{
    decorative?: boolean
  }>(),
  {
    decorative: false
  }
)
</script>

<template>
  <img
    class="asio-compatible-logo"
    :src="logo"
    :alt="props.decorative ? '' : 'ASIO Compatible'"
    :aria-hidden="props.decorative ? 'true' : undefined"
  />
</template>

<style scoped>
.asio-compatible-logo {
  display: block;
  width: var(--asio-compatible-logo-width, 24mm);
  min-width: 20mm;
  min-height: 12mm;
  max-width: 100%;
  height: auto;
  object-fit: contain;
}
</style>
