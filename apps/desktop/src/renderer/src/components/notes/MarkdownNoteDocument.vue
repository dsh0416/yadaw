<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import DOMPurify from "dompurify"
import { marked } from "marked"
import { FilePenLine } from "@lucide/vue"
import { UiButton } from "@heron/ui"

const props = defineProps<{
  content: string
  draft: string
  editing: boolean
  saving: boolean
  emptyTitle: string
  emptyDescription: string
  unavailableDescription?: string
}>()

const emit = defineEmits<{
  edit: []
  cancel: []
  save: []
  updateDraft: [value: string]
}>()

const { t } = useI18n()
const editor = useTemplateRef<HTMLTextAreaElement>("editor")
const renderer = new marked.Renderer()

renderer.html = ({ text }) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  )
renderer.link = ({ tokens }) => renderer.parser.parseInline(tokens)
renderer.image = () => ""

const renderedMarkdown = computed(() =>
  DOMPurify.sanitize(marked.parse(props.content, { async: false, renderer }), {
    FORBID_TAGS: ["a", "img", "script", "style", "iframe", "object", "embed"],
    USE_PROFILES: { html: true }
  })
)

function draftFromInput(event: Event): void {
  emit("updateDraft", (event.target as HTMLTextAreaElement).value)
}

function handleEditorKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault()
    emit("save")
  }
}

watch(
  () => props.editing,
  async (editing) => {
    if (!editing) return
    await nextTick()
    editor.value?.focus()
  }
)
</script>

<template>
  <div class="note-document">
    <template v-if="unavailableDescription">
      <div class="empty-state muted">
        <FilePenLine :size="22" aria-hidden="true" />
        <p>{{ unavailableDescription }}</p>
      </div>
    </template>

    <template v-else-if="editing">
      <label class="editor-label" for="notes-markdown-editor">
        {{ t("studio.notes.markdownLabel") }}
      </label>
      <textarea
        id="notes-markdown-editor"
        ref="editor"
        class="markdown-editor"
        :value="draft"
        :placeholder="t('studio.notes.editorPlaceholder')"
        spellcheck="true"
        @input="draftFromInput"
        @keydown="handleEditorKeydown"
      />
      <div class="editor-footer">
        <span>{{ t("studio.notes.saveShortcut") }}</span>
        <div class="editor-actions">
          <UiButton size="sm" :disabled="saving" @click="emit('cancel')">
            {{ t("studio.notes.cancel") }}
          </UiButton>
          <UiButton size="sm" variant="primary" :disabled="saving" @click="emit('save')">
            {{ saving ? t("studio.notes.saving") : t("studio.notes.save") }}
          </UiButton>
        </div>
      </div>
    </template>

    <template v-else>
      <button class="edit-button" type="button" @click="emit('edit')">
        <FilePenLine :size="14" aria-hidden="true" />
        {{ t("studio.notes.edit") }}
      </button>
      <!-- Markdown is escaped during parsing, then sanitized before rendering. -->
      <!-- eslint-disable vue/no-v-html -->
      <article
        v-if="content.trim()"
        class="markdown-preview"
        data-testid="markdown-preview"
        v-html="renderedMarkdown"
      />
      <!-- eslint-enable vue/no-v-html -->
      <div v-else class="empty-state">
        <FilePenLine :size="22" aria-hidden="true" />
        <strong>{{ emptyTitle }}</strong>
        <p>{{ emptyDescription }}</p>
        <button type="button" @click="emit('edit')">{{ t("studio.notes.startWriting") }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.note-document {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 14px;
  overflow: hidden;
}

.edit-button {
  display: inline-flex;
  align-items: center;
  align-self: flex-end;
  gap: 6px;
  margin-bottom: 10px;
  padding: 5px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  color: var(--text-muted);
  background: var(--daw-control);
  cursor: pointer;
  font-size: var(--ui-type-size-caption);
}

.edit-button:hover,
.edit-button:focus-visible {
  border-color: var(--line-strong);
  color: var(--text-primary);
}

.edit-button:focus-visible,
.empty-state button:focus-visible,
.markdown-editor:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.markdown-preview {
  min-height: 0;
  padding: 2px 5px 24px;
  overflow-y: auto;
  color: var(--text-secondary);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-relaxed);
  user-select: text;
}

.markdown-preview :deep(:is(h1, h2, h3, h4)) {
  margin: 1.25em 0 0.45em;
  color: var(--text-primary);
  font-family: var(--ui-type-family-display);
  line-height: var(--ui-type-leading-tight);
}

.markdown-preview :deep(h1) {
  margin-top: 0;
  font-size: var(--ui-type-size-page-title);
}

.markdown-preview :deep(h2) {
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--ui-type-size-feature-title);
}

.markdown-preview :deep(h3) {
  font-size: var(--ui-type-size-view-title);
}

.markdown-preview :deep(:is(p, ul, ol, blockquote, pre)) {
  margin: 0 0 0.9em;
}

.markdown-preview :deep(:is(ul, ol)) {
  padding-left: 1.4rem;
}

.markdown-preview :deep(blockquote) {
  padding: 2px 0 2px 11px;
  border-left: 2px solid var(--accent);
  color: var(--text-muted);
}

.markdown-preview :deep(:is(code, pre)) {
  font-family: var(--ui-type-family-data);
}

.markdown-preview :deep(code) {
  padding: 0.12em 0.35em;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  color: var(--accent-soft);
  background: var(--surface-sunken);
}

.markdown-preview :deep(pre) {
  padding: 10px;
  overflow-x: auto;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--surface-sunken);
}

.markdown-preview :deep(pre code) {
  padding: 0;
  border: 0;
  color: var(--text-secondary);
  background: transparent;
}

.markdown-preview :deep(hr) {
  height: 1px;
  margin: 1.2em 0;
  border: 0;
  background: var(--line-soft);
}

.empty-state {
  display: grid;
  justify-items: center;
  margin: auto;
  padding: 26px 18px;
  color: var(--text-faint);
  text-align: center;
}

.empty-state svg {
  margin-bottom: 12px;
  color: var(--accent-soft);
}

.empty-state strong {
  color: var(--text-secondary);
  font-family: var(--ui-type-family-display);
  font-size: var(--ui-type-size-panel-title);
}

.empty-state p {
  max-width: 220px;
  margin: 7px 0 14px;
  font-size: var(--ui-type-size-caption);
  line-height: var(--ui-type-leading-normal);
}

.empty-state button {
  padding: 5px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  color: var(--text-secondary);
  background: var(--daw-control);
  cursor: pointer;
  font-size: var(--ui-type-size-caption);
}

.empty-state.muted svg {
  color: var(--text-faint);
}

.editor-label {
  margin: 0 2px 7px;
  color: var(--text-faint);
  font: var(--ui-type-weight-bold) var(--ui-type-size-caption) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-wider);
  text-transform: uppercase;
}

.markdown-editor {
  width: 100%;
  min-height: 0;
  flex: 1;
  resize: none;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--surface-sunken);
  font-family: var(--ui-type-family-data);
  font-size: var(--ui-type-size-body-compact);
  line-height: var(--ui-type-leading-relaxed);
  tab-size: 2;
}

.markdown-editor::placeholder {
  color: var(--text-faint);
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
}

.editor-footer > span {
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.editor-actions {
  display: flex;
  gap: 6px;
}
</style>
