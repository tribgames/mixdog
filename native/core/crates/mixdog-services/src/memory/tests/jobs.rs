//! The daemon's memory background jobs over a temporary Postgres cluster: the transcript tail
//! ingest against the Node run recorded in `fixtures/memory-jobs/golden.json`, a cycle1 run end to
//! end (commit, coalescing), the scheduled slot claim, the tick that runs the scheduled cycle and
//! stops on shutdown, and the transcript watcher on a real directory. Needs `MIXDOG_PG_RUNTIME`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_workspace::watcher::FolderWatcher;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::bots::delivery::env::{RetryTimer, SleepRetry};
use crate::memory::cycles::requests::{claim_and_mark_scheduled_cycle, consume_cycle_requests};
use crate::memory::cycles::run::{Cycle1Options, Cycle1Runner};
use crate::memory::cycles::scheduler::{CycleScheduler, SchedulerDeps};
use crate::memory::cycles::{Cycle1Llm, Cycle1Request, CycleConfig, CycleEmbeddings, DirtyFlush};
use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;
use crate::memory::transcript::watcher::{TranscriptSink, start_transcript_watcher};
use crate::memory::transcript::{TranscriptIngest, TranscriptIo};

const GOLDEN: &str = include_str!("../../../../../fixtures/memory-jobs/golden.json");

async fn memory_db(pg: &TestPg) -> Db {
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({"model": "test"})).await.expect("schema");
    db
}

fn io() -> TranscriptIo {
    let tokens = mixdog_rt::testing::tokens();
    TranscriptIo { maintenance: tokens.maintenance_io, durability: tokens.durability_io }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn stored_rows(db: &Db) -> Vec<Value> {
    let rows = db.query("SELECT ts, role, content, source_ref, session_id, source_turn, project_id, time_source FROM entries ORDER BY id", &[]).await.expect("rows");
    rows.iter()
        .map(|r| {
            json!({
                "ts": r.get::<_, i64>(0), "role": r.get::<_, String>(1), "content": r.get::<_, String>(2), "sourceRef": r.get::<_, String>(3),
                "sessionId": r.get::<_, Option<String>>(4), "turn": r.get::<_, Option<i32>>(5), "project": r.get::<_, Option<String>>(6),
                "timeSource": r.get::<_, Option<String>>(7),
            })
        })
        .collect()
}

fn line(value: &Value) -> String {
    value.to_string()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn the_tail_ingest_matches_the_recorded_node_run() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
    let frozen = golden["frozenNow"].as_i64().unwrap();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    let ingest = TranscriptIngest::new(db.clone(), io(), Arc::new(move || frozen));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sess-1.jsonl");
    let project = dir.path().join(".mixdog").join("project.id");
    std::fs::create_dir_all(project.parent().unwrap()).unwrap();
    std::fs::write(&project, "proj-a").unwrap();
    let steps = golden["tail"].as_array().unwrap();
    let mut expected_rows: Vec<Value> = Vec::new();
    let run = |step: &Value, rows: &mut Vec<Value>| {
        rows.extend(step["inserts"].as_array().unwrap().iter().map(|i| {
            json!({"ts": i["ts"], "role": i["role"], "content": i["content"], "sourceRef": i["sourceRef"], "sessionId": i["sessionId"], "turn": i["turn"], "project": i["project"], "timeSource": i["timeSource"]})
        }));
        step["count"].as_u64().unwrap() as usize
    };

    let user = |text: &str, extra: Value| {
        let mut v = json!({"type": "user", "message": {"content": text}});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    let first = [
        line(&user("first question", json!({"timestamp": "2026-01-02T03:04:05.000Z"}))),
        String::new(),
        line(&json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "first answer"}]}, "ts": 1_700_000_000})),
        "{broken json".to_owned(),
        line(&json!({"type": "summary"})),
    ]
    .join("\r\n")
        + "\r\n"
        + "{\"type\":\"user\",\"message\":{\"content\":\"par";
    std::fs::write(&file, first).unwrap();
    let count = ingest.ingest_transcript_file(&file, Some(dir.path())).await.unwrap();
    assert_eq!(count, run(&steps[0], &mut expected_rows), "{}", steps[0]["label"]);
    assert_eq!(stored_rows(&db).await, expected_rows);
    assert_offset(&ingest, &file, &steps[0]["offset"]);

    let mut more = std::fs::read(&file).unwrap();
    more.extend_from_slice(format!("tial\"}}}}\n\u{0}\u{0}{}\n", line(&user("after a NUL run", json!({"ts": 1_700_000_100})))).as_bytes());
    std::fs::write(&file, more).unwrap();
    let count = ingest.ingest_transcript_file(&file, Some(dir.path())).await.unwrap();
    assert_eq!(count, run(&steps[1], &mut expected_rows), "{}", steps[1]["label"]);
    assert_eq!(stored_rows(&db).await, expected_rows);
    assert_offset(&ingest, &file, &steps[1]["offset"]);

    assert_eq!(ingest.ingest_transcript_file(&file, Some(dir.path())).await.unwrap(), 0, "nothing new");

    std::fs::remove_file(&project).unwrap();
    std::fs::write(&file, format!("{}\n", line(&user("rewritten", json!({"ts": 1_700_000_200}))))).unwrap();
    let count = ingest.ingest_transcript_file(&file, Some(dir.path())).await.unwrap();
    assert_eq!(count, run(&steps[3], &mut expected_rows), "{}", steps[3]["label"]);
    assert_eq!(stored_rows(&db).await, expected_rows);
    assert_offset(&ingest, &file, &steps[3]["offset"]);

    // The positions survive a restart: a new ingest loads them from the meta row.
    let reloaded = TranscriptIngest::new(db.clone(), io(), Arc::new(move || frozen));
    reloaded.load_transcript_offsets().await;
    assert_offset(&reloaded, &file, &steps[3]["offset"]);
    assert_eq!(reloaded.forget_transcripts(std::slice::from_ref(&file)).await, 1);
    assert!(reloaded.get_offset(&file).is_none());
}

