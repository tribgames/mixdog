//! `mixdogd effort-judge-host`: the process the effort judge's model runs in, so that a native fault
//! in ONNX Runtime ends this process and not the core (`mixdog-services` `effort_judge/host.rs`).
//! It serves requests on its stdin and stdout until the core closes them.

use std::path::PathBuf;

use mixdog_services::effort_judge::ModelConfig;
use mixdog_services::effort_judge::model::OrtRuntime;

/// Boots the executors (the model's threads run on the judge's thread token), loads the model and
/// serves. Answers the process's exit status.
pub fn run(dir: PathBuf, ort_library: PathBuf, explicit: bool) -> i32 {
    let (_executors, tokens) = match crate::boot_executors() {
        Ok(booted) => booted,
        Err(error) => {
            eprintln!("mixdogd effort-judge-host: starting the executors: {error}");
            return 1;
        }
    };
    let config = ModelConfig { dir, explicit, ort_library: OrtRuntime::Library(ort_library) };
    mixdog_services::effort_judge::host::serve(&config, tokens.judge_thread, std::io::stdin().lock(), std::io::stdout().lock())
}
