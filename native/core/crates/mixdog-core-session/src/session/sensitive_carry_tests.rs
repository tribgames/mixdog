//! The three orders a value marked sensitive in one session and carried to another can meet the other session's writer and
//! readers in, each forced at a named point of the rewrite (`store::rewrite_holds`, a `crash-gates` build only): a write of the
//! session between its rewrite's scan and a later carry; the process ending between a child's mark and its parent's rewrite;
//! reads of the session while its rewrite holds them.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
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
    let threads =
        Arc::new(StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
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

/// What the row reads hold of a thread's log is kept while nothing changes it and read again after each thing that may:
/// a rewind (whose history revision the kept one must not answer), a rewrite that leaves the file's name, length and
/// write time as they were (a marked value as long as its replacement, the write time put back), and the delete mark,
/// after which the read is refused. An append of rows changes none of it: the log is not read again (a running thread
/// appends on every step, and every status pass reads its message count). Each time it answers what an open made then
/// answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_row_reads_keep_of_a_log_is_read_again_after_every_write_that_may_change_it() {
    const SAME_LENGTH: &str = "4829130157";
    const THREAD: &str = "kept-shape-thread";
    assert_eq!(SAME_LENGTH.len(), "[redacted]".len());
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let log = create(&threads, tokens, THREAD, vec![row("a", &format!("the code is {SAME_LENGTH}"))]).await;
    threads.projected().await;
    let shape = |threads: Arc<StoreThreads>| async move {
        LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| {
            let shape = threads.shape_now(lane, &ThreadId::from(THREAD));
            (shape, threads.shape_and_open(lane, &ThreadId::from(THREAD)))
        })
        .expect("lane")
        .await
        .expect("job ran")
    };
    let (first, (kept, opened)) = shape(threads.clone()).await;
    assert_eq!(kept, opened);
    assert!(Arc::ptr_eq(&first, &shape(threads.clone()).await.0), "an unwritten log is not opened again");

    append(&log, tokens, vec![row("b", "a second row")]).await;
    threads.projected().await;
    let (appended, (kept, opened)) = shape(threads.clone()).await;
    assert!(first.of_one_read(&appended), "a log that rows were appended to is not opened again");
    assert!(!first.is_current() && appended.is_current(), "the kept shape is of the log as it is now");
    assert_eq!(kept, opened);
    assert!(Arc::ptr_eq(&appended, &shape(threads.clone()).await.0));

    append(&log, tokens, vec![commit(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    threads.projected().await;
    let (rewound, (kept, opened_after_rewind)) = shape(threads.clone()).await;
    assert!(!appended.of_one_read(&rewound), "a rewound log is opened again");
    assert_eq!(kept, opened_after_rewind);
    assert_ne!(opened_after_rewind.0, opened.0, "the rewind moved the history revision");

    let dir = data.path().join("sessions").join(THREAD);
    let newest = std::fs::read_dir(&dir)
        .expect("dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("log.")))
        .max()
        .expect("a log file");
    let before = std::fs::metadata(&newest).expect("metadata");
    assert!(marks.remember(THREAD, &[fill(SAME_LENGTH)]));
    redact(&log, tokens).await;
    threads.projected().await;
    assert_eq!(holding(data.path(), &[SAME_LENGTH]), Vec::<String>::new(), "the log was rewritten");
    std::fs::File::options()
        .write(true)
        .open(&newest)
        .expect("the log file")
        .set_modified(before.modified().expect("a write time"))
        .expect("the write time put back");
    assert_eq!(std::fs::metadata(&newest).expect("metadata").len(), before.len(), "the rewrite left the file's length");
    let (rewritten, (kept, opened)) = shape(threads.clone()).await;
    assert!(!rewound.of_one_read(&rewritten), "the rewritten log is opened again");
    assert_eq!(kept, opened);

    append(&log, tokens, vec![commit(json!({"k":"meta","change":{"inline":{"set":{"deleted":true},"unset":[]}}}))]).await;
    threads.projected().await;
    let refused = LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| threads.shape_refused(lane, &ThreadId::from(THREAD)))
        .expect("lane")
        .await
        .expect("job ran");
    assert!(refused, "the kept shape does not answer for a deleted thread");
}

/// The length of a thread's model context is counted from the index once and followed in memory from then on, through the
/// thread's own commits: a model row adds one, a row the model does not see and an amend add none, a compaction starts
/// the context again at its replacement. The number is there as the commit returns, before the index has the rows, and it
/// is what the index counts once it has them. A rewind drops it, and the next ask counts again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_length_of_a_context_is_followed_in_memory_through_the_threads_commits() {
    const THREAD: &str = "kept-length-thread";
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let log = create(&threads, tokens, THREAD, vec![row("a", "one")]).await;
    threads.projected().await;
    let id = ThreadId::from(THREAD);
    let message = json!({"role":"user","content":"again"});
    let ask = |threads: Arc<StoreThreads>| async move {
        LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| {
            let id = ThreadId::from(THREAD);
            (threads.context_len(lane, &id).expect("the context's length"), threads.context_len_kept_and_counted(lane, &id))
        })
        .expect("lane")
        .await
        .expect("job ran")
    };
    assert_eq!(threads.context_len_kept(&id), None, "nothing is kept of a thread never counted");
    assert_eq!(ask(threads.clone()).await, (1, (Some(1), 1)));

    append(
        &log,
        tokens,
        vec![
            row("b", "two"),
            commit(json!({"k":"item","iid":"n","role":"user","form":"message","model":false,"visible":true,"refs":[],"body":{"inline":message}})),
            commit(json!({"k":"amend","iid":"a","refs":[],"body":{"inline":message}})),
            row("c", "three"),
        ],
    )
    .await;
    assert_eq!(threads.context_len_kept(&id), Some(3), "the count holds the batch as its commit returns");
    threads.projected().await;
    assert_eq!(ask(threads.clone()).await, (3, (Some(3), 3)));

    append(
        &log,
        tokens,
        vec![commit(json!({"k":"compacted","cid":"c","replacement":{"inline":[{"iid":"s","body":message},{"iid":"t","body":message}]}})), row("d", "four")],
    )
    .await;
    assert_eq!(threads.context_len_kept(&id), Some(3), "the context starts again at the replacement");
    threads.projected().await;
    assert_eq!(ask(threads.clone()).await, (3, (Some(3), 3)));

    append(&log, tokens, vec![commit(json!({"k":"rewind","to_ordinal":7,"reason":"edit"}))]).await;
    assert_eq!(threads.context_len_kept(&id), None, "a rewind drops the count");
    threads.projected().await;
    let (len, (kept, counted)) = ask(threads.clone()).await;
    assert_eq!((len, kept), (counted, Some(counted)), "the next ask counts again and keeps it");
    assert_eq!(counted, 2, "the row after the compaction was rewound");
}

