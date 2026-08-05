# Rust performance benchmarks

Heron uses Criterion for repeatable microbenchmarks of the native mixer, render
path, media cache, and recorder. These results describe code performance on one
machine; they are not portable scores and do not run as a pull-request gate.

## Commands

```text
mise run bench:quick
mise run bench
mise run bench:save
mise run bench:compare
```

`mise run bench:save` stores a baseline named `main` under each crate's
`target/criterion` directory. `mise run bench:compare` compares against those
baselines. The directories are ignored by Git and should not be copied between
machines. `mise run check` compiles every benchmark without measuring it and
runs the real-time allocation invariants.

The live cpal runtime and graph renderer live in `heron-audio-engine`.
Development builds optimize that crate and its measured real-time dependency
closure at level 3; UI, IPC, NAPI, and orchestration crates use Cargo's default
unoptimized development profile with full debug information.

For compile-performance changes, record a clean build, warm workspace check,
single-file incremental check, predev duration, and fresh target size. Use the
same explicit host target for every comparison. A UI-only audio-host edit must
not rebuild `heron-audio-engine`, and a representative workflow regression over
10% requires investigation before merging.

## User-facing audio performance test

The packaged desktop application also exposes a short native DSP test from
**Help → Audio Performance Benchmark…**. Unlike the Criterion suite, this test
does not require a Rust toolchain or repository checkout. It renders three
reference mixer graphs on a native worker thread, then measures the local N-API
bridge. Each graph processes a deterministic stereo
signal through independent instances of the bundled Heron Gain VST3: 8 instances
for low-latency tracking, 32 for a production mix, and 64 for a dense session.
Using a bundled effect keeps results reproducible while including the real VST3
ABI, buffer adaptation, and plug-in scheduling path. The two suites run
sequentially so they do not distort each other. The report includes:

- p95, p99, maximum block processing time, deadline utilization, and deadline
  misses for low-latency tracking, production mix, and dense-session scenarios,
  including the VST3 instance count for each;
- real-time factor as a secondary diagnostic rather than the score;
- inline sequential request/reply latency;
- concurrent in-process request routing and direct telemetry read throughput;
- debug/release profile, resolved Tokio runtime settings, and the actual
  MessagePack body size;
- the processor, logical-core count, platform, and measurement time.

The headline rating uses the worse of p99 block-deadline stability and the
release native-bridge targets. Debug bridge numbers are explicitly diagnostic and do not
lower the rating.
Real-time factor alone can make a deliberately heavy graph look informative
while hiding jitter that actually causes dropouts. This report helps users
evaluate both practical buffer stability and local native-boundary overhead. It does
not open an audio device and is not a substitute for the repeatable Criterion
regression suite. The bundled gain workload measures realistic hosting overhead,
not the algorithmic cost of arbitrary third-party synthesis, convolution, or
oversampling plug-ins.

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

## Deadline and throughput interpretation

For live playback, a block must finish before its buffer deadline. Average block
time and aggregate real-time factor can hide occasional slow blocks, so use p99
deadline utilization and deadline misses as the first stability signal. A p99
utilization of 30% means 99% of measured blocks completed within roughly 30% of
the available callback budget.

IPC latency and throughput answer different questions. Small inline payloads
show request-routing overhead. Cold shared latency includes lazy region
creation and handle transfer. Warm sequential throughput is an effective
request/reply number and must not be presented as the channel's saturated
bandwidth. The 1/4/8/16 in-flight cases measure saturated duplex behavior and
response routing; telemetry reads represent the 30 Hz meter/transport polling
path. Shared-memory results still include the intentional one copy in each
direction at the native-addon/Node Buffer boundary.

The Windows reference release targets are 750 MiB/s for warm sequential 4 MiB
duplex, 1.5 GiB/s at eight in-flight, and p99 inline RTT at or below 1 ms.
During saturation, priority heartbeat p99 must remain at or below 500 ms and
the audio callback generation must continue advancing. Always report arena
offers and MessagePack body bytes with bandwidth: a 4 MiB attachment request
whose body is no longer below 8 KiB indicates a regression back into payload
serialization.

At 48 kHz the engine must still sustain at least 48,000 rendered frames per
second; at 96 kHz it must sustain at least 96,000. Divide frame throughput by
sample rate to estimate real-time factor, but treat it as supporting context.

Criterion measures timing distributions, while the allocation integration test
enforces a separate invariant: after warm-up, mixer processing, in-memory
rendering, preview command consumption, and recording tap capture must not
allocate or free memory on the calling thread.
