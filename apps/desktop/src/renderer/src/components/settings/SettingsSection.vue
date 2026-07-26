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
  font: 700 7px var(--font-utility);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.settings-section-copy h3 {
  margin: 0 0 6px;
  font: 600 11px var(--font-display);
  letter-spacing: 0.01em;
}

.settings-section-copy p {
  margin: 0;
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1.55;
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
