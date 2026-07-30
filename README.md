# YADAW

[![CI](https://github.com/dsh0416/yadaw/actions/workflows/ci.yml/badge.svg)](https://github.com/dsh0416/yadaw/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/tag/dsh0416/yadaw?label=version)](https://github.com/dsh0416/yadaw/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Status](https://img.shields.io/badge/status-experimental-orange)

**Yet Another Digital Audio Workstation**

YADAW is a free and open-source digital audio workstation for creating,
recording, and performing music. It aims to provide a fast, dependable creative
environment across Windows, macOS, and Linux—one that can follow an idea from
its first sketch to a finished production or a live stage.

YADAW is currently experimental and under active development. It is not yet
recommended for production sessions or live performances.

## Vision

Music-making should not require choosing between creative freedom, technical
control, and reliable performance. YADAW's long-term vision is a single,
coherent workspace that serves:

- **Composition and production** — arranging audio and MIDI, shaping sounds,
  automating ideas, and moving quickly from sketch to full arrangement.
- **Recording and mixing** — capturing performances with low latency, editing
  non-destructively, routing signals flexibly, and delivering a finished mix.
- **Live performance** — preparing material in the studio and bringing the same
  instruments, effects, routing, and musical ideas to the stage.

These workflows should reinforce one another instead of living as separate
products or incompatible project formats.

## Project goals

- **High and predictable performance.** Keep the audio path low-latency,
  real-time safe, and stable as sessions grow.
- **A genuinely cross-platform experience.** Make the same core workflow and
  project available on Windows, macOS, and Linux while integrating well with
  each platform's audio system.
- **Freedom and user ownership.** Keep YADAW free software, keep creative work
  under the user's control, and avoid making a service account or subscription
  a prerequisite for making music.
- **Interoperability.** Work with established plug-in ecosystems, audio and MIDI
  hardware, and common media formats rather than creating a closed island.
- **An approachable workflow with room to grow.** Support direct,
  discoverable creation without hiding the routing, timing, and processing
  control needed for demanding work.
- **Reliability from studio to stage.** Treat project integrity, recovery,
  diagnostics, and graceful handling of device or plug-in failures as product
  features.
- **A community-shaped tool.** Develop in the open so musicians, engineers,
  performers, and developers can inspect it, adapt it, and influence its
  direction.

## Current direction

The foundation is in place: a native real-time audio engine, project
persistence, arrangement and mixer workflows, audio recording, MIDI clips, and
VST3 hosting. The next primary focus is composition depth—especially MIDI
editing and the piano roll—then mixing/export, live performance, and finally a
broader built-in plug-in rack for out-of-the-box use. After VST3, hosted formats
are planned as ARA, then CLAP, then AU.

Until 1.0, project formats and compatibility may change without a migration
guarantee. See the [roadmap](agents/docs/roadmap.md) for milestones and priorities.

## Development

The repository uses a locked, project-managed toolchain. To start a development
build:

```sh
mise install
mise run dev
```

Contributor-facing details live outside this README:

- [Contributing guide](CONTRIBUTING.md)
- [Development environment](agents/docs/environment.md)
- [Architecture and real-time constraints](agents/docs/architecture.md)
- [Product roadmap](agents/docs/roadmap.md)
- [Performance benchmarks](agents/docs/benchmarks.md)
- [Continuous integration and releases](agents/docs/ci.md)

## License

YADAW is licensed under the
[GNU General Public License v3.0](LICENSE).
