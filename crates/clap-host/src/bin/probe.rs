use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};

use clap_sys::ext::audio_ports::CLAP_AUDIO_PORT_IS_MAIN;
use heron_clap_host::{ClapDescriptor, ClapInstance, ClapModule};
use serde::{Deserialize, Serialize};

const CHILD_ID_ENV: &str = "HERON_CLAP_PROBE_PLUGIN_ID";
const SOFT_MODE_ENV: &str = "HERON_CLAP_PROBE_MODE";

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
    buses: Vec<AudioBusOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioBusOutput {
    index: u32,
    port_key: String,
    direction: String,
    kind: String,
    name: String,
    channels: u32,
    default_active: bool,
}

fn looks_like_instrument(features: &[String]) -> bool {
    features.iter().any(|feature| {
        let feature = feature.to_ascii_lowercase();
        feature.contains("instrument") || feature.contains("synthesizer")
    })
}

fn soft_output(descriptor: ClapDescriptor) -> ClassOutput {
    let instrument = looks_like_instrument(&descriptor.features);
    let mut buses = Vec::with_capacity(2);
    if !instrument {
        buses.push(AudioBusOutput {
            index: 0,
            port_key: "clap:audio:input:0".to_owned(),
            direction: "input".to_owned(),
            kind: "main".to_owned(),
            name: "Stereo In".to_owned(),
            channels: 2,
            default_active: true,
        });
    }
    buses.push(AudioBusOutput {
        index: 0,
        port_key: "clap:audio:output:0".to_owned(),
        direction: "output".to_owned(),
        kind: "main".to_owned(),
        name: "Stereo Out".to_owned(),
        channels: 2,
        default_active: true,
    });
    ClassOutput {
        class_id: descriptor.id,
        name: descriptor.name,
        vendor: descriptor.vendor,
        version: descriptor.version,
        categories: descriptor.features,
        initialized: true,
        sample32: true,
        has_editor: true,
        audio_inputs: u32::from(!instrument),
        audio_outputs: 1,
        event_inputs: u32::from(instrument),
        supported_audio_modes: if instrument {
            vec!["mono".to_owned(), "stereo".to_owned()]
        } else {
            vec![
                "mono".to_owned(),
                "mono-to-stereo".to_owned(),
                "stereo".to_owned(),
            ]
        },
        buses,
    }
}

fn deep_output(path: &Path, descriptor: ClapDescriptor) -> Result<ClassOutput, String> {
    let module = ClapModule::open(path).map_err(|error| error.to_string())?;
    let instance =
        ClapInstance::create(module, &descriptor.id).map_err(|error| error.to_string())?;
    let ports = instance.audio_ports().map_err(|error| error.to_string())?;
    let note_ports = instance.note_ports().map_err(|error| error.to_string())?;
    let mut input_index = 0_u32;
    let mut output_index = 0_u32;
    let buses = ports
        .iter()
        .map(|port| {
            let index = if port.is_input {
                let value = input_index;
                input_index += 1;
                value
            } else {
                let value = output_index;
                output_index += 1;
                value
            };
            AudioBusOutput {
                index,
                port_key: format!(
                    "clap:audio:{}:{}",
                    if port.is_input { "input" } else { "output" },
                    port.id
                ),
                direction: if port.is_input { "input" } else { "output" }.to_owned(),
                kind: if port.flags & CLAP_AUDIO_PORT_IS_MAIN != 0 {
                    "main"
                } else {
                    "aux"
                }
                .to_owned(),
                name: port.name.clone(),
                channels: port.channel_count,
                default_active: port.flags & CLAP_AUDIO_PORT_IS_MAIN != 0,
            }
        })
        .collect::<Vec<_>>();
    let instrument = looks_like_instrument(&descriptor.features);
    let main_input = buses
        .iter()
        .find(|bus| bus.direction == "input" && bus.kind == "main");
    let main_output = buses
        .iter()
        .find(|bus| bus.direction == "output" && bus.kind == "main");
    let supported_audio_modes = match (instrument, main_input, main_output) {
        (true, None, Some(output)) if output.channels == 1 => vec!["mono".to_owned()],
        (true, None, Some(output)) if output.channels == 2 => vec!["stereo".to_owned()],
        (false, Some(input), Some(output)) if input.channels == 1 && output.channels == 1 => {
            vec!["mono".to_owned()]
        }
        (false, Some(input), Some(output)) if input.channels == 1 && output.channels == 2 => {
            vec!["mono-to-stereo".to_owned()]
        }
        (false, Some(input), Some(output)) if input.channels == 2 && output.channels == 2 => {
            vec!["stereo".to_owned()]
        }
        _ => Vec::new(),
    };
    Ok(ClassOutput {
        class_id: descriptor.id,
        name: descriptor.name,
        vendor: descriptor.vendor,
        version: descriptor.version,
        categories: descriptor.features,
        initialized: true,
        sample32: true,
        has_editor: instance.supports_gui(),
        audio_inputs: buses.iter().filter(|bus| bus.direction == "input").count() as u32,
        audio_outputs: buses.iter().filter(|bus| bus.direction == "output").count() as u32,
        event_inputs: note_ports.iter().filter(|port| port.is_input).count() as u32,
        supported_audio_modes,
        buses,
    })
}

fn child(path: &Path, plugin_id: &str) -> Result<(), String> {
    let module = ClapModule::open(path).map_err(|error| error.to_string())?;
    let descriptor = module
        .descriptors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|descriptor| descriptor.id == plugin_id)
        .ok_or_else(|| format!("CLAP plug-in `{plugin_id}` disappeared"))?;
    let output = deep_output(path, descriptor)?;
    println!(
        "{}",
        serde_json::to_string(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn parent(path: &Path, soft: bool) -> Result<(), String> {
    let module = ClapModule::open(path).map_err(|error| error.to_string())?;
    let descriptors = module.descriptors().map_err(|error| error.to_string())?;
    let vendor = descriptors
        .first()
        .map_or(String::new(), |descriptor| descriptor.vendor.clone());
    let classes = if soft {
        descriptors.into_iter().map(soft_output).collect()
    } else {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        descriptors
            .into_iter()
            .map(|descriptor| {
                let result = Command::new(&executable)
                    .arg(path)
                    .env(CHILD_ID_ENV, &descriptor.id)
                    .stdin(Stdio::null())
                    .stderr(Stdio::inherit())
                    .output();
                match result {
                    Ok(output) if output.status.success() => {
                        serde_json::from_slice::<ClassOutput>(&output.stdout)
                            .unwrap_or_else(|_| failed_output(descriptor))
                    }
                    _ => failed_output(descriptor),
                }
            })
            .collect()
    };
    println!(
        "{}",
        serde_json::to_string(&Output {
            module: ModuleOutput {
                path,
                vendor,
                classes,
            },
        })
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn failed_output(descriptor: ClapDescriptor) -> ClassOutput {
    let mut output = soft_output(descriptor);
    output.initialized = false;
    output
}

fn run() -> Result<(), String> {
    let path = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| "usage: heron-clap-probe <plugin.clap>".to_owned())?;
    if let Ok(plugin_id) = env::var(CHILD_ID_ENV) {
        child(&path, &plugin_id)
    } else {
        parent(
            &path,
            env::var(SOFT_MODE_ENV).is_ok_and(|value| value == "soft"),
        )
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