fn assert_offset(ingest: &TranscriptIngest, file: &Path, expected: &Value) {
    let got = ingest.get_offset(file).expect("a stored position");
    assert_eq!(
        json!({"bytes": mixdog_js::json_number(got.bytes), "generation": mixdog_js::json_number(got.generation), "lineIndex": mixdog_js::json_number(got.line_index)}),
        json!({"bytes": expected["bytes"], "generation": expected["generation"], "lineIndex": expected["lineIndex"]})
    );
}

struct Config {
    section: Mutex<Value>,
    enabled: AtomicBool,
}

impl CycleConfig for Config {
    fn memory_section(&self) -> Value {
        self.section.lock().unwrap().clone()
    }
    fn cycles_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }
    fn maintenance_preset(&self) -> Option<Value> {
        Some(json!({"provider": "test", "model": "m"}))
    }
}

struct Llm {
    replies: Mutex<VecDeque<String>>,
    /// Held until the test releases it: the run stays in flight for as long as the test needs.
    gate: Option<Arc<tokio::sync::Notify>>,
    /// Signalled when a call starts.
    entered: tokio::sync::Notify,
    calls: Mutex<usize>,
}

#[async_trait]
impl Cycle1Llm for Llm {
    async fn call(&self, _request: &Cycle1Request, _cancel: &CancellationToken, _prompt: &str) -> Result<String, String> {
        *self.calls.lock().unwrap() += 1;
        self.entered.notify_one();
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        self.replies.lock().unwrap().pop_front().ok_or_else(|| "no scripted reply".to_owned())
    }
}

#[derive(Default)]
struct Embeddings {
    roots: Mutex<Vec<i64>>,
    dirty_flushes: Mutex<usize>,
}

#[async_trait]
impl CycleEmbeddings for Embeddings {
    async fn flush_dirty(&self, _cancel: &CancellationToken) -> Result<DirtyFlush, String> {
        *self.dirty_flushes.lock().unwrap() += 1;
        Ok(DirtyFlush::default())
    }
    async fn sync_root(&self, root_id: i64, _cancel: &CancellationToken) -> Result<(), String> {
        self.roots.lock().unwrap().push(root_id);
        Ok(())
    }
    async fn flush_raw(&self, _limit: usize) -> Result<(usize, usize), String> {
        Ok((0, 0))
    }
}

fn words(n: usize) -> String {
    "alpha-bravo-charlie ".repeat(n)
}

async fn seed_session(db: &Db, session: &str, rows: usize, age_ms: i64) {
    for i in 0..rows {
        let ts = now_ms() - age_ms + i as i64;
        let role = if i % 2 == 0 { "user" } else { "assistant" };
        db.execute(
            "INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, time_source) VALUES ($1, $2, $3, $4, $5, $6, 'recorded')",
            &[&ts, &role, &words(20), &format!("transcript:{session}#{i}"), &session, &(i as i32 + 1)],
        )
        .await
        .expect("seed");
    }
}

