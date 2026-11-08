//! The session delete purge hooks (`PurgeHooks`) over the real owners of the state they drop,
//! against what a 1.4.5 daemon's real `deleteSession` did to a populated data folder
//! (`fixtures/session-delete/populated_delete.json`, recorded by
//! `benchmarks/rust-core/recorders/record-session-delete.mjs`): the files the golden's before
//! state holds are written, the hooks run for the two deleted sessions, and every file must end as
//! Node left it (removed, kept as it was, or edited), with nothing else made.
//!
//! The store's own files (the summary log, the writer locks) are the thread store's, purged by
//! its delete mark (`store` tests), not by these hooks. `sessions/<id>.log.jsonl` is the hooks'
//! transcript export here (a copy the store does not own), removed by `transcript_export`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::flow::seams::{RowUpdate, SessionNames, TurnListener, TurnSource, Unobserve, WorkerRows};
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::registry::warm::WarmLedger;
use mixdog_ai::warmer::chain::{TimerHandle, WarmDeps, WarmRequest, WarmTarget, WarmTimers, Warmer};
use mixdog_ai::warmer::plan::{IDLE_RETURN_LOOKBACK_MS, IDLE_RETURN_WINDOW_MS, Prices, warm_delay_ms};
use mixdog_ai::warmer::stores::{GapRules, GapStore, TouchStore};
use mixdog_ai::warmer::stream::{WarmFailure, WarmUsage};
use mixdog_core::run_host::read_snapshots::FileSnapshotPersist;
use mixdog_core_session::session::agent_registry::{AgentRegistry, LiveSessions, ReapWindow, Row, WorkerStore};
use mixdog_core_session::session::delete::PurgeHooks;
use mixdog_core_session::session::purge::{IngestOffsets, PurgeOwners};
use mixdog_core_session::session::SystemClock;
use mixdog_tools::fs::{Persistence, ReadState};
use serde_json::{Value, json};
use mixdog_rt::{InLane, MaintenanceIo};
use tokio_util::sync::CancellationToken;

const GOLDEN: &str = include_str!("../../../../fixtures/session-delete/populated_delete.json");

struct NoTurns;
impl TurnSource for NoTurns {
    fn observe_session_turns(&self, _: &str, _: Arc<dyn TurnListener>) -> Option<Unobserve> {
        None
    }
}
impl SessionNames for NoTurns {
    fn tag_for_session(&self, _: &str) -> Option<String> {
        None
    }
    fn agent(&self, _: &str) -> Option<String> {
        None
    }
}
impl WorkerRows for NoTurns {
    fn upsert(&self, _: &str, _: Option<&str>, _: RowUpdate) {}
}
impl mixdog_agent::env::Clock for NoTurns {
    fn now_ms(&self) -> i64 {
        0
    }
}

/// The worker index: one settled worker row of a deleted session.
#[derive(Default)]
struct Workers(Mutex<Vec<(String, Row)>>);

fn rows(workers: &Workers) -> std::sync::MutexGuard<'_, Vec<(String, Row)>> {
    workers.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[async_trait]
impl WorkerStore for Workers {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(rows(self).clone())
    }
    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        Ok(Vec::new())
    }
    async fn header(&self, _: &str) -> Option<Row> {
        None
    }
    async fn is_directory(&self, _: &str) -> bool {
        false
    }
    fn write(&self, session: &str, worker: Option<Row>) {
        let mut maps = rows(self);
        maps.retain(|(id, _)| id != session);
        if let Some(worker) = worker {
            maps.push((session.to_owned(), worker));
        }
    }
}

impl LiveSessions for Workers {
    fn loaded(&self) -> Vec<String> {
        Vec::new()
    }
    fn header(&self, _: &str) -> Option<Row> {
        None
    }
    fn running(&self, _: &str) -> bool {
        false
    }
    fn has_live_work(&self, _: &str) -> bool {
        false
    }
    fn runtime_stage(&self, _: &str) -> Option<String> {
        None
    }
}

impl ReapWindow for Workers {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        3_600_000.0
    }
}

/// A provider registry with nothing registered (a provider's release is `mixdog-ai`'s test).
struct NoProviders;

#[async_trait]
impl ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// A warmer with no chain armed: nothing here sends, times or reads a request.
struct Idle;
struct NoTimer;
impl TimerHandle for NoTimer {
    fn cancel(&self) {}
}
impl WarmTimers for Idle {
    fn schedule(&self, _: f64, _: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
        Box::new(NoTimer)
    }
}

