use ara2_bridge_core::{ApiGeneration, AraError};
use ara2_bridge_host::{
    ArchiveReaderId, ArchiveWriterId, ArchivingProvider, AudioAccessProvider, AudioSourceId,
    HostAudioReader, HostServicesBuilder,
};
use ara2_bridge_sys::{
    ARAAudioAccessControllerHostRef, ARAAudioAccessControllerInterface, ARAAudioReaderHostRef,
    ARAAudioSourceHostRef, ARABool, ARASampleCount, ARASamplePosition, access::read_field,
    kARAFalse, kARATrue,
};
use std::ffi::c_void;
use std::mem::offset_of;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

struct FixtureAudio {
    created: AtomicUsize,
    source: Arc<Mutex<Option<AudioSourceId>>>,
}

impl AudioAccessProvider for FixtureAudio {
    fn create_reader(
        &self,
        source: AudioSourceId,
        _: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        *self.source.lock().unwrap() = Some(source);
        let fail = self.created.fetch_add(1, Ordering::Relaxed) != 0;
        Ok(Box::new(FixtureReader { fail }))
    }
}

struct FixtureReader {
    fail: bool,
}

impl HostAudioReader for FixtureReader {
    fn channel_count(&self) -> usize {
        2
    }

    fn sample_count(&self) -> i64 {
        4
    }

    fn read_f32(&mut self, position: i64, buffers: &mut [&mut [f32]]) -> Result<(), AraError> {
        for (channel, buffer) in buffers.iter_mut().enumerate() {
            for (offset, sample) in buffer.iter_mut().enumerate() {
                *sample = (channel * 10) as f32 + position as f32 + offset as f32 + 1.0;
            }
        }
        if self.fail {
            Err(AraError::Peer("injected partial read failure"))
        } else {
            Ok(())
        }
    }

    fn read_f64(&mut self, position: i64, buffers: &mut [&mut [f64]]) -> Result<(), AraError> {
        for (channel, buffer) in buffers.iter_mut().enumerate() {
            for (offset, sample) in buffer.iter_mut().enumerate() {
                *sample = (channel * 10) as f64 + position as f64 + offset as f64 + 1.0;
            }
        }
        Ok(())
    }
}

struct EmptyArchive;

impl ArchivingProvider for EmptyArchive {
    fn len(&self, _: ArchiveReaderId) -> Result<usize, AraError> {
        Ok(0)
    }

    fn read_at(&self, _: ArchiveReaderId, _: usize, _: &mut [u8]) -> Result<(), AraError> {
        Ok(())
    }

    fn write_at(&self, _: ArchiveWriterId, _: usize, _: &[u8]) -> Result<(), AraError> {
        Ok(())
    }
}

