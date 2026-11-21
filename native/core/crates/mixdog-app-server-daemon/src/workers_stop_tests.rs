//! The stop's agent index step (`compose_flip::workers_step`): a row write still queued when the stop begins is on the headers
//! when the step ends. Node drains its index write queue at that point of `shutdown` (`drainProcessWrites`, daemon.mjs:338);
//! before this step nothing in the product awaited `StoreWorkers::settled`, so a stop left the queued writes to the process's end.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::agent_registry::KeptRows;
use mixdog_core_session::session::agent_registry::StoreWorkers;
use mixdog_core_session::session::agent_registry::WorkerStore;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Headers whose first patch waits at a gate, and which record the patches applied.
#[derive(Default)]
struct GatedHeaders {
    arrived: tokio::sync::Notify,
    go: tokio::sync::Notify,
    applied: Mutex<Vec<(String, Value)>>,
}

#[async_trait::async_trait]
impl ThreadState for GatedHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        self.arrived.notify_one();
        self.go.notified().await;
        self.applied.lock().unwrap().push((thread.as_str().to_owned(), set.get("worker").cloned().unwrap_or(Value::Null)));
        Ok(())
    }
    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, PortError> {
        mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
    }
    async fn patch_header_if(
        &self,
        _: &ThreadId,
        _: Map<String, Value>,
        _: Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// Headers that refuse their first N patches.
struct RefusingHeaders(std::sync::atomic::AtomicU32);

#[async_trait::async_trait]
impl ThreadState for RefusingHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        let refused = self.0.try_update(std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
        if refused { Err(PortError::Invalid { field: "worker".into(), reason: "disk full".into() }) } else { Ok(()) }
    }
    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, PortError> {
        mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
    }
    async fn patch_header_if(
        &self,
        _: &ThreadId,
        _: Map<String, Value>,
        _: Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// A daemon log that keeps what is logged before its file takes over.
fn capturing_log(dir: &std::path::Path, tokens: &mixdog_rt::LaneTokens) -> (crate::daemon_log::DaemonLog, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let log = crate::daemon_log::DaemonLog::with_parts(
        Arc::new(crate::daemon_log::DiskLogFile::new(dir.join("daemon.log"))),
        tokens.maintenance_io,
        mixdog_rt::CancellationToken::new(),
        Arc::new(|| 0),
        Arc::new(move |text| sink.lock().unwrap().push(text.to_owned())),
    );
    (log, lines)
}

/// The row writer over `headers`, a log that keeps its lines, and the folder they live in.
async fn refusing(refusals: u32) -> (tempfile::TempDir, Arc<RefusingHeaders>, Arc<StoreWorkers>, crate::daemon_log::DaemonLog, Arc<Mutex<Vec<String>>>) {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) =
        mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
    let root = dir.path().to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let headers = Arc::new(RefusingHeaders(refusals.into()));
    let workers = Arc::new(StoreWorkers::new(index, headers.clone(), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let (log, lines) = capturing_log(dir.path(), &tokens);
    (dir, headers, workers, log, lines)
}

fn running_row() -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("status".to_owned(), json!("running"));
    row
}

/// A write the headers refuse is answered failed after that one put and logged by the stop step, which then ends: the writer makes no
/// second attempt, on a timer or at the stop (the headers would have taken the fourth).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "Test-only explicit Tokio watchdog or fixture clock; keep it independent of the product replay-time adapter.")]
async fn a_row_write_the_headers_refused_is_put_once_and_logged_by_the_stop_step() {
    let (_dir, headers, workers, log, lines) = refusing(3).await;
    workers.write("sess_fail", Some(running_row()));

    let (_, step) = crate::compose_flip::workers_step(workers, log);
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s");
    let logged = lines.lock().unwrap();
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(logged[0].starts_with("[daemon] agent index drain failed: ") && logged[0].contains("sess_fail") && logged[0].contains("disk full"), "{logged:?}");
    assert_eq!(headers.0.load(std::sync::atomic::Ordering::SeqCst), 2, "one refused put, and none after it");
}

/// A refused write the session's next write replaced leaves the stop step nothing to log: the headers hold the row the session is owed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "Test-only explicit Tokio watchdog or fixture clock; keep it independent of the product replay-time adapter.")]
async fn a_refused_row_write_the_sessions_next_write_replaced_is_not_logged_by_the_stop_step() {
    let (_dir, _headers, workers, log, lines) = refusing(1).await;
    workers.write("sess_fail", Some(running_row()));
    let flushed = tokio::time::timeout(DEADLINE, workers.settled()).await.expect("the flush did not answer within 10 s");
    assert!(flushed.is_err(), "the refused write is the flush's error: {flushed:?}");
    workers.write("sess_fail", Some(running_row()));

    let (_, step) = crate::compose_flip::workers_step(workers, log);
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s");
    assert!(lines.lock().unwrap().is_empty(), "{:?}", lines.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "Test-only explicit Tokio watchdog or fixture clock; keep it independent of the product replay-time adapter.")]
async fn the_stop_step_ends_only_once_a_queued_agent_row_write_is_on_the_headers() {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) =
        mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
    let root = dir.path().to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let headers = Arc::new(GatedHeaders::default());
    let workers = Arc::new(StoreWorkers::new(index, headers.clone(), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let log = crate::daemon_log::DaemonLog::new(dir.path().join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());

    let mut row = Map::new();
    row.insert("status".to_owned(), json!("running"));
    workers.write("sess_stop", Some(row));
    tokio::time::timeout(DEADLINE, headers.arrived.notified()).await.expect("the queued row write did not reach the headers within 10 s");

    let (name, step) = crate::compose_flip::workers_step(workers, log);
    assert_eq!(name, "agent index");
    let mut step = step;
    assert!(futures::poll!(step.as_mut()).is_pending(), "the step ended while a row write was still queued");
    assert!(headers.applied.lock().unwrap().is_empty());

    headers.go.notify_one();
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s after the write was released");
    assert_eq!(*headers.applied.lock().unwrap(), [("sess_stop".to_owned(), json!({ "status": "running" }))]);
}