/// A count taken while a batch is in the thread's log and its projection is not yet sent is not kept. Here the batch is a
/// rewind: the count pairs the rewound shape with the index's rows from before it, and the rewind's own batch adds
/// nothing to a kept number, so one kept there would stay the thread's length. On the product's lanes: the held batch
/// keeps its own lane thread, and the count runs on another.
#[tokio::test]
async fn a_count_taken_beside_a_batch_in_the_log_is_not_kept() {
    const THREAD: &str = "counted-mid-batch-thread";
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("production lanes");
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let log = create(&threads, tokens, THREAD, vec![row("a", "one"), row("b", "two"), row("c", "three")]).await;
    threads.projected().await;
    let id = ThreadId::from(THREAD);
    let ask = |threads: Arc<StoreThreads>| async move {
        LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| {
            let id = ThreadId::from(THREAD);
            (threads.context_len(lane, &id).expect("the context's length"), threads.context_len_kept_and_counted(lane, &id))
        })
        .expect("lane")
        .await
        .expect("job ran")
    };
    assert_eq!(ask(threads.clone()).await, (3, (Some(3), 3)));

    let (reached_tx, reached) = tokio::sync::oneshot::channel::<()>();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (reached_tx, released) = (Mutex::new(Some(reached_tx)), Mutex::new(released));
    // The first batch to get there is held, once.
    rewrite_holds::set("appended", move || {
        let Some(tx) = reached_tx.lock().expect("reached").take() else { return };
        let _ = tx.send(());
        let _ = released.lock().expect("released").recv();
    });
    let rewind = {
        let log = log.clone();
        LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
            log.lock().expect("log").commit(lane, &[commit(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).expect("appended");
        })
        .expect("lane")
    };
    reached.await.expect("the rewind is in the log");
    let (_, (kept, _)) = ask(threads.clone()).await;
    assert_eq!(kept, None, "a count beside the rewind's batch was kept");
    release.send(()).expect("the batch is held");
    rewind.await.expect("the rewind ran");
    threads.projected().await;
    assert_eq!(threads.context_len_kept(&id), None, "nothing was kept across the rewind");
    assert_eq!(ask(threads.clone()).await, (1, (Some(1), 1)));
}

