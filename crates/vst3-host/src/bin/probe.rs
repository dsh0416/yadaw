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
use yadaw_vst3_host::{AudioLayout, ClassId, ClassInfo, Module, PluginKind, StereoProcessor};

const CLASS_PROBE_ENV: &str = "YADAW_VST3_PROBE_CLASS";

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
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= CHILD_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).ok()?;
    json_from_stdout(&bytes)
}

fn inspect(module_path: &Path, class: ClassInfo) -> ClassOutput {
    if let Some(deep) = deep_inspect_in_child(module_path, &class) {
        return deep;
    }
    // Child crashed or rejected the processor setup. Keep the class visible
    // from the already-successful module load instead of quarantining the bundle.
    soft_inspect(&class)
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

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args_os()
        .nth(1)
        .ok_or("usage: yadaw-vst3-probe <module.vst3>")?;
    let path = PathBuf::from(path);
    if let Ok(class_id) = env::var(CLASS_PROBE_ENV) {
        return run_class_probe(&path, &class_id);
    }

    let module = Rc::new(Module::open(&path)?);
    let classes = module
        .classes()?
        .into_iter()
        .filter(|class| class.category == "Audio Module Class")
        .map(|class| inspect(&path, class))
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

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
