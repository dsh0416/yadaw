<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { MoreHorizontal, Trash2 } from "@lucide/vue"
import { UiPopover } from "@yadaw/ui"

defineProps<{
  channelName: string
  color: string
  deletable: boolean
}>()

const emit = defineEmits<{
  updateColor: [color: string]
  delete: []
}>()

const { t } = useI18n()
</script>

<template>
  <UiPopover side="top" align="end" :side-offset="6">
    <template #trigger>
      <button
        class="menu-trigger"
        :aria-label="t('mixer.channelMenu.ariaLabel', { name: channelName })"
      >
        <MoreHorizontal :size="13" />
      </button>
    </template>
    <div class="channel-menu">
      <label>
        <span>{{ t("mixer.channelMenu.channelColor") }}</span>
        <input
          type="color"
          :value="color"
          :aria-label="t('mixer.channelMenu.colorAria', { name: channelName })"
          @change="
            emit('updateColor', ($event.currentTarget as HTMLInputElement).value.toUpperCase())
          "
        />
      </label>
      <button
        v-if="deletable"
        class="delete-action"
        :aria-label="t('mixer.channelMenu.deleteAria', { name: channelName })"
        @click="emit('delete')"
      >
        <Trash2 :size="12" />{{ t("mixer.channelMenu.delete") }}
      </button>
    </div>
  </UiPopover>
</template>

<style scoped>
.menu-trigger {
  display: grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--ui-domain-color-ffffff2c);
  border-radius: 3px;
  color: var(--ui-domain-color-fff);
  background: var(--ui-domain-color-00000024);
  cursor: pointer;
}
.menu-trigger:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.channel-menu {
  display: grid;
  width: 168px;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 14px 36px var(--ui-domain-color-00000075);
}
.channel-menu label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: var(--ui-type-size-control);
}
.channel-menu input {
  width: 36px;
  height: 24px;
  padding: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: var(--daw-control);
}
.delete-action {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 27px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--record) 55%, var(--line-strong));
  border-radius: 3px;
  color: var(--record);
  background: color-mix(in srgb, var(--record) 9%, var(--daw-control));
  font-size: var(--ui-type-size-control);
  cursor: pointer;
}
</style>