/// A batch the index refused is in the thread's log and not in the index. From then on nothing kept answers for the
/// thread: every reader is given the index's count, asked every time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_one_of_whose_batches_the_index_lost_is_counted_in_the_index() {
    const THREAD: &str = "lost-batch-thread";
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index_over(data.path(), tokens).await, tokens, &marks).await;
    let log = create(&threads, tokens, THREAD, vec![row("a", "one")]).await;
    threads.projected().await;
    let ask = |threads: Arc<StoreThreads>| async move {
        LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| {
            let id = ThreadId::from(THREAD);
            (threads.context_len(lane, &id).expect("the context's length"), threads.context_len_kept_and_counted(lane, &id))
        })
        .expect("lane")
        .await
        .expect("job ran")
    };
    assert_eq!(ask(threads.clone()).await, (1, (Some(1), 1)));

    threads.refuse_next_projection();
    append(&log, tokens, vec![row("b", "two")]).await;
    threads.projected().await;
    assert_eq!(ask(threads.clone()).await, (1, (None, 1)), "the kept number, which holds the lost row, answered");
    append(&log, tokens, vec![row("c", "three")]).await;
    threads.projected().await;
    assert_eq!(ask(threads.clone()).await, (2, (None, 2)));
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
    let progress = Arc::new(mixdog_store::sqlite::RebuildProgress::default());
    threads.settle_marks(tokens.durability_io, Some(&progress)).await.expect("the marks settle");
    let (done, total) = progress.snapshot().expect("the owed rewrites are counted, so the start shows progress");
    assert!(total > 0 && done == total, "every owed rewrite is told as it is done: {done}/{total}");
    threads.projected().await;
    assert_eq!(holding(data.path(), &[CODE]), Vec::<String>::new());
    assert_eq!(marks.redact_text("child", CODE), "[redacted]", "the child's mark is known again");
    assert_eq!(marks.redact_text("parent", CODE), "[redacted]", "and carried to the parent again");
}

/// A failed startup must leave the original durable mark available for another attempt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_retires_a_pending_mark_only_after_its_logs_are_safe() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    {
        let marks = Arc::new(SensitiveStore::default());
        let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
        create(&threads, tokens, "parent", vec![row("r", &format!("the code is {CODE}"))]).await;
        marks.carry("child", "parent");
        assert!(marks.remember("child", &[fill(CODE)]));
        threads.projected().await;
    }
    let pending = data.path().join("sensitive/pending");
    let original = std::fs::read_dir(&pending).expect("pending dir").next().expect("a mark").expect("entry").path();
    let session = data.path().join("sessions/parent");
    let log = session.join("log.000000");
    let displaced = session.join("unavailable");
    std::fs::rename(&log, &displaced).expect("make the owed log unavailable");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    assert!(threads.settle_marks(tokens.durability_io, None).await.is_err(), "an unsettled log stays owed");
    assert!(original.is_file(), "a failed recovery must not consume the only durable mark");

    std::fs::rename(displaced, log).expect("restore the owed log");
    threads.settle_marks(tokens.durability_io, None).await.expect("the mark settles on retry");
    assert_eq!(holding(data.path(), &[CODE]), Vec::<String>::new());
    assert!(std::fs::read_dir(pending).expect("pending dir").next().is_none(), "the settled mark is retired");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_retry_finishes_a_swapped_rewrite_before_retiring_its_mark() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    let title = format!("code {CODE}");
    {
        let marks = Arc::new(SensitiveStore::default());
        let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
        create(
            &threads,
            tokens,
            "parent",
            vec![commit(json!({
                "k":"meta","change":{"inline":{"set":{"title":title},"unset":[]}}
            }))],
        )
        .await;
        assert!(marks.remember("parent", &[fill(CODE)]));
        threads.projected().await;
    }
    let pending = data.path().join("sensitive/pending");
    let original = std::fs::read_dir(&pending).expect("pending dir").next().expect("a mark").expect("entry").path();
    let session = data.path().join("sessions/parent");
    let staged = data.path().join(mixdog_store::log_rewrite::REWRITE_DIR).join("parent");
    let indexed_title = || async { index.lead_row("parent").await.expect("index read").expect("indexed session").row["title"].clone() };
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
    index.refuse_next_reproject();
    assert!(threads.settle_marks(tokens.durability_io, None).await.is_err(), "index failure must leave the session owed");
    assert!(holding(&session, &[CODE]).is_empty(), "the log has already been swapped");
    assert!(!holding(&staged, &[CODE]).is_empty(), "the staged old log still holds the code");
    assert!(index.is_withheld("parent").await.expect("index read"), "the old index row, which still holds the code, is answered by no read");
    assert!(original.is_file(), "the mark is still owed after the swap");

    // A directory where the intent file belongs is an inspection failure, not a missing intent.
    let intent = staged.join("intent");
    let saved_intent = data.path().join("saved-intent");
    std::fs::rename(&intent, &saved_intent).expect("set the intent aside");
    std::fs::create_dir(&intent).expect("put a directory where the intent belongs");
    assert!(threads.settle_marks(tokens.durability_io, None).await.is_err(), "a malformed rewrite must prevent serving");
    assert!(original.is_file(), "failed inspection must not retire the mark");
    assert!(!holding(&staged, &[CODE]).is_empty(), "failed inspection must not discard the staged old log");
    std::fs::remove_dir(&intent).expect("remove the fixture directory");
    std::fs::rename(saved_intent, intent).expect("restore the intent");

    threads.settle_marks(tokens.durability_io, None).await.expect("same-store retry settles the rewrite");
    assert_eq!(indexed_title().await, json!("code [redacted]"));
    assert!(!staged.exists(), "the staged old log is gone");
    assert!(std::fs::read_dir(pending).expect("pending dir").next().is_none(), "the mark is retired");
}

