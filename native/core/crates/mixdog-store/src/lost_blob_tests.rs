//! Nothing deletes a blob (FORMAT.md §4.3): a log rewrite and a purge leave every blob in place. And a session whose
//! blobs a past census deleted opens and lists as far as its data allows (§4.5).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test-only file and index checks")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::testing::tokens;
use serde_json::Value;
use serde_json::json;

use crate::blobs::BlobError;
use crate::blobs::BlobStore;
use crate::encode::Encoded;
use crate::encode::encode_record;
use crate::fold::LineageIndex;
use crate::log::*;
use crate::schema::blob::Slot;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::Record;
use crate::sqlite::*;
use crate::summary::CatalogHead;

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

/// A value whose encoding exceeds `INLINE_MAX`: its slot goes out of line.
fn big(tag: &str) -> String {
    format!("{tag} {}", "x".repeat(mixdog_protocol::INLINE_MAX))
}

fn encoded(v: Value) -> Encoded {
    encode_record(serde_json::from_value(v).expect("record")).expect("encodes")
}

fn session(id: &str, base: Option<(&str, u64)>, header: Value) -> Encoded {
    let mut v = json!({"k":"session","v":2,"id":id,"log_id":LOG_ID,"header":{"inline":header}});
    if let Some((b, end)) = base {
        v["base"] = json!({"session":b,"log_id":LOG_ID,"end_ordinal_exclusive":end});
    }
    encoded(v)
}

fn item(iid: &str, content: &str) -> Encoded {
    encoded(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":content,"role":"user"}}}))
}

fn run(rid: &str, detail: &str) -> Encoded {
    encoded(json!({"k":"run","rid":rid,"phase":"started","detail":{"inline":{"note":detail}}}))
}

fn meta(key: &str, value: &str) -> Encoded {
    encoded(json!({"k":"meta","change":{"inline":{"set":{key:value},"unset":[]}}}))
}

async fn on_lane<R: Send + 'static>(f: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokens().durability_io.submit(&CancellationToken::new(), f).expect("lane").await.expect("job ran")
}

/// `SqliteStore::open` as a maintenance job.
fn open_index(data: &Path) -> SqliteStore {
    let (tx, rx) = std::sync::mpsc::channel();
    let data = data.to_path_buf();
    let _job = tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data));
        })
        .expect("lane");
    rx.recv().expect("job ran").expect("the index opens")
}

/// Every record of the log in `dir`, read forward.
fn log_records(dir: &Path) -> Vec<Record> {
    let mut from = FramePos { ordinal: first_ordinal_unlaned(dir).unwrap(), file_no: 0, offset: 0 };
    let mut records = Vec::new();
    loop {
        let read = read_forward_unlaned(dir, from, u64::MAX).unwrap();
        records.extend(read.frames.into_iter().map(|(record, ..)| record));
        match read.next {
            ForwardEnd::More(next) => from = next,
            ForwardEnd::Done { .. } => return records,
            ForwardEnd::Damaged(d) => panic!("damaged at {d:?}"),
        }
    }
}

/// The blob of the record's own header or state slot, when it is out of line.
fn own_blob(record: &Record) -> Option<Digest> {
    match record {
        Record::Session(r) => match &r.header {
            Slot::Blob(blob) => Some(blob.descriptor().digest.clone()),
            Slot::Inline(_) => None,
        },
        Record::Checkpoint(r) => match &r.state {
            Slot::Blob(blob) => Some(blob.descriptor().digest.clone()),
            Slot::Inline(_) => None,
        },
        _ => None,
    }
}

/// The blob a checkpoint keeps its header value `key` in. Its state is inline: a header value large enough to take the
/// state out of line is out of line itself (`CheckpointState::header_blobs`).
fn state_value(record: &Record, key: &str) -> Option<Digest> {
    let Record::Checkpoint(checkpoint) = record else { return None };
    let Slot::Inline(state) = &checkpoint.state else { panic!("a checkpoint's state is inline once its large header values left it") };
    state.header_blobs.get(key).map(|blob| blob.descriptor().digest.clone())
}