#[test]
fn planar_reads_silence_out_of_range_portions_and_failures() {
    let source_id = Arc::new(Mutex::new(None));
    let services = HostServicesBuilder::new()
        .audio(FixtureAudio {
            created: AtomicUsize::new(0),
            source: Arc::clone(&source_id),
        })
        .archiving(EmptyArchive)
        .build(ApiGeneration::V23Final)
        .unwrap();
    let instance = services.instance();
    let interface = instance.audioAccessControllerInterface;
    let create = callback::<
        unsafe extern "C" fn(
            ARAAudioAccessControllerHostRef,
            ARAAudioSourceHostRef,
            ARABool,
        ) -> ARAAudioReaderHostRef,
    >(
        interface,
        offset_of!(
            ARAAudioAccessControllerInterface,
            createAudioReaderForSource
        ),
    );
    let read = callback::<
        unsafe extern "C" fn(
            ARAAudioAccessControllerHostRef,
            ARAAudioReaderHostRef,
            ARASamplePosition,
            ARASampleCount,
            *const *mut c_void,
        ) -> ARABool,
    >(
        interface,
        offset_of!(ARAAudioAccessControllerInterface, readAudioSamples),
    );
    let destroy =
        callback::<unsafe extern "C" fn(ARAAudioAccessControllerHostRef, ARAAudioReaderHostRef)>(
            interface,
            offset_of!(ARAAudioAccessControllerInterface, destroyAudioReader),
        );
    let mut source = Box::new(0_u8);
    let source_ref = (&mut *source as *mut u8).cast();

    // SAFETY: callbacks and references belong to the live service instance and source fixture.
    let reader = unsafe { create(instance.audioAccessControllerHostRef, source_ref, kARAFalse) };
    let mut left = [9.0_f32; 6];
    let mut right = [9.0_f32; 6];
    let pointers = [left.as_mut_ptr().cast(), right.as_mut_ptr().cast()];
    // SAFETY: both planar buffers contain six writable f32 samples.
    assert_eq!(
        unsafe {
            read(
                instance.audioAccessControllerHostRef,
                reader,
                -1,
                6,
                pointers.as_ptr(),
            )
        },
        kARATrue
    );
    assert_eq!(left, [0.0, 1.0, 2.0, 3.0, 4.0, 0.0]);
    assert_eq!(right, [0.0, 11.0, 12.0, 13.0, 14.0, 0.0]);

    // The second fixture reader writes partial data and then reports failure.
    // SAFETY: same live references as above.
    let failing = unsafe { create(instance.audioAccessControllerHostRef, source_ref, kARAFalse) };
    left.fill(9.0);
    right.fill(9.0);
    let pointers = [left.as_mut_ptr().cast(), right.as_mut_ptr().cast()];
    assert_eq!(
        unsafe {
            read(
                instance.audioAccessControllerHostRef,
                failing,
                0,
                6,
                pointers.as_ptr(),
            )
        },
        kARAFalse
    );
    assert_eq!(left, [0.0; 6]);
    assert_eq!(right, [0.0; 6]);

    // A 64-bit reader uses the same clipping rules at the trailing source boundary.
    // SAFETY: same live service and source references.
    let reader_64 = unsafe { create(instance.audioAccessControllerHostRef, source_ref, kARATrue) };
    let mut left_64 = [9.0_f64; 4];
    let mut right_64 = [9.0_f64; 4];
    let pointers_64 = [left_64.as_mut_ptr().cast(), right_64.as_mut_ptr().cast()];
    // SAFETY: both planar buffers contain four writable f64 samples.
    assert_eq!(
        unsafe {
            read(
                instance.audioAccessControllerHostRef,
                reader_64,
                2,
                4,
                pointers_64.as_ptr(),
            )
        },
        kARATrue
    );
    assert_eq!(left_64, [3.0, 4.0, 0.0, 0.0]);
    assert_eq!(right_64, [13.0, 14.0, 0.0, 0.0]);

    let source_id = source_id.lock().unwrap().unwrap();
    services.revoke_audio_source_readers(source_id);
    left_64.fill(9.0);
    right_64.fill(9.0);
    let pointers_64 = [left_64.as_mut_ptr().cast(), right_64.as_mut_ptr().cast()];
    // SAFETY: buffers remain valid; the revoked reader must be rejected without dereference.
    assert_eq!(
        unsafe {
            read(
                instance.audioAccessControllerHostRef,
                reader_64,
                0,
                4,
                pointers_64.as_ptr(),
            )
        },
        kARAFalse
    );
    assert_eq!(left_64, [9.0; 4]);
    assert_eq!(right_64, [9.0; 4]);

    // All three reader references were synchronously revoked; explicit destruction is now stale.
    // SAFETY: the callback rejects stale identities before dereferencing them.
    unsafe { destroy(instance.audioAccessControllerHostRef, reader) };
}

struct ConcurrentAudio {
    gate: Arc<(Mutex<usize>, Condvar)>,
}

impl AudioAccessProvider for ConcurrentAudio {
    fn create_reader(
        &self,
        _: AudioSourceId,
        _: bool,
    ) -> Result<Box<dyn HostAudioReader>, AraError> {
        Ok(Box::new(ConcurrentReader {
            gate: Arc::clone(&self.gate),
        }))
    }
}