/// `thread`'s whole history read through the store, as a lane job of a read.
async fn history(threads: &Arc<StoreThreads>, tokens: LaneTokens, thread: &str) -> Result<String, CoreError> {
    let (threads, thread) = (threads.clone(), ThreadId::from(thread));
    LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| threads.history_rows(lane, &thread).map(|(_, rows)| format!("{rows:?}")))
        .expect("lane")
        .await
        .expect("job ran")
}

fn owed_refusal<T>(read: &Result<T, CoreError>) -> bool {
    matches!(read, Err(CoreError::CoreMigrating { kind, .. }) if &**kind == "sensitiveRewrite")
}

/// A start finds a session owing its rewrite: the core serves at once, the session owing nothing is read, and no read of the
/// owed one (its head, header, history or model context) answers until its own rewrite, run behind serving, is done.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_owing_its_rewrite_is_refused_until_it_is_done_while_the_others_serve() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    {
        let marks = Arc::new(SensitiveStore::default());
        let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
        create(&threads, tokens, "owed", vec![row("r", &format!("the code is {CODE}"))]).await;
        create(&threads, tokens, "clean", vec![row("r", "nothing to hide")]).await;
        assert!(marks.remember("owed", &[fill(CODE)]));
        threads.projected().await;
        // The process ends before the owed thread's next barrier.
    }
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    let owed = threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed");
    assert_eq!(owed.owed(), 1);
    assert!(history(&threads, tokens, "clean").await.expect("a session owing nothing is served at once").contains("nothing to hide"));
    assert!(owed_refusal(&history(&threads, tokens, "owed").await), "the owed history is refused");
    let (store, id) = (threads.clone(), ThreadId::from("owed"));
    let (head, header) = LaneToken::submit(tokens.interactive_io, &CancellationToken::new(), move |lane| {
        (store.read_head(lane, &id).map(|_| ()), store.read_header(lane, &id).map(|_| ()))
    })
    .expect("lane")
    .await
    .expect("job ran");
    assert!(owed_refusal(&head) && owed_refusal(&header), "neither its head nor its header is read");
    let lanes = super::SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    let store: Arc<dyn ThreadStore> = threads.clone();
    assert!(super::run::read_context(&store, &lanes, &ThreadId::from("owed")).await.is_err(), "nor its model context");

    owed.run(&CancellationToken::new()).await.expect("the rewrite runs behind serving");
    let read = history(&threads, tokens, "owed").await.expect("answered once rewritten");
    assert!(!read.contains(CODE) && read.contains("[redacted]"), "{read}");
}

