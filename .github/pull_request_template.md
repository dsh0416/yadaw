<!--
Title: use Conventional Commits, e.g.
  feat(desktop): add piano-roll note drag
  fix(audio-host): recover after device disconnect
  chore: bump version to v0.x.y
-->

## Summary

<!-- State the user, product, maintenance, or reliability outcome. Prefer purpose over a file list. -->

-

## Tracking

<!-- Link the issue when one exists. Every exception, TODO/FIXME, or deferred correctness item requires one. -->

- Issue: <!-- Closes #... / Relates to #... / None -->

## Governance review

<!-- Check each line after reviewing the linked rule. Use the notes below for evidence or explain N/A. -->

- [ ] [Engineering standards](https://github.com/minori-live/heron/blob/main/agents/docs/engineering-standards.md): ownership, failure states, tests, documentation, and source cohesion are addressed.
- [ ] [Architecture](https://github.com/minori-live/heron/blob/main/agents/docs/architecture.md): dependency direction, process/thread ownership, protocols, and real-time constraints are preserved or updated.
- [ ] [Interaction design](https://github.com/minori-live/heron/blob/main/agents/docs/interaction-design.md): affected workflows follow the documented DAW behavior, feedback, accessibility, and recovery rules.
- [ ] [ADR governance](https://github.com/minori-live/heron/blob/main/agents/docs/adr/README.md): no ADR trigger applies, or the accepted/proposed ADR and its status are linked below.
- [ ] Exceptions, TODOs/FIXMEs, and deferred correctness work are absent or linked to a scoped issue.

<!--
Engineering evidence / N/A reason:
Architecture impact / N/A reason:
Interaction impact / N/A reason:
ADR or exception link:
-->

## Test plan

<!-- How you validated this. Check boxes as you go. -->

- [ ] `mise run check` (or narrower package-level checks noted below)
- [ ]
- [ ]

## Notes for reviewers

<!-- Risk areas, highest-risk behavior, real-time/process-boundary impact, and issue-linked follow-ups. -->
