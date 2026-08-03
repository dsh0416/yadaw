use std::{env, process::ExitCode, rc::Rc};

use heron_vst3_host::{Module, PluginKind, StereoProcessor};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args_os()
        .nth(1)
        .ok_or("usage: inspect <plugin.vst3> [--process]")?;
    let module = Rc::new(Module::open(path)?);
    let classes = module.classes()?;
    for class in &classes {
        println!("{} | {} | {}", class.id, class.category, class.name);
    }
    if env::args_os().any(|argument| argument == "--process") {
        let class = classes.first().ok_or("module has no classes")?;
        let instrument = env::args_os().any(|argument| argument == "--instrument");
        let mut processor = StereoProcessor::create(
            module,
            class.id,
            48_000.0,
            if instrument {
                PluginKind::Instrument
            } else {
                PluginKind::Effect
            },
        )?;
        if instrument {
            processor.queue_note_on(0, 0, 60, 1.0, 1);
        }
        let mut input_left = vec![0.25_f32; 64];
        let mut input_right = vec![-0.25_f32; 64];
        let mut output_left = vec![0.0_f32; 64];
        let mut output_right = vec![0.0_f32; 64];
        processor.process_stereo(
            &mut input_left,
            &mut input_right,
            &mut output_left,
            &mut output_right,
        )?;
        println!(
            "processed 64 frames; latency={}, tail={:?}, peak={}, first=[{}, {}]",
            processor.latency_samples(),
            processor.tail_samples(),
            output_left
                .iter()
                .chain(&output_right)
                .copied()
                .map(f32::abs)
                .fold(0.0_f32, f32::max),
            output_left[0],
            output_right[0]
        );
    }
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
