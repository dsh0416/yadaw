# Rust performance benchmarks

YADAW uses Criterion for repeatable microbenchmarks of the native mixer, render
path, media cache, and recorder. These results describe code performance on one
machine; they are not portable scores and do not run as a pull-request gate.

## Commands

```text
pnpm bench:rust:quick
pnpm bench:rust
pnpm bench:rust:save
pnpm bench:rust:compare
```

`bench:rust:save` stores a baseline named `main` under each crate's
`target/criterion` directory. `bench:rust:compare` compares against those
baselines. The directories are ignored by Git and should not be copied between
machines. `pnpm check:rust` compiles every benchmark without measuring it and
runs the real-time allocation invariants.

## User-facing audio performance test

The packaged desktop application also exposes a short native DSP test from
**Help → Audio Performance Benchmark…**. Unlike the Criterion suite, this test
does not require a Rust toolchain or repository checkout. It renders three
reference mixer graphs on a worker thread and reports:

- real-time headroom for low-latency tracking, production mix, and dense-session
  scenarios;
- average processing time compared with each scenario's audio buffer deadline;
- the processor, logical-core count, platform, and measurement time.

This report helps users choose practical project density and buffer settings on
their own computer. It does not open an audio device and is not a substitute for
the repeatable Criterion regression suite.

Criterion writes HTML indexes to
`crates/dsp-core/target/criterion/report/index.html` and
`crates/dsp-node/target/criterion/report/index.html`; CSV measurements sit below
the corresponding benchmark directories. CPU groups report audio frames per
second. Media groups also report bytes per second where the whole file is
processed.

## Preparing a measurement

Record the following beside any result shared in an issue or pull request:

- commit SHA and whether the working tree was dirty;
- `rustc -Vv`;
- operating system, CPU model, RAM, and storage model;
- active power plan and whether the machine was on AC power;
- audio sample rate and benchmark command.

Use the same machine, Rust toolchain, target triple, power plan, and background
load for both sides of a comparison. Close the desktop application, browsers,
indexers, and other sustained workloads. Run the quick suite once before saving
a baseline so compilation and basic fixture generation are already warm.

The stable CPU groups use a 3% noise threshold. Disk, writer, finalize, and seek
refill groups use a 10% threshold and are trend data: an apparent regression
must be reproduced before it is treated as actionable. The seek refill
benchmark intentionally includes worker wake-up and filesystem cache behavior;
it is not a claim about cold-disk latency.

## Real-time interpretation

At 48 kHz the engine must sustain at least 48,000 rendered frames per second; at
96 kHz it must sustain at least 96,000. Divide the reported throughput by the
sample rate to estimate real-time headroom. For example, 2,400,000 frames/s at
48 kHz is approximately 50 times real time.

Criterion measures timing distributions, while the allocation integration test
enforces a separate invariant: after warm-up, mixer processing, in-memory
rendering, preview command consumption, and recording tap capture must not
allocate or free memory on the calling thread.
