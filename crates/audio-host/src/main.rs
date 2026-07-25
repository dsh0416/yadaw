use std::{
    io::{self, BufReader, BufWriter},
    process::ExitCode,
};

use yadaw_dsp_runtime::protocol::{
    ControlCommand, ControlRequest, ControlResponse, ControlResult, PROTOCOL_VERSION, read_message,
    validate_version, write_message,
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let request: ControlRequest = read_message(&mut input)?;
        let result = match validate_version(request.version) {
            Ok(()) => match request.command {
                ControlCommand::Ping => ControlResult::Pong,
                ControlCommand::LoadGraph { .. } => ControlResult::Accepted,
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
