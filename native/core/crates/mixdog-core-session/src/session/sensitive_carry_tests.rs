//! The three orders a value marked sensitive in one session and carried to another can meet the other session's writer and
//! readers in, each forced at a named point of the rewrite (`store::rewrite_holds`, a `crash-gates` build only): a write of the
//! session between its rewrite's scan and a later carry; the process ending between a child's mark and its parent's rewrite;
//! reads of the session while its rewrite holds them.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_services::memory::sensitive::SensitiveStore;
use mixdog_store::schema::record::Record;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

use super::seams::CommitRecord;
use super::seams::EncodedRecord;
use super::seams::SessionLog;
use super::seams::ThreadStore;
use super::store::SensitiveMarksOf;
use super::store::StoreThreads;
use super::store::rewrite_holds;

const CODE: &str = "482913";
const LATER: &str = "730215";
const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

type Log = Arc<Mutex<Box<dyn SessionLog>>>;

async fn index_over(data: &std::path::Path, tokens: LaneTokens) -> SqliteStore {
    let root = data.to_path_buf();
    LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index")
}

/// A thread store over `data` and `index` whose logs take `marks`.
async fn store_over(data: &std::path::Path, index: SqliteStore, tokens: LaneTokens, marks: &Arc<SensitiveStore>) -> Arc<StoreThreads> {
    let threads = Arc::new(StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
    assert!(threads.redact_with(Arc::new(SensitiveMarksOf::new(marks.clone()))).is_ok());
    threads
}

fn commit(value: Value) -> CommitRecord {
    let record: Record = serde_json::from_value(value).expect("a record");
    let encoded = EncodedRecord(mixdog_store::encode::encode_record(record.clone()).expect("encodes"));
    CommitRecord { record: Arc::new(record), encoded }
}

/// A model row of the user saying `text`.
fn row(iid: &str, text: &str) -> CommitRecord {
    commit(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"role":"user","content":text}}}))
}

fn fill(code: &str) -> Value {
    json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": code } } })
}

/// The thread's log, created with `rows` committed.
async fn create(threads: &Arc<StoreThreads>, tokens: LaneTokens, thread: &str, rows: Vec<CommitRecord>) -> Log {
    let (threads, thread) = (threads.clone(), ThreadId::from(thread));
    let session = commit(json!({"k":"session","v":2,"id":thread.as_str(),"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        let (mut log, _) = threads.create_log(lane, &thread, &session).expect("created");
        log.commit(lane, &rows).expect("appended");
        Arc::new(Mutex::new(log))
    })
    .expect("lane")
    .await
    .expect("job ran")
}

async fn append(log: &Log, tokens: LaneTokens, rows: Vec<CommitRecord>) {
    let log = log.clone();
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        log.lock().expect("log").commit(lane, &rows).expect("appended");
    })
    .expect("lane")
    .await
    .expect("job ran");
}

/// The thread's writer runs the rewrite its marks owe with no row to append (what a carried mark sends an idle thread).
async fn redact(log: &Log, tokens: LaneTokens) {
    let log = log.clone();
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| log.lock().expect("log").redact(lane))
        .expect("lane")
        .await
        .expect("job ran");
}

/// Every file under `data` that holds one of `codes`.
fn holding(data: &std::path::Path, codes: &[&str]) -> Vec<String> {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("dir").flatten() {
            let path = entry.path();
            if path.is_dir() { walk(&path, out) } else { out.push(path) }
        }
    }
    let mut files = Vec::new();
    walk(data, &mut files);
    files
        .into_iter()
        .filter(|path| {
            let bytes = std::fs::read(path).unwrap_or_default();
            codes.iter().any(|code| bytes.windows(code.len()).any(|w| w == code.as_bytes()))
        })
        .map(|path| path.display().to_string())
        .collect()
}

/// (a) A value carried to a thread after its rewrite for an earlier mark scanned the log, with a row holding it committed in
/// that same barrier: the row is appended without it, and the thread's next pass takes it out of the rows the scan missed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_value_carried_after_the_scan_never_stays_in_the_thread() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let parent = create(&threads, tokens, "parent", vec![row("a", &format!("{CODE} and {LATER}"))]).await;
    // The child's own log: its mark is journaled until it, too, was rewritten.
    let child = create(&threads, tokens, "child", vec![]).await;
    marks.carry("child", "parent");
    assert!(marks.remember("parent", &[fill(CODE)]));
    let carried = marks.clone();
    rewrite_holds::set("planned", move || {
        carried.remember("child", &[fill(LATER)]);
    });
    append(&parent, tokens, vec![row("b", &format!("{LATER} again"))]).await;
    redact(&parent, tokens).await;
    redact(&child, tokens).await;
    threads.projected().await;
    assert_eq!(holding(data.path(), &[CODE, LATER]), Vec::<String>::new());
}