#[async_trait]
impl WarmDeps for Idle {
    fn now(&self) -> f64 {
        0.0
    }
    fn timers(&self) -> &dyn WarmTimers {
        self
    }
    async fn enabled(&self) -> bool {
        false
    }
    fn read_config_enabled(&self) -> bool {
        false
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        false
    }
    async fn last_sent_request(&self, _: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        Ok(None)
    }
    async fn providers_ready(&self) {}
    async fn provider_current(&self, _: &dyn WarmRequest) -> bool {
        false
    }
    async fn prices(&self, _: &dyn WarmRequest, _: f64, _: f64) -> Result<Prices, String> {
        Err("no prices".into())
    }
    async fn send(
        &self,
        _: &dyn WarmRequest,
        _: &WarmTarget,
        _: &CancellationToken,
        _: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        Err(WarmFailure { message: "no warm".into(), error: None, usage: None })
    }
    async fn record_usage(&self, _: &dyn WarmRequest, _: &WarmUsage, _: f64, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn log(&self, _: &str) {}
}

/// The transcript ingest's `forgetTranscripts`, recording what it is asked to forget.
/// The sessions whose retention record the delete forgot, in order.
#[derive(Default)]
struct Forgotten(Mutex<Vec<String>>);

#[async_trait]
impl mixdog_core_session::session::thread_settings::ArchiveRetention for Forgotten {
    async fn note_archived(&self, _: &str, _: bool) -> Result<(), String> {
        unreachable!("a delete never archives")
    }
    async fn forget(&self, session_id: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(session_id.to_owned());
        Ok(())
    }
}

#[derive(Default)]
struct Offsets(Mutex<Vec<PathBuf>>);

#[async_trait]
impl IngestOffsets for Offsets {
    async fn forget_transcripts(&self, paths: &[PathBuf]) -> usize {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend_from_slice(paths);
        paths.len()
    }
}

/// The thread store's own files, which the store's delete mark purges, not a purge hook.
fn store_owned(path: &str) -> bool {
    path == "data/session-summaries.log" || path.starts_with("data/session-writer-locks/")
}

/// `job` on the maintenance lane: the test's file system access, as the hooks' is.
async fn on_maintenance<R: Send + 'static>(job: impl FnOnce(&InLane<MaintenanceIo>) -> R + Send + 'static) -> R {
    mixdog_core_base::support::on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), job)
        .await
        .expect("a lane job")
}

async fn write(path: &Path, text: &str) {
    let (path, bytes) = (path.to_owned(), text.as_bytes().to_vec());
    on_maintenance(move |lane| {
        mixdog_statefile::create_private_dir_all(lane, path.parent().expect("a parent")).expect("a folder");
        mixdog_core_base::support::write_atomic(lane, &path, &bytes, false).expect("a file");
    })
    .await;
}

