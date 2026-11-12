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
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// Headers that refuse their first N patches (Node's queue retries a refused persist, so one row write is four patches).
struct RefusingHeaders(std::sync::atomic::AtomicU32);

#[async_trait::async_trait]
impl ThreadState for RefusingHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        let refused = self.0.fetch_update(std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
        if refused { Err(PortError::Invalid { field: "worker".into(), reason: "disk full".into() }) } else { Ok(()) }
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
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

/// A write the headers refuse through every attempt is logged by the stop step, which then ends; a write that failed and was put by
/// a later attempt is not (the step's drain is Node's `flushAllIndexWrites`, which rejects only while a batch still fails).
#[tokio::test(start_paused = true)]
async fn a_row_write_the_headers_refused_is_logged_by_the_stop_step_until_it_recovers() {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
    let root = dir.path().to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    // Refused by the first four patches: the write's four attempts, then the stop's drain succeeds on its first.
    let workers = Arc::new(StoreWorkers::new(index, Arc::new(RefusingHeaders(4.into())), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let (log, lines) = capturing_log(dir.path(), &tokens);

    let mut row = Map::new();
    row.insert("status".to_owned(), json!("running"));
    workers.write("sess_fail", Some(row));

    // The stop's drain with the batch still failing logs it (Node: `flushAllIndexWrites` rejects).
    let (_, step) = crate::compose_flip::workers_step(workers.clone(), log.clone());
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s");
    {
        let logged = lines.lock().unwrap();
        assert_eq!(logged.len(), 1, "{logged:?}");
        assert!(logged[0].starts_with("[daemon] agent index drain failed: ") && logged[0].contains("sess_fail") && logged[0].contains("disk full"), "{logged:?}");
    }
    lines.lock().unwrap().clear();

    // The headers recovered: the next drain puts the kept write and leaves no failure to log.
    let (_, step) = crate::compose_flip::workers_step(workers, log);
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s");
    assert!(lines.lock().unwrap().is_empty(), "{:?}", lines.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_stop_step_ends_only_once_a_queued_agent_row_write_is_on_the_headers() {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
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
