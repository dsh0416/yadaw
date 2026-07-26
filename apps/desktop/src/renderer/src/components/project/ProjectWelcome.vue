<script setup lang="ts">
import type { ApplicationSettings, CreateProjectRequest } from "@yadaw/contracts"

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
        <span>YADAW</span>
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
  width: 100vw;
  height: 100vh;
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
.welcome-brand > span,
.new-project > span,
.recent-heading > span {
  color: var(--accent);
  font: 700 8px var(--font-utility);
  letter-spacing: 0.18em;
}
.welcome-brand h1 {
  margin: 18px 0 12px;
  font: 560 34px/1.08 var(--font-display);
  letter-spacing: -0.02em;
}
.welcome-brand p,
.new-project p,
.recent-projects > p {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}
.new-project {
  display: grid;
  align-content: start;
  gap: 13px;
}
.new-project h2 {
  margin: 6px 0 0;
  font: 560 21px/1.1 var(--font-display);
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
  font-size: 8px;
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
  font-size: 10px;
}
.recent-item small {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-faint);
  font: 7px var(--font-utility);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.welcome-error {
  grid-column: 1/-1;
  margin: 0;
  padding: 10px 18px;
  color: var(--ui-domain-color-ff9dab);
  background: var(--ui-domain-color-321923);
  font-size: 9px;
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
