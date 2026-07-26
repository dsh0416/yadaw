use std::{
    env,
    process::{Command, ExitCode, Stdio},
    time::Instant,
};

use ipc_channel::ipc::{self, IpcOneShotServer, IpcReceiver, IpcSender, IpcSharedMemory};
use serde::{Deserialize, Serialize};
use yadaw_ipc_transport::{
    TelemetryReader, TelemetrySnapshot, TelemetryWriter, WirePacket, create_telemetry_page,
};

#[derive(Serialize, Deserialize)]
struct BenchmarkBootstrap {
    requests: IpcReceiver<WirePacket>,
    responses: IpcSender<WirePacket>,
}

fn child(token: String) -> Result<(), String> {
    let rendezvous =
        IpcSender::<IpcSender<BenchmarkBootstrap>>::connect(token).map_err(|e| e.to_string())?;
    let (bootstrap_sender, bootstrap_receiver) = ipc::channel().map_err(|e| e.to_string())?;
    rendezvous
        .send(bootstrap_sender)
        .map_err(|e| e.to_string())?;
    let bootstrap = bootstrap_receiver.recv().map_err(|e| e.to_string())?;
    while let Ok(packet) = bootstrap.requests.recv() {
        if packet.body.is_empty() {
            break;
        }
        bootstrap
            .responses
            .send(packet)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn round_trips(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
    bytes: usize,
    shared: bool,
    iterations: usize,
) -> Result<(), String> {
    let start = Instant::now();
    for _ in 0..iterations {
        let packet = if shared {
            WirePacket {
                body: vec![1],
                regions: vec![IpcSharedMemory::from_byte(7, bytes)],
            }
        } else {
            WirePacket {
                body: vec![7; bytes],
                regions: Vec::new(),
            }
        };
        requests.send(packet).map_err(|e| e.to_string())?;
        responses.recv().map_err(|e| e.to_string())?;
    }
    let elapsed = start.elapsed();
    let megabytes = bytes.saturating_mul(iterations) as f64 / (1024.0 * 1024.0);
    println!(
        "{:>7} {:>7} bytes: {:>9.1} round-trips/s, {:>8.1} MiB/s",
        if shared { "shared" } else { "inline" },
        bytes,
        iterations as f64 / elapsed.as_secs_f64(),
        megabytes / elapsed.as_secs_f64()
    );
    Ok(())
}

fn pipelined_requests(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
) -> Result<(), String> {
    const BATCH: usize = 256;
    const ROUNDS: usize = 100;
    let start = Instant::now();
    for _ in 0..ROUNDS {
        for _ in 0..BATCH {
            requests
                .send(WirePacket {
                    body: vec![1; 128],
                    regions: Vec::new(),
                })
                .map_err(|e| e.to_string())?;
        }
        for _ in 0..BATCH {
            responses.recv().map_err(|e| e.to_string())?;
        }
    }
    println!(
        "256 in-flight inline requests: {:.1}/s",
        (BATCH * ROUNDS) as f64 / start.elapsed().as_secs_f64()
    );
    Ok(())
}

fn parent() -> Result<(), String> {
    let (server, token) =
        IpcOneShotServer::<IpcSender<BenchmarkBootstrap>>::new().map_err(|e| e.to_string())?;
    let mut child = Command::new(env::current_exe().map_err(|e| e.to_string())?)
        .arg("--child")
        .arg(token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let (_, bootstrap_sender) = server.accept().map_err(|e| e.to_string())?;
    let (requests, request_receiver) = ipc::channel().map_err(|e| e.to_string())?;
    let (response_sender, responses) = ipc::channel().map_err(|e| e.to_string())?;
    bootstrap_sender
        .send(BenchmarkBootstrap {
            requests: request_receiver,
            responses: response_sender,
        })
        .map_err(|e| e.to_string())?;

    round_trips(&requests, &responses, 1_024, false, 1_000)?;
    round_trips(&requests, &responses, 64 * 1_024, false, 250)?;
    round_trips(&requests, &responses, 64 * 1_024 + 1, true, 250)?;
    round_trips(&requests, &responses, 4 * 1_024 * 1_024, true, 32)?;
    pipelined_requests(&requests, &responses)?;

    let page = create_telemetry_page(64, 1).map_err(|e| e.to_string())?;
    let writer = TelemetryWriter::map(page.clone()).map_err(|e| e.to_string())?;
    let reader = TelemetryReader::map(page).map_err(|e| e.to_string())?;
    writer
        .publish(&TelemetrySnapshot {
            epoch: 1,
            graph_revision: 1,
            callback_generation: 1,
            transport_state: 1,
            position_frames: 0,
            sample_rate: 48_000,
            meters: Vec::new(),
        })
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    for _ in 0..100_000 {
        std::hint::black_box(reader.read());
    }
    println!(
        "telemetry shared-page reads: {:.1}/s",
        100_000.0 / start.elapsed().as_secs_f64()
    );

    requests
        .send(WirePacket {
            body: Vec::new(),
            regions: Vec::new(),
        })
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let result = if args.next().as_deref() == Some("--child") {
        args.next()
            .ok_or_else(|| "missing child rendezvous token".to_owned())
            .and_then(child)
    } else {
        parent()
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("IPC benchmark failed: {error}");
            ExitCode::FAILURE
        }
    }
}
