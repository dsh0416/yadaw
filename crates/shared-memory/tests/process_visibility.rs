use std::{
    env,
    num::NonZeroUsize,
    process::{Command, ExitStatus},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use yadaw_shared_memory::{SHARED_MEMORY_DESCRIPTOR_VERSION, SharedMemory, SharedMemoryDescriptor};

const CHILD_MARKER: &str = "YADAW_SHARED_MEMORY_CHILD";
const CHILD_ID: &str = "YADAW_SHARED_MEMORY_ID";
const CHILD_LENGTH: &str = "YADAW_SHARED_MEMORY_LENGTH";
const CHILD_GENERATION: &str = "YADAW_SHARED_MEMORY_GENERATION";
const TIMEOUT: Duration = Duration::from_secs(10);
const PARENT_CHALLENGE: u64 = 0x7061_7265_6e74_0001;
const CHILD_CHALLENGE: u64 = 0x6368_696c_6400_0002;
const UNLINK_CHALLENGE: u64 = 0x756e_6c69_6e6b_0003;
const CHILD_ACK: u64 = 0x6163_6b00_0000_0004;

#[test]
fn process_visibility_child() {
    if env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let object_id = decode_id(&env::var(CHILD_ID).expect("child object ID is present"));
    let byte_len = parse_env::<u64>(CHILD_LENGTH);
    let generation = parse_env::<u64>(CHILD_GENERATION);
    let descriptor = SharedMemoryDescriptor::from_parts(
        SHARED_MEMORY_DESCRIPTOR_VERSION,
        object_id,
        byte_len,
        generation,
    )
    .expect("child descriptor is valid");
    let mapping = SharedMemory::open(descriptor).expect("child opens the shared mapping");
    assert_eq!(wait_for(&mapping, 0, PARENT_CHALLENGE), PARENT_CHALLENGE);
    atomic(&mapping, 1).store(CHILD_CHALLENGE, Ordering::Release);
    assert_eq!(wait_for(&mapping, 2, UNLINK_CHALLENGE), UNLINK_CHALLENGE);
    atomic(&mapping, 3).store(CHILD_ACK, Ordering::Release);
}

#[test]
fn writes_remain_visible_in_both_directions_and_after_unlink() {
    let mapping = SharedMemory::create(NonZeroUsize::new(4096).unwrap(), 7)
        .expect("parent creates shared mapping");
    let descriptor = mapping.descriptor();
    atomic(&mapping, 0).store(PARENT_CHALLENGE, Ordering::Release);

    let mut child = Command::new(env::current_exe().expect("test executable is available"))
        .arg("--exact")
        .arg("process_visibility_child")
        .arg("--nocapture")
        .env(CHILD_MARKER, "1")
        .env(CHILD_ID, encode_id(descriptor.object_id()))
        .env(CHILD_LENGTH, descriptor.byte_len().to_string())
        .env(CHILD_GENERATION, descriptor.generation().to_string())
        .spawn()
        .expect("child process starts");

    assert_eq!(wait_for(&mapping, 1, CHILD_CHALLENGE), CHILD_CHALLENGE);
    mapping
        .unlink()
        .expect("creator removes the discoverable name");
    atomic(&mapping, 2).store(UNLINK_CHALLENGE, Ordering::Release);
    assert_eq!(wait_for(&mapping, 3, CHILD_ACK), CHILD_ACK);
    let status = wait_for_child(&mut child);
    assert!(status.success(), "child exited with {status}");

    drop(mapping);
    assert!(
        SharedMemory::open(descriptor).is_err(),
        "mapping must not be discoverable after all owners close"
    );
}

fn atomic(mapping: &SharedMemory, index: usize) -> &AtomicU64 {
    let offset = index
        .checked_mul(size_of::<AtomicU64>())
        .expect("test atomic offset fits usize");
    assert!(offset + size_of::<AtomicU64>() <= mapping.len().get());
    // SAFETY: the mapping is live for the returned borrow, mmap/MapViewOfFile is
    // page-aligned, the checked offset is naturally aligned and in bounds, the
    // zero-filled storage is a valid AtomicU64 representation, and both
    // processes access these slots only through AtomicU64.
    unsafe { AtomicU64::from_ptr(mapping.address().as_ptr().add(offset).cast::<u64>()) }
}

fn wait_for(mapping: &SharedMemory, index: usize, expected: u64) -> u64 {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let value = atomic(mapping, index).load(Ordering::Acquire);
        if value == expected {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for shared value"
        );
        thread::yield_now();
    }
}

fn wait_for_child(child: &mut std::process::Child) -> ExitStatus {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("child status is readable") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for child exit"
        );
        thread::yield_now();
    }
}

fn parse_env<T>(name: &str) -> T
where
    T: FromStr,
    T::Err: std::fmt::Debug,
{
    env::var(name)
        .expect("child environment value is present")
        .parse()
        .expect("child environment value is valid")
}

fn encode_id(object_id: [u8; 16]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(32);
    for byte in object_id {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn decode_id(encoded: &str) -> [u8; 16] {
    assert_eq!(encoded.len(), 32);
    let bytes = encoded.as_bytes();
    let mut object_id = [0; 16];
    for (index, output) in object_id.iter_mut().enumerate() {
        *output = (hex(bytes[index * 2]) << 4) | hex(bytes[index * 2 + 1]);
    }
    object_id
}

fn hex(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        _ => panic!("invalid hex digit"),
    }
}
