use std::{
    env,
    process::{Command, ExitCode, Stdio},
    time::{Duration, Instant},
};

use ipc_channel::ipc::{self, IpcOneShotServer, IpcReceiver, IpcSender, IpcSharedMemory};
use serde::{Deserialize, Serialize};
use yadaw_ipc_transport::{
    RegionOffer, TelemetryReader, TelemetrySnapshot, TelemetryWriter, WirePacket,
    create_telemetry_page,
};

const BULK_BYTES: usize = 4 * 1024 * 1024;
const INLINE_ITERATIONS: usize = 2_000;
const WARM_SEQUENTIAL_ITERATIONS: usize = 256;
const SATURATED_ITERATIONS: usize = 512;

#[derive(Serialize, Deserialize)]
struct BenchmarkBootstrap {
    requests: IpcReceiver<WirePacket>,
    responses: IpcSender<WirePacket>,
}

#[derive(Clone, Serialize, Deserialize)]
enum BenchmarkBody {
    Inline(Vec<u8>),
    Shared {
        sequence: u64,
        request_region: u32,
        response_region: u32,
        length: u64,
    },
    Shutdown,
}

fn encode_body(body: &BenchmarkBody) -> Result<Vec<u8>, String> {
    rmp_serde::to_vec_named(body).map_err(|error| error.to_string())
}

fn decode_body(body: &[u8]) -> Result<BenchmarkBody, String> {
    rmp_serde::from_slice(body).map_err(|error| error.to_string())
}

