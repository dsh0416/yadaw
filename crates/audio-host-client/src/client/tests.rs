#[cfg(test)]
mod tests {
    use super::*;
    use ipc_channel::ipc::IpcSharedMemory;
    use yadaw_dsp_runtime::protocol::BinaryPayload;
    use yadaw_ipc_transport::RegionOffer;

    #[test]
    fn native_window_handle_requires_one_nonzero_pointer() {
        let handle = 0x1234usize;
        assert_eq!(
            decode_native_window_handle(Some(&handle.to_ne_bytes())).expect("valid handle"),
            Some(handle)
        );
        assert!(decode_native_window_handle(Some(&[])).is_err());
        assert!(decode_native_window_handle(Some(&0usize.to_ne_bytes())).is_err());
        assert_eq!(decode_native_window_handle(None).expect("no handle"), None);
    }

    #[test]
    fn run_audio_benchmark_uses_the_extended_request_deadline() {
        assert_eq!(
            request_deadline(&ControlCommand::RunAudioBenchmark {
                plugin_instance_ids: Vec::new(),
            }),
            Duration::from_secs(60)
        );
        assert_eq!(
            request_deadline(&ControlCommand::BenchmarkEcho {
                payload: BinaryPayload::inline(Vec::new()),
            }),
            Duration::from_secs(15)
        );
        assert_eq!(
            request_deadline(&ControlCommand::Ping),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn transport_traffic_separates_inline_and_shared_packets() {
        let traffic = TransportTraffic::default();
        record_packet(
            &WirePacket {
                body: vec![1, 2, 3],
                region_offers: Vec::new(),
            },
            &traffic,
        );
        record_packet(
            &WirePacket {
                body: vec![4],
                region_offers: vec![RegionOffer {
                    session_epoch: 1,
                    region_id: 1,
                    region_generation: 1,
                    capacity: 17,
                    memory: IpcSharedMemory::from_bytes(&[0; 17]),
                }],
            },
            &traffic,
        );

        assert_eq!(traffic.inline_packets.load(Ordering::Relaxed), 1);
        assert_eq!(traffic.inline_bytes.load(Ordering::Relaxed), 3);
        assert_eq!(traffic.shared_packets.load(Ordering::Relaxed), 1);
        assert_eq!(traffic.shared_regions.load(Ordering::Relaxed), 1);
        assert_eq!(traffic.shared_bytes.load(Ordering::Relaxed), 17);
    }
}
