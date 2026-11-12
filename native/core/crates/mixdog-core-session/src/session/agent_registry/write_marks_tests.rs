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

/// What a replayed scenario's store saw, in ms since `started` (the write): the header patch attempts, the rows it took, and the
/// flushes that settled; `left` is how many more attempts it refuses.
struct Scene {
    started: mixdog_rt::time::Instant,
    left: std::sync::atomic::AtomicU64,
    attempts: Mutex<Vec<u64>>,
    written: Mutex<Vec<(u64, String, Value)>>,
    settled: Mutex<Vec<(String, u64, Result<(), String>)>>,
    moved: tokio::sync::Notify,
}

impl Scene {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// The recorded step's fields (`attempts` made, rows `indexed`, flushes `settled`) as this store saw them. A rejected
    /// flush's text is the one declared difference (the set's manifest, `settled[].error`): the recorded text is the refusal
    /// the recorder's store threw, which this store refuses with too, and the core's answer must carry it.
    fn observed(&self, want: &Value) -> Value {
        let mut indexed: Vec<String> = Vec::new();
        for (_, session, _) in self.written.lock().unwrap().iter() {
            if !indexed.contains(session) {
                indexed.push(session.clone());
            }
        }
        let settled: Vec<Value> = self
            .settled
            .lock()
            .unwrap()
            .iter()
            .map(|(id, at, result)| {
                let recorded = want["settled"].as_array().and_then(|all| all.iter().find(|w| w["id"] == *id)).and_then(|w| w["error"].as_str());
                let error = match (result, recorded) {
                    (Ok(()), _) => Value::Null,
                    (Err(text), Some(recorded)) if text.contains(recorded) => Value::from(recorded),
                    (Err(text), _) => Value::from(text.as_str()),
                };
                serde_json::json!({"id": id, "at": at, "ok": result.is_ok(), "error": error})
            })
            .collect();
        serde_json::json!({"attempts": self.attempts.lock().unwrap().len(), "indexed": indexed, "settled": settled})
    }