fn status(db: &Path, session: &str) -> (String, Option<String>) {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.query_row("SELECT status, damage FROM sessions WHERE id = ?1", [session], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A data dir holding `data`'s logs and blobs and no index.
fn copy_data(data: &Path) -> tempfile::TempDir {
    let other = tempfile::tempdir().unwrap();
    copy_tree(&data.join("sessions"), &other.path().join("sessions"));
    copy_tree(&data.join("blobs"), &other.path().join("blobs"));
    other
}

struct Env {
    _tmp: tempfile::TempDir,
    data: PathBuf,
    store: SqliteStore,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().to_path_buf();
        let store = open_index(&data);
        Env { _tmp: tmp, data, store }
    }

    fn deps(&self) -> WriterDeps {
        WriterDeps { io: Arc::new(OsIo), blobs: BlobStore::new(&self.data), ownership: Arc::new(MockOwnership::default()), index: Arc::new(self.store.clone()) }
    }

    fn dir(&self, id: &str) -> PathBuf {
        self.data.join("sessions").join(id)
    }

    async fn create(&self, id: &str, record: Encoded) -> LogWriter {
        let mut header = serde_json::Map::new();
        header.insert("id".into(), id.into());
        let head = CatalogHead { session: id.into(), log_id: LOG_ID.into(), base_session: None, header };
        self.store.upsert(head, DirtyMark::Set).await.unwrap();
        let (dir, deps) = (self.dir(id), self.deps());
        let (w, ack) = on_lane(move |l| LogWriter::create(l, &dir, record, deps).unwrap()).await;
        self.store.project(ack.projection).await.unwrap();
        w
    }

    async fn commit(&self, w: LogWriter, batch: Vec<Encoded>) -> LogWriter {
        let (w, ack) = on_lane(move |l| {
            let mut w = w;
            let ack = w.append_barrier(l, batch).unwrap();
            (w, ack)
        })
        .await;
        self.store.project(ack.projection).await.unwrap();
        w
    }

    /// A clean close: the log ends with a checkpoint.
    async fn close(&self, w: LogWriter) {
        let ack = on_lane(move |l| {
            let mut w = w;
            w.close(l).unwrap().expect("a checkpoint")
        })
        .await;
        self.store.project(ack.projection).await.unwrap();
    }

    async fn reopen(&self, id: &str) -> Result<OpenedLog, OpenError> {
        let (dir, blobs, store) = (self.dir(id), BlobStore::new(&self.data), self.store.clone());
        on_lane(move |l| open_log(l, &dir, &blobs, &store as &dyn LineageIndex)).await
    }

    async fn writer(&self, id: &str) -> LogWriter {
        let opened = self.reopen(id).await.unwrap();
        let deps = self.deps();
        on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await
    }
}

/// A rewrite deletes nothing: the blob only the rewritten-away record named stays, and so does the one the new log names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewrite_deletes_no_blob() {
    let env = Env::new();
    let w = env.create("s1", session("s1", None, json!({"title": "t"}))).await;
    let secret = run("r1", &big("secret 482913"));
    let gone = secret.blobs()[0].digest.clone();
    let change = meta("note", &big("kept change"));
    let kept = change.blobs()[0].digest.clone();
    let w = env.commit(w, vec![secret, change]).await;
    drop(w);
    // A sensitive rewrite: the run's detail replaced by one that fits inline. The index step after the files.
    let (data, blobs) = (env.data.clone(), BlobStore::new(&env.data));
    on_lane(move |l| {
        let planned = crate::log_rewrite::plan(l, &data, "s1", &OsIo, &blobs, &mut |record: &Record| match record {
            Record::Run(r) => {
                let mut r = r.clone();
                r.detail = Some(Slot::Inline(json!({"note": "[redacted]"})));
                Some(Record::Run(r))
            }
            _ => None,
        })
        .unwrap();
        assert!(planned, "a change");
        crate::log_rewrite::settle(l, &data, "s1", &OsIo, &blobs, &mut || Ok(())).unwrap();
    })
    .await;
    let rewrite = Rewritten { data: env.data.clone(), session: "s1".into(), dirty: DirtyMark::Clear };
    env.store.reproject(rewrite).await.unwrap();
    assert!(BlobStore::new(&env.data).path(&gone).is_file(), "the rewrite deletes no blob");
    assert!(BlobStore::new(&env.data).path(&kept).is_file(), "the change the new log still names stays");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_keeps_its_base_until_both_are_purged() {
    let env = Env::new();
    let w = env.create("b1", session("b1", None, json!({"title": "t", "tools": big("base catalog")}))).await;
    drop(env.commit(w, vec![item("a", "hi")]).await);
    drop(env.create("f1", session("f1", Some(("b1", 2)), json!({"title": "fork"}))).await);
    env.store.mark_deleted("b1").await.unwrap();
    let purge = || env.store.purge_deleted(tokens().maintenance_io, env.data.clone());
    assert!(purge().await.unwrap().is_empty(), "the fork reads the base");
    env.store.mark_deleted("f1").await.unwrap();
    let mut purged = purge().await.unwrap();
    purged.sort();
    assert_eq!(purged, ["b1", "f1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_whose_blobs_a_census_deleted_opens_from_what_is_left() {
    let env = Env::new();
    let w = env.create("s1", session("s1", None, json!({"title": "kept title", "tools": big("catalog")}))).await;
    let w = env.commit(w, vec![item("a", "one")]).await;
    env.close(w).await;
    let w = env.writer("s1").await;
    let w = env.commit(w, vec![item("b", "two"), meta("note", &big("late change"))]).await;
    env.close(w).await;
    let records = log_records(&env.dir("s1"));
    let header = own_blob(&records[0]).expect("the header is out of line");
    // Both checkpoints keep the catalog in one blob; only the newest holds the late change, in a blob of its own (the
    // change's record keeps its body in another).
    let catalogs: Vec<Digest> = records.iter().filter_map(|r| state_value(r, "tools")).collect();
    let [older, same] = catalogs.as_slice() else { panic!("two checkpoints with the catalog out of line: {catalogs:?}") };
    assert_eq!(older, same);
    let notes: Vec<Digest> = records.iter().filter_map(|r| state_value(r, "note")).collect();
    let [newest] = notes.as_slice() else { panic!("the newest checkpoint alone holds the late change: {notes:?}") };
    let remove = |digest: &Digest| std::fs::remove_file(BlobStore::new(&env.data).path(digest)).unwrap();
    remove(&header);
    remove(newest);

    let opened = env.reopen("s1").await.expect("opens from the older checkpoint");
    assert_eq!(opened.status, LogStatus::Clean);
    // Every loss was put back (the header by the older checkpoint; the newest state is only an anchor): writable.
    assert_eq!(opened.lost, None, "nothing stayed lost");
    assert_eq!((opened.fold.rows, opened.fold.header["title"].clone()), (2, json!("kept title")));
    assert_eq!(opened.fold.header["note"], json!(big("late change")), "the change after the older checkpoint");
    let other = copy_data(&env.data);
    let rebuilt = open_index(other.path());
    rebuilt.reconciled().await.unwrap();
    assert_eq!(status(&other.path().join(INDEX_FILE), "s1"), ("ok".to_owned(), None), "nothing it lists was lost");
    drop(rebuilt);

    remove(older);
    match env.reopen("s1").await {
        Err(OpenError::Blob(BlobError::Missing { digest })) => assert_eq!(digest, header),
        other => panic!("opened without its header: {other:?}"),
    }
    let other = copy_data(&env.data);
    let rebuilt = open_index(other.path());
    rebuilt.reconciled().await.unwrap();
    let (state, damage) = status(&other.path().join(INDEX_FILE), "s1");
    assert_eq!(state, "damaged");
    assert!(damage.expect("the damage").contains(r#"\"sessionHeader\":true"#), "it names the lost header");
    let (rows, _) = rebuilt.history_page(vec![LineageLevel { session: "s1".into(), end: None }], None, None, 10).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.iid.as_str()).collect::<Vec<_>>(), ["b", "a"], "every row it still holds");
    drop(rebuilt);
}

/// A session whose salvaged fold lost state no later checkpoint restores (a header change whose blob is gone) opens
/// read-only: no write, so no checkpoint makes the stale state permanent. Restored blob, writable again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_lost_state_opens_read_only_until_the_blob_is_back() {
    let env = Env::new();
    let w = env.create("s1", session("s1", None, json!({"title": "t", "tools": big("catalog")}))).await;
    let change = meta("note", &big("a change no checkpoint holds"));
    let lost = change.blobs()[0].clone();
    let w = env.commit(w, vec![item("a", "one"), change]).await;
    env.close(w).await;
    let records = log_records(&env.dir("s1"));
    let state = records.iter().find_map(|r| state_value(r, "note")).expect("the checkpoint keeps the changed value out of line");
    let blobs = BlobStore::new(&env.data);
    std::fs::remove_file(blobs.path(&lost.digest)).unwrap();
    std::fs::remove_file(blobs.path(&state)).unwrap();
    let opened = env.reopen("s1").await.expect("it opens");
    assert!(opened.lost.is_some(), "the loss is reported");
    assert_eq!(opened.fold.rows, 1);
    let deps = env.deps();
    let refused = on_lane(move |l| LogWriter::open(l, opened, deps).err()).await;
    assert!(matches!(refused, Some(OpenAppendError::BodiesLost(_))), "{refused:?}");
    let path = blobs.path(&lost.digest);
    std::fs::write(&path, &lost.bytes).unwrap();
    let opened = env.reopen("s1").await.unwrap();
    assert_eq!((opened.lost, opened.fold.header["note"].clone()), (None, json!(big("a change no checkpoint holds"))));
    drop(env.writer("s1").await);
}

/// A queue entry or run detail whose out-of-line body file is gone is no row, but the rebuild still reports it: the
/// session is listed as damaged with the record's ordinal and digest, like a lost row body; with the file there, it is `ok`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_nested_body_marks_the_session_damaged_at_rebuild() {
    let env = Env::new();
    let w = env.create("s1", session("s1", None, json!({"title": "t"}))).await;
    let entry = encoded(json!({"k":"queue","qid":"q1","action":"enqueue","entry":{"inline":{"message":"hi","pad": big("queued")}}}));
    let detail = run("r1", &big("run detail"));
    let (lost_entry, lost_detail) = (entry.blobs()[0].digest.clone(), detail.blobs()[0].digest.clone());
    drop(env.commit(w, vec![item("a", "one"), entry, detail]).await);
    env.store.close();
    let whole = copy_data(&env.data);
    let rebuilt = open_index(whole.path());
    rebuilt.reconciled().await.unwrap();
    assert_eq!(status(&whole.path().join(INDEX_FILE), "s1"), ("ok".to_owned(), None), "nothing lost");
    // Closed, not only dropped: the index file is removed next, and the writer thread holds it open until it has ended.
    rebuilt.close();
    for digest in [&lost_entry, &lost_detail] {
        std::fs::remove_file(BlobStore::new(whole.path()).path(digest)).unwrap();
    }
    std::fs::remove_file(whole.path().join(INDEX_FILE)).unwrap();
    let rebuilt = open_index(whole.path());
    rebuilt.reconciled().await.unwrap();
    let (state, damage) = status(&whole.path().join(INDEX_FILE), "s1");
    assert_eq!(state, "damaged");
    let damage = damage.expect("the damage");
    assert!(damage.contains(lost_entry.as_str()) && damage.contains(lost_detail.as_str()), "{damage}");
    drop(rebuilt);
}

/// A data dir holding three closed sessions' logs and blobs and no index.
async fn three_sessions_without_an_index() -> tempfile::TempDir {
    let env = Env::new();
    for id in ["s1", "s2", "s3"] {
        let w = env.create(id, session(id, None, json!({"title": "t"}))).await;
        drop(env.commit(w, vec![item("a", "one"), meta("note", &big("a body out of line"))]).await);
    }
    env.store.close();
    copy_data(&env.data)
}

/// `SqliteStore::open_reporting` of `data` as a maintenance job, as a tool opens it ([`RepairStart::FirstWait`]).
async fn open_reporting(data: &Path, progress: &Arc<RebuildProgress>) -> SqliteStore {
    open_starting(data, progress, RepairStart::FirstWait).await
}

/// `SqliteStore::open_reporting` of `data` as the core's boot opens it ([`RepairStart::WithheldSet`]).
async fn open_withholding(data: &Path, progress: &Arc<RebuildProgress>) -> SqliteStore {
    open_starting(data, progress, RepairStart::WithheldSet).await
}

async fn open_starting(data: &Path, progress: &Arc<RebuildProgress>, start: RepairStart) -> SqliteStore {
    let (data, progress) = (data.to_path_buf(), progress.clone());
    tokio::task::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let _job = tokens()
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                let _ = tx.send(SqliteStore::open_reporting(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data, Some(&progress), start));
            })
            .expect("lane");
        rx.recv().unwrap().expect("opens")
    })
    .await
    .unwrap()
}

