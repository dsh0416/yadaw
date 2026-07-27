<script setup lang="ts">
import type { ApplicationSettings, CreateProjectRequest } from "@yadaw/contracts"
import { YadawLogo } from "@yadaw/ui"

defineProps<{ settings: ApplicationSettings | null; busy: boolean; error: string }>()
const emit = defineEmits<{ create: [request: CreateProjectRequest]; open: [path?: string] }>()

function createProject(): void {
  emit("create", {
    name: "Untitled project",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  })
}
</script>

<template>
  <main class="welcome-shell">
    <section class="welcome-card">
      <div class="welcome-brand">
        <YadawLogo class="welcome-logo" />
        <h1>Build a session that survives the unexpected.</h1>
        <p>
          Projects are self-contained PGlite archives. Recordings remain recoverable in swap until
          the archive is saved.
        </p>
      </div>
      <section class="new-project">
        <span>NEW PROJECT</span>
        <h2>Start with a clean session.</h2>
        <p>
          48 kHz · 4/4 · Tempo Track starts at 120 BPM. Name and format can be changed later in
          Project settings.
        </p>
        <button :disabled="busy" type="button" @click="createProject">
          {{ busy ? "Creating…" : "Create project" }}
        </button>
      </section>
      <section class="recent-projects">
        <div class="recent-heading">
          <span>RECENT PROJECTS</span>
          <button :disabled="busy" @click="emit('open')">Open another…</button>
        </div>
        <button
          v-for="recent in settings?.recentProjects"
          :key="recent.path"
          class="recent-item"
          :disabled="busy"
          @click="emit('open', recent.path)"
        >
          <b>{{ recent.name }}</b>
          <small>{{ recent.path }}</small>
        </button>
        <p v-if="!settings?.recentProjects.length">No recent projects yet.</p>
      </section>
      <p v-if="error" role="alert" class="welcome-error">{{ error }}</p>
    </section>
  </main>
</template>

<style scoped>
.welcome-shell {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 38px;
  background:
    radial-gradient(circle at 20% 10%, var(--ui-domain-color-2e285f66), transparent 34%),
    radial-gradient(circle at 80% 90%, var(--ui-domain-color-17394355), transparent 36%),
    var(--canvas);
}
.welcome-card {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(330px, 1fr);
  width: min(1000px, 100%);
  max-height: 100%;
  gap: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--line-soft);
  box-shadow: var(--ui-shadow-lg);
  overflow: auto;
}
.welcome-brand,
.new-project,
.recent-projects {
  padding: 34px;
  background: var(--ui-domain-color-101620);
}
.welcome-brand {
  grid-row: span 2;
  background: linear-gradient(155deg, var(--ui-domain-color-171735), var(--ui-domain-color-0d1620));
}
.welcome-logo,
.new-project > span,
.recent-heading > span {
  color: var(--accent);
  font: var(--ui-type-weight-bold) var(--ui-type-size-control) var(--ui-type-family-data);
  letter-spacing: var(--ui-type-tracking-widest);
}
.welcome-logo {
  --yadaw-logo-highlight: var(--signal-cyan);

  font-size: var(--ui-font-size-sm);
  letter-spacing: var(--ui-type-tracking-normal);
}
.welcome-brand h1 {
  margin: 18px 0 12px;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-hero) / var(--ui-type-leading-tight)
    var(--ui-type-family-display);
  letter-spacing: var(--ui-type-tracking-tight);
}
.welcome-brand p,
.new-project p,
.recent-projects > p {
  color: var(--text-muted);
  font-size: var(--ui-type-size-label);
  line-height: var(--ui-type-leading-relaxed);
}
.new-project {
  display: grid;
  align-content: start;
  gap: 13px;
}
.new-project h2 {
  margin: 6px 0 0;
  font: var(--ui-type-weight-semibold) var(--ui-type-size-page-title) / var(--ui-type-leading-tight)
    var(--ui-type-family-display);
}
.new-project p {
  margin: 0;
}
.new-project button,
.recent-heading button {
  padding: 9px 13px;
  border: 1px solid var(--ui-domain-color-7770d0);
  border-radius: 7px;
  color: var(--ui-domain-color-f2f0ff);
  background: var(--ui-domain-color-423d83);
  cursor: pointer;
}
.new-project button {
  margin-top: 8px;
}
.recent-projects {
  display: grid;
  gap: 7px;
  padding-top: 24px;
}
.recent-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.recent-heading button {
  padding: 6px 9px;
  border-color: var(--line-strong);
  color: var(--text-secondary);
  background: var(--surface-3);
  font-size: var(--ui-type-size-control);
}
.recent-item {
  display: grid;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--ui-domain-color-0c121b);
  text-align: left;
  cursor: pointer;
}
.recent-item b {
  font-size: var(--ui-type-size-label);
}
.recent-item small {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-faint);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.welcome-error {
  grid-column: 1/-1;
  margin: 0;
  padding: 10px 18px;
  color: var(--ui-domain-color-ff9dab);
  background: var(--ui-domain-color-321923);
  font-size: var(--ui-type-size-body-compact);
}
@media (max-width: 800px) {
  .welcome-card {
    grid-template-columns: 1fr;
  }
  .welcome-brand {
    grid-row: auto;
  }
}
</style>