/// A quit while the owed rewrites run ends them after the session in hand; the journal keeps that session settled, so the
/// next start rewrites only the others, and the progress counts each one done as it goes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quit_ends_the_owed_rewrites_between_sessions_and_the_next_start_rewrites_only_the_rest() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    {
        let marks = Arc::new(SensitiveStore::default());
        let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
        for thread in ["a", "b", "c"] {
            create(&threads, tokens, thread, vec![row("r", &format!("the code is {CODE}"))]).await;
        }
        marks.carry("a", "b");
        marks.carry("a", "c");
        assert!(marks.remember("a", &[fill(CODE)]));
        threads.projected().await;
    }
    let sessions = data.path().join("sessions");
    let holding_code = || ["a", "b", "c"].into_iter().filter(|thread| !holding(&sessions.join(thread), &[CODE]).is_empty()).collect::<Vec<_>>();
    assert_eq!(holding_code(), ["a", "b", "c"]);

    let progress = Arc::new(mixdog_store::sqlite::RebuildProgress::default());
    let stop = CancellationToken::new();
    let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    progress.on_change(Box::new({
        let (told, stop) = (told.clone(), stop.clone());
        // The first change counts the owed rewrites; the second is the first one done: the quit comes then.
        move || {
            if told.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                stop.cancel();
            }
        }
    }));
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
    let owed = threads.owe_marks(tokens.durability_io, Some(&progress)).await.expect("the marks are owed");
    assert_eq!(owed.owed(), 3, "the mark and its carries");
    assert_eq!(progress.snapshot(), Some((0, 3)), "the owed rewrites are counted before the core serves");
    owed.run(&stop).await.expect("a quit is not a failure");
    assert_eq!(progress.snapshot(), Some((1, 3)));
    assert_eq!(holding_code(), ["b", "c"], "the quit came after the first session");
    assert!(history(&threads, tokens, "a").await.is_ok(), "the session rewritten is answered");
    assert!(owed_refusal(&history(&threads, tokens, "b").await), "the others stay refused");

    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    let owed = threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed");
    assert_eq!(owed.owed(), 2, "the session rewritten before the quit is not rewritten again");
    owed.run(&CancellationToken::new()).await.expect("the rest is rewritten");
    assert_eq!(holding(data.path(), &[CODE]), Vec::<String>::new());
    assert!(std::fs::read_dir(data.path().join("sensitive/pending")).expect("pending dir").next().is_none(), "the mark is retired");
}

/// The search copy of a test: tells every session dropped and every one indexed again. `.1`: what a drop answers (`None`
/// refuses it, `Some(deleted)` confirms it); `.3`: how many indexing attempts of a session answer "not readable yet".
struct Copy(Mutex<Vec<String>>, Option<bool>, Mutex<Vec<String>>, usize);

impl Copy {
    fn dropping(deleted: Option<bool>, unread: usize) -> Arc<Self> {
        Arc::new(Self(Mutex::default(), deleted, Mutex::default(), unread))
    }
}

impl super::store::SearchCopy for Copy {
    fn invalidate(&self, session: &str) -> futures::future::BoxFuture<'static, Result<bool, String>> {
        self.0.lock().expect("copies").push(session.to_owned());
        let dropped = self.1;
        Box::pin(async move { dropped.ok_or_else(|| "the search copy is unavailable".to_owned()) })
    }

    fn reindex(&self, session: &str) -> futures::future::BoxFuture<'static, Result<bool, String>> {
        let mut tried = self.2.lock().expect("reindexed");
        tried.push(session.to_owned());
        let readable = tried.len() > self.3;
        Box::pin(async move { Ok(readable) })
    }
}

/// A data dir whose one session `t` owes its rewrite (the process ended before its next barrier), and its index.
async fn one_owed(tokens: LaneTokens) -> (tempfile::TempDir, SqliteStore) {
    let data = tempfile::tempdir().expect("data dir");
    let index = index_over(data.path(), tokens).await;
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
    create(&threads, tokens, "t", vec![row("r", &format!("the code is {CODE}"))]).await;
    assert!(marks.remember("t", &[fill(CODE)]));
    threads.projected().await;
    (data, index)
}