/// The rebuild reports its sessions done and total as it runs, and ends at the total.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_reports_its_sessions_done_and_ends_at_the_total() {
    let whole = three_sessions_without_an_index().await;
    let rebuilding = Arc::new(RebuildProgress::default());
    let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    rebuilding.on_change(Box::new({
        let told = told.clone();
        move || {
            told.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }));
    assert_eq!(rebuilding.snapshot(), None, "nothing before a rebuild");
    let rebuilt = open_reporting(whole.path(), &rebuilding).await;
    assert!(rebuilt.rebuilding());
    rebuilt.reconciled().await.unwrap();
    assert_eq!(rebuilding.snapshot(), Some((3, 3)), "it ends at the total");
    assert_eq!(told.load(std::sync::atomic::Ordering::SeqCst), 4, "told when it began and as each of the three sessions finished");
    rebuilt.close();
}

/// An open that needs no rebuild leaves the progress absent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_of_an_intact_index_reports_no_rebuild() {
    let whole = three_sessions_without_an_index().await;
    let rebuilt = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    rebuilt.reconciled().await.unwrap();
    rebuilt.close();
    let plain = Arc::new(RebuildProgress::default());
    let reopened = open_reporting(whole.path(), &plain).await;
    assert_eq!(plain.snapshot(), None, "an intact index is not rebuilt");
    reopened.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_schema_with_intact_identity_is_rebuilt_from_the_logs() {
    let whole = three_sessions_without_an_index().await;
    std::fs::create_dir_all(whole.path().join(INDEX_FILE).parent().unwrap()).unwrap();
    let blank = rusqlite::Connection::open(whole.path().join(INDEX_FILE)).unwrap();
    blank.pragma_update(None, "application_id", crate::schema::sql::INDEX_APPLICATION_ID).unwrap();
    blank.pragma_update(None, "user_version", crate::schema::sql::INDEX_USER_VERSION).unwrap();
    drop(blank);
    let empty = Arc::new(RebuildProgress::default());
    let recovered = open_reporting(whole.path(), &empty).await;
    recovered.reconciled().await.unwrap();
    assert_eq!(empty.snapshot(), Some((3, 3)), "an empty schema with intact identity cannot stand in for the logs");
    recovered.close();
}

