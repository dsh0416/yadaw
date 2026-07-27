<script setup lang="ts">
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform
} from "@yadaw/contracts"
import { YadawLogo, type UiMenubarMenu } from "@yadaw/ui"
import ApplicationMenuBar from "./ApplicationMenuBar.vue"
import AppWindowControls from "./AppWindowControls.vue"

defineProps<{
  platform: DesktopPlatform
  menus: UiMenubarMenu[]
  projectName: string | null
  dirty: boolean
}>()

const emit = defineEmits<{
  command: [command: ApplicationCommandId]
  windowCommand: [command: ApplicationWindowCommandId]
}>()
</script>

<template>
  <header class="app-titlebar" :data-platform="platform">
    <div class="app-titlebar__safe-area">
      <div class="app-titlebar__identity">
        <YadawLogo class="app-titlebar__logo" />
      </div>

      <ApplicationMenuBar
        v-if="platform !== 'darwin'"
        :menus="menus"
        @command="emit('command', $event)"
      />

      <div class="app-titlebar__drag">
        <span v-if="projectName" class="app-titlebar__project">
          <i v-if="dirty" title="Unsaved changes" aria-label="Unsaved changes" />
          {{ projectName }}
        </span>
        <span v-else class="app-titlebar__project app-titlebar__project--empty">
          No project open
        </span>
      </div>

      <AppWindowControls v-if="platform === 'win32'" @command="emit('windowCommand', $event)" />
    </div>
  </header>
</template>

<style scoped>
.app-titlebar {
  position: relative;
  z-index: var(--ui-z-local-header);
  min-width: 0;
  height: 38px;
  border-bottom: 1px solid var(--line-strong);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface-2) 76%, var(--surface-1)),
    var(--surface-panel)
  );
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent) inset;
  user-select: none;
}

.app-titlebar__safe-area {
  position: absolute;
  top: env(titlebar-area-y, 0);
  left: env(titlebar-area-x, 0);
  display: flex;
  align-items: center;
  width: env(titlebar-area-width, 100%);
  height: env(titlebar-area-height, 38px);
  min-width: 0;
  gap: 7px;
  padding: 0 9px;
}

.app-titlebar[data-platform="darwin"] .app-titlebar__safe-area {
  padding-left: 78px;
}

.app-titlebar[data-platform="win32"] .app-titlebar__safe-area {
  padding-right: 5px;
}

.app-titlebar__identity {
  display: flex;
  align-items: center;
  flex: none;
  color: var(--text-secondary);
}

.app-titlebar__logo {
  color: var(--accent);
  font-size: 12px;
}

.app-titlebar__drag {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 100%;
  flex: 1;
  padding-right: 72px;
  app-region: drag;
  -webkit-app-region: drag;
}

.app-titlebar[data-platform="win32"] .app-titlebar__drag {
  padding-right: 0;
}

.app-titlebar__project {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  overflow: hidden;
  color: var(--text-muted);
  font: 8px var(--font-utility);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-titlebar__project i {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning) 15%, transparent);
}

.app-titlebar__project--empty {
  color: var(--text-faint);
}

@media (max-width: 980px) {
  .app-titlebar__logo {
    --yadaw-logo-wordmark-display: none;
  }

  .app-titlebar__drag {
    justify-content: flex-end;
    padding-right: 12px;
  }
}
</style>
