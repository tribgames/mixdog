//! [`StoreWorkers::marks`], what the replay's barrier waits on for the agent index: a write queued before the barrier holds it
//! until its patch is applied, a write queued after it does not, and a failed patch before it is its error.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

use super::StoreWorkers;
use super::WorkerStore;

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Headers whose patches wait at a gate named by the session, or fail for the session `bad`.
#[derive(Default)]
struct GatedHeaders {
    gates: Mutex<Vec<(String, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

impl GatedHeaders {
    /// The patch of `session` signals the first notify when it arrives and waits for the second.
    fn hold(&self, session: &str) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
        let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        self.gates.lock().unwrap().push((session.to_owned(), arrived.clone(), go.clone()));
        (arrived, go)
    }
}

#[async_trait::async_trait]
impl ThreadState for GatedHeaders {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, thread: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        if thread.as_str() == "bad" {
            return Err(PortError::Denied("the header store refused it".into()));
        }
        let gate = self.gates.lock().unwrap().iter().find(|(s, _, _)| s == thread.as_str()).map(|(_, a, g)| (a.clone(), g.clone()));
        if let Some((arrived, go)) = gate {
            arrived.notify_one();
            go.notified().await;
        }
        Ok(())
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

async fn workers(headers: Arc<impl ThreadState + 'static>) -> (tempfile::TempDir, StoreWorkers) {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = dir.path().to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
    (dir, StoreWorkers::new(index, headers, tokens.interactive_io, Arc::new(super::KeptRows::new(state))))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_barrier_waits_for_the_writes_before_it_and_not_the_later_ones() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (before_arrived, before_go) = headers.hold("before");
    let (after_arrived, _after_held) = headers.hold("after");

    workers.write("before", Some(Map::new()));
    tokio::time::timeout(DEADLINE, before_arrived.notified()).await.expect("the earlier patch did not start within 10 s");
    let mark = workers.marks().accepted();
    let mut settled = Box::pin(workers.marks().reached(mark));
    assert!(futures::poll!(settled.as_mut()).is_pending(), "the patch from before the barrier is still held");

    // A write after the barrier: held at its patch for good.
    workers.write("after", None);
    before_go.notify_one();
    tokio::time::timeout(DEADLINE, after_arrived.notified()).await.expect("the later patch did not start within 10 s");
    let answer = tokio::time::timeout(DEADLINE, settled).await.expect("the barrier did not answer within 10 s although the earlier patch was applied");
    assert_eq!(answer, Ok(()));
    assert_eq!(workers.marks().committed(), mark, "the later write was still open when the barrier answered");
}

/// Headers whose patches are refused for the first `left` attempts, each attempt stamped in ms since `started`.
struct Flaky {
    left: std::sync::atomic::AtomicU64,
    started: mixdog_rt::time::Instant,
    attempts: Mutex<Vec<u128>>,
}

#[async_trait::async_trait]
impl ThreadState for Flaky {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        use std::sync::atomic::Ordering;
        self.attempts.lock().unwrap().push(self.started.elapsed().as_millis());
        let refused = self.left.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
        if refused { Err(PortError::Denied("store refused".into())) } else { Ok(()) }
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// `fixtures/agent-index-retry` (record-agent-index-retry.mjs): Node's index write queue tries a refused persist four times, after
/// 50, 250 and 1000 ms, stops at the first success, rejects its flush after the fourth refusal and keeps the batch for a later
/// flush or the 15 s retry; a write that recovered leaves no failure behind. The clock moves only by its own timers and the
/// explicit `advance` of the retry timer.
#[tokio::test(start_paused = true)]
async fn a_refused_header_write_is_retried_as_nodes_index_queue_retries_it() {
    use std::sync::atomic::Ordering;

    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent-index-retry/golden.json")).unwrap();
    let outcome = |settled: Result<(), String>, started: mixdog_rt::time::Instant| (settled.is_ok(), started.elapsed().as_millis() as u64);
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let left = case["failures"].as_u64().unwrap_or(u64::MAX);
        let headers = Arc::new(Flaky { left: left.into(), started: mixdog_rt::time::Instant::now(), attempts: Mutex::new(Vec::new()) });
        let (_dir, workers) = workers(headers.clone()).await;

        workers.write("sess_row", Some(Map::new()));
        let want = |step: &Value| (step["ok"].as_bool().unwrap(), step["at"].as_u64().unwrap());
        assert_eq!(outcome(workers.settled().await, headers.started), want(&case["flush"]), "{name}: the flush");
        if let Some(after) = case["retryAfter"].as_u64() {
            tokio::time::advance(std::time::Duration::from_millis(after)).await;
        }
        if let Some(later) = case.get("later").or_else(|| case.get("laterDrain")) {
            headers.left.store(0, Ordering::SeqCst);
            assert_eq!(outcome(workers.settled().await, headers.started), want(later), "{name}: the later flush");
        } else if case.get("retryAfter").is_some() {
            workers.settled().await.expect("the retry timer put the kept write");
        }

        let attempts: Vec<u64> = case["attempts"].as_array().unwrap().iter().map(|a| a.as_u64().unwrap()).collect();
        let tried: Vec<u64> = headers.attempts.lock().unwrap().iter().map(|a| *a as u64).collect();
        assert_eq!(tried, attempts, "{name}: the attempts");
        let still_failing = case["unpersisted"].as_bool().unwrap();
        assert_eq!(workers.marks().check(workers.marks().accepted()).unwrap().is_err(), still_failing, "{name}: the failure left behind");
    }
}

#[tokio::test(start_paused = true)]
async fn a_failed_write_before_the_barrier_is_its_error() {
    let (_dir, workers) = workers(Arc::new(GatedHeaders::default())).await;
    workers.write("bad", None);
    let answer = tokio::time::timeout(DEADLINE, workers.marks().reached(workers.marks().accepted())).await.expect("the barrier did not answer within 10 s");
    let error = answer.expect_err("the failed patch is the barrier's error");
    assert!(error.starts_with("the agent index: write 1, accepted before the barrier, failed: the worker row of bad"), "{error}");
}
