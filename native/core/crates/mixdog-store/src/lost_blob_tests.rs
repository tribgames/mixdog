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
        WriterDeps {
            io: Arc::new(OsIo),
            blobs: BlobStore::new(&self.data),
            ownership: Arc::new(MockOwnership::default()),
            index: Arc::new(self.store.clone()),
        }
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

/// A census of an earlier build deleted the session's header blob and its newest checkpoint's state: the open folds the
/// log from its start and takes the header from the older checkpoint, and a rebuilt index lists the session whole.
/// Without that checkpoint too, the header is unrecoverable: the open names the missing blob, and the rebuilt index
/// lists the session as damaged with every row it still holds.
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
    let states: Vec<Digest> =
        records.iter().filter(|r| matches!(r, Record::Checkpoint(_))).filter_map(own_blob).collect();
    let [older, newest] = states.as_slice() else { panic!("two checkpoints out of line: {states:?}") };
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
    let state = records.iter().filter(|r| matches!(r, Record::Checkpoint(_))).find_map(own_blob).expect("a state blob");
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
/// The rebuild reports its sessions done and total as it runs, and ends at the total; an open that needs no rebuild
/// leaves the progress absent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_reports_its_sessions_and_a_plain_open_reports_none() {
    let env = Env::new();
    for id in ["s1", "s2", "s3"] {
        let w = env.create(id, session(id, None, json!({"title": "t"}))).await;
        drop(env.commit(w, vec![item("a", "one"), meta("note", &big("a body out of line"))]).await);
    }
    env.store.close();
    let whole = copy_data(&env.data);
    let open =|data: PathBuf, progress: Arc<RebuildProgress>| {
        let (tx, rx) = std::sync::mpsc::channel();
        let _job = tokens()
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                let _ = tx.send(SqliteStore::open_reporting(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data, Some(&progress)));
            })
            .expect("lane");
        rx.recv().unwrap().expect("opens")
    };
    let rebuilding = Arc::new(RebuildProgress::default());
    let told = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    rebuilding.on_change(Box::new({
        let told = told.clone();
        move || {
            told.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }));
    assert_eq!(rebuilding.snapshot(), None, "nothing before a rebuild");
    let rebuilt = tokio::task::spawn_blocking({
        let (data, rebuilding) = (whole.path().to_path_buf(), rebuilding.clone());
        move || open(data, rebuilding)
    })
    .await
    .unwrap();
    assert_eq!(rebuilding.snapshot(), Some((3, 3)), "it ends at the total");
    assert_eq!(told.load(std::sync::atomic::Ordering::SeqCst), 4, "told when it began and as each of the three sessions finished");
    rebuilt.reconciled().await.unwrap();
    rebuilt.close();
    let plain = Arc::new(RebuildProgress::default());
    let reopened = tokio::task::spawn_blocking({
        let (data, plain) = (whole.path().to_path_buf(), plain.clone());
        move || open(data, plain)
    })
    .await
    .unwrap();
    assert_eq!(plain.snapshot(), None, "an intact index is not rebuilt");
    reopened.close();

    std::fs::write(whole.path().join(INDEX_FILE), []).unwrap();
    let blank = rusqlite::Connection::open(whole.path().join(INDEX_FILE)).unwrap();
    blank.pragma_update(None, "application_id", crate::schema::sql::INDEX_APPLICATION_ID).unwrap();
    blank.pragma_update(None, "user_version", crate::schema::sql::INDEX_USER_VERSION).unwrap();
    drop(blank);
    let empty = Arc::new(RebuildProgress::default());
    let recovered = tokio::task::spawn_blocking({
        let (data, empty) = (whole.path().to_path_buf(), empty.clone());
        move || open(data, empty)
    })
    .await
    .unwrap();
    assert_eq!(empty.snapshot(), Some((3, 3)), "an empty schema with intact identity cannot stand in for the logs");
    recovered.close();
}