struct ConcurrentReader {
    gate: Arc<(Mutex<usize>, Condvar)>,
}

impl HostAudioReader for ConcurrentReader {
    fn channel_count(&self) -> usize {
        1
    }

    fn sample_count(&self) -> i64 {
        1
    }

    fn read_f32(&mut self, _: i64, buffers: &mut [&mut [f32]]) -> Result<(), AraError> {
        let (mutex, condition) = &*self.gate;
        let mut entered = mutex.lock().unwrap();
        *entered += 1;
        condition.notify_all();
        while *entered < 2 {
            let (next, timeout) = condition
                .wait_timeout(entered, Duration::from_secs(2))
                .unwrap();
            entered = next;
            if timeout.timed_out() {
                return Err(AraError::InvalidState(
                    "distinct audio readers were globally serialized",
                ));
            }
        }
        buffers[0][0] = 1.0;
        Ok(())
    }
}

#[test]
fn distinct_audio_readers_can_run_concurrently() {
    let gate = Arc::new((Mutex::new(0), Condvar::new()));
    let services = Arc::new(
        HostServicesBuilder::new()
            .audio(ConcurrentAudio {
                gate: Arc::clone(&gate),
            })
            .archiving(EmptyArchive)
            .build(ApiGeneration::V23Final)
            .unwrap(),
    );
    let interface = services.instance().audioAccessControllerInterface;
    let create = callback::<
        unsafe extern "C" fn(
            ARAAudioAccessControllerHostRef,
            ARAAudioSourceHostRef,
            ARABool,
        ) -> ARAAudioReaderHostRef,
    >(
        interface,
        offset_of!(
            ARAAudioAccessControllerInterface,
            createAudioReaderForSource
        ),
    );
    let read = callback::<
        unsafe extern "C" fn(
            ARAAudioAccessControllerHostRef,
            ARAAudioReaderHostRef,
            ARASamplePosition,
            ARASampleCount,
            *const *mut c_void,
        ) -> ARABool,
    >(
        interface,
        offset_of!(ARAAudioAccessControllerInterface, readAudioSamples),
    );
    let destroy =
        callback::<unsafe extern "C" fn(ARAAudioAccessControllerHostRef, ARAAudioReaderHostRef)>(
            interface,
            offset_of!(ARAAudioAccessControllerInterface, destroyAudioReader),
        );
    let source = Arc::new(0_u8);

    let threads = (0..2)
        .map(|_| {
            let services = Arc::clone(&services);
            let source = Arc::clone(&source);
            std::thread::spawn(move || {
                let instance = services.instance();
                let source_ref = Arc::as_ptr(&source).cast_mut().cast();
                // SAFETY: callbacks, host state, and the source allocation remain live in this Arc.
                let reader =
                    unsafe { create(instance.audioAccessControllerHostRef, source_ref, kARAFalse) };
                let mut output = [0.0_f32];
                let pointers = [output.as_mut_ptr().cast()];
                // SAFETY: the planar output contains one writable f32 sample.
                let result = unsafe {
                    read(
                        instance.audioAccessControllerHostRef,
                        reader,
                        0,
                        1,
                        pointers.as_ptr(),
                    )
                };
                // SAFETY: balances this thread's reader creation after its read completes.
                unsafe { destroy(instance.audioAccessControllerHostRef, reader) };
                (result, output)
            })
        })
        .collect::<Vec<_>>();

    for thread in threads {
        let (result, output) = thread.join().unwrap();
        assert_eq!(result, kARATrue);
        assert_eq!(output, [1.0]);
    }
}

fn callback<T: Copy>(interface: *const ARAAudioAccessControllerInterface, offset: usize) -> T {
    // SAFETY: the live packed vtable represents all three required audio callbacks.
    unsafe { read_field::<Option<T>>(interface.cast(), offset) }.unwrap()
}
