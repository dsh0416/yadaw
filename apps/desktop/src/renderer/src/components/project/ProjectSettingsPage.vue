<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { Save } from "@lucide/vue"
import type { ProjectConfiguration } from "@yadaw/contracts"
import ProjectGeneralSettings from "./ProjectGeneralSettings.vue"
import ProjectSettingsNavigation from "./ProjectSettingsNavigation.vue"

const props = defineProps<{
  configuration: ProjectConfiguration
  saving: boolean
  error: string
  saved: boolean
}>()
const emit = defineEmits<{ save: [configuration: ProjectConfiguration]; close: [] }>()
const draft = ref<ProjectConfiguration>({ ...props.configuration })

watch(() => props.configuration, (value) => {
  draft.value = { ...value }
})

const dirty = computed(() =>
  draft.value.name !== props.configuration.name ||
  draft.value.sampleRate !== props.configuration.sampleRate ||
  draft.value.tempo !== props.configuration.tempo ||
  draft.value.timeSignatureNumerator !== props.configuration.timeSignatureNumerator ||
  draft.value.timeSignatureDenominator !== props.configuration.timeSignatureDenominator
)
</script>

<template>
  <main class="project-settings-shell">
    <ProjectSettingsNavigation active-page="general" @close="emit('close')" />
    <form class="settings-workspace" @submit.prevent="emit('save', { ...draft })">
      <header class="workspace-header">
        <div>
          <span>PROJECT / GENERAL</span>
          <h1>Project Settings</h1>
          <p>Parameters stored inside this project and shared wherever it is opened.</p>
        </div>
        <div class="header-actions">
          <span v-if="error" role="alert" class="save-error">{{ error }}</span>
          <span v-else-if="saved && !dirty" role="status" class="save-status">Changes saved</span>
          <button type="submit" :disabled="saving || !dirty">
            <Save :size="14" />
            {{ saving ? "Saving…" : "Save changes" }}
          </button>
        </div>
      </header>
      <div class="workspace-scroll">
        <ProjectGeneralSettings v-model="draft" />
      </div>
    </form>
  </main>
</template>

<style scoped>
.project-settings-shell{display:grid;grid-template-columns:244px minmax(0,1fr);width:100vw;height:100vh;color:var(--text-primary);background:var(--canvas)}
.settings-workspace{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0}
.workspace-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:26px 34px 22px;border-bottom:1px solid var(--line-soft);background:#0d131c}
.workspace-header span,.workspace-header h1,.workspace-header p{display:block}
.workspace-header>div>span{color:var(--accent);font:700 7px var(--font-utility);letter-spacing:.17em}
.workspace-header h1{margin:8px 0 5px;font:580 27px/1 var(--font-display);letter-spacing:-.01em}
.workspace-header p{margin:0;color:var(--text-muted);font-size:9px}
.header-actions{display:flex;align-items:center;gap:13px}
.header-actions button{display:flex;align-items:center;gap:7px;padding:9px 13px;border:1px solid #7770d0;border-radius:7px;color:#f5f3ff;background:#423d83;font-size:9px;cursor:pointer}
.header-actions button:disabled{border-color:var(--line-strong);color:var(--text-faint);background:#181f2b;cursor:not-allowed}
.save-status{color:#7be3ed!important;font:8px var(--font-utility)!important;letter-spacing:0!important}
.save-error{max-width:280px;color:#ff9dab!important;font:8px var(--font-utility)!important;letter-spacing:0!important}
.workspace-scroll{overflow:auto;padding:28px 34px 46px}
@media(max-width:820px){.project-settings-shell{grid-template-columns:200px minmax(0,1fr)}.workspace-header{align-items:flex-start;flex-direction:column}.header-actions{width:100%;justify-content:flex-end}}
</style>