/// (b) The process ends after a child marked a value whose earlier report its parent holds and before the parent's rewrite:
/// the next start knows the child's mark again and rewrites the parent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_carried_mark_the_parent_never_applied_is_applied_at_the_next_start() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    {
        let marks = Arc::new(SensitiveStore::default());
        let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
        create(&threads, tokens, "parent", vec![row("r", &format!("the code is {CODE}"))]).await;
        let child = create(&threads, tokens, "child", vec![row("c", "asked")]).await;
        marks.carry("child", "parent");
        assert!(marks.remember("child", &[fill(CODE)]));
        // The child's barrier after the mark: the row of the marking call.
        append(&child, tokens, vec![row("d", "filled")]).await;
        threads.projected().await;
        // The parent's rewrite never runs: the process ends here.
    }
    assert!(!holding(&data.path().join("sessions").join("parent"), &[CODE]).is_empty(), "the parent holds the report");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    threads.settle_marks(tokens.durability_io).await.expect("the marks settle");
    threads.projected().await;
    assert_eq!(holding(data.path(), &[CODE]), Vec::<String>::new());
    assert_eq!(marks.redact_text("child", CODE), "[redacted]", "the child's mark is known again");
    assert_eq!(marks.redact_text("parent", CODE), "[redacted]", "and carried to the parent again");
}

/// (c) Twenty model-context reads issued while the index is behind (its projections held, as a carried mark's rewrite of
/// another thread holds them) wait for it off the lane: a row's commit job is still taken, and each read answers once the
/// index catches up.
#[tokio::test]
async fn reads_issued_while_the_index_is_behind_wait_off_the_lane() {
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("production lanes");
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    create(&threads, tokens, "t", vec![row("a", "the first row")]).await;
    let (reached, release) = threads.hold_index();
    reached.await.expect("the index is held");
    let lanes = super::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let store: Arc<dyn ThreadStore> = threads.clone();
    let reads: Vec<_> = (0..20)
        .map(|_| {
            let store = store.clone();
            tokio::spawn(async move { super::run::read_context(&store, &lanes, &ThreadId::from("t")).await })
        })
        .collect();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    let commit_job = LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), |_| ());
    assert!(commit_job.is_ok(), "a row's commit job is refused while the reads wait for the index");
    drop(release);
    for read in reads {
        read.await.expect("the read's task").expect("the model context");
    }
}

/// (c) Twenty model-context reads of a thread issued while its rewrite holds the reads take no io-interactive thread or queue
/// place meanwhile (the product's lanes: 4 threads, 16 queued), so a row's commit job is still taken; each read answers the
/// rewritten rows once the rewrite lets go.
#[tokio::test]
async fn reads_issued_during_a_held_rewrite_wait_off_the_lane() {
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("production lanes");
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let log = create(&threads, tokens, "t", vec![row("a", &format!("{CODE} is the code"))]).await;
    assert!(marks.remember("t", &[fill(CODE)]));
    let (reached_tx, reached) = tokio::sync::oneshot::channel::<()>();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (reached_tx, released) = (Mutex::new(Some(reached_tx)), Mutex::new(released));
    rewrite_holds::set("held", move || {
        if let Some(tx) = reached_tx.lock().expect("reached").take() {
            let _ = tx.send(());
        }
        let _ = released.lock().expect("released").recv();
    });
    let rewrite = {
        let log = log.clone();
        LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| log.lock().expect("log").redact(lane)).expect("lane")
    };
    reached.await.expect("the rewrite holds the reads");
    let lanes = super::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let store: Arc<dyn ThreadStore> = threads.clone();
    let reads: Vec<_> = (0..20)
        .map(|_| {
            let store = store.clone();
            tokio::spawn(async move { super::run::read_context(&store, &lanes, &ThreadId::from("t")).await })
        })
        .collect();
    // Each read runs to where it waits.
    tokio::task::yield_now().await;
    let commit_job = LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), |_| ());
    assert!(commit_job.is_ok(), "a row's commit job is refused while the reads wait for the rewrite");
    release.send(()).expect("the rewrite is held");
    rewrite.await.expect("the rewrite ran");
    for read in reads {
        let rows = read.await.expect("the read's task").expect("the model context");
        let text = serde_json::to_string(&rows.into_iter().map(|(_, body)| body).collect::<Vec<_>>()).expect("encodes");
        assert!(!text.contains(CODE) && text.contains("[redacted]"), "{text}");
    }
}