/// The open of an index that has to be made anew answers at once: a session the rebuild has not reached is one the index cannot
/// answer for, a read that names it waits for its own projection, and the rest of the rows follow behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_answers_at_once_and_fills_in_behind() {
    let whole = three_sessions_without_an_index().await;
    let (release, arrived) = crate::sqlite::reconcile_seam::hold(whole.path(), "s3");
    let progress = Arc::new(RebuildProgress::default());
    let index = open_reporting(whole.path(), &progress).await;
    assert!(index.rebuilding());
    assert_eq!(progress.snapshot(), Some((0, 3)), "owed, none yet projected");
    assert!(index.summary("s1").await.unwrap().is_some(), "a read that names a session waits for its projection");
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    assert_eq!(index.listed("s3").await.unwrap(), None, "not yet projected: the index cannot answer for it");
    assert!(index.repairs().pending >= 1);
    drop(release);
    index.reconciled().await.unwrap();
    assert!(index.summary("s3").await.unwrap().is_some());
    assert_eq!(progress.snapshot(), Some((3, 3)));
    index.close();
    let reopened = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    assert!(!reopened.rebuilding(), "a finished rebuild owes the next start nothing");
    reopened.close();
}

/// A rebuild a stop cut off mid-session is finished by the next start, the cut session rebuilt from its log.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_cut_off_by_a_stop_is_finished_by_the_next_start() {
    let whole = three_sessions_without_an_index().await;
    crate::sqlite::reconcile_seam::arm(whole.path());
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    index.withhold(Vec::new()).await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while crate::sqlite::reconcile_seam::armed(whole.path()) {
        assert!(std::time::Instant::now() < deadline, "a session's projection reaches the stop");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    index.close();
    let next = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    assert!(next.rebuilding(), "what the stop left is still owed");
    assert!(next.repairs().owed >= 1);
    next.reconciled().await.unwrap();
    for id in ["s1", "s2", "s3"] {
        assert!(next.summary(id).await.unwrap().is_some(), "{id} is in the finished index");
    }
    next.close();
}

/// A rebuild of an index of an earlier format projects first the sessions that index held as workers (or behind their log, or
/// did not hold): the worker rows answer once those are in, while the repair of an ordinary session is still held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_projects_the_worker_sessions_first_and_their_rows_answer_before_it_ends() {
    let env = Env::new();
    for id in ["s1", "s2"] {
        let w = env.create(id, session(id, None, json!({"title": "t"}))).await;
        let w = env.commit(w, vec![item("a", "one"), meta("note", &big("a body out of line"))]).await;
        env.close(w).await;
    }
    let w = env.create("w1", session("w1", None, json!({"title": "t"}))).await;
    let worker = encoded(json!({"k":"meta","change":{"inline":{"set":{"worker":{"tag":"t1","parentSessionId":"p9"}},"unset":[]}}}));
    let w = env.commit(w, vec![item("a", "one"), worker]).await;
    env.close(w).await;
    env.store.close();
    let whole = copy_data(&env.data);
    let db = whole.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    for suffix in ["", "-wal"] {
        let from = PathBuf::from(format!("{}{suffix}", env.data.join(INDEX_FILE).display()));
        if from.exists() {
            std::fs::copy(&from, format!("{}{suffix}", db.display())).unwrap();
        }
    }
    let old = rusqlite::Connection::open(&db).unwrap();
    // Older than the first released version: rebuilt, not upgraded in place.
    old.pragma_update(None, "user_version", crate::schema::sql::FIRST_RELEASED_INDEX_VERSION - 1).unwrap();
    // As a start leaves the rows of sessions it retired: level with their logs (this Env's writers leave them marked).
    old.execute("UPDATE sessions SET dirty = 0", []).unwrap();
    drop(old);

    let (release, arrived) = crate::sqlite::reconcile_seam::hold(whole.path(), "s2");
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    assert!(index.rebuilding());
    index.withhold(Vec::new()).await.unwrap();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(30), index.worker_rows_projected())
        .await
        .expect("the worker sessions are projected first")
        .unwrap();
    let rows = index.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())).await.unwrap();
    assert_eq!(rows.iter().map(|row| row.session.as_str()).collect::<Vec<_>>(), ["w1"]);
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    assert!(index.repairs().pending >= 1, "an ordinary session is still owed");
    drop(release);
    index.reconciled().await.unwrap();
    assert!(index.summary("s2").await.unwrap().is_some());
    index.close();
}

/// A write to a session the rebuild has not reached waits for its projection and is in the finished index; a session made during
/// the rebuild is written at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_made_during_a_rebuild_are_in_the_finished_index() {
    let whole = three_sessions_without_an_index().await;
    let (release, arrived) = crate::sqlite::reconcile_seam::hold(whole.path(), "s3");
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    index.withhold(Vec::new()).await.unwrap();
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    let head = |id: &str, title: &str| {
        let header = json!({ "id": id, "title": title, "updatedAt": 9, "desktopSession": { "classification": "task", "projectPath": "/p" } });
        CatalogHead { session: id.into(), log_id: LOG_ID.into(), base_session: None, header: header.as_object().unwrap().clone() }
    };
    index.upsert(head("s4", "made meanwhile"), DirtyMark::Clear).await.unwrap();
    assert!(index.summary("s4").await.unwrap().unwrap().contains("made meanwhile"), "a new session is not held back");
    let written = {
        let index = index.clone();
        let head = head("s3", "renamed meanwhile");
        tokio::spawn(async move { index.upsert(head, DirtyMark::Clear).await })
    };
    drop(release);
    written.await.unwrap().unwrap();
    index.reconciled().await.unwrap();
    assert!(index.summary("s3").await.unwrap().unwrap().contains("renamed meanwhile"), "the write follows the projection");
    index.close();
}

