use std::{
    env,
    io::{self, BufReader, BufWriter},
    path::PathBuf,
    process::ExitCode,
};

use yadaw_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, ControlResponse, ControlResult, PROTOCOL_VERSION, read_message,
    validate_version, write_message,
};

mod vst3;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let mut bridge_path: Option<PathBuf> = None;
    while let Some(argument) = arguments.next() {
        if argument == "--vst3-bridge" {
            bridge_path = arguments.next().map(PathBuf::from);
        }
    }
    let mut vst3 = bridge_path
        .as_deref()
        .map(vst3::Vst3Runtime::load)
        .transpose()
        .map_err(|error| format!("could not load VST3 bridge: {error}"))?;
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let request: ControlRequest = read_message(&mut input)?;
        let result = match validate_version(request.version) {
            Ok(()) => match request.command {
                ControlCommand::Ping => ControlResult::Pong,
                ControlCommand::LoadGraph { .. } => ControlResult::Accepted,
                command @ (ControlCommand::LoadPlugin { .. }
                | ControlCommand::UnloadPlugin { .. }
                | ControlCommand::PluginParameters { .. }
                | ControlCommand::SetPluginParameter { .. }
                | ControlCommand::SavePluginState { .. }) => match vst3.as_mut() {
                    Some(runtime) => runtime.execute(command),
                    None => ControlResult::Error {
                        message: "VST3 bridge is not configured".into(),
                    },
                },
                ControlCommand::Shutdown => {
                    write_message(
                        &mut output,
                        &ControlResponse {
                            version: PROTOCOL_VERSION,
                            request_id: request.request_id,
                            result: ControlResult::Accepted,
                        },
                    )?;
                    return Ok(());
                }
            },
            Err(error) => ControlResult::Error {
                message: error.to_string(),
            },
        };
        write_message(
            &mut output,
            &ControlResponse {
                version: PROTOCOL_VERSION,
                request_id: request.request_id,
                result,
            },
        )?;
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("audio-host: {error}");
            ExitCode::FAILURE
        }
    }
}