/// Polls `done` until it holds (each poll a short wait), or fails the test.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{what}");
}

/// The settlement is written before the release: a session whose settlement cannot be written stays withheld (its reads
/// refused and told failed, the catalog withholding it), is counted failed and not done, and the next start owes it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test breaks and mends the journal file")]
async fn an_unwritten_settlement_leaves_the_session_withheld_told_as_failed_and_owed() {
    let tokens = mixdog_rt::testing::tokens();
    let (data, index) = one_owed(tokens).await;
    let file = std::fs::read_dir(data.path().join("sensitive/pending")).expect("pending dir").next().expect("a mark").expect("entry").path();
    let saved = std::fs::read(&file).expect("the mark");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
    let progress = Arc::new(mixdog_store::sqlite::RebuildProgress::default());
    let owed = threads.owe_marks(tokens.durability_io, Some(&progress)).await.expect("the marks are owed");
    // The journal is read when the marks are owed: a folder takes the mark's place after that.
    std::fs::remove_file(&file).expect("the mark set aside");
    std::fs::create_dir(&file).expect("a folder where the mark belongs");
    assert!(owed.run(&CancellationToken::new()).await.is_err(), "an unwritten settlement is a failure");
    let read = history(&threads, tokens, "t").await;
    assert!(matches!(&read, Err(CoreError::CoreMigrating { kind, .. }) if &**kind == "sensitiveRewriteFailed"), "{read:?}");
    assert!(index.is_withheld("t").await.expect("index read"), "the catalog keeps it withheld");
    assert_eq!((progress.snapshot(), progress.failed()), (Some((0, 1)), 1), "counted as failed, not as done");
    std::fs::remove_dir(&file).expect("the folder removed");
    std::fs::write(&file, &saved).expect("the mark put back");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    assert_eq!(threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed").owed(), 1, "the next start owes it");
}

/// A rewritten session is answered at once, without waiting on its search copy; the copy is a journaled debt of its own,
/// kept across a restart and by a boot that discharges nothing, and no search answers the session until the copy is
/// confirmed gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_search_copy_stays_owed_and_unsearched_until_it_is_confirmed_gone() {
    let tokens = mixdog_rt::testing::tokens();
    let (data, index) = one_owed(tokens).await;
    let debt = data.path().join("sensitive/search-owed/t");
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index.clone(), tokens, &marks).await;
    threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed").run(&CancellationToken::new()).await.expect("settled");
    assert!(!history(&threads, tokens, "t").await.expect("answered with no search copy bound").contains(CODE));
    assert_eq!(threads.search_withheld(), ["t"], "no search answers it");
    assert!(debt.is_file(), "the debt is on disk");

    // The next start (a boot with no memory runtime discharges nothing) keeps it.
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    assert_eq!(threads.owe_marks(tokens.durability_io, None).await.expect("loaded").owed(), 0);
    assert_eq!(threads.search_withheld(), ["t"]);

    // A copy that cannot be confirmed gone leaves the debt.
    let refusing = Copy::dropping(None, 0);
    let stop = CancellationToken::new();
    let discharge = tokio::spawn(threads.clone().discharge_search_debt(refusing.clone(), stop.clone()));
    eventually("the discharge tries the copy", || !refusing.0.lock().expect("copies").is_empty()).await;
    stop.cancel();
    discharge.await.expect("the discharge ends at the stop");
    assert_eq!(threads.search_withheld(), ["t"], "an unconfirmed copy is still owed");
    assert!(debt.is_file());

    assert!(refusing.2.lock().expect("reindexed").is_empty(), "nothing is indexed again before its rows are deleted");

    // Confirmed gone (its rows deleted): the debt leaves the journal, and searches answer the session again. The session
    // cannot be read for its new copy at first (a fork whose base still owes its rewrite): that stays pending, and the next
    // release tries it again.
    let dropping = Copy::dropping(Some(true), 1);
    let stop = CancellationToken::new();
    let discharge = tokio::spawn(threads.clone().discharge_search_debt(dropping.clone(), stop.clone()));
    eventually("the debt is discharged", || threads.search_withheld().is_empty()).await;
    eventually("the new copy is tried", || dropping.2.lock().expect("reindexed").len() == 1).await;
    assert!(!debt.exists(), "the debt left the journal");
    threads.tell_released();
    eventually("a later release tries the unread copy again", || dropping.2.lock().expect("reindexed").len() == 2).await;
    threads.tell_released();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    stop.cancel();
    discharge.await.expect("the discharge ends at the stop");
    assert_eq!(*dropping.2.lock().expect("reindexed"), ["t", "t"], "once indexed it is not tried again");
    assert_eq!(*dropping.0.lock().expect("copies"), ["t"], "the rows are deleted once");
}