fn runner(db: &Db, replies: &[&str], gate: Option<Arc<tokio::sync::Notify>>, embeddings: Arc<Embeddings>) -> (Arc<Cycle1Runner>, Arc<Llm>) {
    let llm = Arc::new(Llm { replies: Mutex::new(replies.iter().map(|s| (*s).to_owned()).collect()), gate, entered: Default::default(), calls: Mutex::new(0) });
    let config = Arc::new(Config { section: Mutex::new(json!({})), enabled: AtomicBool::new(true) });
    (Cycle1Runner::new(db.clone(), llm.clone(), embeddings, config, Arc::new(now_ms), Arc::new(SleepRetry)), llm)
}

const THREE_HOURS: i64 = 3 * 60 * 60 * 1000;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn cycle1_commits_a_chunk_and_coalesces_a_concurrent_request() {
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    seed_session(&db, "sess-a", 3, THREE_HOURS).await;
    let embeddings = Arc::new(Embeddings::default());
    let gate = Arc::new(tokio::sync::Notify::new());
    let (runner, llm) = runner(&db, &["1-3|Topic|decision|Short summary", "1-3|Topic|fact|Another short summary"], Some(Arc::clone(&gate)), embeddings.clone());
    let config = json!({"min_batch": 1});
    let first = tokio::spawn(Arc::clone(&runner).run_cycle1(config.clone(), Cycle1Options::default()));
    llm.entered.notified().await;
    // The second caller arrives while the first holds the gate: it leaves a request and returns.
    let second = Arc::clone(&runner).run_cycle1(config.clone(), Cycle1Options::default()).await.unwrap();
    assert!(second.skipped_in_flight, "{:?}", second.to_json());
    gate.notify_one();
    let first = first.await.unwrap().unwrap();
    assert_eq!((first.chunks, first.processed, first.skipped_in_flight), (1, 3, false), "{:?}", first.to_json());
    let rows = db.query("SELECT id, chunk_root, is_root, category, summary, status, element, chunk_quality IS NOT NULL FROM entries ORDER BY ts, id", &[]).await.unwrap();
    let root: i64 = rows[0].get(0);
    for row in &rows {
        assert_eq!(row.get::<_, Option<i64>>(1), Some(root));
    }
    assert_eq!((rows[0].get::<_, i16>(2), rows[0].get::<_, String>(3), rows[0].get::<_, String>(4), rows[0].get::<_, String>(6)), (1, "decision".into(), "Short summary".into(), "Topic".into()));
    assert!(rows[0].get::<_, bool>(7) && rows[1].get::<_, i16>(2) == 0);
    assert_eq!(*embeddings.roots.lock().unwrap(), vec![root]);
    assert_eq!(*llm.calls.lock().unwrap(), 1);
    let requests = db.query("SELECT value FROM meta WHERE key LIKE 'cycle_request.cycle1.%'", &[]).await.unwrap();
    assert_eq!(requests.len(), 1, "the skipped caller left one coalesced request");
    assert_eq!(requests[0].get::<_, Value>(0)["count"], json!(0), "the finished run consumed it and scheduled the retry");
    // A retry drains the request: nothing is due, so it records no run.
    let drained = Arc::clone(&runner).run_cycle1(config.clone(), Cycle1Options { coalesced_retry: true, ..Cycle1Options::default() }).await.unwrap();
    assert!(drained.coalesced_retry_noop || drained.chunks == 0, "{:?}", drained.to_json());
    runner.retries().cancel_all();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn a_scheduled_slot_is_claimed_once_and_counted_as_a_request() {
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    let now = now_ms();
    let claim = claim_and_mark_scheduled_cycle(&db, "cycle1", 600_000.0, "sig", "scheduled", Some(60_000.0), now).await;
    assert_eq!((claim.claimed, claim.next_allowed_at), (true, now + 60_000));
    let again = claim_and_mark_scheduled_cycle(&db, "cycle1", 600_000.0, "sig", "scheduled", Some(60_000.0), now + 1000).await;
    assert!(!again.claimed);
    let later = claim_and_mark_scheduled_cycle(&db, "cycle1", 600_000.0, "sig", "scheduled", Some(60_000.0), now + 60_000).await;
    assert!(later.claimed);
    assert_eq!(consume_cycle_requests(&db, "cycle1", "sig", now).await.unwrap(), 2.0);
    assert_eq!(consume_cycle_requests(&db, "cycle1", "sig", now).await.unwrap(), 0.0);
    let spaced = claim_and_mark_scheduled_cycle(&db, "cycle1", 20.0, "other", "scheduled", None, now).await;
    assert_eq!(spaced.next_allowed_at, now + 1000, "spacing is at least a second");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn the_tick_runs_the_scheduled_cycle_and_shutdown_stops_it() {
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    seed_session(&db, "sess-b", 3, THREE_HOURS).await;
    let state = pg.dir.path().join("memory-cycle-state.json");
    let config = Arc::new(Config { section: Mutex::new(json!({"cycle1": {"interval": "50ms", "min_batch": 1}})), enabled: AtomicBool::new(true) });
    let llm = Arc::new(Llm { replies: Mutex::new(VecDeque::from(["1-3|Topic|task|Short summary".to_owned()])), gate: None, entered: Default::default(), calls: Mutex::new(0) });
    let timer = Arc::new(ManualTimer::default());
    let scheduler = CycleScheduler::new(SchedulerDeps {
        db: db.clone(),
        llm: llm.clone(),
        embeddings: Arc::new(Embeddings::default()),
        config: config.clone(),
        state_file: state.clone(),
        lane: mixdog_rt::testing::tokens().maintenance_io,
        now: Arc::new(now_ms),
        timer: timer.clone(),
    })
    .with_tick(Duration::from_millis(150));
    scheduler.start_cycles().await;
    let tick = Duration::from_millis(150);
    timer.armed_at(tick).await;
    timer.fire(tick);
    llm.entered.notified().await;
    // Shutdown joins the tick task, which finishes the check it is in before it ends.
    scheduler.shutdown().await;
    let last = db.query_opt("SELECT value FROM meta WHERE key = 'state.cycle_last_run'", &[]).await.unwrap();
    assert!(last.is_some_and(|r| r.get::<_, Value>(0)["cycle1"].as_i64().unwrap_or(0) > 0), "the scheduled tick ran cycle1");
    assert_eq!(*llm.calls.lock().unwrap(), 1);
    let document: Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
    assert!(document["cycles"]["cycle1"]["last_success_at"].as_i64().unwrap() > 0);
    assert_eq!(document["running"], Value::Null);
    let before = *llm.calls.lock().unwrap();
    timer.fire(tick);
    assert_eq!(*llm.calls.lock().unwrap(), before, "no tick after shutdown");
    assert!(!scheduler.is_cycle1_running());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn the_watcher_ingests_appended_transcripts_and_stops() {
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    let root: PathBuf = mixdog_workspace::pathguard::canonical(&pg.dir.path().join("projects")).unwrap_or_else(|_| pg.dir.path().join("projects"));
    let project_dir = root.join("proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let file = project_dir.join("sess-w.jsonl");
    let user = |text: &str| json!({"type": "user", "message": {"content": text}, "ts": 1_700_000_000}).to_string();
    std::fs::write(&file, format!("{}\n", user("before the watcher"))).unwrap();
    std::fs::write(project_dir.join("agent-sub.jsonl"), format!("{}\n", user("a sub-agent transcript"))).unwrap();
    let root = mixdog_workspace::pathguard::canonical(&root).unwrap();

    let ingest = TranscriptIngest::new(db.clone(), io(), Arc::new(now_ms));
    let sink = TranscriptSink::default();
    let folders = Arc::new(FolderWatcher::new(sink.change_sink()).unwrap());
    let timer = Arc::new(ManualTimer::default());
    let watcher = start_transcript_watcher(root.clone(), Arc::clone(&ingest), Arc::clone(&folders), &sink, timer.clone()).await;
    assert_eq!(stored_rows(&db).await.len(), 1, "the first sweep ingests what is already there, not a sub-agent's file");

    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&format!("{}\n", user("while the watcher runs")));
    std::fs::write(&file, text).unwrap();
    let debounce = Duration::from_millis(500);
    timer.armed_at(debounce).await;
    timer.fire(debounce);
    while watcher.timers_waiting() > 0 {
        tokio::task::yield_now().await;
    }
    watcher.stop();
    watcher.finished().await.unwrap();
    assert_eq!(stored_rows(&db).await.len(), 2, "a change event is debounced into one ingest");
    assert_eq!(folders.open_watches(), 0, "the OS watch is released");
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&format!("{}\n", user("after the watcher stopped")));
    std::fs::write(&file, text).unwrap();
    sink.change_sink().changed(super::super::transcript::watcher::WATCH_ID, vec![file.to_string_lossy().into_owned()], mixdog_workspace::watcher::ChangeKind::Modified);
    assert_eq!(watcher.timers_waiting(), 0, "no debounce timer is armed after stop");
    assert!(timer.armed.lock().unwrap().iter().all(|(d, _)| *d != debounce));
    assert_eq!(stored_rows(&db).await.len(), 2, "nothing is ingested after stop");
}

type Armed = (Duration, Box<dyn FnOnce() + Send>);

/// A retry timer a test fires by hand.
#[derive(Default)]
struct ManualTimer {
    armed: Mutex<Vec<Armed>>,
    signal: tokio::sync::Notify,
}

impl RetryTimer for ManualTimer {
    fn arm(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) {
        self.armed.lock().unwrap().push((delay, fire));
        self.signal.notify_waiters();
    }
}

impl ManualTimer {
    /// Resolves once a timer of `delay` is armed.
    async fn armed_at(&self, delay: Duration) {
        loop {
            let notified = self.signal.notified();
            tokio::pin!(notified);
            // Registered before the check, so an arm between the two is not missed.
            notified.as_mut().enable();
            if self.armed.lock().unwrap().iter().any(|(d, _)| *d == delay) {
                return;
            }
            notified.await;
        }
    }

    fn fire(&self, delay: Duration) {
        let due: Vec<_> = {
            let mut armed = self.armed.lock().unwrap();
            let (due, rest) = std::mem::take(&mut *armed).into_iter().partition(|(d, _)| *d == delay);
            *armed = rest;
            due
        };
        for (_, fire) in due {
            fire();
        }
    }
}

/// Shutdown waits for the ingestion a fired debounce timer started, and arms nothing afterwards:
/// the caller may persist offsets and close the store as soon as `finished` returns.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn shutdown_joins_the_ingestion_a_fired_timer_started() {
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    let root = mixdog_workspace::pathguard::canonical(&pg.dir.path().join("projects")).unwrap_or_else(|_| pg.dir.path().join("projects"));
    let project_dir = root.join("proj");
    std::fs::create_dir_all(&project_dir).unwrap();
    let file = project_dir.join("sess-j.jsonl");
    let user = |text: &str| json!({"type": "user", "message": {"content": text}, "ts": 1_700_000_000}).to_string();
    std::fs::write(&file, format!("{}\n", user("before the watcher"))).unwrap();
    let root = mixdog_workspace::pathguard::canonical(&root).unwrap();

    let ingest = TranscriptIngest::new(db.clone(), io(), Arc::new(now_ms));
    let sink = TranscriptSink::default();
    let folders = Arc::new(FolderWatcher::new(sink.change_sink()).unwrap());
    let timer = Arc::new(ManualTimer::default());
    let watcher = start_transcript_watcher(root, Arc::clone(&ingest), Arc::clone(&folders), &sink, timer.clone()).await;
    assert_eq!(stored_rows(&db).await.len(), 1);

    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&format!("{}\n", user("appended while the timer waits")));
    std::fs::write(&file, text).unwrap();
    let debounce = Duration::from_millis(500);
    timer.armed_at(debounce).await;
    assert_eq!(stored_rows(&db).await.len(), 1, "the debounce timer has not fired: nothing ingested yet");
    timer.fire(debounce);
    while watcher.timers_waiting() > 0 {
        tokio::task::yield_now().await;
    }
    watcher.stop();
    watcher.finished().await.unwrap();
    assert_eq!(stored_rows(&db).await.len(), 2, "the ingestion in flight at stop finished before `finished` returned");

    // A change batch that arrives after stop arms no timer.
    sink.change_sink().changed(super::super::transcript::watcher::WATCH_ID, vec![file.to_string_lossy().into_owned()], mixdog_workspace::watcher::ChangeKind::Modified);
    assert_eq!(watcher.timers_waiting(), 0);
    assert!(timer.armed.lock().unwrap().iter().all(|(d, _)| *d != debounce), "no debounce timer after stop");
}

/// The recorded chunk-root cases through the real row boundary: ids and timestamps pass through
/// the database's bigint columns, so a member that is not a number is refused there and left out
/// of the root choice, as Node's `Number.isFinite` check leaves it out.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME)"]
async fn the_recorded_root_cases_cross_the_row_boundary() {
    use crate::memory::cycles::rows::{row_of, select_root_id};
    mixdog_rt::testing::tokens();
    let pg = TestPg::start().await;
    let db = memory_db(&pg).await;
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["roots"].as_array().unwrap() {
        let mut members = Vec::new();
        for member in case["members"].as_array().unwrap() {
            let (id, ts) = (member["id"].as_str().unwrap(), member["ts"].as_str().unwrap());
            let read = db
                .query_opt("SELECT $1::text::bigint AS id, $2::text::bigint AS ts, NULL::text AS role, ''::text AS content, NULL::text AS session_id, NULL::text AS project_id", &[&id, &ts])
                .await;
            if let Ok(Some(row)) = read {
                members.push(row_of(&row));
            } else {
                assert!(id.parse::<i64>().is_err(), "only a non-number is refused: {member}");
            }
        }
        assert_eq!(select_root_id(&members), case["root"].as_i64(), "{case}");
    }
}
