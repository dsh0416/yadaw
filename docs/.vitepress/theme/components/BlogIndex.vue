<script setup lang="ts">
import { withBase } from "vitepress"
import { data as posts } from "../../posts.data"

function formatDisplayDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${isoDate}T00:00:00Z`))
}
</script>

<template>
  <main class="blog">
    <header class="blog__header">
      <p class="blog__eyebrow">Development log</p>
      <h1 class="blog__title">Notes from building YADAW.</h1>
      <p class="blog__lead">
        Short posts about milestones, architecture choices, and the work between releases.
      </p>
    </header>

    <ul v-if="posts.length > 0" class="blog__list">
      <li v-for="post in posts" :key="post.url" class="blog__item">
        <a class="blog__link" :href="withBase(post.url)">
          <time class="blog__date" :datetime="post.date">
            {{ formatDisplayDate(post.date) }}
          </time>
          <h2 class="blog__post-title">{{ post.title }}</h2>
          <p v-if="post.description" class="blog__description">{{ post.description }}</p>
          <ul v-if="post.tags.length > 0" class="blog__tags" aria-label="Tags">
            <li v-for="tag in post.tags" :key="tag">{{ tag }}</li>
          </ul>
        </a>
      </li>
    </ul>

    <p v-else class="blog__empty">No posts yet.</p>
  </main>
</template>

<style scoped>
.blog {
  box-sizing: border-box;
  width: min(720px, calc(100% - 48px));
  margin: 0 auto;
  padding: 72px 0 96px;
}

.blog__eyebrow {
  margin: 0 0 16px;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--heron-cyan);
}

.blog__title {
  margin: 0;
  font-family: var(--heron-display);
  font-size: clamp(36px, 6vw, 52px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
  color: var(--vp-c-text-1);
}

.blog__lead {
  margin: 18px 0 0;
  max-width: 46ch;
  font-size: 17px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.blog__list {
  display: grid;
  gap: 12px;
  margin: 48px 0 0;
  padding: 0;
  list-style: none;
}

.blog__item {
  margin: 0;
}

.blog__link {
  display: grid;
  gap: 10px;
  padding: 22px 0;
  border-top: 1px solid var(--vp-c-divider);
  text-decoration: none;
  color: inherit;
  transition: color 160ms ease;
}

.blog__item:last-child .blog__link {
  border-bottom: 1px solid var(--vp-c-divider);
}

.blog__link:hover .blog__post-title {
  color: var(--heron-cyan);
}

.blog__date {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}

.blog__post-title {
  margin: 0;
  font-family: var(--heron-display);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.025em;
  color: var(--vp-c-text-1);
  transition: color 160ms ease;
}

.blog__description {
  margin: 0;
  font-size: 15px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.blog__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.blog__tags li {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}

.blog__empty {
  margin: 48px 0 0;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-3);
}

@media (prefers-reduced-motion: reduce) {
  .blog__link,
  .blog__post-title {
    transition: none;
  }
}
</style>
