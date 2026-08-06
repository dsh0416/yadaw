#!/usr/bin/env bash
set -euo pipefail

readonly source_root=/source
readonly work_root=/work

if [[ ! -f "$source_root/mise.toml" ]]; then
  echo "Heron source must be mounted read-only at $source_root" >&2
  exit 1
fi

rsync --archive \
  --exclude .git \
  --exclude node_modules \
  --exclude target \
  --exclude target-coverage \
  --exclude coverage \
  "$source_root/" "$work_root/"

cd "$work_root"
mise trust mise.toml
prepare_fixture="${HERON_DOCKER_PREPARE:-1}"
if [[ "$prepare_fixture" != 0 && "$prepare_fixture" != 1 ]]; then
  echo "HERON_DOCKER_PREPARE must be 0 or 1" >&2
  exit 1
fi
if [[ "$prepare_fixture" == 1 ]]; then
  mise install
fi
pnpm install --frozen-lockfile --prefer-offline

electron_package_dir="$(
  cd apps/desktop
  node -p 'require("node:path").dirname(require.resolve("electron/package.json"))'
)"
electron_version="$(node -p "require('$electron_package_dir/package.json').version")"
electron_archive="electron-v${electron_version}-linux-x64.zip"
electron_cache_dir=/root/.cache/heron-electron
electron_cache="$electron_cache_dir/$electron_archive"
electron_checksum="$(
  node -p "require('$electron_package_dir/checksums.json')['$electron_archive']"
)"

mkdir -p "$electron_cache_dir" "$electron_package_dir/dist"
if ! printf '%s  %s\n' "$electron_checksum" "$electron_cache" | sha256sum --check --status; then
  curl \
    --continue-at - \
    --fail \
    --location \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 2 \
    "https://github.com/electron/electron/releases/download/v${electron_version}/${electron_archive}" \
    --output "$electron_cache"
fi
printf '%s  %s\n' "$electron_checksum" "$electron_cache" | sha256sum --check --status
unzip -q -o "$electron_cache" -d "$electron_package_dir/dist"
printf 'electron' > "$electron_package_dir/path.txt"

fixture_build_type="${HERON_DOCKER_BUILD_TYPE:-Release}"
if [[ "$prepare_fixture" == 1 ]]; then
  cmake \
    -S . \
    -B target/vst3-fixtures \
    -G Ninja \
    -DCMAKE_BUILD_TYPE="$fixture_build_type" \
    -DHERON_BUILD_VST3_FIXTURES=ON \
    -DSMTG_RUN_VST_VALIDATOR=ON
  cmake --build target/vst3-fixtures --target note-expression-synth
fi

mise run native:bindings:debug

target="$(cargo xtask host-target)"
cargo build --target "$target" -p heron-vst3-host --bin heron-vst3-probe

fixture="$(
  find "target/vst3-fixtures/VST3/$fixture_build_type" \
    -type d \
    -name note-expression-synth.vst3 \
    -print \
    -quit
)"
if [[ -z "$fixture" || ! -d "$fixture" ]]; then
  echo "The Note Expression Synth fixture was not produced" >&2
  exit 1
fi
fixture="$(realpath "$fixture")"

profile_dir="${CARGO_TARGET_DIR:-$work_root/target}/$target/debug"
probe_output="$("$profile_dir/heron-vst3-probe" "$fixture")"
class_id="$(node -e '
  const { readFileSync } = require("node:fs");
  const lines = readFileSync(0, "utf8").trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const plugin = parsed?.module?.classes?.find(
        ({ name }) => name === "Note Expression Synth With UI"
      );
      if (typeof plugin?.classId === "string") {
        process.stdout.write(plugin.classId);
        process.exit(0);
      }
    } catch {}
  }
  process.exit(1);
' <<< "$probe_output")"

electron="$(cd apps/desktop && node -e 'process.stdout.write(require("electron"))')"
if [[ ! -x "$electron" ]]; then
  echo "Electron executable is missing after verified extraction: $electron" >&2
  exit 1
fi
app_path="$work_root/apps/desktop/scripts/vst3-editor-smoke-app"
repeat_count="${HERON_DOCKER_REPEAT:-1}"
if ! [[ "$repeat_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "HERON_DOCKER_REPEAT must be a positive integer" >&2
  exit 1
fi
use_gdb="${HERON_DOCKER_GDB:-0}"
if [[ "$use_gdb" != 0 && "$use_gdb" != 1 ]]; then
  echo "HERON_DOCKER_GDB must be 0 or 1" >&2
  exit 1
fi

for ((iteration = 1; iteration <= repeat_count; iteration += 1)); do
  echo "VST3 editor Docker smoke iteration $iteration/$repeat_count"
  if [[ "$use_gdb" == 1 ]]; then
    HERON_EDITOR_SMOKE_DELAY_MS=0 \
      RUST_BACKTRACE=full \
      xvfb-run --auto-servernum \
      gdb --quiet --batch --return-child-result \
        -ex "set pagination off" \
        -ex "set print thread-events off" \
        -ex run \
        -ex "thread apply all backtrace full" \
        --args \
        "$electron" \
        --no-sandbox \
        "$app_path" \
        heron-editor-smoke-arguments: \
        "$fixture" \
        "$class_id" \
        instrument
  else
    HERON_EDITOR_SMOKE_DELAY_MS=0 \
      RUST_BACKTRACE=full \
      xvfb-run --auto-servernum \
      "$electron" \
      --no-sandbox \
      "$app_path" \
      heron-editor-smoke-arguments: \
      "$fixture" \
      "$class_id" \
      instrument
  fi
done