/// A carried mark's thread that is refused while it (or a base) still owes a rewrite from the start is opened again until
/// that rewrite released it, so the mark is not left for the next start; a rewrite that failed is not asked again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_carried_marks_thread_is_opened_again_until_its_owed_rewrite_released_it() {
    let refusal = |kind: &str| CoreError::CoreMigrating { kind: kind.into(), done: 0, total: 1 };
    let asked = std::sync::atomic::AtomicUsize::new(0);
    let opened = super::directory::once_released(
        || false,
        || async {
            match asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 | 1 => Err(refusal("sensitiveRewrite")),
                _ => Ok("opened"),
            }
        },
    )
    .await;
    assert!(matches!(opened, Ok("opened")), "{opened:?}");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 3, "refused twice, then opened");

    let asked = std::sync::atomic::AtomicUsize::new(0);
    let failed = super::directory::once_released(
        || false,
        || async {
            asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err::<(), _>(refusal("sensitiveRewriteFailed"))
        },
    )
    .await;
    assert!(matches!(&failed, Err(CoreError::CoreMigrating { kind, .. }) if &**kind == "sensitiveRewriteFailed"), "{failed:?}");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1, "a failed rewrite is not waited for");

    // A shutdown that stopped the rewriter between sessions leaves this one held and not failed: not asked again.
    let asked = std::sync::atomic::AtomicUsize::new(0);
    let held = super::directory::once_released(
        || true,
        || async {
            asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err::<(), _>(refusal("sensitiveRewrite"))
        },
    )
    .await;
    assert!(matches!(&held, Err(CoreError::CoreMigrating { kind, .. }) if &**kind == "sensitiveRewrite"), "{held:?}");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1, "a held session is not waited for once the shutdown began");
}

/// A search copy whose delete never answers (a lock it waits on).
struct Hanging;

impl super::store::SearchCopy for Hanging {
    fn invalidate(&self, _: &str) -> futures::future::BoxFuture<'static, Result<bool, String>> {
        Box::pin(std::future::pending())
    }

    fn reindex(&self, _: &str) -> futures::future::BoxFuture<'static, Result<bool, String>> {
        Box::pin(std::future::pending())
    }
}

/// A quit ends the discharge at once, even while the copy's delete waits: the debt stays on disk for the next start.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quit_ends_the_discharge_without_waiting_on_the_copy_and_keeps_the_debt() {
    let tokens = mixdog_rt::testing::tokens();
    let (data, index) = one_owed(tokens).await;
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed").run(&CancellationToken::new()).await.expect("settled");
    let stop = CancellationToken::new();
    let discharge = tokio::spawn(threads.clone().discharge_search_debt(Arc::new(Hanging), stop.clone()));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    stop.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(5), discharge).await.expect("the quit is not held").expect("ended");
    assert!(data.path().join("sensitive/search-owed/t").is_file(), "the debt stays for the next start");
    assert_eq!(threads.search_withheld(), ["t"]);
}

/// A data folder with no search copy at all discharges the debt and indexes nothing again: nothing is opened or created
/// for a copy that was never kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_debt_with_no_copy_kept_is_discharged_without_indexing_again() {
    let tokens = mixdog_rt::testing::tokens();
    let (data, index) = one_owed(tokens).await;
    let marks = Arc::new(SensitiveStore::default());
    let threads = store_over(data.path(), index, tokens, &marks).await;
    threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed").run(&CancellationToken::new()).await.expect("settled");
    let absent = Copy::dropping(Some(false), 0);
    let stop = CancellationToken::new();
    let discharge = tokio::spawn(threads.clone().discharge_search_debt(absent.clone(), stop.clone()));
    eventually("the debt is discharged", || threads.search_withheld().is_empty()).await;
    threads.tell_released();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    stop.cancel();
    discharge.await.expect("the discharge ends at the stop");
    assert!(absent.2.lock().expect("reindexed").is_empty(), "no copy was deleted, so none is derived again");
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
