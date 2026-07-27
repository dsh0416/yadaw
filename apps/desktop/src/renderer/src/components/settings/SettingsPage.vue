<script setup lang="ts">
defineProps<{
  category: string
  page: string
  title: string
  description: string
}>()

defineSlots<{
  default(): unknown
}>()
</script>

<template>
  <section class="settings-page">
    <header class="settings-page-intro">
      <span class="settings-page-path">
        {{ category }}
        <b aria-hidden="true">/</b>
        {{ page }}
      </span>
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </header>
    <div class="settings-page-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-page {
  min-width: 0;
  overflow: auto;
  padding: 38px clamp(30px, 4.5vw, 68px) 60px;
  background: var(--canvas);
}

.settings-page-intro,
.settings-page-body {
  max-width: 900px;
}

.settings-page-path {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
  text-transform: uppercase;
}

.settings-page-path b {
  margin: 0 5px;
  color: var(--text-faint);
  font-weight: var(--ui-type-weight-medium);
}

.settings-page-intro h2 {
  margin: 8px 0 6px;
  font: var(--ui-type-weight-semibold) var(--ui-font-size-2xl) var(--ui-type-family-display);
  letter-spacing: var(--ui-type-tracking-tight);
}

.settings-page-intro p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.settings-page-body {
  margin-top: 25px;
  border-top: 1px solid var(--line-soft);
}
</style>
