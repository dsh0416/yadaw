use std::env;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus};

use clap::{Args, Parser, Subcommand, ValueEnum};

const BENCHMARKS: [&str; 4] = [
    "mixer_graph",
    "render_runtime",
    "media_streaming",
    "recording",
];
const BENCH_FEATURES: &str = "heron-dsp-node/bench-internals";
const VST3_PROBE: &str = "heron-vst3-probe";
const CLAP_PROBE: &str = "heron-clap-probe";

#[derive(Debug, Parser)]
#[command(name = "cargo xtask", about = "Heron Rust workspace tasks")]
struct Cli {
    #[command(subcommand)]
    command: XtaskCommand,
}

#[derive(Debug, Subcommand)]
enum XtaskCommand {
    /// Format the Rust workspace.
    Fmt {
        /// Check formatting without modifying files.
        #[arg(long)]
        check: bool,
    },
    /// Run Clippy for the Rust workspace.
    Clippy {
        /// Check only workspace libraries and binaries.
        #[arg(long)]
        fast: bool,
    },
    /// Run Rust workspace tests.
    Test {
        /// Run only workspace library tests.
        #[arg(long)]
        fast: bool,
    },
    /// Compile or run the Rust benchmarks.
    Bench {
        #[arg(value_enum)]
        mode: BenchMode,
    },
    /// Build and stage Rust native artifacts.
    Native {
        #[command(subcommand)]
        command: NativeCommand,
    },
    /// Prepare or export Rust coverage data.
    Coverage {
        #[command(subcommand)]
        command: CoverageCommand,
    },
    /// Print the rustc host target triple.
    HostTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BenchMode {
    Check,
    Run,
    Quick,
    Save,
    Compare,
}

#[derive(Debug, Subcommand)]
enum NativeCommand {
    /// Build the VST3 probe and bundled plug-ins, then stage them for Electron.
    Build(NativeBuildArgs),
}

#[derive(Debug, Args)]
struct NativeBuildArgs {
    #[arg(long, value_enum, default_value_t = BuildProfile::Debug)]
    profile: BuildProfile,
    /// Rust target triple. Defaults to the rustc host target.
    #[arg(long)]
    target: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BuildProfile {
    Debug,
    Release,
}

impl BuildProfile {
    const fn directory(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Release => "release",
        }
    }

    const fn is_release(self) -> bool {
        matches!(self, Self::Release)
    }
}

#[derive(Debug, Subcommand)]
enum CoverageCommand {
    /// Clean old profiles and run instrumented Rust tests.
    Prepare,
    /// Export the accumulated Rust coverage profiles as LCOV.
    Report,
}

#[derive(Debug)]
enum XtaskError {
    Io {
        operation: &'static str,
        source: io::Error,
    },
    InvalidHostOutput,
    CommandFailed {
        program: OsString,
        status: ExitStatus,
    },
}

impl XtaskError {
    fn exit_code(&self) -> i32 {
        match self {
            Self::CommandFailed { status, .. } => status.code().unwrap_or(1),
            Self::Io { .. } | Self::InvalidHostOutput => 1,
        }
    }
}

impl fmt::Display for XtaskError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::InvalidHostOutput => {
                write!(formatter, "could not determine the Rust host target")
            }
            Self::CommandFailed { program, status } => {
                write!(
                    formatter,
                    "{} exited with {status}",
                    program.to_string_lossy()
                )
            }
        }
    }
}

pub fn main_entry() -> ExitCode {
    match execute(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            let code = u8::try_from(error.exit_code()).unwrap_or(1);
            ExitCode::from(code)
        }
    }
}

