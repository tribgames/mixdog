//! Headless embedding model process.

use std::path::PathBuf;
use mixdog_rt::Backend;
use mixdog_services::memory::embed::engine::EmbedConfig;

pub fn run(cache_dir: PathBuf, model_id: String, ort_library: PathBuf, dtype: Option<String>) -> i32 {
    let (executors, tokens) = match crate::boot_executors() {
        Ok(booted) => booted,
        Err(error) => {
            eprintln!("embedding host executors: {error}");
            return 1;
        }
    };
    let config = EmbedConfig { cache_dir, model_id, ort_library, dtype, sessions: 1, lane: tokens.cpu_bulk };
    mixdog_services::memory::embed::host::serve(
        config, &executors.handle(mixdog_rt::TaskClass::Work),
        std::io::stdin().lock(), std::io::stdout().lock(),
    )
}
