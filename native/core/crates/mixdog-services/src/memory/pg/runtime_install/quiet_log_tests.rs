//! `MIXDOG_QUIET_MEMORY_LOG` against Node's recorded stderr (`fixtures/memory-quiet`, `record-memory-quiet.mjs`): the real
//! `ensureRuntime` on a win32-arm64 host with the runtime already installed. Node, started with the standalone defaults, prints
//! nothing; without them it prints the `[runtime-fetcher] ... under emulation` line. `mixdogd` formats its `tracing` events to stderr
//! through `EnvFilter::from_default_env()` (`mixdog-cli/src/main.rs` `serve`), whose default (no `RUST_LOG`) lets no info line through,
//! so the same scenario prints nothing; with `RUST_LOG=info` it prints the very line Node's unmuted run printed.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

use super::{InstallOptions, Manifest, Platform, ensure_runtime};
use crate::memory::ingest::system_now;

const TWIN: &str = include_str!("../../../../../../fixtures/memory-quiet/twin.json");

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("sink").extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs the scenario under `serve()`'s subscriber (fmt to stderr, `EnvFilter`) with `RUST_LOG` = `spec`; returns what it wrote and the
/// installed runtime dir relative to the data dir.
async fn scenario(twin: &Value, spec: &str) -> (String, String) {
    let data = tempfile::tempdir().expect("data dir");
    for entry in twin["seed"].as_array().expect("seed") {
        let path = data.path().join(entry["path"].as_str().expect("path"));
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, entry["text"].as_str().expect("text")).expect("file");
    }
    let tokens = mixdog_rt::testing::tokens();
    let options = InstallOptions {
        data_dir: data.path().to_owned(),
        manifest: Manifest::parse(twin["manifest"].as_str().expect("manifest")).expect("manifest"),
        platform: Platform::new("win32", "arm64"),
        release_repositories: String::new(),
        durability: tokens.durability_io,
        bulk: tokens.cpu_bulk,
        now: system_now(),
        progress: None,
    };
    let sink = Sink::default();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::builder().parse_lossy(spec))
        .with_writer({
            let sink = sink.clone();
            move || sink.clone()
        })
        .with_ansi(false)
        .without_time()
        .with_target(false)
        .with_level(false)
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    let installed = ensure_runtime(&options, &CancellationToken::new()).await.expect("the cached runtime is reused");
    drop(guard);
    let dir = installed.runtime_dir.strip_prefix(data.path()).expect("inside").to_string_lossy().replace('\\', "/");
    let written = String::from_utf8(sink.0.lock().expect("sink").clone()).expect("utf8");
    (written, dir)
}

#[tokio::test(flavor = "current_thread")]
async fn the_standalone_default_prints_no_memory_log_line_as_node_does() {
    if !cfg!(windows) {
        return; // the seed names `bin/postgres.exe`, as recorded on Windows
    }
    let twin: Value = serde_json::from_str(TWIN).expect("twin");
    let (stderr, dir) = scenario(&twin, "").await;
    assert_eq!(stderr, twin["runs"]["standalone"]["stderr"].as_str().expect("stderr"));
    assert_eq!(dir, twin["runs"]["standalone"]["result"]["runtimeDir"].as_str().expect("dir"));
}

#[tokio::test(flavor = "current_thread")]
async fn the_scenario_does_emit_node_s_line_when_the_filter_lets_it_through() {
    if !cfg!(windows) {
        return;
    }
    let twin: Value = serde_json::from_str(TWIN).expect("twin");
    let (stderr, dir) = scenario(&twin, "info").await;
    assert_eq!(stderr, twin["runs"]["bare"]["stderr"].as_str().expect("stderr"));
    assert_eq!(dir, twin["runs"]["bare"]["result"]["runtimeDir"].as_str().expect("dir"));
}
