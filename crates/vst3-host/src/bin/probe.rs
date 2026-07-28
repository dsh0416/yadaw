use std::{env, path::Path, process::ExitCode, rc::Rc};

use serde::Serialize;
use yadaw_vst3_host::{AudioLayout, ClassInfo, Module, PluginKind, StereoProcessor};

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

#[derive(Serialize)]
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
    supported_audio_modes: Vec<&'static str>,
}

fn inspect(module: &Rc<Module>, class: ClassInfo) -> ClassOutput {
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
    .filter_map(|(layout, name)| supports(PluginKind::Effect, layout).then_some(name))
    .collect::<Vec<_>>();
    let instrument_modes = [(AudioLayout::Mono, "mono"), (AudioLayout::Stereo, "stereo")]
        .into_iter()
        .filter_map(|(layout, name)| supports(PluginKind::Instrument, layout).then_some(name))
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
        // Editor attachment is attempted lazily by the runtime. Reporting the
        // capability here preserves native-editor discovery while attachment
        // failure still falls back to the generic parameter panel.
        has_editor: initialized,
        audio_inputs: u32::from(!instrument),
        audio_outputs: u32::from(initialized),
        event_inputs: u32::from(instrument),
        supported_audio_modes,
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args_os()
        .nth(1)
        .ok_or("usage: yadaw-vst3-probe <module.vst3>")?;
    let path = Path::new(&path);
    let module = Rc::new(Module::open(path)?);
    let classes = module
        .classes()?
        .into_iter()
        .filter(|class| class.category == "Audio Module Class")
        .map(|class| inspect(&module, class))
        .collect();
    println!(
        "{}",
        serde_json::to_string(&Output {
            module: ModuleOutput {
                path,
                vendor: "",
                classes,
            },
        })?
    );
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