const REBUILD_BOUND: std::time::Duration = std::time::Duration::from_secs(30);

/// A rebuild stopped after a deleted base was written and before its live fork's first frame: the index then holds no fork
/// edge to the base. The next start purges nothing while projections are owed, so the fork is repaired from the base's log.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_stopped_before_a_forks_first_frame_keeps_its_deleted_base() {
    let env = Env::new();
    let w = env.create("p1", session("p1", None, json!({"title": "base"}))).await;
    let w = env.commit(w, vec![item("a", "hi"), meta("note", &big("a body out of line"))]).await;
    drop(env.create("c1", session("c1", Some(("p1", 2)), json!({"title": "fork"}))).await);
    drop(env.commit(w, vec![encoded(json!({"k":"meta","change":{"inline":{"set":{"deleted":true},"unset":[]}}}))]).await);
    env.store.close();
    let whole = copy_data(&env.data);
    let (release, arrived) = crate::sqlite::reconcile_seam::hold(whole.path(), "c1");
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    index.withhold(Vec::new()).await.unwrap();
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    assert_eq!(mixdog_rt::time::timeout(REBUILD_BOUND, index.deleted("p1")).await.expect("the base is written").unwrap(), Some(true));
    // What a kill here leaves: the base's rows committed, the fork owed and none of its frames in.
    let killed = tempfile::tempdir().unwrap();
    copy_tree(whole.path(), killed.path());
    let _ = std::fs::remove_file(format!("{}-shm", killed.path().join(INDEX_FILE).display()));
    drop(release);
    index.reconciled().await.unwrap();
    index.close();

    let next = open_reporting(killed.path(), &Arc::new(RebuildProgress::default())).await;
    assert!(killed.path().join("sessions").join("p1").join(log_name(0)).is_file(), "the boot purge took the base of an owed fork");
    let purged = next.purge_deleted(tokens().maintenance_io, killed.path().to_path_buf());
    assert_eq!(purged.await.unwrap(), Vec::<String>::new(), "a purge while the fork is owed");
    next.withhold(Vec::new()).await.unwrap();
    next.reconciled().await.unwrap();
    assert!(next.summary("c1").await.unwrap().is_some(), "the fork is repaired from its base's log");
    assert_eq!(next.purge_deleted(tokens().maintenance_io, killed.path().to_path_buf()).await.unwrap(), Vec::<String>::new(), "the fork reads its base");
    next.close();
}

/// A resumed rebuild waits, for the worker rows, also for a session behind its log at open that no debt of the rebuild names:
/// one projected while an earlier start served, whose worker change reached its log and not the index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_readers_of_a_resumed_rebuild_wait_for_a_session_behind_its_log() {
    let env = Env::new();
    let w = env.create("o1", session("o1", None, json!({"title": "t"}))).await;
    let w = env.commit(w, vec![item("a", "one")]).await;
    env.close(w).await;
    let w = env.create("w1", session("w1", None, json!({"title": "t"}))).await;
    let w = env.commit(w, vec![item("a", "one")]).await;
    env.close(w).await;
    let w = env.writer("w1").await;
    let worker = encoded(json!({"k":"meta","change":{"inline":{"set":{"worker":{"tag":"t1","parentSessionId":"p9"}},"unset":[]}}}));
    let (w, _unprojected) = on_lane(move |l| {
        let mut w = w;
        let ack = w.append_barrier(l, vec![worker]).unwrap();
        (w, ack)
    })
    .await;
    drop(w);
    env.store.close();
    // An earlier start's rebuild still owes another session, not tagged to come first; w1 it projected, and w1's worker change
    // reached its log only.
    let db = rusqlite::Connection::open(env.data.join(INDEX_FILE)).unwrap();
    db.execute("UPDATE sessions SET dirty = (id = 'w1')", []).unwrap();
    db.execute("INSERT INTO meta (key, value) VALUES ('rebuild:o1', '1')", []).unwrap();
    drop(db);

    let (release, arrived) = crate::sqlite::reconcile_seam::hold(&env.data, "w1");
    let index = open_reporting(&env.data, &Arc::new(RebuildProgress::default())).await;
    assert!(index.rebuilding());
    index.withhold(Vec::new()).await.unwrap();
    let mut waiters = index.reconcile_waiters();
    let before = *waiters.borrow();
    let projected = tokio::spawn({
        let index = index.clone();
        async move { index.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())).await.map(drop) }
    });
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, waiters.wait_for(|n| *n > before)).await.expect("the worker read waited").unwrap();
    assert!(!projected.is_finished(), "the worker rows answered before the session behind its log was repaired");
    drop(release);
    mixdog_rt::time::timeout(REBUILD_BOUND, projected).await.expect("answered once repaired").unwrap().unwrap();
    let rows = index.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())).await.unwrap();
    assert_eq!(rows.iter().map(|row| row.session.as_str()).collect::<Vec<_>>(), ["w1"]);
    index.close();
}

/// A session that may hold a worker row whose projection fails fails every read of the worker rows with its failure: none
/// answers from the rest as if it were all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_worker_projection_fails_the_worker_readers() {
    let whole = three_sessions_without_an_index().await;
    crate::sqlite::reconcile_seam::fail(whole.path());
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    index.withhold(Vec::new()).await.unwrap();
    let projected = mixdog_rt::time::timeout(REBUILD_BOUND, index.worker_rows_projected()).await.expect("answered");
    assert!(projected.is_err() && format!("{projected:?}").contains("test seam"), "{projected:?}");
    let read = index.worker_rows(None, crate::worker::WorkerScope::All).await;
    assert!(read.is_err(), "the worker rows answered without a session that failed: {read:?}");
    index.close();
}

