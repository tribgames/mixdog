//! The memory runtime's `[runtime-fetcher]` line against Node's recorded stderr (`fixtures/memory-quiet`, `record-memory-quiet.mjs`): the
//! real `ensureRuntime` on a win32-arm64 host with the runtime already installed. Node prints the line unless `MIXDOG_QUIET_MEMORY_LOG`
//! mutes it, and the memory worker the daemon forks (`memory-runtime-proxy/daemon-spawn.mjs:39-50`) never sets that variable, so the line
//! reaches the memory worker's log. Rust writes it through `mixdog_rt::memory_stderr!`, the memory worker's Node-stderr sink.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{InstallOptions, Manifest, Platform, ensure_runtime};
use crate::memory::ingest::system_now;

const TWIN: &str = include_str!("../../../../../../fixtures/memory-quiet/twin.json");

#[tokio::test(flavor = "current_thread")]
async fn the_cached_runtime_logs_the_line_node_s_unmuted_run_printed() {
    if !cfg!(windows) {
        return; // the seed names `bin/postgres.exe`, as recorded on Windows
    }
    let twin: Value = serde_json::from_str(TWIN).expect("twin");
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
    let (lines, guard) = mixdog_rt::node_log::capture();
    let installed = ensure_runtime(&options, &CancellationToken::new()).await.expect("the cached runtime is reused");
    drop(guard);
    let written: String = lines.lock().expect("lines").iter().map(|(_, _, line)| mixdog_rt::node_log::bare(line)).collect();
    assert_eq!(written, twin["runs"]["bare"]["stderr"].as_str().expect("stderr"));
    let dir = installed.runtime_dir.strip_prefix(data.path()).expect("inside").to_string_lossy().replace('\\', "/");
    assert_eq!(dir, twin["runs"]["bare"]["result"]["runtimeDir"].as_str().expect("dir"));
}