use std::{
    env,
    io::{Read, Write, stdout},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    rc::Rc,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use yadaw_vst3_host::{
    AraFactoryInfo, AudioLayout, ClassId, ClassInfo, Module, PluginKind, StereoProcessor,
};

const CLASS_PROBE_ENV: &str = "YADAW_VST3_PROBE_CLASS";
/// When set to `soft`, enumerate factory classes without instantiating processors.
const PROBE_MODE_ENV: &str = "YADAW_VST3_PROBE_MODE";

#[derive(Serialize)]
struct Output<'a> {
    module: ModuleOutput<'a>,
}

#[derive(Serialize)]
struct ModuleOutput<'a> {
    path: &'a Path,
    vendor: &'static str,
    classes: Vec<ClassOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassOutput {
    class_id: String,
    name: String,
    vendor: String,
    version: String,
    category: String,
    initialized: bool,
    sample32: bool,
    has_editor: bool,
    audio_inputs: u32,
    audio_outputs: u32,
    event_inputs: u32,
    supported_audio_modes: Vec<String>,
    ara: Option<AraOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AraOutput {
    factory_class_id: String,
    factory_id: String,
    document_archive_id: String,
    lowest_api_generation: i32,
    highest_api_generation: i32,
    playback_transformation_flags: u32,
    supports_storing_audio_file_chunks: bool,
}

fn looks_like_instrument(class: &ClassInfo) -> bool {
    class.subcategories.split('|').any(|category| {
        let category = category.trim().to_ascii_lowercase();
        category.contains("instrument") || category.contains("synth")
    })
}

fn soft_inspect(class: &ClassInfo) -> ClassOutput {
    // Factory enumeration alone cannot prove bus layouts. Advertise the host's
    // supported paths so a module that loads is discoverable; insert-time
    // activation still validates the processor setup.
    let instrument = looks_like_instrument(class);
    ClassOutput {
        class_id: class.id.to_string(),
        name: class.name.clone(),
        vendor: String::new(),
        version: String::new(),
        category: if instrument {
            if class.subcategories.is_empty() {
                "Instrument|Synth".into()
            } else {
                class.subcategories.clone()
            }
        } else if class.subcategories.is_empty() {
            "Fx".into()
        } else {
            class.subcategories.clone()
        },
        initialized: true,
        sample32: true,
        has_editor: true,
        audio_inputs: u32::from(!instrument),
        audio_outputs: 1,
        event_inputs: u32::from(instrument),
        supported_audio_modes: if instrument {
            ["mono", "stereo"].into_iter().map(str::to_owned).collect()
        } else {
            ["mono", "mono-to-stereo", "stereo"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        },
        ara: None,
    }
}

fn deep_inspect(module: &Rc<Module>, class: ClassInfo) -> ClassOutput {
    let supports = |kind, layout| {
        StereoProcessor::create_with_layout(Rc::clone(module), class.id, 48_000.0, kind, layout)
            .is_ok()
    };
    let effect_modes = [
        (AudioLayout::Mono, "mono"),
        (AudioLayout::MonoToStereo, "mono-to-stereo"),
        (AudioLayout::Stereo, "stereo"),
    ]
    .into_iter()
    .filter_map(|(layout, name)| supports(PluginKind::Effect, layout).then_some(name.to_owned()))
    .collect::<Vec<_>>();
    let instrument_modes = [(AudioLayout::Mono, "mono"), (AudioLayout::Stereo, "stereo")]
        .into_iter()
        .filter_map(|(layout, name)| {
            supports(PluginKind::Instrument, layout).then_some(name.to_owned())
        })
        .collect::<Vec<_>>();
    let (kind, supported_audio_modes) = if effect_modes.is_empty() && !instrument_modes.is_empty() {
        (PluginKind::Instrument, instrument_modes)
    } else {
        (PluginKind::Effect, effect_modes)
    };
    let initialized = !supported_audio_modes.is_empty();
    let instrument = kind == PluginKind::Instrument;
    ClassOutput {
        class_id: class.id.to_string(),
        name: class.name,
        vendor: String::new(),
        version: String::new(),
        category: if instrument {
            "Instrument|Synth".into()
        } else {
            "Fx".into()
        },
        initialized,
        sample32: initialized,
        has_editor: initialized,
        audio_inputs: u32::from(!instrument),
        audio_outputs: u32::from(initialized),
        event_inputs: u32::from(instrument),
        supported_audio_modes,
        ara: None,
    }
}

fn json_from_stdout(stdout: &[u8]) -> Option<ClassOutput> {
    if let Ok(value) = serde_json::from_slice(stdout) {
        return Some(value);
    }
    // Plug-ins often print diagnostics to stdout before our JSON payload.
    let text = String::from_utf8_lossy(stdout);
    for line in text.lines().rev() {
        let line = line.trim();
        if line.starts_with('{')
            && let Ok(value) = serde_json::from_str(line)
        {
            return Some(value);
        }
    }
    None
}

fn deep_inspect_in_child(module_path: &Path, class: &ClassInfo) -> Option<ClassOutput> {
    const CHILD_TIMEOUT: Duration = Duration::from_secs(8);
    let executable = env::current_exe().ok()?;
    let mut child = Command::new(executable)
        .arg(module_path)
        .env(CLASS_PROBE_ENV, class.id.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= CHILD_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).ok()?;
    // The child flushes its JSON payload before tearing the module down, so a
    // crash during teardown can still leave a completed probe result on stdout.
    // Prefer that result over the exit status; a child that failed before
    // probing produces no JSON and falls back to `soft_inspect` regardless.
    json_from_stdout(&bytes)
}

fn inspect(module_path: &Path, class: ClassInfo, ara: Option<AraOutput>) -> ClassOutput {
    let mut output = deep_inspect_in_child(module_path, &class).unwrap_or_else(|| {
        // Child crashed or rejected the processor setup. Keep the class visible
        // from the already-successful module load instead of quarantining the bundle.
        soft_inspect(&class)
    });
    output.ara = ara;
    output
}

fn run_class_probe(module_path: &Path, class_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let class_id: ClassId = class_id.parse()?;
    let module = Rc::new(Module::open(module_path)?);
    let class = module
        .classes()?
        .into_iter()
        .find(|class| class.id == class_id)
        .ok_or("requested VST3 class was not exported by the module")?;
    let output = deep_inspect(&module, class);
    println!("{}", serde_json::to_string(&output)?);
    stdout().flush()?;
    // Keep the module alive until after stdout is flushed; some hosts tear down
    // poorly and we must not lose a successful probe result to a late crash.
    drop(module);
    Ok(())
}

fn soft_probe_requested() -> bool {
    env::var(PROBE_MODE_ENV)
        .map(|value| value.eq_ignore_ascii_case("soft"))
        .unwrap_or(false)
        || env::args_os().any(|arg| arg == "--soft")
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args_os()
        .skip(1)
        .find(|arg| arg != "--soft")
        .ok_or("usage: yadaw-vst3-probe [--soft] <module.vst3>")?;
    let path = PathBuf::from(path);
    if let Ok(class_id) = env::var(CLASS_PROBE_ENV) {
        return run_class_probe(&path, &class_id);
    }

    let soft = soft_probe_requested();
    let module = Rc::new(Module::open(&path)?);
    let discovered = module.classes()?;
    let ara_factories = discovered
        .iter()
        .filter(|class| class.category == "ARA Main Factory Class")
        .filter_map(|class| match module.ara_factory_info(class.id) {
            Ok(info) => Some((class.name.clone(), (class.id, info))),
            Err(error) => {
                eprintln!("could not inspect ARA factory class {}: {error}", class.id);
                None
            }
        })
        .collect::<std::collections::HashMap<_, _>>();
    let classes = discovered
        .into_iter()
        .filter(|class| class.category == "Audio Module Class")
        .map(|class| {
            let ara = ara_factories
                .get(class.name.as_str())
                .map(|(class_id, info)| ara_output(*class_id, info));
            if soft {
                let mut output = soft_inspect(&class);
                output.ara = ara;
                output
            } else {
                inspect(&path, class, ara)
            }
        })
        .collect();
    // Emit JSON on its own line so hosts can recover it when plug-ins log to stdout.
    println!(
        "{}",
        serde_json::to_string(&Output {
            module: ModuleOutput {
                path: &path,
                vendor: "",
                classes,
            },
        })?
    );
    stdout().flush()?;
    drop(module);
    Ok(())
}

fn ara_output(class_id: ClassId, info: &AraFactoryInfo) -> AraOutput {
    AraOutput {
        factory_class_id: class_id.to_string(),
        factory_id: info.factory_id.clone(),
        document_archive_id: info.document_archive_id.clone(),
        lowest_api_generation: info.lowest_api_generation,
        highest_api_generation: info.highest_api_generation,
        playback_transformation_flags: info.playback_transformation_flags,
        supports_storing_audio_file_chunks: info.supports_storing_audio_file_chunks,
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