/// In a store the boot opens, no reader waiting for the rebuild starts it: the repairs begin with this boot's withheld set,
/// so a withheld session's log is never projected before the set says to leave it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_waits_for_the_withheld_set_whatever_waits_for_it() {
    let whole = three_sessions_without_an_index().await;
    let index = open_withholding(whole.path(), &Arc::new(RebuildProgress::default())).await;
    let workers = tokio::spawn({
        let index = index.clone();
        async move { index.worker_rows_projected().await }
    });
    let deleted = tokio::spawn({
        let index = index.clone();
        async move { index.deleted_ids().await }
    });
    let mut waiters = index.reconcile_waiters();
    mixdog_rt::time::timeout(REBUILD_BOUND, waiters.wait_for(|n| *n >= 2)).await.expect("both readers wait").unwrap();
    assert_eq!(index.repairs().repaired, 0, "a waiting reader started the repairs before the withheld set");
    index.withhold(vec!["s2".to_owned()]).await.unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, index.repairs_idle()).await.expect("the repairs ended");
    let report = index.repairs();
    assert_eq!((report.repaired, report.left), (2, vec!["s2".to_owned()]), "the withheld session is left for its rewrite");
    // No index classified the sessions: each may hold a worker row, and the held one keeps both readers waiting.
    assert!(!workers.is_finished() && !deleted.is_finished(), "a reader was answered without the session held for its rewrite");
    index.release_withheld("s2").await.unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, workers).await.expect("the worker rows answered").unwrap().unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, deleted).await.expect("the deleted set answered").unwrap().unwrap();
    index.reconciled().await.unwrap();
    index.close();
}

/// The row changes a rebuild tells.
#[derive(Default)]
struct Told(std::sync::Mutex<Vec<RowEdge>>);

impl RowSink for Told {
    fn written(&self, edge: RowEdge) {
        self.0.lock().unwrap().push(edge);
    }
}

/// A session a rebuild writes in a shared transaction is told as the change from no row: a subscribed roster takes it as a
/// new session, whatever the row written at its first frame held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_a_rebuild_writes_whole_is_told_as_a_new_row() {
    let whole = three_sessions_without_an_index().await;
    let index = open_reporting(whole.path(), &Arc::new(RebuildProgress::default())).await;
    let told = Arc::new(Told::default());
    index.observe_rows(told.clone()).unwrap();
    index.withhold(Vec::new()).await.unwrap();
    index.reconciled().await.unwrap();
    let mut edges: Vec<(String, bool)> = Vec::new();
    for edge in told.0.lock().unwrap().iter() {
        if !edges.iter().any(|(id, _)| *id == edge.id) {
            edges.push((edge.id.clone(), edge.before.is_none()));
        }
    }
    edges.sort();
    assert_eq!(edges, [("s1".to_owned(), true), ("s2".to_owned(), true), ("s3".to_owned(), true)]);
    index.close();
}

/// Whether `answer` is the index recovery failure of `session`, which is no answer about the data.
fn failed_for<T>(answer: &Result<T, DbError>, session: &str) -> bool {
    matches!(answer, Err(DbError::Recovery { session: failed, .. }) if failed == session)
}

/// A data dir of logs and no index: `p`, whose header archives the result of the child `c`, and `f` and `o`, unrelated.
async fn a_parent_archiving_a_child() -> tempfile::TempDir {
    let env = Env::new();
    let listed = |title: &str| json!({"title": title, "updatedAt": 5, "desktopSession": {"classification": "task", "projectPath": "/p"}});
    let mut parent = listed("parent");
    parent["archivedAgentResults"] = json!({"c": {"result": "done"}});
    for (id, header) in [("p", parent), ("f", listed("other")), ("o", listed("third"))] {
        let w = env.create(id, session(id, None, header)).await;
        drop(env.commit(w, vec![item("a", "one"), meta("note", &big("a body out of line"))]).await);
    }
    env.store.close();
    copy_data(&env.data)
}

