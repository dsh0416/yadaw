<script setup lang="ts">
defineProps<{
  eyebrow?: string
  title: string
  description: string
}>()

defineSlots<{
  default(): unknown
}>()
</script>

<template>
  <section class="settings-section">
    <header class="settings-section-copy">
      <span v-if="eyebrow">{{ eyebrow }}</span>
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
    </header>
    <div class="settings-section-control">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.settings-section {
  display: grid;
  grid-template-columns: minmax(170px, 230px) minmax(0, 1fr);
  gap: 48px;
  padding: 25px 0;
  border-bottom: 1px solid var(--line-soft);
}

.settings-section-copy span {
  display: block;
  margin-bottom: 7px;
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.settings-section-copy h3 {
  margin: 0 0 6px;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-section-title)
    var(--ui-type-family-display);
  letter-spacing: var(--ui-type-tracking-wide);
}

.settings-section-copy p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-normal);
}

.settings-section-control {
  min-width: 0;
}

@media (max-width: 1120px) {
  .settings-section {
    grid-template-columns: 1fr;
    gap: 17px;
  }
}
</style>