    /// Waits until `ready` holds, re-checked on every change, under one real-time deadline. The deadline is a blocking task:
    /// while it runs the paused clock does not advance by itself, so only the replay's `advance` moves time.
    async fn until(&self, what: &str, ready: impl Fn(&Scene) -> bool) {
        let (done, ended) = std::sync::mpsc::channel::<()>();
        let mut deadline = tokio::task::spawn_blocking(move || matches!(ended.recv_timeout(DEADLINE), Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
        loop {
            let changed = self.moved.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if ready(self) {
                drop(done);
                return;
            }
            tokio::select! {
                () = &mut changed => {}
                expired = &mut deadline => {
                    assert!(!expired.expect("the deadline task"), "timed out after {DEADLINE:?} waiting for {what}");
                    unreachable!("the deadline task ends only when the wait ends or its deadline passes");
                }
            }
        }
    }
}

/// Headers whose patches are refused for the first `left` attempts of the scene.
struct Flaky(Arc<Scene>);

#[async_trait::async_trait]
impl ThreadState for Flaky {
    async fn header(&self, _: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(Map::new())
    }
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        use std::sync::atomic::Ordering;
        let scene = &self.0;
        let at = scene.now();
        scene.attempts.lock().unwrap().push(at);
        let refused = scene.left.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
        if !refused {
            scene.written.lock().unwrap().push((at, thread.as_str().to_owned(), set.get("worker").cloned().unwrap_or(Value::Null)));
        }
        scene.moved.notify_waiters();
        if refused { Err(PortError::Denied("store refused".into())) } else { Ok(()) }
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

/// A flush the replay started: its barrier is sent before this returns (the first poll), and its answer is stamped on the scene.
async fn start_flush(workers: &Arc<StoreWorkers>, scene: &Arc<Scene>, id: &str) {
    let (workers, scene, id) = (workers.clone(), scene.clone(), id.to_owned());
    let mut flush = Box::pin(async move {
        let answer = workers.settled().await;
        scene.settled.lock().unwrap().push((id, scene.now(), answer));
        scene.moved.notify_waiters();
    });
    assert!(futures::poll!(flush.as_mut()).is_pending(), "a flush answers only once the writer has seen its barrier");
    drop(tokio::spawn(flush));
}

/// The warnings the replay's thread logs, as the product's subscriber writes them.
#[derive(Clone, Default)]
struct Logged(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `fixtures/agent-index-retry` (record-agent-index-retry.mjs): Node's index write queue tries a refused persist four times, after
/// 50, 250 and 1000 ms, stops at the first success, rejects its flush after the fourth refusal and keeps the batch for a later
/// flush or the 15 s retry; a flush that arrives during a round the retry timer started ends with that round; a write that
/// recovered leaves no failure behind. The recorded input is written, and the clock moves only by the explicit steps of the
/// recording (each first stopped one ms short, where nothing more may have been tried, written or answered).
#[tokio::test(start_paused = true)]
async fn a_refused_header_write_is_retried_as_nodes_index_queue_retries_it() {
    use std::sync::atomic::Ordering;

    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent-index-retry/golden.json")).unwrap();
    let log = Logged::default();
    let writer = log.clone();
    let _logging = tracing::subscriber::set_default(tracing_subscriber::fmt().with_ansi(false).with_max_level(tracing::Level::WARN).with_writer(move || writer.clone()).finish());
    let ms = |d: std::time::Duration| d.as_millis() as u64;
    let product: Vec<u64> = super::RETRY_DELAYS.iter().copied().map(ms).chain([ms(super::KEPT_RETRY_AFTER)]).collect();
    let mut armed: std::collections::BTreeSet<u64> = Default::default();

    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let scene = Arc::new(Scene {
            started: mixdog_rt::time::Instant::now(),
            left: case["failures"].as_u64().unwrap_or(u64::MAX).into(),
            attempts: Mutex::default(),
            written: Mutex::default(),
            settled: Mutex::default(),
            moved: tokio::sync::Notify::new(),
        });
        let (_dir, workers) = workers(Arc::new(Flaky(scene.clone()))).await;
        let workers = Arc::new(workers);
        log.0.lock().unwrap().clear();

        let (session, row) = (case["input"]["session"].as_str().unwrap(), case["input"]["row"].as_object().unwrap().clone());
        workers.write(session, Some(row));

        let mut previous = serde_json::json!({"attempts": 0, "indexed": [], "settled": []});
        for step in case["steps"].as_array().unwrap() {
            match step["op"].as_str().unwrap() {
                "flush" => start_flush(&workers, &scene, step["id"].as_str().unwrap()).await,
                "recover" => scene.left.store(step["failures"].as_u64().unwrap(), Ordering::SeqCst),
                "advance" => {
                    let by = step["by"].as_u64().unwrap();
                    let want = serde_json::json!({"attempts": step["attempts"], "indexed": step["indexed"], "settled": step["settled"]});
                    if by > 1 {
                        tokio::time::advance(std::time::Duration::from_millis(by - 1)).await;
                        assert_eq!(scene.observed(&previous), previous, "{name}: something happened 1 ms short of the recorded step at {} ms", step["at"]);
                    }
                    if by > 0 {
                        tokio::time::advance(std::time::Duration::from_millis(1)).await;
                    }
                    let (attempts, settled) = (want["attempts"].as_u64().unwrap() as usize, want["settled"].as_array().unwrap().len());
                    scene.until(&format!("{name}: the state at {} ms", step["at"]), |s| s.attempts.lock().unwrap().len() >= attempts && s.settled.lock().unwrap().len() >= settled).await;
                    assert_eq!(scene.observed(&want), want, "{name}: the state at {} ms", step["at"]);
                    assert_eq!(scene.now(), step["at"].as_u64().unwrap(), "{name}: the clock");
                    previous = want;
                }
                other => panic!("an unknown recorded step {other}"),
            }
        }

        // Every other recorded field, from what the replay saw.
        let answer = |id: &str| {
            let state = scene.observed(&previous);
            state["settled"].as_array().unwrap().iter().find(|s| s["id"] == id).map(|s| serde_json::json!({"at": s["at"], "ok": s["ok"], "error": s["error"]})).unwrap_or(Value::Null)
        };
        let written = scene.written.lock().unwrap().clone();
        assert!(written.iter().all(|(_, s, w)| s == session && *w == case["input"]["row"]), "{name}: the recorded input is what was written");
        let reports = String::from_utf8_lossy(&log.0.lock().unwrap()).lines().filter(|l| l.contains("unpersisted write(s) kept queued after retries")).count();
        for (field, want) in case.as_object().unwrap() {
            let got = match field.as_str() {
                "name" | "failures" | "input" | "steps" => continue,
                "attempts" => serde_json::json!(*scene.attempts.lock().unwrap()),
                "delays" => {
                    let delays: Vec<u64> = want.as_array().unwrap().iter().map(|d| d.as_u64().unwrap()).collect();
                    assert!(delays.iter().all(|d| product.contains(d)), "{name}: a delay the product does not have: {delays:?}");
                    armed.extend(delays);
                    want.clone()
                }
                "flush" | "later" | "laterDrain" | "joined" => answer(field),
                "retryAfter" => serde_json::json!(ms(super::KEPT_RETRY_AFTER)),
                "retriedAt" => written.last().map_or(Value::Null, |(at, _, _)| serde_json::json!(at)),
                "joinedAt" => case["steps"].as_array().unwrap().iter().find(|s| s["id"] == "joined").map_or(Value::Null, |s| s["at"].clone()),
                "failureReports" => serde_json::json!(reports),
                "indexed" => scene.observed(&previous)["indexed"].clone(),
                "unpersisted" => serde_json::json!(workers.marks().check(workers.marks().accepted()).unwrap().is_err()),
                other => panic!("{name}: a recorded field the replay does not compare: {other}"),
            };
            assert_eq!(&got, want, "{name}: {field}");
        }
    }
    assert_eq!(armed.into_iter().collect::<Vec<_>>(), { let mut all = product.clone(); all.sort_unstable(); all }, "the recorded delays are the product's");
}

#[tokio::test(start_paused = true)]
async fn a_failed_write_before_the_barrier_is_its_error() {
    let (_dir, workers) = workers(Arc::new(GatedHeaders::default())).await;
    workers.write("bad", None);
    let answer = tokio::time::timeout(DEADLINE, workers.marks().reached(workers.marks().accepted())).await.expect("the barrier did not answer within 10 s");
    let error = answer.expect_err("the failed patch is the barrier's error");
    assert!(error.starts_with("the agent index: write 1, accepted before the barrier, failed: the worker row of bad"), "{error}");
}