/// While the parent `p` is held for its rewrite, a lookup of the child's parents, a listing, a search and a read of `p`
/// all wait: none answers absence. Once `p` is released its own read answers; the lookups over every session answer with
/// the failure of the unrelated `f` when its repair failed (never no parent, never a shorter page), and with `p` when
/// nothing failed. A read of `f` answers its failure while `p` is still held.
async fn lookups_over_a_held_parent(failing: bool) {
    let whole = a_parent_archiving_a_child().await;
    if failing {
        crate::sqlite::reconcile_seam::fail_session(whole.path(), "f");
    }
    let index = open_withholding(whole.path(), &Arc::new(RebuildProgress::default())).await;
    let mut waiters = index.reconcile_waiters();
    let parents = tokio::spawn({
        let index = index.clone();
        async move { index.archived_agent_parents("c").await }
    });
    let listing = tokio::spawn({
        let index = index.clone();
        async move { index.list_sessions(true, None, None).await }
    });
    let search = tokio::spawn({
        let index = index.clone();
        async move { index.search("", 10, None).await }
    });
    let named = tokio::spawn({
        let index = index.clone();
        async move { index.summary("p").await }
    });
    mixdog_rt::time::timeout(REBUILD_BOUND, waiters.wait_for(|n| *n >= 4)).await.expect("the four reads wait").unwrap();
    index.withhold(vec!["p".to_owned()]).await.unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, index.repairs_idle()).await.expect("the repairs ended");
    let report = index.repairs();
    assert_eq!((report.left, report.failed.len()), (vec!["p".to_owned()], usize::from(failing)));
    assert!(
        !parents.is_finished() && !listing.is_finished() && !search.is_finished() && !named.is_finished(),
        "a read was answered while the parent was held for its rewrite"
    );
    if failing {
        let read = mixdog_rt::time::timeout(REBUILD_BOUND, index.summary("f")).await.expect("the failed session answers while another is held");
        assert!(failed_for(&read, "f"), "{read:?}");
    }
    index.release_withheld("p").await.unwrap();
    let named = mixdog_rt::time::timeout(REBUILD_BOUND, named).await.expect("the parent answered once released").unwrap();
    assert!(named.unwrap().is_some(), "the parent reads on its own, whatever another session's repair came to");
    let parents = mixdog_rt::time::timeout(REBUILD_BOUND, parents).await.expect("the lookup answered").unwrap();
    let listing = mixdog_rt::time::timeout(REBUILD_BOUND, listing).await.expect("the listing answered").unwrap();
    let search = mixdog_rt::time::timeout(REBUILD_BOUND, search).await.expect("the search answered").unwrap();
    if failing {
        assert!(failed_for(&parents, "f"), "the lookup of the child's parents: {parents:?}");
        assert!(failed_for(&listing, "f"), "the listing: {:?}", listing.map(|rows| rows.len()));
        assert!(failed_for(&search, "f"), "the search: {search:?}");
    } else {
        assert_eq!(parents.unwrap(), ["p"], "the child's archived result is its parent's");
        let mut listed: Vec<String> = listing.unwrap().iter().filter_map(|row| row.row["id"].as_str().map(str::to_owned)).collect();
        listed.sort();
        assert_eq!(listed, ["f", "o", "p"]);
        assert_eq!(search.unwrap().len(), 3, "the search holds every session");
    }
    index.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lookups_over_every_session_answer_the_failure_of_one_and_never_absence() {
    lookups_over_a_held_parent(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lookups_over_every_session_wait_for_a_held_parent_and_then_hold_it() {
    lookups_over_a_held_parent(false).await;
}

/// An interrupted rebuild resumed: `w1` was projected by the start that was cut off and its worker change then reached its
/// log only (its row is dirty, or its rows are holed); `n1` and `o1` are still owed their rows and were recorded as no
/// worker candidates. `w1` is repaired ahead of them and its committed tag is read while the repair of `o1` is still held,
/// and the failure of `n1` fails a listing and no read of the worker rows.
async fn a_worker_change_behind_the_index(holed: bool) {
    let env = Env::new();
    let w = env.create("w1", session("w1", None, json!({"title": "t"}))).await;
    let w = env.commit(w, vec![item("a", "one")]).await;
    env.close(w).await;
    let w = env.writer("w1").await;
    let worker = encoded(json!({"k":"meta","change":{"inline":{"set":{"worker":{"tag":"t1","parentSessionId":"p9"}},"unset":[]}}}));
    let (w, _unprojected) = on_lane(move |l| {
        let mut w = w;
        let ack = w.append_barrier(l, vec![worker]).unwrap();
        (w, ack)
    })
    .await;
    drop(w);
    env.store.close();
    // The logs of the two sessions the interrupted rebuild had not reached: no row of theirs is in the index.
    let other = Env::new();
    for id in ["n1", "o1"] {
        let w = other.create(id, session(id, None, json!({"title": "t"}))).await;
        let w = other.commit(w, vec![item("a", "one")]).await;
        other.close(w).await;
    }
    other.store.close();
    for id in ["n1", "o1"] {
        copy_tree(&other.dir(id), &env.dir(id));
    }
    let db = rusqlite::Connection::open(env.data.join(INDEX_FILE)).unwrap();
    if holed {
        db.execute("UPDATE sessions SET dirty = 0", []).unwrap();
        db.execute("INSERT INTO meta (key, value) VALUES ('hole:w1', '1')", []).unwrap();
    } else {
        db.execute("UPDATE sessions SET dirty = (id = 'w1')", []).unwrap();
    }
    // Ordinary debts (below the candidates' value), `n1` ahead of `o1`.
    db.execute("INSERT INTO meta (key, value) VALUES ('rebuild:n1', '2'), ('rebuild:o1', '1')", []).unwrap();
    drop(db);

    crate::sqlite::reconcile_seam::fail_session(&env.data, "n1");
    let (release, arrived) = crate::sqlite::reconcile_seam::hold(&env.data, "o1");
    let index = open_reporting(&env.data, &Arc::new(RebuildProgress::default())).await;
    index.withhold(Vec::new()).await.unwrap();
    tokio::task::spawn_blocking(move || arrived.recv().unwrap()).await.unwrap();
    // A rebuild repairs on several threads: the order the sessions were handed out, not the order their repairs ended.
    assert_eq!(index.repair_taken(), ["w1", "n1", "o1"], "the session behind its log is taken ahead of the ordinary ones");
    let rows = mixdog_rt::time::timeout(REBUILD_BOUND, index.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())))
        .await
        .expect("the worker rows answer while an ordinary repair is held")
        .expect("the failure of a session that is no worker candidate fails no worker read");
    assert_eq!(rows.iter().map(|row| row.session.as_str()).collect::<Vec<_>>(), ["w1"]);
    mixdog_rt::time::timeout(REBUILD_BOUND, index.worker_rows_projected()).await.expect("answered").unwrap();
    let mut waiters = index.reconcile_waiters();
    let before = *waiters.borrow();
    let listing = tokio::spawn({
        let index = index.clone();
        async move { index.list_sessions(true, None, None).await }
    });
    mixdog_rt::time::timeout(REBUILD_BOUND, waiters.wait_for(|n| *n > before)).await.expect("the listing waited").unwrap();
    assert!(!listing.is_finished(), "a listing answered short of a session under repair");
    drop(release);
    let listing = mixdog_rt::time::timeout(REBUILD_BOUND, listing).await.expect("the listing answered").unwrap();
    assert!(failed_for(&listing, "n1"), "{:?}", listing.map(|rows| rows.len()));
    index.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dirty_session_of_a_resumed_rebuild_is_a_worker_candidate_repaired_first() {
    a_worker_change_behind_the_index(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_holed_session_of_a_resumed_rebuild_is_a_worker_candidate_repaired_first() {
    a_worker_change_behind_the_index(true).await;
}

/// The messages of the fork's own log in [`a_deleted_base_with_a_long_fork`]: more than one rebuild transaction holds.
const FORK_OWN: usize = 1200;

/// A data dir of logs and no index: `p1`, deleted and the base of the live fork `c1`, and `d1`, deleted and read by no fork.
async fn a_deleted_base_with_a_long_fork() -> tempfile::TempDir {
    let env = Env::new();
    let deleted = || encoded(json!({"k":"meta","change":{"inline":{"set":{"deleted":true},"unset":[]}}}));
    let w = env.create("p1", session("p1", None, json!({"title": "base"}))).await;
    let w = env.commit(w, vec![item("a", "hi"), meta("note", &big("a body out of line"))]).await;
    let mut fork = env.create("c1", session("c1", Some(("p1", 2)), json!({"title": "fork"}))).await;
    for batch in 0..FORK_OWN / 100 {
        fork = env.commit(fork, (0..100).map(|i| item(&format!("m{batch}-{i}"), "more")).collect()).await;
    }
    drop(fork);
    drop(env.commit(w, vec![deleted()]).await);
    let w = env.create("d1", session("d1", None, json!({"title": "gone"}))).await;
    drop(env.commit(w, vec![item("a", "hi"), deleted()]).await);
    env.store.close();
    copy_data(&env.data)
}

/// What a kill leaves of `data` now: its files as they are, the index's shared memory gone with the process.
fn killed_copy(data: &Path) -> tempfile::TempDir {
    // The `-shm` file is not read: a writer inside a transaction holds a lock on part of it, and a kill leaves none.
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else if !entry.file_name().to_string_lossy().ends_with("-shm") {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    let killed = tempfile::tempdir().unwrap();
    copy(data, killed.path());
    killed
}

/// The data dir of [`a_deleted_base_with_a_long_fork`] as a kill of its rebuild leaves it at `point`.
async fn killed_at(point: &str) -> tempfile::TempDir {
    let whole = a_deleted_base_with_a_long_fork().await;
    let progress = Arc::new(RebuildProgress::default());
    match point {
        "before the rename" => {
            // The stage beside the index, half written; no index was published.
            let staged = crate::fsio::tmp_path(&whole.path().join(INDEX_FILE));
            std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
            std::fs::write(&staged, b"half a staged index").unwrap();
            whole
        }
        "after the first partial commit" => {
            let (first, in_first) = crate::sqlite::reconcile_seam::hold_slice(whole.path(), "c1");
            let (second, in_second) = crate::sqlite::reconcile_seam::hold_slice(whole.path(), "c1");
            let index = open_reporting(whole.path(), &progress).await;
            index.withhold(Vec::new()).await.unwrap();
            in_first.recv_timeout(REBUILD_BOUND).expect("the writer is inside the fork's first transaction");
            drop(first);
            in_second.recv_timeout(REBUILD_BOUND).expect("the first transaction committed, the writer is inside the second");
            let killed = killed_copy(whole.path());
            drop(second);
            index.reconciled().await.unwrap();
            index.close();
            killed
        }
        "while the fork is withheld" => {
            let index = open_withholding(whole.path(), &progress).await;
            index.withhold(vec!["c1".to_owned()]).await.unwrap();
            mixdog_rt::time::timeout(REBUILD_BOUND, index.repairs_idle()).await.expect("the repairs ended");
            assert_eq!(index.repairs().left, ["c1"]);
            let killed = killed_copy(whole.path());
            index.close();
            killed
        }
        "after the final commit, before the notification" => {
            let (release, arrived) = crate::sqlite::reconcile_seam::hold_settle(whole.path(), "c1");
            let index = open_reporting(whole.path(), &progress).await;
            index.withhold(Vec::new()).await.unwrap();
            arrived.recv_timeout(REBUILD_BOUND).expect("the fork's last transaction committed");
            assert!(index.repairs().pending >= 1, "the fork was settled before its repair said so");
            let killed = killed_copy(whole.path());
            drop(release);
            index.reconciled().await.unwrap();
            index.close();
            killed
        }
        other => panic!("no such point: {other}"),
    }
}

/// The start after a kill: the deleted base's log survives the boot purge and a live purge while a projection is owed,
/// the fork is recovered with its base's message and its own, and the purge that follows the complete recovery reclaims
/// the deletion no fork reads and keeps the base the fork reads.
async fn recovers(killed: &Path, point: &str) {
    let log = |id: &str| killed.join("sessions").join(id).join(log_name(0));
    let next = open_withholding(killed, &Arc::new(RebuildProgress::default())).await;
    assert!(log("p1").is_file(), "{point}: the boot purge took the base of a fork");
    let live = next.purge_deleted(tokens().maintenance_io, killed.to_path_buf()).await.unwrap();
    assert!(!live.contains(&"p1".to_owned()) && log("p1").is_file(), "{point}: a live purge took the base of a fork: {live:?}");
    next.withhold(Vec::new()).await.unwrap();
    mixdog_rt::time::timeout(REBUILD_BOUND, next.reconciled()).await.unwrap_or_else(|_| panic!("{point}: the recovery ended")).unwrap();
    let summary: Value = serde_json::from_str(&next.summary("c1").await.unwrap().unwrap_or_else(|| panic!("{point}: the fork is listed"))).unwrap();
    assert_eq!(summary["messageCount"], json!(FORK_OWN + 1), "{point}: the fork holds its base's message and its own");
    let purged = next.purge_once_projected(tokens().maintenance_io, killed.to_path_buf()).await.unwrap();
    assert!(!purged.contains(&"p1".to_owned()) && log("p1").is_file(), "{point}: the purge took the base its fork reads: {purged:?}");
    assert!(!killed.join("sessions").join("d1").exists(), "{point}: the deletion no fork reads is reclaimed");
    next.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_killed_at_any_point_keeps_a_deleted_base_until_its_fork_is_recovered() {
    for point in ["before the rename", "after the first partial commit", "while the fork is withheld", "after the final commit, before the notification"] {
        let killed = killed_at(point).await;
        recovers(killed.path(), point).await;
    }
}

/// A start whose repair of the fork fails removes nothing: every deleted log is intact for the start after it, which
/// recovers the fork.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_repair_of_a_fork_leaves_every_deleted_log_for_the_next_start() {
    let killed = killed_at("while the fork is withheld").await;
    let log = |id: &str| killed.path().join("sessions").join(id).join(log_name(0));
    crate::sqlite::reconcile_seam::fail_session(killed.path(), "c1");
    let failing = open_withholding(killed.path(), &Arc::new(RebuildProgress::default())).await;
    failing.withhold(Vec::new()).await.unwrap();
    let ended = mixdog_rt::time::timeout(REBUILD_BOUND, failing.reconciled()).await.expect("the recovery ended");
    assert!(failed_for(&ended, "c1"), "{ended:?}");
    assert_eq!(failing.purge_deleted(tokens().maintenance_io, killed.path().to_path_buf()).await.unwrap(), Vec::<String>::new());
    let deferred = failing.purge_once_projected(tokens().maintenance_io, killed.path().to_path_buf()).await;
    assert!(failed_for(&deferred, "c1"), "{deferred:?}");
    assert!(log("p1").is_file() && log("d1").is_file(), "a start whose repair failed removed a deleted session");
    failing.close();
    recovers(killed.path(), "after a failed repair").await;
}