fn child(token: String) -> Result<(), String> {
    let rendezvous =
        IpcSender::<IpcSender<BenchmarkBootstrap>>::connect(token).map_err(|e| e.to_string())?;
    let (bootstrap_sender, bootstrap_receiver) = ipc::channel().map_err(|e| e.to_string())?;
    rendezvous
        .send(bootstrap_sender)
        .map_err(|e| e.to_string())?;
    let bootstrap = bootstrap_receiver.recv().map_err(|e| e.to_string())?;
    let mut retained_request_regions = Vec::new();
    let response_region = IpcSharedMemory::from_byte(9, BULK_BYTES);
    let mut response_region_offered = false;

    while let Ok(packet) = bootstrap.requests.recv() {
        for offer in packet.region_offers {
            retained_request_regions.push(offer.memory);
        }
        let body = decode_body(&packet.body)?;
        if matches!(body, BenchmarkBody::Shutdown) {
            break;
        }
        let region_offers =
            if matches!(body, BenchmarkBody::Shared { .. }) && !response_region_offered {
                response_region_offered = true;
                vec![RegionOffer {
                    session_epoch: 1,
                    region_id: 2,
                    region_generation: 1,
                    capacity: BULK_BYTES as u64,
                    memory: response_region.clone(),
                }]
            } else {
                Vec::new()
            };
        bootstrap
            .responses
            .send(WirePacket {
                body: encode_body(&body)?,
                region_offers,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn percentile(samples: &mut [Duration], percentile: f64) -> Duration {
    samples.sort_unstable();
    let index = ((samples.len() - 1) as f64 * percentile).round() as usize;
    samples[index]
}

fn inline_sequential_rtt(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
) -> Result<(), String> {
    let body = encode_body(&BenchmarkBody::Inline(vec![7; 128]))?;
    let mut samples = Vec::with_capacity(INLINE_ITERATIONS);
    for _ in 0..INLINE_ITERATIONS {
        let started = Instant::now();
        requests
            .send(WirePacket {
                body: body.clone(),
                region_offers: Vec::new(),
            })
            .map_err(|e| e.to_string())?;
        responses.recv().map_err(|e| e.to_string())?;
        samples.push(started.elapsed());
    }
    let p50 = percentile(&mut samples, 0.50);
    let p99 = percentile(&mut samples, 0.99);
    println!(
        "inline sequential RTT (128-byte payload): p50 {:.3} ms, p99 {:.3} ms",
        p50.as_secs_f64() * 1_000.0,
        p99.as_secs_f64() * 1_000.0
    );
    Ok(())
}

fn shared_cold_first_use(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
) -> Result<(IpcSharedMemory, IpcSharedMemory, usize), String> {
    let request_region = IpcSharedMemory::from_byte(7, BULK_BYTES);
    let body = encode_body(&BenchmarkBody::Shared {
        sequence: 0,
        request_region: 1,
        response_region: 2,
        length: BULK_BYTES as u64,
    })?;
    let started = Instant::now();
    requests
        .send(WirePacket {
            body: body.clone(),
            region_offers: vec![RegionOffer {
                session_epoch: 1,
                region_id: 1,
                region_generation: 1,
                capacity: BULK_BYTES as u64,
                memory: request_region.clone(),
            }],
        })
        .map_err(|e| e.to_string())?;
    let response = responses.recv().map_err(|e| e.to_string())?;
    let elapsed = started.elapsed();
    let response_region = response
        .region_offers
        .into_iter()
        .next()
        .ok_or_else(|| "cold response did not offer its persistent arena region".to_owned())?
        .memory;
    println!(
        "shared cold first-use latency (two 4 MiB mappings): {:.3} ms",
        elapsed.as_secs_f64() * 1_000.0
    );
    Ok((request_region, response_region, body.len()))
}

fn warm_sequential(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
) -> Result<(), String> {
    let body = encode_body(&BenchmarkBody::Shared {
        sequence: 1,
        request_region: 1,
        response_region: 2,
        length: BULK_BYTES as u64,
    })?;
    let started = Instant::now();
    for _ in 0..WARM_SEQUENTIAL_ITERATIONS {
        requests
            .send(WirePacket {
                body: body.clone(),
                region_offers: Vec::new(),
            })
            .map_err(|e| e.to_string())?;
        let response = responses.recv().map_err(|e| e.to_string())?;
        if !response.region_offers.is_empty() {
            return Err("warm response unexpectedly resent a region offer".to_owned());
        }
    }
    let elapsed = started.elapsed();
    let duplex_bytes = 2.0 * BULK_BYTES as f64 * WARM_SEQUENTIAL_ITERATIONS as f64;
    println!(
        "shared warm sequential reference throughput (logical duplex bytes, no payload copy): {:.1} MiB/s",
        duplex_bytes / elapsed.as_secs_f64() / (1024.0 * 1024.0)
    );
    Ok(())
}

fn warm_saturated(
    requests: &IpcSender<WirePacket>,
    responses: &IpcReceiver<WirePacket>,
    in_flight: usize,
) -> Result<(), String> {
    let body = encode_body(&BenchmarkBody::Shared {
        sequence: in_flight as u64,
        request_region: 1,
        response_region: 2,
        length: BULK_BYTES as u64,
    })?;
    let started = Instant::now();
    let mut completed = 0;
    while completed < SATURATED_ITERATIONS {
        let batch = in_flight.min(SATURATED_ITERATIONS - completed);
        for _ in 0..batch {
            requests
                .send(WirePacket {
                    body: body.clone(),
                    region_offers: Vec::new(),
                })
                .map_err(|e| e.to_string())?;
        }
        for _ in 0..batch {
            responses.recv().map_err(|e| e.to_string())?;
        }
        completed += batch;
    }
    let elapsed = started.elapsed();
    let duplex_bytes = 2.0 * BULK_BYTES as f64 * SATURATED_ITERATIONS as f64;
    println!(
        "shared warm saturated reference throughput ({in_flight:>2} in-flight, logical duplex bytes): {:>10.1} MiB/s",
        duplex_bytes / elapsed.as_secs_f64() / (1024.0 * 1024.0)
    );
    Ok(())
}

fn telemetry_reads() -> Result<(), String> {
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
    let started = Instant::now();
    for _ in 0..100_000 {
        std::hint::black_box(reader.read());
    }
    println!(
        "telemetry shared-page reads: {:.1}/s",
        100_000.0 / started.elapsed().as_secs_f64()
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

    println!(
        "IPC benchmark profile: {}",
        if cfg!(debug_assertions) {
            "debug (diagnostic only)"
        } else {
            "release"
        }
    );
    inline_sequential_rtt(&requests, &responses)?;
    let (request_region, response_region, shared_body_bytes) =
        shared_cold_first_use(&requests, &responses)?;
    warm_sequential(&requests, &responses)?;
    for in_flight in [1, 4, 8, 16] {
        warm_saturated(&requests, &responses, in_flight)?;
    }
    telemetry_reads()?;
    println!(
        "arena offers: 2 total; warm offers: 0; shared MessagePack body: {shared_body_bytes} bytes"
    );

    std::hint::black_box((&request_region, &response_region));
    requests
        .send(WirePacket {
            body: encode_body(&BenchmarkBody::Shutdown)?,
            region_offers: Vec::new(),
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