fn execute(cli: Cli) -> Result<(), XtaskError> {
    let workspace = workspace_root();
    match cli.command {
        XtaskCommand::Fmt { check } => run_spec(&workspace, &fmt_spec(check)),
        XtaskCommand::Clippy { fast } => {
            let target = host_target(&workspace)?;
            run_spec(&workspace, &clippy_spec(fast, &target))
        }
        XtaskCommand::Test { fast } => {
            let target = host_target(&workspace)?;
            run_spec(&workspace, &test_spec(fast, &target))
        }
        XtaskCommand::Bench { mode } => {
            let target = host_target(&workspace)?;
            run_spec(&workspace, &bench_spec(mode, &target))
        }
        XtaskCommand::Native { command } => match command {
            NativeCommand::Build(args) => native_build(&workspace, &args),
        },
        XtaskCommand::Coverage { command } => {
            let target = host_target(&workspace)?;
            match command {
                CoverageCommand::Prepare => coverage_prepare(&workspace, &target),
                CoverageCommand::Report => coverage_report(&workspace, &target),
            }
        }
        XtaskCommand::HostTarget => {
            println!("{}", host_target(&workspace)?);
            Ok(())
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct CommandSpec {
    program: OsString,
    args: Vec<OsString>,
}

impl CommandSpec {
    fn cargo(args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        Self {
            program: cargo_executable(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

fn cargo_executable() -> OsString {
    env::var_os("CARGO").unwrap_or_else(|| {
        if cfg!(windows) {
            OsString::from("cargo.exe")
        } else {
            OsString::from("cargo")
        }
    })
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must be located directly under the workspace root")
        .to_path_buf()
}

fn fmt_spec(check: bool) -> CommandSpec {
    let mut args = vec![OsString::from("fmt"), OsString::from("--all")];
    if check {
        args.push(OsString::from("--check"));
    }
    CommandSpec::cargo(args)
}

fn clippy_spec(fast: bool, target: &str) -> CommandSpec {
    let mut args = vec![
        "clippy",
        "--workspace",
        if fast { "--lib" } else { "--all-targets" },
    ];
    if fast {
        args.push("--bins");
    }
    args.extend([
        "--features",
        BENCH_FEATURES,
        "--target",
        target,
        "--",
        "-D",
        "warnings",
    ]);
    CommandSpec::cargo(args)
}

fn test_spec(fast: bool, target: &str) -> CommandSpec {
    let mut args = vec!["test", "--workspace"];
    if fast {
        args.push("--lib");
    }
    args.extend(["--features", BENCH_FEATURES, "--target", target]);
    CommandSpec::cargo(args)
}

fn bench_spec(mode: BenchMode, target: &str) -> CommandSpec {
    let mut args = vec![OsString::from("bench"), OsString::from("--workspace")];
    for benchmark in BENCHMARKS {
        args.extend([OsString::from("--bench"), OsString::from(benchmark)]);
    }
    args.extend([
        OsString::from("--features"),
        OsString::from(BENCH_FEATURES),
        OsString::from("--target"),
        OsString::from(target),
    ]);

    match mode {
        BenchMode::Check => args.push(OsString::from("--no-run")),
        BenchMode::Run => {}
        BenchMode::Quick => args.extend([OsString::from("--"), OsString::from("--quick")]),
        BenchMode::Save => args.extend([
            OsString::from("--"),
            OsString::from("--save-baseline"),
            OsString::from("main"),
        ]),
        BenchMode::Compare => args.extend([
            OsString::from("--"),
            OsString::from("--baseline"),
            OsString::from("main"),
        ]),
    }
    CommandSpec::cargo(args)
}

fn host_target(workspace: &Path) -> Result<String, XtaskError> {
    let output = Command::new("rustc")
        .arg("-vV")
        .current_dir(workspace)
        .output()
        .map_err(|source| XtaskError::Io {
            operation: "failed to run rustc -vV",
            source,
        })?;
    if !output.status.success() {
        return Err(XtaskError::CommandFailed {
            program: OsString::from("rustc"),
            status: output.status,
        });
    }
    parse_host_target(&String::from_utf8_lossy(&output.stdout))
        .map(str::to_owned)
        .ok_or(XtaskError::InvalidHostOutput)
}

fn parse_host_target(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("host:").map(str::trim))
        .filter(|target| !target.is_empty())
}

fn native_build(workspace: &Path, args: &NativeBuildArgs) -> Result<(), XtaskError> {
    let target = match &args.target {
        Some(target) => target.clone(),
        None => host_target(workspace)?,
    };
    run_spec(
        workspace,
        &native_probe_spec(args.profile, &target, "heron-vst3-host", VST3_PROBE),
    )?;
    run_spec(
        workspace,
        &native_probe_spec(args.profile, &target, "heron-clap-host", CLAP_PROBE),
    )?;
    run_spec(workspace, &native_plugins_spec(args.profile, &target))?;
    stage_native_artifacts(workspace, args.profile, &target)
}

fn native_probe_spec(
    profile: BuildProfile,
    target: &str,
    package: &str,
    binary: &str,
) -> CommandSpec {
    let mut args = vec!["build", "--target", target];
    if profile.is_release() {
        args.push("--release");
    }
    args.extend(["-p", package, "--bin", binary]);
    CommandSpec::cargo(args)
}

fn native_plugins_spec(profile: BuildProfile, target: &str) -> CommandSpec {
    let mut args = vec!["truce", "build", "--vst3", "--target", target];
    if !profile.is_release() {
        args.push("--debug");
    }
    CommandSpec::cargo(args)
}

fn stage_native_artifacts(
    workspace: &Path,
    profile: BuildProfile,
    target: &str,
) -> Result<(), XtaskError> {
    let paths = native_artifact_paths(workspace, profile, target, cfg!(windows));
    for entry in fs::read_dir(&paths.source_bundles).map_err(|source| XtaskError::Io {
        operation: "failed to read target-specific VST3 bundles",
        source,
    })? {
        let entry = entry.map_err(|source| XtaskError::Io {
            operation: "failed to read a VST3 bundle entry",
            source,
        })?;
        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && entry.path().extension() == Some(OsStr::new("vst3"))
        {
            copy_directory(&entry.path(), &paths.stable_bundles.join(entry.file_name()))?;
        }
    }

    let stable_profile = paths
        .stable_vst3_probe
        .parent()
        .expect("stable probe path must have a parent directory");
    fs::create_dir_all(stable_profile).map_err(|source| XtaskError::Io {
        operation: "failed to create the stable native artifact directory",
        source,
    })?;
    fs::copy(paths.source_vst3_probe, paths.stable_vst3_probe).map_err(|source| {
        XtaskError::Io {
            operation: "failed to stage the VST3 probe",
            source,
        }
    })?;
    fs::copy(paths.source_clap_probe, paths.stable_clap_probe).map_err(|source| {
        XtaskError::Io {
            operation: "failed to stage the CLAP probe",
            source,
        }
    })?;
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
struct NativeArtifactPaths {
    source_bundles: PathBuf,
    stable_bundles: PathBuf,
    source_vst3_probe: PathBuf,
    stable_vst3_probe: PathBuf,
    source_clap_probe: PathBuf,
    stable_clap_probe: PathBuf,
}

fn native_artifact_paths(
    workspace: &Path,
    profile: BuildProfile,
    target: &str,
    windows: bool,
) -> NativeArtifactPaths {
    let target_directory = workspace.join("target");
    let profile_directory = target_directory.join(target).join(profile.directory());
    let stable_profile_directory = target_directory.join(profile.directory());
    let vst3_executable = executable_name(VST3_PROBE, windows);
    let clap_executable = executable_name(CLAP_PROBE, windows);
    NativeArtifactPaths {
        source_bundles: target_directory.join("bundles").join(target),
        stable_bundles: target_directory.join("bundles"),
        source_vst3_probe: profile_directory.join(&vst3_executable),
        stable_vst3_probe: stable_profile_directory.join(vst3_executable),
        source_clap_probe: profile_directory.join(&clap_executable),
        stable_clap_probe: stable_profile_directory.join(clap_executable),
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), XtaskError> {
    fs::create_dir_all(destination).map_err(|source| XtaskError::Io {
        operation: "failed to create a staged VST3 bundle directory",
        source,
    })?;
    for entry in fs::read_dir(source).map_err(|source| XtaskError::Io {
        operation: "failed to read a VST3 bundle directory",
        source,
    })? {
        let entry = entry.map_err(|source| XtaskError::Io {
            operation: "failed to read a VST3 bundle entry",
            source,
        })?;
        let destination_entry = destination.join(entry.file_name());
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            copy_directory(&entry.path(), &destination_entry)?;
        } else {
            fs::copy(entry.path(), destination_entry).map_err(|source| XtaskError::Io {
                operation: "failed to stage a VST3 bundle file",
                source,
            })?;
        }
    }
    Ok(())
}

fn executable_name(binary: &str, windows: bool) -> OsString {
    if windows {
        OsString::from(format!("{binary}.exe"))
    } else {
        OsString::from(binary)
    }
}

fn coverage_prepare(workspace: &Path, target: &str) -> Result<(), XtaskError> {
    run_spec(
        workspace,
        &CommandSpec::cargo(["llvm-cov", "clean", "--workspace"]),
    )?;
    run_spec(
        workspace,
        &CommandSpec::cargo([
            "test",
            "--workspace",
            "--features",
            BENCH_FEATURES,
            "--target",
            target,
        ]),
    )
}

fn coverage_report(workspace: &Path, target: &str) -> Result<(), XtaskError> {
    fs::create_dir_all(workspace.join("coverage").join("rust")).map_err(|source| {
        XtaskError::Io {
            operation: "failed to create the Rust coverage directory",
            source,
        }
    })?;
    run_spec(
        workspace,
        &CommandSpec::cargo([
            "llvm-cov",
            "report",
            "--target",
            target,
            "--ignore-filename-regex",
            "(/|^)third_party/",
            "--lcov",
            "--output-path",
            "coverage/rust/lcov.info",
        ]),
    )
}

fn run_spec(workspace: &Path, spec: &CommandSpec) -> Result<(), XtaskError> {
    let printable_args = spec
        .args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    println!("\n> {} {printable_args}", spec.program.to_string_lossy());
    let status = Command::new(&spec.program)
        .args(&spec.args)
        .current_dir(workspace)
        .status()
        .map_err(|source| XtaskError::Io {
            operation: "failed to start a child command",
            source,
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(XtaskError::CommandFailed {
            program: spec.program.clone(),
            status,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rustc_host_target() {
        let output = "rustc 1.97.0\nbinary: rustc\nhost: aarch64-apple-darwin\n";
        assert_eq!(parse_host_target(output), Some("aarch64-apple-darwin"));
    }

    #[test]
    fn fast_clippy_checks_only_libraries_and_binaries() {
        let spec = clippy_spec(true, "x86_64-unknown-linux-gnu");
        let args = spec
            .args
            .iter()
            .map(OsString::as_os_str)
            .collect::<Vec<_>>();
        assert!(args.contains(&OsStr::new("--lib")));
        assert!(args.contains(&OsStr::new("--bins")));
        assert!(!args.contains(&OsStr::new("--all-targets")));
        assert!(args.windows(2).any(|pair| {
            pair == [
                OsStr::new("--target"),
                OsStr::new("x86_64-unknown-linux-gnu"),
            ]
        }));
    }

    #[test]
    fn benchmark_modes_add_the_expected_criterion_arguments() {
        assert!(
            bench_spec(BenchMode::Check, "host")
                .args
                .contains(&OsString::from("--no-run"))
        );
        assert!(
            bench_spec(BenchMode::Quick, "host")
                .args
                .ends_with(&[OsString::from("--"), OsString::from("--quick"),])
        );
        assert!(bench_spec(BenchMode::Save, "host").args.ends_with(&[
            OsString::from("--"),
            OsString::from("--save-baseline"),
            OsString::from("main"),
        ]));
        assert!(bench_spec(BenchMode::Compare, "host").args.ends_with(&[
            OsString::from("--"),
            OsString::from("--baseline"),
            OsString::from("main"),
        ]));
    }

    #[test]
    fn native_specs_preserve_profile_and_target() {
        let probe = native_probe_spec(
            BuildProfile::Release,
            "aarch64-apple-darwin",
            "heron-clap-host",
            CLAP_PROBE,
        );
        assert!(probe.args.contains(&OsString::from("--release")));
        assert!(
            probe.args.windows(2).any(|pair| {
                pair == [OsStr::new("--target"), OsStr::new("aarch64-apple-darwin")]
            })
        );
        assert!(probe.args.contains(&OsString::from("heron-clap-host")));
        assert!(probe.args.contains(&OsString::from(CLAP_PROBE)));

        let plugins = native_plugins_spec(BuildProfile::Debug, "aarch64-apple-darwin");
        assert!(plugins.args.contains(&OsString::from("--debug")));
    }

    #[test]
    fn executable_suffix_is_platform_specific() {
        assert_eq!(executable_name("probe", false), OsString::from("probe"));
        assert_eq!(executable_name("probe", true), OsString::from("probe.exe"));
    }

    #[test]
    fn native_artifacts_stage_from_target_specific_to_stable_paths() {
        let workspace = Path::new("/workspace");
        let paths = native_artifact_paths(
            workspace,
            BuildProfile::Release,
            "x86_64-pc-windows-msvc",
            true,
        );

        assert_eq!(
            paths.source_bundles,
            workspace
                .join("target")
                .join("bundles")
                .join("x86_64-pc-windows-msvc")
        );
        assert_eq!(
            paths.stable_bundles,
            workspace.join("target").join("bundles")
        );
        assert_eq!(
            paths.source_vst3_probe,
            workspace
                .join("target")
                .join("x86_64-pc-windows-msvc")
                .join("release")
                .join("heron-vst3-probe.exe")
        );
        assert_eq!(
            paths.stable_vst3_probe,
            workspace
                .join("target")
                .join("release")
                .join("heron-vst3-probe.exe")
        );
        assert_eq!(
            paths.source_clap_probe,
            workspace
                .join("target")
                .join("x86_64-pc-windows-msvc")
                .join("release")
                .join("heron-clap-probe.exe")
        );
        assert_eq!(
            paths.stable_clap_probe,
            workspace
                .join("target")
                .join("release")
                .join("heron-clap-probe.exe")
        );
    }

    #[test]
    fn child_failure_preserves_the_exit_code() {
        #[cfg(unix)]
        let spec = CommandSpec {
            program: OsString::from("sh"),
            args: vec![OsString::from("-c"), OsString::from("exit 7")],
        };
        #[cfg(windows)]
        let spec = CommandSpec {
            program: OsString::from("cmd.exe"),
            args: vec![
                OsString::from("/d"),
                OsString::from("/s"),
                OsString::from("/c"),
                OsString::from("exit 7"),
            ],
        };

        let error = run_spec(&workspace_root(), &spec).expect_err("command should fail");
        assert_eq!(error.exit_code(), 7);
    }
}
