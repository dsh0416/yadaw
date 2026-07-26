<script setup lang="ts">
import { nextTick, shallowRef, useTemplateRef } from "vue"

const props = defineProps<{
  name: string
  label: string
}>()

const emit = defineEmits<{
  rename: [name: string]
}>()

const editing = shallowRef(false)
const draft = shallowRef("")
const input = useTemplateRef<HTMLInputElement>("input")

function beginEditing(): void {
  draft.value = props.name
  editing.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

function commit(): void {
  if (!editing.value) return
  const name = draft.value.trim()
  editing.value = false
  if (name && name !== props.name) emit("rename", name)
}

function cancel(): void {
  editing.value = false
}
</script>

<template>
  <span class="inline-track-name">
    <input
      v-if="editing"
      ref="input"
      v-model="draft"
      class="inline-track-name-input"
      :aria-label="`Rename ${name}`"
      @blur="commit"
      @click.stop
      @dblclick.stop
      @keydown.enter.stop.prevent="commit"
      @keydown.esc.stop.prevent="cancel"
      @pointerdown.stop
    />
    <button
      v-else
      class="inline-track-name-value"
      type="button"
      :aria-label="label"
      :title="`${name} — Double-click to rename`"
      @dblclick.stop.prevent="beginEditing"
      @keydown.f2.stop.prevent="beginEditing"
    >
      {{ name }}
    </button>
  </span>
</template>

<style scoped>
.inline-track-name {
  display: block;
  min-width: 0;
}

.inline-track-name-value {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}

.inline-track-name-input {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-width: 0;
  height: 20px;
  padding: 1px 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  outline: none;
  color: var(--text-primary);
  background: #090e16;
  box-shadow: 0 0 0 2px #8c83ff2e;
  font: inherit;
}
</style>
