use std::{
    env,
    io::{Read, Write, stdout},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    rc::Rc,
    thread,
    time::{Duration, Instant},
};

use heron_vst3_host::{
    AraFactoryInfo, AudioBusDescriptor, AudioBusDirection, AudioBusKind, AudioLayout, ClassId,
    ClassInfo, Module, PluginKind, StereoProcessor,
};
use serde::{Deserialize, Serialize};

const CLASS_PROBE_ENV: &str = "HERON_VST3_PROBE_CLASS";
/// When set to `soft`, enumerate factory classes without instantiating processors.
const PROBE_MODE_ENV: &str = "HERON_VST3_PROBE_MODE";

#[derive(Serialize)]
struct Output<'a> {
    module: ModuleOutput<'a>,
}

#[derive(Serialize)]
struct ModuleOutput<'a> {
    path: &'a Path,
    vendor: String,
    classes: Vec<ClassOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassOutput {
    class_id: String,
    name: String,
    vendor: String,
    version: String,
    categories: Vec<String>,
    initialized: bool,
    sample32: bool,
    has_editor: bool,
    audio_inputs: u32,
    audio_outputs: u32,
    event_inputs: u32,
    supported_audio_modes: Vec<String>,
    #[serde(default)]
    buses: Vec<AudioBusOutput>,
    ara: Option<AraOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioBusOutput {
    index: i32,
    direction: String,
    kind: String,
    name: String,
    channels: i32,
    default_active: bool,
}

impl From<AudioBusDescriptor> for AudioBusOutput {
    fn from(bus: AudioBusDescriptor) -> Self {
        Self {
            index: bus.index,
            direction: match bus.direction {
                AudioBusDirection::Input => "input",
                AudioBusDirection::Output => "output",
            }
            .into(),
            kind: match bus.kind {
                AudioBusKind::Main => "main",
                AudioBusKind::Aux => "aux",
            }
            .into(),
            name: bus.name,
            channels: bus.channels,
            default_active: bus.default_active,
        }
    }
}

fn soft_buses(instrument: bool) -> Vec<AudioBusOutput> {
    let mut buses = Vec::with_capacity(2);
    if !instrument {
        buses.push(AudioBusOutput {
            index: 0,
            direction: "input".into(),
            kind: "main".into(),
            name: "Stereo In".into(),
            channels: 2,
            default_active: true,
        });
    }
    buses.push(AudioBusOutput {
        index: 0,
        direction: "output".into(),
        kind: "main".into(),
        name: "Stereo Out".into(),
        channels: 2,
        default_active: true,
    });
    buses
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

fn parse_subcategories(subcategories: &str) -> Vec<String> {
    subcategories
        .split('|')
        .map(str::trim)
        .filter(|category| !category.is_empty())
        .map(str::to_owned)
        .collect()
}

fn looks_like_instrument(categories: &[String]) -> bool {
    categories.iter().any(|category| {
        let category = category.to_ascii_lowercase();
        category.contains("instrument") || category.contains("synth")
    })
}

fn categories_for_output(subcategories: &str, instrument: bool) -> Vec<String> {
    let parsed = parse_subcategories(subcategories);
    if !parsed.is_empty() {
        parsed
    } else if instrument {
        vec!["Instrument".into(), "Synth".into()]
    } else {
        vec!["Fx".into()]
    }
}

/// Choose instrument vs effect from factory subcategories and negotiated layouts.
///
/// Many instruments still accept an audio-input bus arrangement (sidechain,
/// FX-on-input, permissive SDK stubs). Prefer the factory `subCategories` hint
/// whenever it identifies an instrument; only fall back to "effect layout wins"
/// when subcategories are silent.
fn classify_plugin_kind(
    categories: &[String],
    effect_modes: &[String],
    instrument_modes: &[String],
) -> (PluginKind, Vec<String>) {
    if looks_like_instrument(categories) {
        if !instrument_modes.is_empty() {
            return (PluginKind::Instrument, instrument_modes.to_vec());
        }
        // Subcategories identify an instrument even when the zero-input layout
        // failed to activate. Keep the class usable with the host's default
        // instrument paths; insert-time activation still validates the setup.
        return (
            PluginKind::Instrument,
            ["mono", "stereo"].into_iter().map(str::to_owned).collect(),
        );
    }
    if effect_modes.is_empty() && !instrument_modes.is_empty() {
        (PluginKind::Instrument, instrument_modes.to_vec())
    } else {
        (PluginKind::Effect, effect_modes.to_vec())
    }
}

fn soft_inspect(class: &ClassInfo) -> ClassOutput {
    // Factory enumeration alone cannot prove bus layouts. Advertise the host's
    // supported paths so a module that loads is discoverable; insert-time
    // activation still validates the processor setup.
    let factory_categories = parse_subcategories(&class.subcategories);
    let instrument = looks_like_instrument(&factory_categories);
    ClassOutput {
        class_id: class.id.to_string(),
        name: class.name.clone(),
        vendor: class.vendor.clone(),
        version: class.version.clone(),
        categories: categories_for_output(&class.subcategories, instrument),
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
        buses: soft_buses(instrument),
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
    let factory_categories = parse_subcategories(&class.subcategories);
    let (kind, supported_audio_modes) =
        classify_plugin_kind(&factory_categories, &effect_modes, &instrument_modes);
    let initialized = !supported_audio_modes.is_empty();
    let instrument = kind == PluginKind::Instrument;
    let preferred_layout = supported_audio_modes
        .iter()
        .find(|mode| mode.as_str() == "stereo")
        .or_else(|| supported_audio_modes.first())
        .map(|mode| match mode.as_str() {
            "mono" => AudioLayout::Mono,
            "mono-to-stereo" => AudioLayout::MonoToStereo,
            _ => AudioLayout::Stereo,
        });
    let buses = preferred_layout
        .and_then(|layout| {
            StereoProcessor::create_with_layout(Rc::clone(module), class.id, 48_000.0, kind, layout)
                .ok()
        })
        .and_then(|processor| processor.audio_buses().ok())
        .unwrap_or_default()
        .into_iter()
        .map(AudioBusOutput::from)
        .collect::<Vec<_>>();
    let audio_inputs = buses.iter().filter(|bus| bus.direction == "input").count() as u32;
    let audio_outputs = buses.iter().filter(|bus| bus.direction == "output").count() as u32;
    ClassOutput {
        class_id: class.id.to_string(),
        name: class.name,
        vendor: class.vendor,
        version: class.version,
        categories: categories_for_output(&class.subcategories, instrument),
        initialized,
        sample32: initialized,
        has_editor: initialized,
        audio_inputs,
        audio_outputs,
        event_inputs: u32::from(instrument),
        supported_audio_modes,
        buses,
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
        .ok_or("usage: heron-vst3-probe [--soft] <module.vst3>")?;
    let path = PathBuf::from(path);
    if let Ok(class_id) = env::var(CLASS_PROBE_ENV) {
        return run_class_probe(&path, &class_id);
    }

    let soft = soft_probe_requested();
    let module = Rc::new(Module::open(&path)?);
    let factory_vendor = module
        .factory_info()
        .map(|info| info.vendor)
        .unwrap_or_default();
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
                vendor: factory_vendor,
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

#[cfg(test)]
mod tests {
    use super::{
        AudioBusDescriptor, AudioBusDirection, AudioBusKind, AudioBusOutput, PluginKind,
        categories_for_output, classify_plugin_kind, looks_like_instrument, parse_subcategories,
        soft_buses,
    };

    fn modes(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn subcategory_instrument_beats_permissive_effect_layout() {
        let effect = modes(&["mono", "stereo"]);
        let instrument = modes(&["stereo"]);
        let (kind, supported) =
            classify_plugin_kind(&modes(&["Instrument", "Synth"]), &effect, &instrument);
        assert_eq!(kind, PluginKind::Instrument);
        assert_eq!(supported, instrument);
    }

    #[test]
    fn subcategory_instrument_survives_failed_instrument_activation() {
        let effect = modes(&["stereo"]);
        let (kind, supported) = classify_plugin_kind(&modes(&["Instrument", "Drum"]), &effect, &[]);
        assert_eq!(kind, PluginKind::Instrument);
        assert_eq!(supported, modes(&["mono", "stereo"]));
    }

    #[test]
    fn bus_heuristic_still_classifies_instrument_without_subcategories() {
        let (kind, supported) = classify_plugin_kind(&[], &[], &modes(&["mono"]));
        assert_eq!(kind, PluginKind::Instrument);
        assert_eq!(supported, modes(&["mono"]));
    }

    #[test]
    fn silent_subcategories_prefer_effect_when_both_layouts_work() {
        let effect = modes(&["stereo"]);
        let instrument = modes(&["stereo"]);
        let (kind, supported) = classify_plugin_kind(&[], &effect, &instrument);
        assert_eq!(kind, PluginKind::Effect);
        assert_eq!(supported, effect);
    }

    #[test]
    fn looks_like_instrument_matches_common_vst3_tokens() {
        assert!(looks_like_instrument(&modes(&["Instrument", "Synth"])));
        assert!(looks_like_instrument(&modes(&["Fx", "Synth"])));
        assert!(!looks_like_instrument(&modes(&["Fx", "EQ"])));
        assert!(!looks_like_instrument(&[]));
    }

    #[test]
    fn categories_for_output_preserves_factory_tags() {
        assert_eq!(
            categories_for_output("Instrument|Sampler", true),
            modes(&["Instrument", "Sampler"])
        );
        assert_eq!(
            categories_for_output("", true),
            modes(&["Instrument", "Synth"])
        );
        assert_eq!(categories_for_output("", false), modes(&["Fx"]));
        assert_eq!(parse_subcategories(" Fx | EQ | "), modes(&["Fx", "EQ"]));
    }

    #[test]
    fn audio_bus_output_preserves_real_vst3_metadata() {
        let input = AudioBusOutput::from(AudioBusDescriptor {
            index: 2,
            direction: AudioBusDirection::Input,
            kind: AudioBusKind::Main,
            name: "Detector".to_owned(),
            channels: 1,
            default_active: false,
        });
        assert_eq!(input.index, 2);
        assert_eq!(input.direction, "input");
        assert_eq!(input.kind, "main");
        assert_eq!(input.name, "Detector");
        assert_eq!(input.channels, 1);
        assert!(!input.default_active);

        let output = AudioBusOutput::from(AudioBusDescriptor {
            index: 4,
            direction: AudioBusDirection::Output,
            kind: AudioBusKind::Aux,
            name: "Monitor".to_owned(),
            channels: 2,
            default_active: true,
        });
        assert_eq!(output.direction, "output");
        assert_eq!(output.kind, "aux");
        assert!(output.default_active);
    }

    #[test]
    fn soft_bus_metadata_matches_effect_and_instrument_fallbacks() {
        let effect = soft_buses(false);
        assert_eq!(effect.len(), 2);
        assert_eq!(effect[0].direction, "input");
        assert_eq!(effect[0].name, "Stereo In");
        assert_eq!(effect[1].direction, "output");
        assert_eq!(effect[1].name, "Stereo Out");
        assert!(effect.iter().all(|bus| {
            bus.index == 0 && bus.kind == "main" && bus.channels == 2 && bus.default_active
        }));

        let instrument = soft_buses(true);
        assert_eq!(instrument.len(), 1);
        assert_eq!(instrument[0].direction, "output");
    }
}
