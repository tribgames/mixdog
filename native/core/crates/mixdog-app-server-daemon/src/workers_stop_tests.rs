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

/// Headers that refuse every patch.
struct FailingHeaders;

#[async_trait::async_trait]
impl ThreadState for FailingHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        Err(PortError::Invalid { field: "worker".into(), reason: "disk full".into() })
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_write_the_headers_refused_is_logged_by_the_stop_step() {
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
    let workers = Arc::new(StoreWorkers::new(index, Arc::new(FailingHeaders), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let log = crate::daemon_log::DaemonLog::new(dir.path().join("daemon.log"), tokens.maintenance_io, mixdog_rt::CancellationToken::new());

    let mut row = Map::new();
    row.insert("status".to_owned(), json!("running"));
    workers.write("sess_fail", Some(row));
    let error = tokio::time::timeout(DEADLINE, workers.settled()).await.expect("settled did not end within 10 s").expect_err("a refused header write is reported");
    assert!(error.contains("sess_fail") && error.contains("failed"), "{error}");

    let (_, step) = crate::compose_flip::workers_step(workers, log);
    tokio::time::timeout(DEADLINE, step).await.expect("the step did not end within 10 s");
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