/// Every file under `dir`, relative and `/`-separated.
async fn tree(dir: &Path) -> Vec<String> {
    fn walk(lane: &InLane<MaintenanceIo>, dir: &Path, root: &Path, out: &mut Vec<String>) {
        for name in mixdog_statefile::list_dir(lane, dir).expect("a folder") {
            let path = dir.join(name);
            if mixdog_statefile::metadata(lane, &path).expect("an entry").is_dir() {
                walk(lane, &path, root, out);
            } else {
                out.push(path.strip_prefix(root).expect("under the root").to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let dir = dir.to_owned();
    on_maintenance(move |lane| {
        let mut out = Vec::new();
        walk(lane, &dir, &dir, &mut out);
        out.sort();
        out
    })
    .await
}

/// The golden's text with `<home>` put back. Every file that names the home is JSON and the
/// recorder only ever replaced the home inside its strings, so it goes back as string content: a
/// Windows path's backslashes unescaped would make the file invalid JSON (`\U`, `\.`), and the
/// folder's untouched state would not even parse while the hooks are still running.
fn with_home(text: &str, home: &Path) -> String {
    let quoted = serde_json::to_string(&home.to_string_lossy()).expect("a path is text");
    text.replace("<home>", &quoted[1..quoted.len() - 1])
}

/// A state file the hooks edit: compared as JSON, without the clock fields Node stamps.
fn without_clocks(text: &str) -> Value {
    let mut value: Value = serde_json::from_str(text).expect("JSON");
    if let Some(map) = value.as_object_mut() {
        for key in ["updatedAt", "clearedAt"] {
            map.shift_remove(key);
        }
    }
    value
}

/// How the folder differs from the golden's after state; empty when it is the same.
async fn differences(golden: &Value, home: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let files = golden["files"].as_object().expect("files");
    for (path, entry) in files.iter().filter(|(path, _)| !store_owned(path)) {
        let file = home.join(path);
        let on_disk = on_maintenance(move |_| mixdog_statefile::read_content(&file)).await.expect("readable").map(|bytes| String::from_utf8(bytes).expect("UTF-8"));
        let after = entry["after"].as_str().map(|text| with_home(text, home));
        let before = entry["before"].as_str().map(|text| with_home(text, home));
        match (&after, &on_disk) {
            (None, None) => {}
            (None, Some(_)) => out.push(format!("not removed: {path}")),
            (Some(_), None) => out.push(format!("removed, Node kept it: {path}")),
            (Some(want), Some(got)) if after == before => {
                if want != got {
                    out.push(format!("changed, Node kept it as it was: {path}"));
                }
            }
            (Some(want), Some(got)) => {
                let (want, got) = (without_clocks(want), without_clocks(got));
                if want != got {
                    out.push(format!("edited differently: {path}\n  node: {want}\n  here: {got}"));
                }
            }
        }
    }
    let known: Vec<&String> = files.keys().collect();
    for path in tree(home).await {
        if !known.contains(&&path) {
            out.push(format!("made, Node did not: {path}"));
        }
    }
    out
}

/// The golden's recording used a Windows working folder (the transcript's project folder is named
/// after it), so the folder name is only the same on Windows.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_purge_hooks_leave_the_files_a_real_node_delete_leaves() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
    let root = tempfile::tempdir().expect("home");
    let home = root.path();
    let data = home.join("data");
    for (path, entry) in golden["files"].as_object().expect("files").iter().filter(|(path, _)| !store_owned(path)) {
        if let Some(before) = entry["before"].as_str() {
            write(&home.join(path), &with_home(before, home)).await;
        }
    }
    let tokens = mixdog_rt::testing::tokens();

    // The warmer over the stores Node's files hold, read as Node wrote them. Node's clock for
    // them is the recording's (the stores drop what is older than their lookback).
    let recorded_now = golden["files"]["data/prompt-cache-idle-gaps.json"]["before"]
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|doc| doc["sessions"]["sess_keeper"]["open"].as_f64())
        .expect("the keeper's open gap");
    let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line| panic!("{line}"));
    let touches = Arc::new(
        TouchStore::open(data.join("prompt-cache-touches.json"), tokens.durability_io, log.clone(), Arc::new(move || recorded_now))
            .await
            .expect("touch store"),
    );
    let rules = GapRules { lookback_ms: IDLE_RETURN_LOOKBACK_MS, window_ms: IDLE_RETURN_WINDOW_MS, min_ms: warm_delay_ms(5.0 * 60_000.0) };
    let gaps = Arc::new(
        GapStore::open(data.join("prompt-cache-idle-gaps.json"), tokens.durability_io, rules, log, Arc::new(move || recorded_now))
            .await
            .expect("gap store"),
    );
    let warm = Warmer::new(Arc::new(Idle), touches.clone(), gaps.clone(), WarmLedger::new());

    let workers = Arc::new(Workers::default());
    let row = json!({ "tag": "w1", "sessionId": "sess_victim", "agent": "worker", "status": "idle", "parentSessionId": "lead-a" });
    workers.write("sess_victim", Some(row.as_object().cloned().expect("a row")));
    let agents = Arc::new(AgentRegistry::new(workers.clone(), workers.clone(), workers.clone(), Arc::new(SystemClock)));
    let turns = Arc::new(NoTurns);
    let offsets = Arc::new(Offsets::default());
    // The desktop's retention record lives in the config, not in the folder this delete is
    // recorded over: the hook's call is what is checked.
    let retention = Arc::new(Forgotten::default());
    let hooks = PurgeHooks::new(PurgeOwners {
        data_dir: data.clone(),
        mixdog_home: home.to_path_buf(),
        maintenance: tokens.maintenance_io,
        read_state: Arc::new(ReadState::new(Some(Persistence::new(Arc::new(FileSnapshotPersist::new(&data)), tokens.durability_io)))),
        warm,
        ingest_offsets: Some(offsets.clone()),
        providers: Arc::new(ProviderRegistry::new(Arc::new(NoProviders))),
        worker_turns: WorkerTurns::new(turns.clone(), turns.clone(), turns.clone(), turns, Arc::new(|| {})),
        agents,
        retention: retention.clone(),
    });
    let review = mixdog_core_review::turn_review::testing::review_at(&data);

    let cwd = golden["cwd"].as_str().expect("cwd").to_owned();
    for id in ["sess_victim", "sess_cleared"] {
        hooks.run(&review, id, std::slice::from_ref(&cwd)).await;
    }
    assert_eq!(*retention.0.lock().unwrap(), ["sess_victim", "sess_cleared"], "each deleted session's retention record is forgotten");
    touches.flush().await;
    gaps.flush().await;

    // The turn review's marker and baselines, and the transcript offsets, are requests Node does
    // not wait for either: wait for the folder to take its final state.
    let started = Instant::now();
    let mut left = differences(&golden, home).await;
    while !left.is_empty() && started.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(25)).await;
        left = differences(&golden, home).await;
    }
    assert!(left.is_empty(), "{}", left.join("\n"));

    let mut forgotten: Vec<String> = offsets
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|path| path.strip_prefix(home).expect("under the home").to_string_lossy().replace('\\', "/"))
        .collect();
    forgotten.sort();
    assert_eq!(json!(forgotten), golden["offsetsForgotten"]);

    // `registry.forgetDeletedSession`: the settled worker row is a tombstone now.
    let tombstoned = rows(&workers).iter().find(|(id, _)| id == "sess_victim").map(|(_, row)| row.clone()).expect("the row");
    assert!(tombstoned.contains_key("tombstone") && !tombstoned.contains_key("sessionId"), "{tombstoned:?}");
}
