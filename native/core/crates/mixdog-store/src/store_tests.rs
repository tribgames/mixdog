//! Store behaviour (SM §11.8): writer transitions with fault injection, projection,
//! rewind and lineage paging, catalog upsert, folds and refold.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "tests inspect log files and the index directly"
)]

use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::testing::tokens;
use serde_json::json;

use crate::blobs::BlobStore;
use crate::encode::Encoded;
use crate::fold::LineageIndex;
use crate::fsio::IoError;
use crate::log::*;
use crate::sqlite::*;
use crate::title::PlaceholderLabels;

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

fn rec(v: serde_json::Value) -> Encoded {
    Encoded::new(serde_json::from_value(v).expect("record"), Vec::new()).expect("encodes")
}

fn session(id: &str, base: Option<(&str, u64)>) -> Encoded {
    let mut v = json!({"k":"session","v":2,"id":id,"log_id":LOG_ID,"header":{"inline":{"title":"t"}}});
    if let Some((b, end)) = base {
        v["base"] = json!({"session":b,"log_id":LOG_ID,"end_ordinal_exclusive":end});
    }
    rec(v)
}

fn item(iid: &str) -> Encoded {
    rec(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":iid,"role":"user"}}}))
}

async fn on_lane<R: Send + 'static>(f: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokens()
        .durability_io
        .submit(&CancellationToken::new(), f)
        .expect("lane")
        .await
        .expect("job ran")
}

#[derive(Default)]
struct Faults {
    write: usize,
    sync: usize,
    truncate: usize,
}

/// `OsIo` with injected failures of the next N writes / syncs / truncates.
#[derive(Clone, Default)]
struct FaultIo(Arc<Mutex<Faults>>);

struct FaultFile(Box<dyn LogFile>, Arc<Mutex<Faults>>);

fn take(n: &mut usize) -> io::Result<()> {
    if *n > 0 {
        *n -= 1;
        return Err(io::Error::other("injected"));
    }
    Ok(())
}

impl LogFile for FaultFile {
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        take(&mut self.1.lock().unwrap().write)?;
        self.0.write_at(offset, bytes)
    }
    fn sync(&mut self) -> io::Result<()> {
        take(&mut self.1.lock().unwrap().sync)?;
        self.0.sync()
    }
    fn truncate(&mut self, len: u64) -> io::Result<()> {
        take(&mut self.1.lock().unwrap().truncate)?;
        self.0.truncate(len)
    }
    fn size(&mut self) -> io::Result<u64> {
        self.0.size()
    }
}

impl WriterIo for FaultIo {
    fn open_append(&self, path: &Path) -> io::Result<Box<dyn LogFile>> {
        Ok(Box::new(FaultFile(OsIo.open_append(path)?, self.0.clone())))
    }
    fn publish(&self, path: &Path, bytes: &[u8]) -> Result<(), IoError> {
        OsIo.publish(path, bytes)
    }
}

/// `SqliteStore::open` as a maintenance job (the test backend runs it inline).
fn open_index(data: &Path) -> Result<SqliteStore, DbError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let data = data.to_path_buf();
    let _job = tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &data));
        })
        .expect("lane");
    rx.recv().expect("job ran")
}

struct Env {
    _tmp: tempfile::TempDir,
    data: PathBuf,
    store: SqliteStore,
    io: FaultIo,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().to_path_buf();
        let store = open_index(&data).unwrap();
        Env { _tmp: tmp, data, store, io: FaultIo::default() }
    }

    fn deps(&self) -> WriterDeps {
        WriterDeps {
            io: Arc::new(self.io.clone()),
            blobs: BlobStore::new(&self.data),
            ownership: Arc::new(MockOwnership::default()),
            index: Arc::new(self.store.clone()),
        }
    }

    fn dir(&self, id: &str) -> PathBuf {
        self.data.join("sessions").join(id)
    }

    async fn create(&self, id: &str, base: Option<(&str, u64)>) -> LogWriter {
        self.create_from(id, session(id, base)).await
    }

    async fn create_from(&self, id: &str, rec: Encoded) -> LogWriter {
        self.store.upsert(head(id, "task", "Title"), DirtyMark::Set).await.unwrap();
        let (dir, deps) = (self.dir(id), self.deps());
        let (w, ack) = on_lane(move |l| LogWriter::create(l, &dir, rec, deps).unwrap()).await;
        self.store.project(ack.projection).await.unwrap();
        w
    }

    async fn append(&self, w: LogWriter, batch: Vec<Encoded>) -> (LogWriter, Result<BatchAck, AppendError>) {
        on_lane(move |l| {
            let mut w = w;
            let r = w.append_barrier(l, batch);
            (w, r)
        })
        .await
    }

    async fn commit(&self, w: LogWriter, batch: Vec<Encoded>) -> (LogWriter, Vec<u64>) {
        let (w, r) = self.append(w, batch).await;
        let ack = r.unwrap();
        let ordinals = ack.positions.iter().map(|p| p.ordinal).collect();
        self.store.project(ack.projection).await.unwrap();
        (w, ordinals)
    }

    async fn reopen(&self, id: &str) -> OpenedLog {
        let (dir, blobs, store) = (self.dir(id), BlobStore::new(&self.data), self.store.clone());
        on_lane(move |l| open_log(l, &dir, &blobs, &store as &dyn LineageIndex).unwrap()).await
    }
}

use crate::summary::CatalogHead;

fn head(id: &str, classification: &str, title: &str) -> CatalogHead {
    let header = serde_json::json!({
        "id": id,
        "title": title,
        "updatedAt": 1,
        "desktopSession": {"classification": classification, "projectPath": "/p"},
    });
    CatalogHead {
        session: id.into(),
        log_id: LOG_ID.into(),
        base_session: None,
        header: header.as_object().unwrap().clone(),
    }
}

fn lineage(levels: &[(&str, Option<u64>)]) -> Vec<LineageLevel> {
    levels.iter().map(|(s, e)| LineageLevel { session: (*s).into(), end: *e }).collect()
}

fn iids(rows: &[HistoryRow]) -> Vec<String> {
    rows.iter().map(|r| r.iid.clone()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn barrier_projects_and_reopens() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, ords) = env.commit(w, vec![item("a"), item("b"), item("c")]).await;
    assert_eq!(ords, vec![1, 2, 3]);
    assert_eq!(*w.state(), WriterState::Clean { end: std::fs::metadata(env.dir("s1").join(log_name(0))).unwrap().len() });
    let (rows, next) = env.store.history_page(lineage(&[("s1", None)]), None, None, 2).await.unwrap();
    assert_eq!(iids(&rows), ["c", "b"]);
    let (rows, _) = env.store.history_page(lineage(&[("s1", None)]), None, next, 2).await.unwrap();
    assert_eq!(iids(&rows), ["a"]);
    let opened = env.reopen("s1").await;
    assert_eq!(opened.status, LogStatus::Clean);
    assert_eq!((opened.fold.rows, opened.fold.next_ordinal), (3, 4));
    assert_eq!(env.store.dirty_sessions().await.unwrap(), ["s1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_ops_are_looked_up_by_session_and_id() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let op = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
    let digest = "sha256:a20b52fae57cc7a99c9651f1b573950fd211823e3ace3bb9c273c06430f24cd3";
    let mut v = serde_json::to_value(item("a").record()).unwrap();
    v["op"] = json!({"id":op,"method":"thread/rename","digest":digest});
    let (_w, ords) = env.commit(w, vec![rec(v)]).await;
    let found = env.store.thread_op("s1", op).await.unwrap().unwrap();
    assert_eq!((found.method.as_str(), found.payload_digest.as_str()), ("thread/rename", digest));
    assert_eq!((found.state, found.pos.ordinal), (crate::schema::record::OpState::Applied, ords[0]));
    assert_eq!(env.store.thread_op("s2", op).await.unwrap(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fenced_ops_are_listed_by_session() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let op = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
    let digest = "sha256:a20b52fae57cc7a99c9651f1b573950fd211823e3ace3bb9c273c06430f24cd3";
    let fence = rec(json!({"k":"op","op":{"id":op,"method":"op/status","digest":digest},"state":"fenced","at":1}));
    env.commit(w, vec![item("a"), fence]).await;
    assert_eq!(env.store.fenced_ops("s1").await.unwrap(), [op]);
    assert!(env.store.fenced_ops("s2").await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rewind_supersedes_rows_and_stales_cursors() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![item("a"), item("b"), item("c")]).await;
    let (_, cursor) = env.store.history_page(lineage(&[("s1", None)]), None, None, 1).await.unwrap();
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (w, _) = env.commit(w, vec![rewind, item("d")]).await;
    assert_eq!((w.fold().rows, w.fold().history_rev), (2, 1));
    let (rows, _) = env.store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["d", "a"]);
    assert!(matches!(
        env.store.history_page(lineage(&[("s1", None)]), None, cursor, 10).await,
        Err(DbError::CursorStale)
    ));
    assert_eq!(env.store.live_rows("s1", 0, 6).unwrap(), (2, 2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lineage_pages_across_bases() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (base, _) = env.commit(base, vec![item("b1"), item("b2"), item("b3")]).await;
    // Fork after b2 (ordinals 1, 2); a later rewind in the base does not reach the fork.
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (_base, _) = env.commit(base, vec![rewind]).await;
    let mid = env.create("m0", Some(("b0", 3))).await;
    let (mid, _) = env.commit(mid, vec![item("m1")]).await;
    drop(mid);
    // m0's own log starts at ordinal 3 (session frame), m1 is 4.
    let child = env.create("c0", Some(("m0", 5))).await;
    let (_child, _) = env.commit(child, vec![item("c1")]).await;
    let levels = lineage(&[("c0", None), ("m0", Some(5)), ("b0", Some(3))]);
    let mut all = Vec::new();
    let mut cursor = None;
    loop {
        let (rows, next) = env.store.history_page(levels.clone(), None, cursor, 1).await.unwrap();
        all.extend(iids(&rows));
        match next {
            Some(n) => cursor = Some(n),
            None => break,
        }
    }
    assert_eq!(all, ["c1", "m1", "b2", "b1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_rewind_into_the_base_cuts_the_lineage_view() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (_base, _) = env.commit(base, vec![item("b1"), item("b2"), item("b3")]).await;
    // Fork after b3 (ordinals 1..=3): the child starts at 4, its item is 5.
    let child = env.create("c0", Some(("b0", 4))).await;
    let (child, _) = env.commit(child, vec![item("c1")]).await;
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (child, _) = env.commit(child, vec![rewind, item("c2")]).await;
    assert_eq!(child.fold().base_cut, Some(2));
    assert_eq!((child.fold().rows, child.fold().history_rev), (1, 1));
    let levels = lineage(&[("c0", None), ("b0", Some(4))]);
    let (rows, _) = env.store.history_page(levels.clone(), child.fold().base_cut, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["c2", "b1"]);
    // The base itself is untouched.
    let (rows, _) = env.store.history_page(lineage(&[("b0", None)]), None, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["b3", "b2", "b1"]);
    // The cut survives the checkpoint at clean close and the bounded reopen.
    let mut child = child;
    let ack = on_lane(move |l| {
        let a = child.close(l).unwrap();
        (child, a)
    })
    .await;
    env.store.project(ack.1.unwrap().projection).await.unwrap();
    let opened = env.reopen("c0").await;
    assert_eq!((opened.fold.base_cut, opened.fold.rows), (Some(2), 1));
}

const GC_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);
const DAY_8: std::time::Duration = std::time::Duration::from_secs(8 * 24 * 3600);

/// One GC pass over `digest`'s shard at day 8, on the maintenance lane.
async fn gc_at_day_8(env: &Env, digest: &crate::schema::bounded::Digest) -> Vec<String> {
    let (blobs, store) = (BlobStore::new(&env.data), env.store.clone());
    let shard = u8::from_str_radix(&digest.as_str()["sha256:".len()..][..2], 16).unwrap();
    tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |l| {
            let now = std::time::SystemTime::now() + DAY_8;
            blobs
                .collect_shard(l, shard, now, GC_MIN_AGE, &mut |d| store.blob_referenced_on_lane(l, d))
                .unwrap()
                .into_iter()
                .map(|d| d.as_str().to_owned())
                .collect()
        })
        .unwrap()
        .await
        .unwrap()
}

fn attachment(bytes: &[u8]) -> crate::encode::PendingBlob {
    crate::encode::PendingBlob { digest: crate::blobs::digest_of(bytes), bytes: bytes.to_vec() }
}

fn item_with_ref(iid: &str, blob: &crate::encode::PendingBlob) -> Encoded {
    let record = json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,
        "refs":[blob.digest.as_str()],"body":{"inline":{"content":iid,"role":"user"}}});
    Encoded::new(serde_json::from_value(record).unwrap(), vec![blob.clone()]).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gc_keeps_a_blob_referenced_only_by_a_migrated_session() {
    let env = Env::new();
    // A session written once and never activated again (as migration leaves it).
    let blob = attachment(b"migrated attachment bytes");
    let w = env.create("migrated", None).await;
    let (w, _) = env.commit(w, vec![item_with_ref("a", &blob)]).await;
    drop(w);
    assert!(gc_at_day_8(&env, &blob.digest).await.is_empty());
    assert!(BlobStore::new(&env.data).path(&blob.digest).is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gc_collects_a_blob_whose_frame_was_rolled_back() {
    let env = Env::new();
    let blob = attachment(b"rolled back attachment");
    let w = env.create("s1", None).await;
    env.io.0.lock().unwrap().write = 1;
    let (w, r) = env.append(w, vec![item_with_ref("a", &blob)]).await;
    assert!(matches!(r, Err(AppendError::BarrierFailed(_))));
    drop(w);
    let path = BlobStore::new(&env.data).path(&blob.digest);
    assert!(path.is_file(), "published before the barrier");
    assert_eq!(gc_at_day_8(&env, &blob.digest).await, [blob.digest.as_str().to_owned()]);
    assert!(!path.is_file());
}

/// GC asks whether a blob is referenced only while it holds the digest's pin lock, so a writer
/// that pins, references and unpins it between an earlier answer and the unlink cannot lose its
/// blob. While GC asks, the pin of that digest cannot be taken; a pin already held is skipped
/// without asking at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gc_checks_references_under_the_pin_lock() {
    let env = Env::new();
    let bytes = b"raced attachment bytes";
    let digest = crate::blobs::digest_of(bytes);
    let blobs = BlobStore::new(&env.data);
    let path = blobs.path(&digest);
    let shard = u8::from_str_radix(&digest.as_str()["sha256:".len()..][..2], 16).unwrap();
    let (store, pinned) = (blobs.clone(), blobs.clone());
    let (writer_digest, asked_digest) = (digest.clone(), digest.clone());
    let (collected, writer_blocked) = tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |l| {
            crate::fsio::publish_file(l, &path, bytes).unwrap();
            let now = std::time::SystemTime::now() + DAY_8;
            // A writer arrives: it pins the digest, then releases it at once.
            let (done, finished) = std::sync::mpsc::channel();
            let mut writer = None;
            let mut blocked = false;
            let mut asked = 0;
            let deleted = store
                .collect_shard(l, shard, now, GC_MIN_AGE, &mut |d| {
                    assert_eq!(d, &asked_digest);
                    asked += 1;
                    let (pinned, digest, done) = (pinned.clone(), writer_digest.clone(), done.clone());
                    writer = Some(std::thread::spawn(move || {
                        drop(pinned.pin(&digest));
                        done.send(()).unwrap();
                    }));
                    blocked = finished.recv_timeout(std::time::Duration::from_millis(200)).is_err();
                    Ok(false)
                })
                .unwrap();
            writer.expect("the answer was asked once").join().unwrap();
            assert_eq!(asked, 1);
            (deleted, blocked)
        })
        .unwrap()
        .await
        .unwrap();
    assert!(writer_blocked, "the pin could be taken while GC was asking: the answer can go stale");
    assert_eq!(collected, [digest.clone()], "unreferenced and unpinned, it went");

    // A pin held beforehand: skipped, and never asked.
    let held = blobs.pin(&digest);
    let (store, asked_digest) = (blobs.clone(), digest.clone());
    let path = blobs.path(&digest);
    let kept = tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |l| {
            crate::fsio::publish_file(l, &path, bytes).unwrap();
            let now = std::time::SystemTime::now() + DAY_8;
            store
                .collect_shard(l, shard, now, GC_MIN_AGE, &mut |_| panic!("asked about {asked_digest:?} while it is pinned"))
                .unwrap()
        })
        .unwrap()
        .await
        .unwrap();
    assert!(kept.is_empty());
    drop(held);
}

fn big_item(iid: &str) -> Encoded {
    let body = "x".repeat(200 * 1024);
    rec(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":body,"role":"user"}}}))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_reads_a_bounded_tail_and_rotation_starts_with_a_checkpoint() {
    use crate::schema::frame::*;
    let env = Env::new();
    let mut w = env.create("s1", None).await;
    // ~70 MiB of history in ~2 MiB batches: checkpoints every 1 MiB and one rotation.
    let mut n = 0;
    while env.dir("s1").join(log_name(1)).metadata().is_err() || n < 340 {
        let batch = (0..10).map(|i| big_item(&format!("i{}", n + i))).collect();
        n += 10;
        w = env.commit(w, batch).await.0;
    }
    drop(w);
    let files = list_logs(&env.dir("s1")).unwrap();
    assert_eq!(files, [0, 1]);
    assert!(std::fs::metadata(env.dir("s1").join(log_name(0))).unwrap().len() <= ROTATE_AT);
    // The rotated file starts with a checkpoint frame (its header names the ordinal).
    let bytes = std::fs::read(env.dir("s1").join(log_name(1))).unwrap();
    let ordinal = u64::from_str_radix(std::str::from_utf8(&bytes[..ORDINAL_DIGITS]).unwrap(), 16).unwrap();
    let first = read_forward_unlaned(
        &env.dir("s1"),
        crate::schema::checkpoint::FramePos { ordinal, file_no: 1, offset: 0 },
        1,
    )
    .unwrap();
    assert!(matches!(first.frames[0].0, crate::schema::record::Record::Checkpoint(_)));

    let opened = env.reopen("s1").await;
    assert_eq!((opened.status, opened.fold.rows), (LogStatus::Clean, n as u64));
    // Independent of history length: the reverse scan window plus the frame before it.
    assert!(opened.bytes_read <= REVERSE_SCAN_MAX + MAX_FRAME_LEN as u64 + 1, "{}", opened.bytes_read);
    assert!(opened.bytes_read <= 5 * 1024 * 1024 + MAX_FRAME_LEN as u64, "SM §11.8: ≤ 5 MiB + state");
}

// ───────────── groups (FORMAT.md §3.6): recovery takes a write whole or not at all ─────────────

/// The records a forward scan of `bytes` (a file's bytes from a frame start, `ordinal` due there, to its end) returns
/// (every frame but the anchors), and how it ended.
fn scanned_from(bytes: &[u8], ordinal: u64) -> (Vec<(u64, Vec<u8>)>, crate::schema::frame::ScanEnd) {
    let scan = crate::framing::scan(bytes, 0, 0, ordinal);
    let records = scan
        .frames
        .iter()
        .filter(|frame| !is_anchor_payload(frame.payload(bytes)))
        .map(|frame| (frame.ordinal, frame.payload(bytes).to_vec()))
        .collect();
    (records, scan.end)
}

fn is_anchor_payload(payload: &[u8]) -> bool {
    payload.starts_with(br#"{"k":"checkpoint","#) || payload.starts_with(br#"{"k":"session","#)
}

/// A log whose last write is the group under test, from the last frame before that write (`ordinal` due there) to its
/// end: those bytes, where the write starts in them, the records before and after it, and the positions the writer
/// acknowledged for it (file offsets; `from` is the file offset of `bytes[0]`).
struct Written {
    bytes: Vec<u8>,
    from: usize,
    ordinal: u64,
    write_start: usize,
    before: Vec<(u64, Vec<u8>)>,
    after: Vec<(u64, Vec<u8>)>,
    acked: Vec<crate::schema::checkpoint::FramePos>,
}

/// Writes `prefix` (one write each) then `group` as the last write of a fresh session `s1`.
async fn written(prefix: Vec<Vec<Encoded>>, group: Vec<Encoded>) -> (Env, Written) {
    let env = Env::new();
    let mut w = env.create("s1", None).await;
    for batch in prefix {
        w = env.commit(w, batch).await.0;
    }
    let path = env.dir("s1").join(log_name(0));
    let write_start = std::fs::metadata(&path).unwrap().len() as usize;
    let before_bytes = std::fs::read(&path).unwrap();
    let (w, ack) = env.append(w, group).await;
    let ack = ack.expect("the group is written");
    let acked = ack.positions.clone();
    env.store.project(ack.projection).await.unwrap();
    drop(w);
    let file = std::fs::read(&path).unwrap();
    let last = crate::framing::scan(&before_bytes, 0, 0, 0).frames.last().copied().expect("a frame before the write");
    let (from, ordinal) = (last.start, last.ordinal);
    let (before, end) = scanned_from(&before_bytes[from..], ordinal);
    assert_eq!(end, crate::schema::frame::ScanEnd::Clean);
    let bytes = file[from..].to_vec();
    let (after, end) = scanned_from(&bytes, ordinal);
    assert_eq!(end, crate::schema::frame::ScanEnd::Clean);
    (env, Written { bytes, from, ordinal, write_start: write_start - from, before, after, acked })
}

impl Written {
    /// The recovered records of `bytes` are exactly those before the group or those after it, never between: which.
    fn before_or_after(&self, what: &str, bytes: &[u8]) -> bool {
        let (records, end) = scanned_from(bytes, self.ordinal);
        assert!(records == self.before || records == self.after, "{what}: recovered {} records ({end:?}), before {} after {}", records.len(), self.before.len(), self.after.len());
        records == self.after
    }

    /// The marker of the group (in `bytes`): the frame start `GROUP_MARKER_LEN + FRAME_OVERHEAD` before the first
    /// acknowledged member.
    fn marker(&self) -> usize {
        self.acked[0].offset as usize - self.from - (crate::schema::frame::GROUP_MARKER_LEN + crate::schema::frame::FRAME_OVERHEAD)
    }
}

/// Re-encodes the group's marker with `payload` (same length, a valid frame): a forged count, length or digest.
fn with_marker(w: &Written, payload: &[u8]) -> Vec<u8> {
    let mut bytes = w.bytes.clone();
    let mut frame = Vec::new();
    crate::framing::encode_into(&mut frame, w.acked[0].ordinal, payload);
    let at = w.marker();
    bytes[at..at + frame.len()].copy_from_slice(&frame);
    bytes
}

fn marker_payload(w: &Written) -> Vec<u8> {
    let at = w.marker() + crate::schema::frame::HEADER_LEN;
    w.bytes[at..at + crate::schema::frame::GROUP_MARKER_LEN].to_vec()
}

/// Every way a group of three (and one whose write starts with a checkpoint) can be damaged, at every byte: the
/// recovered records are exactly those before the group or after it, never some of it; the positions the writer
/// acknowledged are where the members are found.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_group_is_recovered_whole_or_not_at_all_however_it_is_damaged() {
    // `since_anchor` past CHECKPOINT_EVERY: the second layout's group write starts with its leading checkpoint.
    let big: Vec<Encoded> = (0..6).map(|i| big_item(&format!("p{i}"))).collect();
    for (layout, prefix) in [("a group of three", vec![vec![item("x")]]), ("a group of three after a leading checkpoint", vec![big])] {
        let (_env, w) = written(prefix, vec![item("a"), item("b"), item("c")]).await;
        assert_eq!(w.after.len(), w.before.len() + 3, "{layout}");
        // The acknowledged positions are the members' frames.
        let scan = crate::framing::scan(&w.bytes, 0, 0, w.ordinal);
        let members: Vec<(u64, u64)> = scan.frames.iter().rev().take(3).rev().map(|f| (f.ordinal, (w.from + f.start) as u64)).collect();
        assert_eq!(members, w.acked.iter().map(|p| (p.ordinal, p.offset)).collect::<Vec<_>>(), "{layout}: BatchAck agrees");
        if layout.contains("checkpoint") {
            assert!(w.marker() > w.write_start, "{layout}: the leading checkpoint precedes the marker");
        }
        let len = w.bytes.len();
        for cut in w.write_start..=len {
            let after = w.before_or_after(&format!("{layout}: cut at {cut}"), &w.bytes[..cut]);
            assert_eq!(after, cut == len, "{layout}: cut at {cut}");
            let mut zeroed = w.bytes.clone();
            zeroed[cut..].fill(0);
            assert_eq!(w.before_or_after(&format!("{layout}: zero from {cut}"), &zeroed), cut == len, "{layout}: zero from {cut}");
        }
        for at in w.write_start..len {
            let mut flipped = w.bytes.clone();
            flipped[at] ^= 0x01;
            assert!(!w.before_or_after(&format!("{layout}: byte {at} flipped"), &flipped), "{layout}: byte {at} flipped");
        }
        // Forged markers, each a well-formed frame: count ±1, length ±1, a digest of other bytes.
        let marker = marker_payload(&w);
        let text = String::from_utf8(marker.clone()).unwrap();
        let count = u64::from_str_radix(&text[7..15], 16).unwrap();
        let bytes = u64::from_str_radix(&text[16..32], 16).unwrap();
        for (what, forged) in [
            ("count + 1", format!("#group {:08x}{}", count + 1, &text[15..])),
            ("count - 1", format!("#group {:08x}{}", count - 1, &text[15..])),
            ("length + 1", format!("{}{:016x}{}", &text[..16], bytes + 1, &text[32..])),
            ("length - 1", format!("{}{:016x}{}", &text[..16], bytes - 1, &text[32..])),
            ("another digest", format!("{}{}", &text[..33], "0".repeat(64))),
        ] {
            assert!(!w.before_or_after(&format!("{layout}: {what}"), &with_marker(&w, forged.as_bytes())), "{layout}: {what}");
        }
    }
}

/// Stale bytes after a new marker (a longer earlier write whose truncation did not last): the members the marker names
/// are not there, so none of the stale frames completes the group.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_bytes_after_a_marker_never_complete_its_group() {
    use crate::schema::frame::*;
    let (_env, longer) = written(vec![vec![item("x")]], vec![item("p"), item("q"), item("r"), item("s")]).await;
    // The new write: three other records at the same ordinals, of which only the marker landed.
    let members: Vec<u8> = [item("a"), item("b"), item("c")]
        .iter()
        .enumerate()
        .flat_map(|(i, e)| {
            let mut out = Vec::new();
            crate::framing::encode_into(&mut out, longer.acked[0].ordinal + i as u64, &e.payload);
            out
        })
        .collect();
    let mut stale = longer.bytes.clone();
    let mut marker = Vec::new();
    crate::framing::encode_into(&mut marker, longer.acked[0].ordinal, &group_marker(3, &members));
    let at = longer.marker();
    stale[at..at + marker.len()].copy_from_slice(&marker);
    let (records, end) = scanned_from(&stale, longer.ordinal);
    assert_eq!(records, longer.before, "{end:?}");
    // The same stale bytes with the new members fully landed: the whole new group.
    let mut landed = stale[..at + marker.len()].to_vec();
    landed.extend_from_slice(&members);
    let (records, end) = scanned_from(&landed, longer.ordinal);
    assert_eq!((records.len(), end), (longer.before.len() + 3, ScanEnd::Clean));
}

/// Two groups back to back, each damaged in turn: the first damaged leaves what was before it; the second damaged
/// leaves the first whole. A damaged group mid-log is damage (FORMAT.md §3.4, as a damaged frame always was): the
/// session opens read-only there and nothing after it is truncated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_damaged_group_mid_log_is_damage_and_nothing_after_it_is_truncated() {
    use crate::schema::frame::*;
    let env = Env::new();
    let w = env.create("s1", None).await;
    let path = env.dir("s1").join(log_name(0));
    let (w, first) = env.append(w, vec![item("a"), item("b"), item("c")]).await;
    let first = first.unwrap();
    let first_acked = first.positions.clone();
    env.store.project(first.projection).await.unwrap();
    let (w, second) = env.append(w, vec![item("d"), item("e"), item("f")]).await;
    let second = second.unwrap();
    let second_acked = second.positions.clone();
    env.store.project(second.projection).await.unwrap();
    drop(w);
    let bytes = std::fs::read(&path).unwrap();
    let marker_of = |acked: &[crate::schema::checkpoint::FramePos]| acked[0].offset as usize - (GROUP_MARKER_LEN + FRAME_OVERHEAD);
    for (what, damaged_at, marker, rows) in [
        ("the first group damaged", first_acked[1].offset as usize + 60, marker_of(&first_acked), 0),
        ("the second group damaged", second_acked[1].offset as usize + 60, marker_of(&second_acked), 3),
    ] {
        let mut damaged = bytes.clone();
        damaged[damaged_at] ^= 0x01;
        std::fs::write(&path, &damaged).unwrap();
        let opened = env.reopen("s1").await;
        assert_eq!(opened.fold.rows, rows, "{what}");
        assert!(matches!(opened.status, LogStatus::Damaged(ref d) if d.offset == marker as u64), "{what}: {:?}", opened.status);
        // Open-for-append refuses a damaged log: nothing is truncated.
        let deps = env.deps();
        let refused = on_lane(move |l| LogWriter::open(l, opened, deps).err()).await;
        assert!(matches!(refused, Some(OpenAppendError::StoreDamaged(_))), "{what}");
        assert_eq!(std::fs::read(&path).unwrap(), damaged, "{what}: the file is as it was");
    }
    // The policy is the one a damaged single frame always had.
    let env = Env::new();
    let mut w = env.create("s2", None).await;
    for iid in ["a", "b"] {
        w = env.commit(w, vec![item(iid)]).await.0;
    }
    drop(w);
    let path = env.dir("s2").join(log_name(0));
    let mut bytes = std::fs::read(&path).unwrap();
    let scan = crate::framing::scan(&bytes, 0, 0, 0);
    bytes[scan.frames[1].start + 60] ^= 0x01;
    std::fs::write(&path, &bytes).unwrap();
    let opened = env.reopen("s2").await;
    assert!(matches!(opened.status, LogStatus::Damaged(ref d) if d.offset == scan.frames[1].start as u64), "{:?}", opened.status);
}

fn sized_item(iid: &str, kib: usize) -> Encoded {
    let body = "x".repeat(kib * 1024);
    rec(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":body,"role":"user"}}}))
}

/// The whole recovered state of an open: the state a checkpoint at its end would carry (FORMAT.md §6.2), however reached.
fn state_of(opened: &OpenedLog) -> serde_json::Value {
    serde_json::to_value(opened.fold.checkpoint_state()).expect("state")
}

fn first_ordinal(bytes: &[u8]) -> u64 {
    u64::from_str_radix(std::str::from_utf8(&bytes[..16]).unwrap(), 16).unwrap()
}

/// A payload the test wrote, as a reader hands its record on: what a read of it must return.
fn as_read(payload: &[u8]) -> serde_json::Value {
    serde_json::to_value(serde_json::from_slice::<crate::schema::record::Record>(payload).expect("a record")).expect("record")
}

/// Every record the log of `id` holds, whole and in order, as the projection rebuild reads them: forward from the
/// `session` frame through every file (`read_forward`, 1 MiB windows); and how the read ended.
fn recovered(env: &Env, id: &str) -> (Vec<serde_json::Value>, ForwardEnd) {
    let dir = env.dir(id);
    let mut pos = crate::schema::checkpoint::FramePos { ordinal: first_ordinal_unlaned(&dir).unwrap(), file_no: 0, offset: 0 };
    let mut records = Vec::new();
    loop {
        let read = read_forward_unlaned(&dir, pos, 1 << 20).unwrap();
        records.extend(read.frames.iter().map(|(record, _, _)| serde_json::to_value(record).expect("record")));
        match read.next {
            ForwardEnd::More(next) => pos = next,
            end => return (records, end),
        }
    }
}

/// Whether the reader o1 shipped (vendored, `framing_o1`) opens a newest file of these bytes: it anchors at the newest
/// `checkpoint`/`session` line its reverse scan finds, with none at the file's first frame, and opens only when the frame
/// it anchors at is a committed `checkpoint` or `session` record (o1 `log.rs`: `read_head`, `read_tail`).
fn o1_opens(bytes: &[u8]) -> bool {
    use crate::schema::record::Record;
    let first = std::str::from_utf8(bytes.get(..16).unwrap_or_default()).ok().and_then(|t| u64::from_str_radix(t, 16).ok()).unwrap_or(0);
    let anchor = crate::framing_o1::reverse_scan(bytes, true).unwrap_or(crate::framing_o1::Anchor { start: 0, ordinal: first });
    let scan = crate::framing_o1::scan(bytes, 0, anchor.start, anchor.ordinal);
    scan.frames
        .first()
        .is_some_and(|f| matches!(serde_json::from_slice::<Record>(f.payload(bytes)), Ok(Record::Checkpoint(_) | Record::Session(_))))
}

impl Env {
    async fn try_reopen(&self, id: &str) -> Result<OpenedLog, String> {
        let (dir, blobs, store) = (self.dir(id), BlobStore::new(&self.data), self.store.clone());
        on_lane(move |l| open_log(l, &dir, &blobs, &store as &dyn LineageIndex).map_err(|e| e.to_string())).await
    }
}

/// What an open and a forward read of a session hold.
#[derive(Debug, Clone, PartialEq)]
struct Seen {
    /// The open's whole state and its status; `None` when the log does not open.
    opened: Option<(serde_json::Value, LogStatus)>,
    /// Every record a forward read returns, and how it ended.
    rows: Vec<serde_json::Value>,
    read: ForwardEnd,
}

/// A session `s1` whose last file is a group file (FORMAT.md §1), `log.000002` after `log.000000`.
struct GroupFile {
    env: Env,
    path: PathBuf,
    bytes: Vec<u8>,
    /// Where the members start: the length of the head frame.
    head_len: usize,
    /// The head's ordinal: its checkpoint's.
    ordinal: u64,
    /// The `checkpoint` record payload the head carries.
    checkpoint: Vec<u8>,
    /// The session with the group file whole: every member.
    whole: Seen,
    /// The session with the group file damaged after its head: exactly what it held before the group.
    none: Seen,
}

impl GroupFile {
    /// Over the group file `bytes` at `path` of `env`'s `s1`, whose records before it are `rows_before` and whose member
    /// records are `members`. The layout is checked from the bytes; the two expected views are built from what the test
    /// wrote, the states from an open of the head alone (checked against the segment's own state) and of the file whole.
    async fn of(env: Env, path: PathBuf, bytes: Vec<u8>, rows_before: Vec<serde_json::Value>, members: Vec<serde_json::Value>) -> GroupFile {
        use crate::schema::frame::*;
        let ordinal = first_ordinal(&bytes);
        let head_len = crate::framing::check_header(&bytes[..HEADER_LEN], ordinal).unwrap().expect("a whole header") + FRAME_OVERHEAD;
        let head = crate::framing::check_frame(&bytes[..head_len], ordinal).expect("the head frame");
        assert!(head.starts_with(GROUP_FILE_HEAD) && head[GROUP_MARKER_LEN] == b' ', "the file starts with a group file head");
        let fields = std::str::from_utf8(&head[..GROUP_MARKER_LEN]).unwrap();
        let named = (u64::from_str_radix(&fields[7..15], 16).unwrap(), u64::from_str_radix(&fields[16..32], 16).unwrap());
        assert_eq!(named, (members.len() as u64, (bytes.len() - head_len) as u64), "the head names its members; nothing follows them");
        let checkpoint = head[GROUP_MARKER_LEN + 1..].to_vec();
        assert!(is_anchor_payload(&checkpoint), "the head carries the checkpoint of the state before the group");
        let scan = crate::framing::scan(&bytes, 0, 0, ordinal);
        assert_eq!(scan.end, ScanEnd::Clean);
        assert!(scan.frames.iter().all(|f| !is_anchor_payload(f.payload(&bytes))), "no frame of a group file is an anchor on its own");

        // Without the group file the segment before it is the newest file: the state before the group, but for the
        // head's own ordinal.
        std::fs::remove_file(&path).unwrap();
        let mut segment = state_of(&env.reopen("s1").await);
        segment["covers_ordinal"] = json!(ordinal + 1);
        let damage = Damage { file_no: 2, offset: 0, ordinal };
        std::fs::write(&path, &bytes[..head_len]).unwrap();
        let before = env.reopen("s1").await;
        assert_eq!((state_of(&before), before.status), (segment, LogStatus::Damaged(damage)), "the head alone: the group is missing");
        std::fs::write(&path, &bytes).unwrap();
        let after = env.reopen("s1").await;
        assert_eq!((after.status, after.fold.rows), (LogStatus::Clean, before.fold.rows + members.len() as u64));
        let mut rows_after = rows_before.clone();
        rows_after.push(as_read(&checkpoint));
        rows_after.extend(members);
        let whole = Seen {
            opened: Some((state_of(&after), LogStatus::Clean)),
            rows: rows_after,
            read: ForwardEnd::Done { file_no: 2, end: bytes.len() as u64, torn: false },
        };
        let none = Seen { opened: Some((state_of(&before), LogStatus::Damaged(damage))), rows: rows_before, read: ForwardEnd::Damaged(damage) };
        GroupFile { env, path, bytes, head_len, ordinal, checkpoint, whole, none }
    }

    /// The session with a group file that has no head: it does not open; a forward read stops at the file.
    fn no_anchor(&self) -> Seen {
        Seen { opened: None, ..self.none.clone() }
    }

    /// The session with the group file replaced by `file`.
    async fn seen_with(&self, file: &[u8]) -> Seen {
        std::fs::write(&self.path, file).unwrap();
        let opened = self.env.try_reopen("s1").await.ok().map(|o| (state_of(&o), o.status));
        let (rows, read) = recovered(&self.env, "s1");
        std::fs::write(&self.path, &self.bytes).unwrap();
        Seen { opened, rows, read }
    }
}

/// A session whose last write is a group file: one item, then `members` big items in one write.
async fn group_file_session(members: usize) -> GroupFile {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![item("x")]).await;
    let batch: Vec<Encoded> = (0..members).map(|i| big_item(&format!("i{i}"))).collect();
    let member_rows = batch.iter().map(|e| as_read(&e.payload)).collect();
    let (w, ack) = env.append(w, batch).await;
    let ack = ack.unwrap();
    assert!(ack.positions.iter().all(|p| p.file_no == 2), "a group over GROUP_IN_PLACE_MAX is a group file, after a gap");
    let acked: Vec<(u64, u64)> = ack.positions.iter().map(|p| (p.ordinal, p.offset)).collect();
    env.store.project(ack.projection).await.unwrap();
    drop(w);
    assert_eq!(list_logs(&env.dir("s1")).unwrap(), [0, 2]);
    let path = env.dir("s1").join(log_name(2));
    let bytes = std::fs::read(&path).unwrap();
    let rows_before = vec![as_read(&session("s1", None).payload), as_read(&item("x").payload)];
    let g = GroupFile::of(env, path, bytes, rows_before, member_rows).await;
    let scan = crate::framing::scan(&g.bytes, 0, 0, g.ordinal);
    assert_eq!(acked, scan.frames[1..].iter().map(|f| (f.ordinal, f.start as u64)).collect::<Vec<_>>(), "the acknowledged positions are the members' frames");
    g
}

/// A group file (FORMAT.md §3.6 invariant G) holds no anchor a reader could use without its group and is never
/// reverse-scanned, so a valid checkpoint line inside its members (stale or forged) is never used, wherever it lies
/// relative to the reverse-scan windows (inside the first, across its start, between them, across the second's start,
/// before it, before the lookback beyond it); and the file is used only whole. Whole, the session holds every member. Cut
/// anywhere after the head — right after it too, the whole group missing — or with a member damaged, it holds exactly
/// what it held before the group, record for record, and is damaged. With the head damaged the file has no anchor and the
/// log does not open. With a segment after the group file the open uses that segment's checkpoint (written once the group
/// file was durable); a damaged member then fails its positioned read and the forward read stops at the group file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_group_file_is_used_only_whole_wherever_a_stale_checkpoint_lies() {
    use crate::schema::frame::*;
    // Members past REVERSE_SCAN_MAX + GROUP_LOOKBACK: every window class lies inside them.
    let g = group_file_session(60).await;
    let head_len = g.head_len;
    let member = (head_len + g.bytes.len()) / 2;
    // A checkpoint line as a segment holds one: a frame of its own with the head's checkpoint record.
    let mut line = Vec::new();
    crate::framing::encode_into(&mut line, g.ordinal, &g.checkpoint);
    let l = line.len();
    let splice = |file: &mut Vec<u8>, q: usize| {
        file[q - 1] = b'\n';
        file[q..q + l].copy_from_slice(&line);
    };
    let w1 = MAX_FRAME_LEN + 1;
    let w2 = REVERSE_SCAN_MAX as usize + 1;
    let lookback = GROUP_LOOKBACK as usize;
    let classes = |size: usize| {
        [
            ("inside the first window", size - 1000 - l),
            ("across the first window's start", size - w1 - l / 2),
            ("between the windows", size - w1 - l - 10),
            ("across the second window's start", size - w2 - l / 2),
            ("before the second window", size - w2 - l - 10),
            ("before the lookback beyond it", size - w2 - lookback - l - 10),
        ]
    };
    assert_eq!(g.seen_with(&g.bytes).await, g.whole, "whole: every member");
    assert_eq!(g.seen_with(&g.bytes[..head_len]).await, g.none, "cut right after the head: the group is missing, not absent");
    let mut head_broken = g.bytes.clone();
    head_broken[CRC_AT] ^= 0x01;
    let mut member_damaged = g.bytes.clone();
    member_damaged[member] ^= 0x01;
    let mut both = head_broken.clone();
    both[member] ^= 0x01;
    let shapes: [(&str, Vec<u8>, Seen); 5] = [
        ("as written", g.bytes.clone(), g.none.clone()),
        ("cut inside the members", g.bytes[..g.bytes.len() - 5000].to_vec(), g.none.clone()),
        ("a member damaged", member_damaged.clone(), g.none.clone()),
        ("the head's checksum broken", head_broken, g.no_anchor()),
        ("the head's checksum broken and a member damaged", both, g.no_anchor()),
    ];
    for (shape, base, want) in &shapes {
        if *shape != "as written" {
            assert_eq!(&g.seen_with(base).await, want, "{shape}");
        }
        for (class, q) in classes(base.len()) {
            assert!(q > head_len, "{shape}, {class}: inside the members");
            let mut file = base.clone();
            splice(&mut file, q);
            assert_eq!(&g.seen_with(&file).await, want, "{shape}, a checkpoint line {class}");
        }
    }

    // What follows the group file: the next write starts a new segment with a checkpoint.
    let opened = g.env.reopen("s1").await;
    let deps = g.env.deps();
    let w = on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await;
    let (w, _) = g.env.commit(w, vec![item("next")]).await;
    drop(w);
    assert_eq!(list_logs(&g.env.dir("s1")).unwrap(), [0, 2, 3]);
    let next = state_of(&g.env.reopen("s1").await);
    let (rows, read) = recovered(&g.env, "s1");
    assert_eq!(rows[..g.whole.rows.len()], g.whole.rows[..], "the group's records, then the segment's");
    assert_eq!(rows.last(), Some(&as_read(&item("next").payload)));
    assert!(matches!(read, ForwardEnd::Done { file_no: 3, torn: false, .. }), "{read:?}");
    std::fs::write(&g.path, &member_damaged).unwrap();
    let opened = g.env.reopen("s1").await;
    assert_eq!((state_of(&opened), opened.status), (next, LogStatus::Clean), "the segment after it opens from its own checkpoint");
    assert_eq!(recovered(&g.env, "s1"), (g.none.rows.clone(), g.none.read), "a forward read stops at the damaged group file: nothing of it, nothing after it");
    let scan = crate::framing::scan(&g.bytes, 0, 0, g.ordinal);
    let damaged = scan.frames.iter().find(|f| f.start <= member && member < f.end()).copied().unwrap();
    let dir = g.env.dir("s1");
    let pos = crate::schema::checkpoint::FramePos { ordinal: damaged.ordinal, file_no: 2, offset: damaged.start as u64 };
    let read = on_lane(move |l| read_frame_at(l, &dir, pos)).await;
    assert!(read.is_err(), "a damaged member fails its positioned read");
}

/// Every byte of a group file (a small one: the reader decides the kind from the names, not the size): cut at every
/// offset, zero from every offset, one byte changed at every offset. Inside the head the file has no anchor and the log
/// does not open; anywhere after it — cut right after the head too, the whole group missing — the session holds exactly
/// what it held before the group and is damaged; only the whole file gives the group. The open's whole state and the
/// forward read's records (bodies, order) are compared each time: a member folded before the group failed its check is
/// in neither. The reader o1 shipped opens none of them, the whole file included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_byte_of_a_group_file_recovers_before_or_after_the_group() {
    use sha2::Digest;
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (mut w, _) = env.commit(w, vec![item("x")]).await;
    let log0 = env.dir("s1").join(log_name(0));
    let segment = std::fs::read(&log0).unwrap();
    let closed = on_lane(move |l| {
        let ack = w.close(l).unwrap();
        (w, ack)
    })
    .await;
    drop(closed.0);
    let with_cp = std::fs::read(&log0).unwrap();
    std::fs::write(&log0, &segment).unwrap();
    let cp_frame = &with_cp[segment.len()..];
    let cp_ordinal = first_ordinal(cp_frame);
    let checkpoint = crate::framing::check_frame(cp_frame, cp_ordinal).expect("the closing checkpoint").to_vec();
    let records = [item("a"), item("b"), item("c")];
    let mut members = Vec::new();
    for (i, e) in records.iter().enumerate() {
        crate::framing::encode_into(&mut members, cp_ordinal + 1 + i as u64, &e.payload);
    }
    let digest: String = sha2::Sha256::digest(&members).iter().map(|b| format!("{b:02x}")).collect();
    let mut head = format!("#gfile {:08x} {:016x} {digest} ", records.len(), members.len()).into_bytes();
    head.extend_from_slice(&checkpoint);
    let mut bytes = Vec::new();
    crate::framing::encode_into(&mut bytes, cp_ordinal, &head);
    bytes.extend_from_slice(&members);
    let path = env.dir("s1").join(log_name(2));
    std::fs::write(&path, &bytes).unwrap();
    let rows_before = vec![as_read(&session("s1", None).payload), as_read(&item("x").payload)];
    let g = GroupFile::of(env, path, bytes, rows_before, records.iter().map(|e| as_read(&e.payload)).collect()).await;
    let len = g.bytes.len();
    let want = |k: usize| if k < g.head_len { g.no_anchor() } else { g.none.clone() };
    for k in 0..=len {
        let mut zeroed = g.bytes.clone();
        zeroed[k..].fill(0);
        for (what, file) in [("cut at", &g.bytes[..k]), ("zero from", &zeroed[..])] {
            let want = if k == len { g.whole.clone() } else { want(k) };
            assert_eq!(g.seen_with(file).await, want, "{what} {k}");
            assert!(!o1_opens(file), "{what} {k}: the old reader opens no group file");
        }
    }
    for k in 0..len {
        let mut changed = g.bytes.clone();
        changed[k] ^= 0x01;
        assert_eq!(g.seen_with(&changed).await, want(k), "byte {k} changed");
        assert!(!o1_opens(&changed), "byte {k} changed: the old reader opens no group file");
    }
}

/// The kind of a file is its name's (FORMAT.md §1): a number after a gap is a group file. No writer path leaves a gap
/// before a segment; a segment found after one (a file removed from outside) is not read as a segment and not taken for
/// a group: the log does not open and a forward read returns nothing of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_segment_after_a_gap_is_damage_not_a_group() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (mut w, _) = env.commit(w, vec![item("x")]).await;
    let log0 = env.dir("s1").join(log_name(0));
    let segment = std::fs::read(&log0).unwrap();
    let closed = on_lane(move |l| {
        let ack = w.close(l).unwrap();
        (w, ack)
    })
    .await;
    drop(closed.0);
    let with_cp = std::fs::read(&log0).unwrap();
    std::fs::write(&log0, &segment).unwrap();
    // A well-formed segment (a checkpoint, then a record) under the number after a gap.
    let mut rotated = with_cp[segment.len()..].to_vec();
    let ordinal = first_ordinal(&rotated);
    crate::framing::encode_into(&mut rotated, ordinal + 1, &item("y").payload);
    assert!(o1_opens(&rotated), "a segment by its bytes");
    std::fs::write(env.dir("s1").join(log_name(2)), &rotated).unwrap();
    assert!(env.try_reopen("s1").await.is_err(), "no group file head: no anchor");
    let rows_before = vec![as_read(&session("s1", None).payload), as_read(&item("x").payload)];
    assert_eq!(recovered(&env, "s1"), (rows_before, ForwardEnd::Damaged(Damage { file_no: 2, offset: 0, ordinal })));
}

/// `session.repair` of a damaged group file (FORMAT.md §3.4, §3.6) moves the file whole to quarantine, wherever in it
/// the damage is: the session then opens clean with exactly what it held before the group, and its next write goes on
/// from the segment.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repairing_a_damaged_group_file_moves_it_whole() {
    let g = group_file_session(11).await;
    let mut damaged = g.bytes.clone();
    damaged[(g.head_len + g.bytes.len()) / 2] ^= 0x01;
    std::fs::write(&g.path, &damaged).unwrap();
    let opened = g.env.reopen("s1").await;
    let LogStatus::Damaged(damage) = opened.status else { panic!("{:?}", opened.status) };
    let data = g.env.data.clone();
    let quarantine = on_lane(move |l| repair_damage(l, &data, "s1", damage).unwrap()).await;
    assert_eq!(std::fs::read(quarantine.join(log_name(2))).unwrap(), damaged, "the whole file, as it was");
    assert_eq!(list_logs(&g.env.dir("s1")).unwrap(), [0]);
    let opened = g.env.reopen("s1").await;
    // The state before the group, without the head's own ordinal.
    let mut before = g.none.opened.clone().expect("opened").0;
    before["covers_ordinal"] = json!(g.ordinal);
    assert_eq!((state_of(&opened), opened.status), (before, LogStatus::Clean));
    let (rows, read) = recovered(&g.env, "s1");
    assert_eq!(rows, g.none.rows);
    assert!(matches!(read, ForwardEnd::Done { file_no: 0, torn: false, .. }), "{read:?}");
    let deps = g.env.deps();
    let w = on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await;
    let (w, ordinals) = g.env.commit(w, vec![item("next")]).await;
    drop(w);
    assert_eq!((ordinals, list_logs(&g.env.dir("s1")).unwrap()), (vec![g.ordinal], vec![0]));
}

/// A place damaged again after its repair is repaired into a folder of its own (FORMAT.md §3.4): the next group file takes
/// the number the moved one had, so its damage is reported at the same place; the first repair's file and reason stay
/// byte for byte what they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_repair_of_the_same_place_keeps_the_first_repairs_evidence() {
    let reason = crate::schema::migration::REASON_FILE;
    let g = group_file_session(11).await;
    let at = (g.head_len + g.bytes.len()) / 2;
    let mut first = g.bytes.clone();
    first[at] ^= 0x01;
    std::fs::write(&g.path, &first).unwrap();
    let opened = g.env.reopen("s1").await;
    let LogStatus::Damaged(damage) = opened.status else { panic!("{:?}", opened.status) };
    let place = (damage.file_no, damage.offset);
    let data = g.env.data.clone();
    let first_dir = on_lane(move |l| repair_damage(l, &data, "s1", damage).unwrap()).await;
    let first_reason = std::fs::read(first_dir.join(reason)).unwrap();

    let opened = g.env.reopen("s1").await;
    let deps = g.env.deps();
    let w = on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await;
    let batch: Vec<Encoded> = (0..11).map(|i| big_item(&format!("i{i}"))).collect();
    let (w, ack) = g.env.append(w, batch).await;
    g.env.store.project(ack.unwrap().projection).await.unwrap();
    drop(w);
    assert_eq!(list_logs(&g.env.dir("s1")).unwrap(), [0, 2], "the next group file takes the moved file's number");
    let mut second = std::fs::read(&g.path).unwrap();
    second[at] ^= 0x02;
    assert_ne!(second, first, "the two damaged files differ");
    std::fs::write(&g.path, &second).unwrap();
    let opened = g.env.reopen("s1").await;
    let LogStatus::Damaged(damage) = opened.status else { panic!("{:?}", opened.status) };
    assert_eq!((damage.file_no, damage.offset), place, "the same place is damaged again");
    let data = g.env.data.clone();
    let second_dir = on_lane(move |l| repair_damage(l, &data, "s1", damage).unwrap()).await;

    assert_ne!(second_dir, first_dir, "a folder of its own");
    assert_eq!(std::fs::read(first_dir.join(log_name(2))).unwrap(), first, "the first repair's file, as it was");
    assert_eq!(std::fs::read(first_dir.join(reason)).unwrap(), first_reason, "the first repair's reason, as it was");
    assert_eq!(std::fs::read(second_dir.join(log_name(2))).unwrap(), second, "the second repair's file");
    assert_eq!(list_logs(&g.env.dir("s1")).unwrap(), [0]);
}

/// Open cost (FORMAT.md §6.3): a log ending in a group file reads it once (in chunks); the next write starts a new
/// segment, also after the writer was reopened, so the open after a small tail reads the window and lookback only; a long
/// file of small writes reads the window only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_open_reads_the_last_group_once_and_otherwise_the_window() {
    use crate::schema::frame::*;
    let g = group_file_session(30).await;
    let group = (g.bytes.len() - g.head_len) as u64;
    let window = MAX_FRAME_LEN as u64 + 1 + GROUP_LOOKBACK + 4096;
    let opened = g.env.reopen("s1").await;
    assert_eq!((opened.status, opened.fold.rows), (LogStatus::Clean, 31));
    assert!(opened.bytes_read >= group && opened.bytes_read <= g.bytes.len() as u64 + 4096, "the group once: {} of {}", opened.bytes_read, g.bytes.len());

    // A small tail through a reopened writer: a new segment, the window only.
    let deps = g.env.deps();
    let w = on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await;
    let (w, _) = g.env.commit(w, vec![item("next")]).await;
    drop(w);
    let opened = g.env.reopen("s1").await;
    assert_eq!((opened.status, opened.fold.rows, opened.newest_file_no), (LogStatus::Clean, 32, 3));
    assert!(opened.bytes_read <= window && opened.bytes_read < group, "{}", opened.bytes_read);

    // A long file of small writes.
    let env = Env::new();
    let mut w = env.create("s2", None).await;
    for n in 0..50 {
        w = env.commit(w, (0..3).map(|i| sized_item(&format!("i{n}.{i}"), 100)).collect()).await.0;
    }
    drop(w);
    let size = std::fs::metadata(env.dir("s2").join(log_name(0))).unwrap().len();
    let opened = env.reopen("s2").await;
    assert_eq!((opened.status, opened.fold.rows), (LogStatus::Clean, 150));
    assert!(size > REVERSE_SCAN_MAX + window, "{size}");
    assert!(opened.bytes_read <= REVERSE_SCAN_MAX + window, "{} of {size}", opened.bytes_read);
}

/// The reader o1 shipped (vendored, `framing_o1`) over EVERY file of logs with groups in every position — in-place groups,
/// a group file, the segment after it — never misreads them and truncates nothing. A segment it opens from its newest
/// anchor: up to its first group marker it returns what this reader returns; there it stops with damage (the first member
/// fails its ordinal; damage, not a torn tail) and the marker is no record to its record layer; a member read by position
/// reads the same. A group file it does not open at all: no line of it is an anchor and its first frame is no record.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_reader_never_misreads_a_log_with_groups() {
    use crate::schema::frame::*;
    let big = |n: usize| (0..n).map(|i| big_item(&format!("p{i}"))).collect::<Vec<_>>();
    let layouts: Vec<(&str, Vec<Vec<Encoded>>, &[u32])> = vec![
        ("a group first", vec![vec![item("a"), item("b")]], &[0]),
        ("a group between single records", vec![vec![item("a")], vec![item("b"), item("c"), item("d")], vec![item("e")]], &[0]),
        ("two groups back to back", vec![vec![item("a"), item("b")], vec![item("c"), item("d")]], &[0]),
        ("a group, a large in-place group with a leading checkpoint, a group", vec![vec![item("a"), item("b")], big(6), vec![item("c"), item("d")], vec![item("e"), item("f")]], &[0]),
        ("a group file last", vec![vec![item("a")], big(11)], &[0, 2]),
        ("a group file, then a segment with an in-place group", vec![vec![item("a")], big(11), vec![item("c"), item("d")], vec![item("e")]], &[0, 2, 3]),
        ("two group files back to back", vec![big(11), big(11)], &[0, 2, 4]),
    ];
    for (layout, writes, want_files) in layouts {
        let env = Env::new();
        let mut w = env.create("s1", None).await;
        for batch in writes {
            w = env.commit(w, batch).await.0;
        }
        drop(w);
        let files = list_logs(&env.dir("s1")).unwrap();
        assert_eq!(files, want_files, "{layout}");
        let mut met = 0;
        for &file_no in &files {
            let path = env.dir("s1").join(log_name(file_no));
            let bytes = std::fs::read(&path).unwrap();
            let group_file = is_group_file(&files, file_no);
            let what = format!("{layout}, log {file_no}{}", if group_file { " (group file)" } else { "" });
            let first = first_ordinal(&bytes);
            let new = crate::framing::scan(&bytes, 0, 0, first);
            assert_eq!(new.end, ScanEnd::Clean, "{what}");
            if group_file {
                assert_eq!(crate::framing_o1::reverse_scan(&bytes, true), None, "{what}: no line of it is an anchor");
                assert!(!o1_opens(&bytes), "{what}: the old reader does not open it");
                met += 1;
            } else {
                assert!(o1_opens(&bytes), "{what}: a segment opens from its newest anchor");
                let anchors = [Some(crate::framing_o1::Anchor { start: 0, ordinal: first }), crate::framing_o1::reverse_scan(&bytes, true)];
                for anchor in anchors.into_iter().flatten() {
                    let old = crate::framing_o1::scan(&bytes, 0, anchor.start, anchor.ordinal);
                    let new_from: Vec<(u64, usize)> = new.frames.iter().filter(|f| f.start >= anchor.start).map(|f| (f.ordinal, f.start)).collect();
                    let old_frames: Vec<(u64, usize)> = old.frames.iter().map(|f| (f.ordinal, f.start)).collect();
                    match old.frames.iter().position(|f| f.payload(&bytes).starts_with(GROUP_MARKER)) {
                        None => assert_eq!((old_frames, &old.end), (new_from, &ScanEnd::Clean), "{what} from {anchor:?}"),
                        Some(at) => {
                            met += 1;
                            assert_eq!(at, old.frames.len() - 1, "{what}: the old reader stops at its first marker");
                            assert_eq!(old_frames[..at], new_from[..at], "{what}: the same frames before it");
                            assert!(matches!(old.end, ScanEnd::Corrupt { cause: CorruptCause::Ordinal, .. }), "{what}: damage, nothing to truncate: {:?}", old.end);
                            assert!(serde_json::from_slice::<crate::schema::record::Record>(old.frames[at].payload(&bytes)).is_err(), "{what}: the marker is no record");
                        }
                    }
                }
            }
            for frame in &new.frames {
                let line = &bytes[frame.start..frame.end()];
                assert_eq!(crate::framing_o1::check_frame(line, frame.ordinal).ok(), crate::framing::check_frame(line, frame.ordinal).ok(), "{what}: a positioned read");
            }
        }
        assert!(met > 0, "{layout}: the old reader met a group");
    }
}

#[test]
fn the_codec_moves_large_bodies_to_blobs_and_refs_them() {
    let small = crate::encode::encode_record(item("a").record().clone()).unwrap();
    assert!(small.blobs().is_empty());
    // Above INLINE_MAX (256 KiB): the size rule moves the body out of line.
    let mut over = big_item("b").record().clone();
    if let crate::schema::record::Record::Item(r) = &mut over {
        r.body = crate::schema::blob::Slot::Inline(json!({"content": "x".repeat(300 << 10)}));
    }
    let big = crate::encode::encode_record(over).unwrap();
    let Some(blob) = big.blobs().first() else { panic!("no blob") };
    let crate::schema::record::Record::Item(r) = big.record() else { panic!() };
    assert!(matches!(r.body, crate::schema::blob::Slot::Blob(_)));
    assert_eq!(r.refs.as_slice(), std::slice::from_ref(&blob.digest));
    let mut huge = big_item("c").record().clone();
    if let crate::schema::record::Record::Item(r) = &mut huge {
        r.body = crate::schema::blob::Slot::Inline(json!({"content": "x".repeat(mixdog_protocol::MAX_BLOB_BYTES as usize)}));
    }
    assert!(matches!(crate::encode::encode_record(huge), Err(crate::encode::EncodeError::ItemTooLarge { .. })));
}

/// A prompt over what the inline body leaves of `INLINE_MAX` moves to a blob of its own,
/// listed in `refs`; the log and the index give back the text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_prompt_moves_to_a_blob_and_round_trips() {
    use crate::schema::blob::Slot;
    use crate::schema::record::Record;
    let with_prompt = |body: usize, prompt: &str| {
        let Record::Item(mut r) = user("u1", "x").record().clone() else { panic!() };
        r.body = Slot::Inline(json!({"content": "b".repeat(body), "role": "user"}));
        r.prompt = Some(Slot::Inline(prompt.to_owned()));
        crate::encode::encode_record(Record::Item(r)).unwrap()
    };
    // Each fits INLINE_MAX alone, together they do not: the prompt moves.
    let shared = with_prompt(200 << 10, &"q".repeat(100 << 10));
    let Record::Item(r) = shared.record() else { panic!() };
    assert!(matches!((&r.body, &r.prompt), (Slot::Inline(_), Some(Slot::Blob(_)))));
    assert!(shared.payload().len() <= crate::schema::frame::MAX_FRAME_PAYLOAD);

    let env = Env::new();
    let text = format!("ask {}", "p".repeat(300 << 10));
    let encoded = with_prompt(10, &text);
    let Record::Item(r) = encoded.record() else { panic!() };
    let Some(Slot::Blob(blob)) = &r.prompt else { panic!("inline prompt") };
    let digest = blob.descriptor().digest.clone();
    assert_eq!(r.refs.as_slice(), std::slice::from_ref(&digest));
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![encoded]).await;
    drop(w);
    assert_eq!(prompts(&env, "s1").await, vec![text.clone()]);

    let dir = env.dir("s1");
    let first = first_ordinal_unlaned(&dir).unwrap();
    let start = crate::schema::checkpoint::FramePos { ordinal: first, file_no: 0, offset: 0 };
    let read = read_forward_unlaned(&dir, start, 1 << 20).unwrap();
    let logged = read.frames.iter().find_map(|(record, ..)| match record {
        Record::Item(item) => item.prompt.clone(),
        _ => None,
    });
    let Some(Slot::Blob(logged)) = logged else { panic!("logged prompt") };
    let bytes = BlobStore::new(&env.data).read_unlaned(&logged.descriptor().digest).unwrap();
    assert_eq!(serde_json::from_slice::<String>(&bytes).unwrap(), text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migration_projection_matches_the_logs() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (base, _) = env.commit(base, vec![item("b1"), item("b2"), rewind, item("b3")]).await;
    drop(base);
    let child = env.create("c0", Some(("b0", 3))).await;
    let (child, _) = env.commit(child, vec![big_item("c1")]).await;
    drop(child);
    let db = env.data.join("migrated.sqlite");
    let ids = vec!["b0".to_owned(), "c0".to_owned()];
    project_index(&env.data, &db, &ids).unwrap();
    assert!(!env.data.join("migrated.sqlite-wal").exists());
    let conn = rusqlite::Connection::open(&db).unwrap();
    for (id, rows) in [("b0", 2), ("c0", 1)] {
        let (count, offset, dirty): (i64, i64, i64) = conn
            .query_row("SELECT row_count, projected_offset, dirty FROM sessions WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        let size = std::fs::metadata(env.dir(id).join(log_name(0))).unwrap().len() as i64;
        assert_eq!((count, offset, dirty), (rows, size, 0), "{id}");
    }
    let live: i64 = conn
        .query_row("SELECT count(*) FROM history WHERE session = 'b0' AND superseded_rev IS NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(live, 2);
}

#[test]
fn prompt_keys_match_the_vectors() {
    let doc: serde_json::Value = serde_json::from_str(include_str!("schema/vectors/prompts.json")).unwrap();
    for case in doc["keys"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        assert_eq!(crate::title::prompt_history_key(text), case["key"].as_str().unwrap(), "{text:?}");
    }
}

fn user(iid: &str, text: &str) -> Encoded {
    rec(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"prompt":{"inline":text},
        "refs":[],"body":{"inline":{"content":text,"role":"user"}}}))
}

fn answer(iid: &str) -> Encoded {
    rec(json!({"k":"item","iid":iid,"role":"assistant","form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":{"content":iid,"role":"assistant"}}}))
}

async fn prompts(env: &Env, session: &str) -> Vec<String> {
    lineage_prompts(env, lineage(&[(session, None)]), None).await
}

async fn lineage_prompts(env: &Env, levels: Vec<LineageLevel>, cut: Option<u64>) -> Vec<String> {
    let store = env.store.clone();
    tokens()
        .interactive_io
        .submit(&CancellationToken::new(), move |l| store.prompts_on_lane(l, &levels, cut).unwrap())
        .unwrap()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_history_is_deduped_newest_first_and_follows_rewinds() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, ords) = env
        .commit(w, vec![user("u1", "first"), user("u2", " second  prompt "), answer("a"), user("u3", "first\n")])
        .await;
    assert_eq!(prompts(&env, "s1").await, ["first", "second  prompt"]);
    // Rewinding past the newest "first" falls back to its older occurrence.
    let rewind = rec(json!({"k":"rewind","to_ordinal":ords[3],"reason":"edit"}));
    let (w, _) = env.commit(w, vec![rewind]).await;
    assert_eq!(prompts(&env, "s1").await, ["second  prompt", "first"]);
    let clear = rec(json!({"k":"rewind","to_ordinal":1,"reason":"clear"}));
    let (w, _) = env.commit(w, vec![clear]).await;
    assert!(prompts(&env, "s1").await.is_empty());
    // At most 50, the newest.
    let batch = (0..60).map(|i| user(&format!("p{i}"), &format!("prompt {i}"))).collect();
    let (_w, _) = env.commit(w, batch).await;
    let list = prompts(&env, "s1").await;
    assert_eq!((list.len(), list[0].as_str(), list[49].as_str()), (50, "prompt 59", "prompt 10"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_prompts_continue_with_the_base_below_the_cut() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    // Ordinals 1..=4; the fork continues after 3.
    let (base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three"), user("b4", "four")]).await;
    // A later rewind in the base does not reach the fork.
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (_base, _) = env.commit(base, vec![rewind]).await;
    let child = env.create("c0", Some(("b0", 4))).await;
    let (child, _) = env.commit(child, vec![user("c1", "two"), user("c2", "own")]).await;
    let levels = lineage(&[("c0", None), ("b0", Some(4))]);
    assert_eq!(lineage_prompts(&env, levels.clone(), None).await, ["own", "two", "three", "one"]);
    // Rewound into the base: only base prompts below the cut remain.
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}));
    let (child, _) = env.commit(child, vec![rewind]).await;
    assert_eq!(lineage_prompts(&env, levels, child.fold().base_cut).await, ["one"]);
}

#[test]
fn every_interactive_query_is_index_backed() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("i.sqlite")).unwrap();
    conn.execute_batch(crate::schema::sql::INDEX_DDL).unwrap();
    let plan = |sql: &str| -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let n = stmt.parameter_count();
        let args: Vec<rusqlite::types::Value> = (0..n).map(|_| rusqlite::types::Value::Integer(1)).collect();
        stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let check = |name: &str, sql: &str, allow_sort: bool| {
        let steps = plan(sql);
        for s in &steps {
            let scan = s.starts_with("SCAN") && !s.contains("VIRTUAL TABLE");
            let sort = s.contains("TEMP B-TREE");
            assert!(!scan && (allow_sort || !sort), "{name}: {steps:?}");
        }
    };
    for (query, trigram) in [("", false), ("ab", false), ("spec", true)] {
        let (sql, _, _) = crate::sqlite::search_statement(query, 50);
        check(&format!("search {query:?}"), &sql, trigram);
    }
    check("page", crate::sqlite::PAGE_SQL, false);
    check("live rows", crate::sqlite::LIVE_ROWS_SQL, false);
    check("previous compaction", crate::sqlite::LIVE_COMPACTION_SQL, false);
    check("projected", crate::sqlite::PROJECTED_SQL, false);
    check("blob ref", crate::sqlite::BLOB_REF_SQL, false);
    check("thread op", crate::sqlite::THREAD_OP_SQL, false);
    check("prompt history", crate::sqlite::PROMPTS_SQL, false);
    check("base prompts", crate::sqlite::BASE_PROMPTS_SQL, false);
    check("prompt refresh", crate::sqlite::PROMPT_NEWEST_SQL, false);
    check("context start", crate::context::CONTEXT_START_SQL, false);
    check("context base start", crate::context::CONTEXT_BASE_START_SQL, false);
    check("context rows", crate::context::CONTEXT_LIVE_SQL, false);
    check("context base rows", crate::context::CONTEXT_BASE_SQL, false);
    check("context base row", crate::context::CONTEXT_BASE_ROW_SQL, false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_fault_rolls_back_and_is_not_applied() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let path = env.dir("s1").join(log_name(0));
    let len = std::fs::metadata(&path).unwrap().len();
    env.io.0.lock().unwrap().write = 1;
    let (w, r) = env.append(w, vec![item("a")]).await;
    assert!(matches!(r, Err(AppendError::BarrierFailed(_))));
    assert_eq!(*w.state(), WriterState::Clean { end: len });
    let (_w, ords) = env.commit(w, vec![item("a")]).await;
    assert_eq!(ords, vec![1]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_fault_is_indeterminate_until_rollback_succeeds() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let path = env.dir("s1").join(log_name(0));
    let len = std::fs::metadata(&path).unwrap().len();
    // A reader holds the file open across the rollback's truncate (Windows sharing).
    let _reader = std::fs::File::open(&path).unwrap();
    {
        let mut f = env.io.0.lock().unwrap();
        f.sync = 1;
        f.truncate = 2;
    }
    let (w, r) = env.append(w, vec![item("a")]).await;
    assert!(matches!(r, Err(AppendError::Indeterminate(_))));
    assert_eq!(r.as_ref().unwrap_err().outcome(), Outcome::Unknown);
    assert!(matches!(w.state(), WriterState::PendingRollback { target, second: true, .. } if *target == len));
    let (w, r) = env.append(w, vec![item("b")]).await;
    assert!(matches!(r, Err(AppendError::Refused(_))));
    let (w, ords) = env.commit(w, vec![item("b")]).await;
    assert_eq!(ords, vec![1]);
    drop(w);
    let opened = env.reopen("s1").await;
    assert_eq!((opened.status, opened.fold.rows), (LogStatus::Clean, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn torn_tail_is_truncated_at_open_for_append() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![item("a")]).await;
    drop(w);
    let path = env.dir("s1").join(log_name(0));
    let good = std::fs::metadata(&path).unwrap().len();
    let mut bytes = std::fs::read(&path).unwrap();
    // A frame cut short by a crash: its declared length runs past end of file.
    let mut frame = Vec::new();
    crate::framing::encode_into(&mut frame, 2, &item("b").payload);
    bytes.extend_from_slice(&frame[..frame.len() / 2]);
    std::fs::write(&path, &bytes).unwrap();
    let opened = env.reopen("s1").await;
    assert_eq!(opened.status, LogStatus::Torn { offset: good });
    let deps = env.deps();
    let w = on_lane(move |l| LogWriter::open(l, opened, deps).unwrap()).await;
    assert_eq!(*w.state(), WriterState::Clean { end: good });
    assert_eq!(std::fs::metadata(&path).unwrap().len(), good);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_projection_spans_bounded_transactions() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let batch: Vec<Encoded> = (0..(APPEND_ROWS * 3)).map(|i| item(&format!("i{i}"))).collect();
    let (_w, ords) = env.commit(w, batch).await;
    let n = ords.len() as u64;
    assert_eq!(env.store.live_rows("s1", 0, n + 1).unwrap(), (n, n));
    assert_eq!(env.store.projected("s1").await.unwrap().unwrap().ordinal, n + 1);
}

/// A process that ends right after a barrier is acked never projects it (the projection runs
/// behind the ack): the next open projects every acked frame of a session still marked dirty,
/// so the rows a crash interrupted (a prompt whose turn never ran) are read again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn boot_projects_the_frames_a_crash_left_unprojected() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![item("a")]).await;
    // Acked on disk, its projection lost with the process.
    let (_w, acked) = env.append(w, vec![item("b"), item("c")]).await;
    let end = acked.unwrap().positions.last().unwrap().ordinal + 1;
    let (rows, _) = env.store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["a"]);
    let reopened = open_index(&env.data).unwrap();
    let (rows, _) = reopened.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["c", "b", "a"]);
    assert_eq!(reopened.projected("s1").await.unwrap().unwrap().ordinal, end);
    // A session whose index holds its whole log is left as it is.
    let again = open_index(&env.data).unwrap();
    let (rows, _) = again.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap();
    assert_eq!(iids(&rows), ["c", "b", "a"]);
}

/// Every column of every `sessions` row of the index under `data`, in id order.
fn session_rows(data: &Path) -> Vec<Vec<rusqlite::types::Value>> {
    let conn = rusqlite::Connection::open(data.join(INDEX_FILE)).unwrap();
    let mut stmt = conn.prepare("SELECT * FROM sessions ORDER BY id").unwrap();
    let width = stmt.column_count();
    stmt.query_map([], |r| (0..width).map(|i| r.get(i)).collect()).unwrap().collect::<Result<_, _>>().unwrap()
}

/// A process that ends after the boot reconcile projected a crash-cut tail but before it wrote
/// the session's row leaves the cursor at the log's end and the row stale: the next boot
/// still reconciles the session, and its row is the one a rebuild from the log writes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_boot_ended_between_the_projection_and_the_row_reconciles_again() {
    let env = Env::new();
    // A header with its own `updatedAt`: the row does not take the clock of its write.
    let header = json!({"k":"session","v":2,"id":"s1","log_id":LOG_ID,"header":{"inline":{"title":"t","updatedAt":5}}});
    let w = env.create_from("s1", rec(header)).await;
    let (w, _) = env.commit(w, vec![item("a")]).await;
    let (_w, acked) = env.append(w, vec![item("b"), item("c")]).await;
    let end = acked.unwrap().positions.last().unwrap().ordinal + 1;
    crate::sqlite::reconcile_seam::arm(&env.data);
    let ended = open_index(&env.data).unwrap();
    let outcome = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), ended.reconciled())
        .await
        .expect("the reconcile the seam ended answered within 60 s");
    assert!(matches!(outcome, Err(DbError::Stopped)));
    drop(ended);
    let reopened = open_index(&env.data).unwrap();
    let projected = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), reopened.projected("s1"))
        .await
        .expect("the reconciled cursor answered within 60 s");
    assert_eq!(projected.unwrap().unwrap().ordinal, end);
    drop(reopened);
    let rebuilt = tempfile::tempdir().unwrap();
    copy_tree(&env.dir("s1"), &rebuilt.path().join("sessions").join("s1"));
    drop(open_index(rebuilt.path()).unwrap());
    assert_eq!(session_rows(&env.data), session_rows(rebuilt.path()));
}

/// A reconcile that fails to write the index fails every way into it with its reason: a read,
/// a write, a read from inside a read-lane job and the wait for the reconcile itself. None
/// answers from the index the crash left.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reconcile_fails_every_access() {
    let step = Arc::new(std::sync::Mutex::new("its start"));
    let reached = step.clone();
    let at = move |name: &'static str| *step.lock().unwrap() = name;
    let body = async move {
        let env = Env::new();
        at("its setup");
        let w = env.create("s1", None).await;
        let (w, _) = env.commit(w, vec![item("a")]).await;
        let (_w, acked) = env.append(w, vec![item("b")]).await;
        acked.unwrap();
        crate::sqlite::reconcile_seam::fail(&env.data);
        let failed = open_index(&env.data).unwrap();
        let why = "s1: the test seam failed the index write";
        at("the read");
        let read = failed.history_page(lineage(&[("s1", None)]), None, None, 10).await;
        assert!(matches!(&read, Err(DbError::Write(w)) if w == why), "{read:?}");
        at("the write");
        let write = failed.mark_dirty("s1").await;
        assert!(matches!(&write, Err(DbError::Write(w)) if w == why), "{write:?}");
        let laned = failed.clone();
        at("the lane read");
        let on_lane = tokens()
            .interactive_io
            .submit(&CancellationToken::new(), move |lane| laned.history_page_on_lane(lane, &lineage(&[("s1", None)]), None, None, 10).map(drop))
            .expect("lane");
        let on_lane = on_lane.await.expect("job ran");
        assert!(matches!(&on_lane, Err(DbError::Write(w)) if w == why), "{on_lane:?}");
        at("the reconcile's outcome");
        let settled = failed.reconciled().await;
        assert!(matches!(&settled, Err(DbError::Write(w)) if w == why), "{settled:?}");
    };
    // The whole body under one real-time deadline (a thread's, so it fires on a paused clock too), naming the step reached.
    let (done, waiting) = std::sync::mpsc::channel::<()>();
    let (expire, expired) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        if waiting.recv_timeout(std::time::Duration::from_secs(60)) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            expire.send(()).ok();
        }
    });
    tokio::select! {
        biased;
        () = body => drop(done),
        _ = expired => panic!("a_failed_reconcile_fails_every_access, at {}: not within 60 s", reached.lock().unwrap()),
    }
}

/// On the production lanes (not the inline test backend): the open returns while the
/// reconcile of a crash-cut session still waits to start, and every way into the index waits
/// for it (a read, a write, and a read from inside a read-lane job, which the open's callers
/// make while the store is fresh), then sees the rows it projected. Each access is seen
/// waiting at the gate before the test releases the reconcile, and answers only after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_store_opens_before_its_reconcile_and_reads_wait_for_it() {
    const BOUND: std::time::Duration = std::time::Duration::from_secs(60);
    let (_exec, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("production lanes");
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_path_buf();
    let open = |data: PathBuf| {
        let job = tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &data)
        });
        async move { job.expect("lane").await.expect("job ran") }
    };
    let durable = |f: Box<dyn FnOnce(&InLane<DurabilityIo>) + Send>| {
        let job = tokens.durability_io.submit(&CancellationToken::new(), move |lane| f(lane));
        async move { job.expect("lane").await.expect("job ran") }
    };
    let store = open(data.clone()).await.unwrap();
    store.upsert(head("s1", "task", "Title"), DirtyMark::Set).await.unwrap();
    let deps = WriterDeps {
        io: Arc::new(OsIo),
        blobs: BlobStore::new(&data),
        ownership: Arc::new(MockOwnership::default()),
        index: Arc::new(store.clone()),
    };
    let (dir, (tx, rx)) = (data.join("sessions").join("s1"), std::sync::mpsc::channel());
    durable(Box::new(move |lane| {
        let (mut w, created) = LogWriter::create(lane, &dir, session("s1", None), deps).unwrap();
        let first = w.append_barrier(lane, vec![item("a")]).unwrap();
        // Acked on disk, never projected: the process ended.
        w.append_barrier(lane, vec![item("b"), item("c")]).unwrap();
        tx.send((created.projection, first.projection)).unwrap();
    }))
    .await;
    let (created, first) = rx.recv().unwrap();
    store.project(created).await.unwrap();
    store.project(first).await.unwrap();
    drop(store);
    let release = crate::sqlite::reconcile_seam::hold(&data);
    let reopened = mixdog_rt::time::timeout(BOUND, open(data.clone()))
        .await
        .expect("the open returned within 60 s while its reconcile was held")
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::<&str>::new()));
    let note = |event: &'static str| {
        let events = events.clone();
        move || events.lock().unwrap().push(event)
    };
    let (reader, writer, laned) = (reopened.clone(), reopened.clone(), reopened.clone());
    let read = tokio::spawn({
        let noted = note("read");
        async move {
            let page = reader.history_page(lineage(&[("s1", None)]), None, None, 10).await;
            noted();
            page
        }
    });
    let write = tokio::spawn({
        let noted = note("write");
        async move {
            let written = writer.mark_dirty("s1").await;
            noted();
            written
        }
    });
    let on_lane = tokens
        .interactive_io
        .submit(&CancellationToken::new(), {
            let noted = note("read on the lane");
            move |lane| {
                let page = laned.history_page_on_lane(lane, &lineage(&[("s1", None)]), None, None, 10);
                noted();
                page
            }
        })
        .expect("lane");
    let mut waiters = reopened.reconcile_waiters();
    mixdog_rt::time::timeout(BOUND, waiters.wait_for(|n| *n == 3))
        .await
        .expect("the read, the write and the lane read waited at the gate within 60 s")
        .unwrap();
    note("released")();
    release.send(()).unwrap();
    let ((rows, _), (laned_rows, _)) = mixdog_rt::time::timeout(BOUND, async {
        let read = read.await.unwrap().unwrap();
        write.await.unwrap().unwrap();
        (read, on_lane.await.expect("job ran").unwrap())
    })
    .await
    .expect("the read, the write and the lane read answered within 60 s of the release");
    assert_eq!(iids(&rows), ["c", "b", "a"]);
    assert_eq!(iids(&laned_rows), ["c", "b", "a"]);
    let events = events.lock().unwrap().clone();
    assert_eq!((events.len(), events[0]), (4, "released"), "{events:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_upsert_keeps_sid_and_searches_folds() {
    let env = Env::new();
    let db = env.data.join(INDEX_FILE);
    let mut h = head("s_A", "task", "Ünïcode Spec Review");
    h.header.insert("cwd".into(), "C:\\Work\\Repo".into());
    env.store.upsert(h.clone(), DirtyMark::Set).await.unwrap();
    let sid = |db: &Path| -> i64 {
        rusqlite::Connection::open(db).unwrap().query_row("SELECT sid FROM sessions WHERE id='s_A'", [], |r| r.get(0)).unwrap()
    };
    let first = sid(&db);
    let summary = |env: &Env| {
        let store = env.store.clone();
        async move { store.summary("s_A").await.unwrap().unwrap() }
    };
    let before = summary(&env).await;
    h.header.insert("title".into(), "Changed title".into());
    env.store.upsert(h.clone(), DirtyMark::Clear).await.unwrap();
    assert_eq!(sid(&db), first);
    assert!(env.store.dirty_sessions().await.unwrap().is_empty());
    env.store.upsert(head("s_B", "chat", "Title"), DirtyMark::Set).await.unwrap();
    let hit = |q: &'static str| {
        let store = env.store.clone();
        async move { store.search(q, 50, None).await.unwrap() }
    };
    let after = summary(&env).await;
    assert_ne!(before, after);
    assert_eq!(hit("changed").await, std::slice::from_ref(&after));
    assert_eq!(hit("wo").await, std::slice::from_ref(&after));
    assert!(hit("ünïcode spec").await.is_empty(), "the old title fold was replaced");
    assert_eq!(hit("").await, std::slice::from_ref(&after), "chat rows are not searchable");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn placeholder_titles_refold_on_language_change() {
    let env = Env::new();
    env.store.upsert(head("s1", "task", "[Video #1]"), DirtyMark::Set).await.unwrap();
    assert_eq!(env.store.search("video", 50, None).await.unwrap().len(), 1);
    let summary = env.store.summary("s1").await.unwrap().unwrap();
    let ko = PlaceholderLabels { image: "이미지".into(), video: "영상".into(), file: "파일".into() };
    env.store.set_placeholder_labels(ko).await.unwrap();
    // The refold step runs right after the transaction that stored the labels, so the
    // next append transaction is ordered after it.
    env.store.mark_dirty("s1").await.unwrap();
    assert_eq!(env.store.search("영상", 50, None).await.unwrap(), [summary]);
    let title_fold: String = rusqlite::Connection::open(env.data.join(INDEX_FILE))
        .unwrap()
        .query_row("SELECT title_fold FROM sessions WHERE id = 's1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title_fold, "영상");
}

// ---------------------------------------------------------------------------------------
// Catalog rows against Node's `_sessionSummary` on the migration corpus.

fn corpus_root() -> PathBuf {
    std::env::var_os("MIXDOG_MIGRATION_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"))
}

fn differing_fields(key: &str, want: &serde_json::Value, got: &serde_json::Value) -> Vec<String> {
    let (want, got) = (want.as_object().unwrap(), got.as_object().unwrap());
    let mut names: Vec<&String> = want.keys().chain(got.keys()).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .filter(|k| want.get(*k) != got.get(*k))
        .map(|k| format!("{key}: {k}: node {:?} rust {:?}", want.get(k), got.get(k)))
        .collect()
}

/// Every corpus session written through the log writer (live) and projected again by
/// `project_index` (reprojection) has the row Node's `_sessionSummary` builds.
const SUMMARIES: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/migration/session-summary/summaries.json");
/// Corpus sessions per test: each is written through its own log writer and projected again.
const SESSION_CHUNK: usize = 4;

mixdog_rt::replay_chunks!(CATALOG_TESTS, #[tokio::test(flavor = "multi_thread", worker_threads = 2)] async catalog_rows_chunk; [
    catalog_rows_equal_nodes_session_summary_on_the_corpus_00 = 0,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_01 = 1,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_02 = 2,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_03 = 3,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_04 = 4,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_05 = 5,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_06 = 6,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_07 = 7,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_08 = 8,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_09 = 9,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_10 = 10,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_11 = 11,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_12 = 12,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_13 = 13,
    catalog_rows_equal_nodes_session_summary_on_the_corpus_14 = 14,
]);

#[test]
fn every_corpus_session_has_its_catalog_test() {
    let fixture: serde_json::Value = serde_json::from_str(&SUMMARIES).unwrap();
    let entries = fixture["sessions"].as_array().unwrap();
    assert!(entries.len() > 50);
    mixdog_rt::testing::assert_chunks_registered(CATALOG_TESTS, entries.len(), SESSION_CHUNK);
}

async fn catalog_rows_chunk(chunk: usize) {
    let fixture: serde_json::Value = serde_json::from_str(&SUMMARIES).unwrap();
    let root = corpus_root();
    assert!(root.join("v145").is_dir(), "the migration corpus is missing at {}; set MIXDOG_MIGRATION_CORPUS", root.display());
    let mut bad = Vec::new();
    let entries = fixture["sessions"].as_array().unwrap();
    for entry in &entries[mixdog_rt::testing::chunk_range(entries.len(), chunk, SESSION_CHUNK)] {
        let key = entry["key"].as_str().unwrap();
        let want = &entry["summary"];
        let source: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join(key)).unwrap()).unwrap();
        let mut header = source.as_object().unwrap().clone();
        let messages = header.remove("messages").unwrap();
        let id = source["id"].as_str().unwrap().to_owned();

        let env = Env::new();
        let first = crate::encode::encode_record(
            serde_json::from_value(json!({"k":"session","v":2,"id":id,"log_id":LOG_ID,"header":{"inline":header}})).unwrap(),
        )
        .unwrap();
        env.store
            .upsert(
                CatalogHead { session: id.clone(), log_id: LOG_ID.into(), base_session: None, header: header.clone() },
                DirtyMark::Set,
            )
            .await
            .unwrap();
        let (dir, deps) = (env.dir(&id), env.deps());
        let (mut w, ack) = on_lane(move |l| LogWriter::create(l, &dir, first, deps).unwrap()).await;
        env.store.project(ack.projection).await.unwrap();
        let mut batch = Vec::new();
        let mut bytes = 0;
        let messages = messages.as_array().unwrap();
        for (i, m) in messages.iter().enumerate() {
            let e = crate::encode::encode_record(
                serde_json::from_value(json!({"k":"item","iid":format!("m{i}"),"form":"message","model":true,
                    "visible":true,"refs":[],"body":{"inline":m}}))
                .unwrap(),
            )
            .unwrap();
            bytes += e.frame_len();
            batch.push(e);
            if bytes > (256 << 10) || i + 1 == messages.len() {
                w = env.commit(w, std::mem::take(&mut batch)).await.0;
                bytes = 0;
            }
        }
        let live: serde_json::Value = serde_json::from_str(&env.store.summary(&id).await.unwrap().unwrap()).unwrap();
        bad.extend(differing_fields(&format!("live {key}"), want, &live));

        let db = env.data.join("reprojected.sqlite");
        let (data, db2, ids) = (env.data.clone(), db.clone(), vec![id.clone()]);
        tokio::task::spawn_blocking(move || crate::sqlite::project_index(&data, &db2, &ids)).await.unwrap().unwrap();
        let text: String = rusqlite::Connection::open(&db)
            .unwrap()
            .query_row("SELECT summary FROM sessions WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        let again: serde_json::Value = serde_json::from_str(&text).unwrap();
        bad.extend(differing_fields(&format!("reprojected {key}"), want, &again));
        drop(w);
    }
    assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_keeps_history_marks_dropped_rows_and_places_the_divider() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two"), user("c", "three"), user("d", "four")]).await;
    // The compaction keeps c and d and adds a summary (ordinal 5); e follows (6).
    let compacted = rec(json!({"k":"compacted","cid":"k1","at":1792567960000_i64,
        "dropped":{"messageIds":["a","b"],"callIds":["call1"]},
        "replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}},
        {"iid":"c","body":{"role":"user","content":"three"}},
        {"iid":"d","body":{"role":"user","content":"four"}}]}}));
    let (w, _) = env.commit(w, vec![compacted, user("e", "five")]).await;
    let page = |env: &Env| {
        let store = env.store.clone();
        async move { store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap().0 }
    };
    let rows = page(&env).await;
    let marks: Vec<(String, bool)> = rows.iter().map(|r| (r.iid.clone(), r.archived)).collect();
    assert_eq!(
        marks,
        [("e".into(), false), ("d".into(), false), ("c".into(), false), ("b".into(), true), ("a".into(), true)]
    );
    let copies: Vec<Vec<(u64, u32)>> =
        rows.iter().map(|r| r.kept.iter().map(|k| (k.compaction.ordinal, k.idx)).collect()).collect();
    assert_eq!(copies, [vec![], vec![(5, 2)], vec![(5, 1)], vec![], vec![]], "the rewritten copies of d and c");
    let dividers = env.store.dividers(lineage(&[("s1", None)]), None, 0, 0, u64::MAX).await.unwrap();
    assert_eq!(dividers.iter().map(|d| (d.cid.as_str(), d.boundary, d.pos.ordinal)).collect::<Vec<_>>(), [("k1", 3, 5)]);
    assert_eq!(dividers[0].at, Some(1792567960000));
    // Rewinding before the compaction removes both the divider and the marks.
    let (_w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":5,"reason":"edit"}))]).await;
    assert!(env.store.dividers(lineage(&[("s1", None)]), None, 0, 0, u64::MAX).await.unwrap().is_empty());
    assert!(page(&env).await.iter().all(|r| !r.archived));
}

/// An earlier build wrote `lost: true` on a compaction record. A rebuilt index must read past it: the whole history is
/// there, the dropped rows archived, and the session is not damaged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_reads_a_compaction_record_with_the_obsolete_lost_flag() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two"), user("c", "three")]).await;
    let compacted = rec(json!({"k":"compacted","cid":"k1","at":1792567960000_i64,
        "dropped":{"messageIds":["a","b"],"callIds":[]},
        "replacement":{"inline":[{"iid":"c","body":{"role":"user","content":"three"}}]}}));
    let mut legacy = serde_json::to_value(compacted.record()).unwrap();
    legacy["lost"] = json!(true);
    let legacy = Encoded { payload: serde_json::to_vec(&legacy).unwrap(), ..compacted };
    let (w, _) = env.commit(w, vec![legacy, user("e", "five")]).await;
    drop(w);

    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let db = other.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let old = rusqlite::Connection::open(&db).unwrap();
    old.execute_batch(&format!("{} PRAGMA user_version = {};", crate::schema::sql::INDEX_DDL, crate::schema::sql::INDEX_USER_VERSION - 1)).unwrap();
    drop(old);
    let store = open_index(other.path()).unwrap();
    let rows = store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap().0;
    let marks: Vec<(String, bool)> = rows.iter().map(|r| (r.iid.clone(), r.archived)).collect();
    assert_eq!(marks, [("e".into(), false), ("c".into(), false), ("b".into(), true), ("a".into(), true)]);
}

/// A compaction names a message by its message id (`meta.transcript.messageId`), which is not the id of the row a core wrote
/// it as: that row is archived too, and a row naming no message id is matched by its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_archives_a_row_by_the_message_id_it_names() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let core_written = message("itm1", json!({"role":"user","content":"five","meta":{"transcript":{"messageId":"msg_1"}}}));
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two"), user("c", "three"), core_written]).await;
    let compacted = rec(json!({"k":"compacted","cid":"k1","at":1792567960000_i64,
        "dropped":{"messageIds":["a","msg_1"],"callIds":[]},
        "replacement":{"inline":[{"iid":"sum","body":{"role":"user","content":"summary"}},{"iid":"b","body":{"role":"user","content":"two"}},{"iid":"c","body":{"role":"user","content":"three"}}]}}));
    let (_w, _) = env.commit(w, vec![compacted, user("d", "four")]).await;
    let rows = env.store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap().0;
    let marks: Vec<(String, bool)> = rows.iter().map(|r| (r.iid.clone(), r.archived)).collect();
    assert_eq!(marks, [("d".into(), false), ("itm1".into(), true), ("c".into(), false), ("b".into(), false), ("a".into(), true)]);
}

fn message(iid: &str, body: serde_json::Value) -> Encoded {
    rec(json!({"k":"item","iid":iid,"form":"message","model":true,"visible":true,"refs":[],
        "body":{"inline":body}}))
}

async fn archive_marks(env: &Env, levels: Vec<LineageLevel>) -> Vec<(String, bool, bool, Vec<String>)> {
    let (rows, _) = env.store.history_page(levels, None, None, 50).await.unwrap();
    rows.iter().rev().map(|r| (r.iid.clone(), r.archived, r.dropped_text, r.dropped_calls.clone())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_message_that_lost_its_text_or_calls_is_classified_by_the_dropped_identities() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env
        .commit(
            w,
            vec![
                message("u1", json!({"role":"user","content":"a long prompt"})),
                message("t1", json!({"role":"assistant","content":"plan","toolCalls":[{"id":"c1"}]})),
                message("r1", json!({"role":"tool","content":"out","toolCallId":"c1"})),
                message("w1", json!({"role":"assistant","content":"","toolCalls":[{"id":"c2"}]})),
                message("r2", json!({"role":"tool","content":"out","toolCallId":"c2"})),
            ],
        )
        .await;
    // u1 is kept but lost all its text; t1 is kept without its text but keeps its call c1;
    // the pair w1/r2 is gone. Membership in the replacement says "nothing archived" for
    // u1, t1 and r1 and "archived" for w1 and r2; the identities say otherwise for u1.
    let compacted = rec(json!({"k":"compacted","cid":"k1","dropped":{"messageIds":["u1","t1","w1","r2"],"callIds":["c2"]},
        "replacement":{"inline":[
            {"iid":"u1","body":{"role":"user","content":""}},
            {"iid":"t1","body":{"role":"assistant","content":"","toolCalls":[{"id":"c1"}]}},
            {"iid":"r1","body":{"role":"tool","content":"out","toolCallId":"c1"}}]}}));
    let (_w, _) = env.commit(w, vec![compacted]).await;
    assert_eq!(
        archive_marks(&env, lineage(&[("s1", None)])).await,
        [
            ("u1".into(), true, true, vec![]),
            ("t1".into(), false, true, vec![]),
            ("r1".into(), false, false, vec![]),
            ("w1".into(), true, false, vec!["c2".into()]),
            ("r2".into(), true, false, vec!["c2".into()]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forks_compaction_archives_the_rows_it_inherited() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (_base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three")]).await;
    let child = env.create("c0", Some(("b0", 4))).await;
    // The fork compacts away its whole inherited context.
    let compacted = rec(json!({"k":"compacted","cid":"k1","dropped":{"messageIds":["b1","b2","b3"],"callIds":[]},
        "replacement":{"inline":[{"iid":"sum","body":{"role":"user","content":"summary"}}]}}));
    let (child, _) = env.commit(child, vec![compacted, user("c1", "after")]).await;
    let levels = lineage(&[("c0", None), ("b0", Some(4))]);
    let (rows, _) = env.store.history_page(levels.clone(), child.fold().base_cut, None, 10).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.iid.as_str(), r.archived)).collect::<Vec<_>>(),
        [("c1", false), ("b3", true), ("b2", true), ("b1", true)]
    );
    // The base alone keeps showing its own rows live.
    assert!(archive_marks(&env, lineage(&[("b0", None)])).await.iter().all(|m| !m.1));
}

/// A `silent` compaction restarts the model context like any other but lists no divider, before
/// and after a reload of the log; a compaction that is not silent keeps its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_compaction_restarts_the_context_and_lists_no_divider() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two")]).await;
    let dividers = |env: &Env| {
        let store = env.store.clone();
        async move {
            store.dividers(lineage(&[("s1", None)]), None, 0, 0, u64::MAX).await.unwrap().into_iter().map(|d| d.cid).collect::<Vec<_>>()
        }
    };
    let silent = rec(json!({"k":"compacted","cid":"k1","dropped_count":0,"silent":true,
        "replacement":{"inline":[{"iid":"b","body":{"role":"user","content":"two"}}]}}));
    let (w, _) = env.commit(w, vec![silent]).await;
    assert!(dividers(&env).await.is_empty(), "no divider for a silent compaction");
    let loud = rec(json!({"k":"compacted","cid":"k2","dropped_count":0,
        "replacement":{"inline":[{"iid":"b","body":{"role":"user","content":"two"}}]}}));
    let (w, _) = env.commit(w, vec![loud]).await;
    assert_eq!(dividers(&env).await, ["k2"], "a compaction that is not silent keeps its divider");
    drop(w);
    let opened = env.reopen("s1").await;
    assert_eq!(opened.fold.context.map(|c| c.ordinal), Some(4), "the newest compaction owns the context");
    assert_eq!(dividers(&env).await, ["k2"], "the reload lists the same dividers");
    let rows = env.store.history_page(lineage(&[("s1", None)]), None, None, 10).await.unwrap().0;
    assert!(rows.iter().all(|r| !r.archived), "a silent compaction takes nothing out of the transcript");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forks_divider_precedes_the_oldest_inherited_row_its_replacement_kept() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (_base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three")]).await;
    // The fork keeps b2 and b3 (inherited) behind a summary: 1.4.5 restores the fork's copies
    // of them after the divider, so it sits before b2 in the base's rows.
    let keeps = env.create("c0", Some(("b0", 4))).await;
    let kept = rec(json!({"k":"compacted","cid":"k1","dropped_count":1,"replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}},
        {"iid":"b2","body":{"role":"user","content":"two"}},
        {"iid":"b3","body":{"role":"user","content":"three"}}]}}));
    let (_keeps, _) = env.commit(keeps, vec![kept, user("c1", "after")]).await;
    let levels = lineage(&[("c0", None), ("b0", Some(4))]);
    let at = |level| {
        let (store, levels) = (env.store.clone(), levels.clone());
        async move {
            store.dividers(levels, None, level, 0, u64::MAX).await.unwrap().iter().map(|d| (d.cid.clone(), d.level, d.boundary)).collect::<Vec<_>>()
        }
    };
    assert_eq!(at(1).await, [("k1".to_owned(), 1, 2)]);
    assert!(at(0).await.is_empty());
    // `droppedMessages: 1` without identities archives the rows before the divider and only
    // those: b1 left, the kept b2 and b3 stay live.
    let (rows, _) = env.store.history_page(levels.clone(), None, None, 10).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.iid.as_str(), r.archived)).collect::<Vec<_>>(),
        [("c1", false), ("b3", false), ("b2", false), ("b1", true)]
    );
    // A fork that keeps nothing it inherited puts its divider after them, in its own rows.
    let drops = env.create("c1", Some(("b0", 4))).await;
    let gone = rec(json!({"k":"compacted","cid":"k2","dropped_count":3,"replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}}]}}));
    let (_drops, ords) = env.commit(drops, vec![gone]).await;
    let levels = lineage(&[("c1", None), ("b0", Some(4))]);
    let got = env.store.dividers(levels.clone(), None, 0, 0, u64::MAX).await.unwrap();
    assert_eq!(got.iter().map(|d| (d.level, d.boundary)).collect::<Vec<_>>(), [(0, ords[0])]);
    assert!(env.store.dividers(levels.clone(), None, 1, 0, u64::MAX).await.unwrap().is_empty());
    // Nothing kept: every inherited row is before the divider, so all are archived.
    let (rows, _) = env.store.history_page(levels, None, None, 10).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.iid.as_str(), r.archived)).collect::<Vec<_>>(),
        [("b3", true), ("b2", true), ("b1", true)]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_event_without_identities_follows_its_count() {
    let env = Env::new();
    let summary = json!({"replacement":{"inline":[{"iid":"sum","body":{"role":"user","content":"summary"}}]}});
    let with = |extra: serde_json::Value| {
        let mut v = summary.clone();
        v["k"] = json!("compacted");
        v["cid"] = json!("k1");
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        rec(v)
    };
    // A pass that took out nothing visible (`droppedMessages: 0`, no identities): live.
    // A positive count, or no count at all (imported history): every row before the divider.
    let cases = [("n0", json!({"dropped_count":0}), false), ("n3", json!({"dropped_count":3}), true), ("nn", json!({}), true)];
    for (id, extra, archived) in cases {
        let w = env.create(id, None).await;
        let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two")]).await;
        let (_w, _) = env.commit(w, vec![with(extra)]).await;
        let marks = archive_marks(&env, lineage(&[(id, None)])).await;
        assert!(marks.iter().all(|m| m.1 == archived), "{id}: {marks:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rewind_past_an_amend_brings_the_earlier_version_back() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two")]).await;
    let amend = rec(json!({"k":"amend","iid":"a","refs":[],"body":{"inline":{"role":"user","content":"changed"}}}));
    let (w, _) = env.commit(w, vec![amend]).await;
    assert_eq!(row_counts(&env, "s1").await, (2, "changed".into()));
    // The amend is frame 3; rewinding to it removes it and only it.
    let (_w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":3,"reason":"edit"}))]).await;
    assert_eq!(row_counts(&env, "s1").await, (2, "one".into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_grandchild_keeps_its_snapshot_across_a_rewind_of_the_base() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three"), user("b4", "four")]).await;
    // c0 forks at 4 (b1..b3), g0 at the end of c0 (frames 4, 5).
    let child = env.create("c0", Some(("b0", 4))).await;
    let (_child, _) = env.commit(child, vec![user("c1", "own")]).await;
    let grand = env.create("g0", Some(("c0", 6))).await;
    let (_grand, _) = env.commit(grand, vec![user("g1", "leaf")]).await;
    assert_eq!(row_counts(&env, "c0").await, (4, "one".into()));
    assert_eq!(row_counts(&env, "g0").await, (5, "one".into()));
    let (_base, _) = env.commit(base, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    assert_eq!(row_counts(&env, "b0").await, (1, "one".into()));
    assert_eq!(row_counts(&env, "c0").await, (4, "one".into()), "the base's rewind does not reach the fork");
    assert_eq!(row_counts(&env, "g0").await, (5, "one".into()));
}

#[test]
fn an_early_amend_in_a_long_session_writes_a_bounded_number_of_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = crate::sqlite::open_schema(
        &dir.path().join("i.sqlite"),
        crate::schema::sql::INDEX_DDL,
        crate::schema::sql::INDEX_APPLICATION_ID,
        crate::schema::sql::INDEX_USER_VERSION,
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    let message = |text: &str| crate::message_state::MessageRow::of(&json!({"role":"user","content":text}));
    for i in 0..2000_i64 {
        crate::message_index::add_item(&tx, "s", i + 1, (0, 0, 0), &format!("m{i}"), &message(&format!("text {i}"))).unwrap();
    }
    let before = tx.total_changes();
    crate::message_index::amend(&tx, "s", "m0", 2001, (0, 0, 0), &message("edited")).unwrap();
    let written = tx.total_changes() - before;
    assert!(written <= 8, "{written} rows written by one amend");
    let stats = crate::message_index::read_stats(&tx, "s", false).unwrap();
    assert_eq!((stats.count, stats.preview.as_str()), (2000, "edited"));
    // A rewind of a long suffix is bounded by its budget and resumes.
    let (used, complete) = crate::message_index::rewind(&tx, "s", 10, 2002, 100).unwrap();
    assert!(used <= 104 && !complete, "{used} {complete}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coalesced_projections_write_the_newest_header() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let meta = |title: &str| rec(json!({"k":"meta","change":{"inline":{"set":{"title":title},"unset":[]}}}));
    let (w, first) = env.append(w, vec![meta("First"), user("a", "one")]).await;
    let (_w, second) = env.append(w, vec![meta("Second"), user("b", "two")]).await;
    let (first, second) = (first.unwrap().projection, second.unwrap().projection);
    let (one, two) = tokio::join!(env.store.project(first), env.store.project(second));
    one.unwrap();
    two.unwrap();
    let summary: serde_json::Value = serde_json::from_str(&env.store.summary("s1").await.unwrap().unwrap()).unwrap();
    assert_eq!((summary["title"].as_str(), summary["messageCount"].as_u64()), (Some("Second"), Some(2)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deep_fork_chain_costs_the_same_as_a_shallow_one() {
    let env = Env::new();
    let w = env.create("f0", None).await;
    let (_w, _) = env.commit(w, vec![user("a", "one"), user("b", "two"), user("c", "three")]).await;
    // f0 has frames 0..=3; each fork adds a session frame and one message.
    let mut end = 4;
    let depth = 40;
    for i in 1..=depth {
        let (id, base) = (format!("f{i}"), format!("f{}", i - 1));
        let w = env.create(&id, Some((&base, end))).await;
        let (_w, _) = env.commit(w, vec![user(&format!("m{i}"), "x")]).await;
        end += 2;
    }
    assert_eq!(row_counts(&env, &format!("f{depth}")).await, (3 + depth as u64, "one".into()));
    // The stats are seeks on the message indexes.
    let conn = rusqlite::Connection::open(env.data.join(INDEX_FILE)).unwrap();
    for (sql, index) in [
        (crate::message_index::PREVIEW_SQL, "message_rows_preview"),
        (crate::message_index::LAST_SQL, "message_rows_line"),
        (crate::message_index::INCOMING_SQL, "message_rows_incoming"),
    ] {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let args: Vec<rusqlite::types::Value> =
            (0..stmt.parameter_count()).map(|_| rusqlite::types::Value::Integer(1)).collect();
        let plan: Vec<String> =
            stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(plan.iter().any(|s| s.contains(index)), "{index}: {plan:?}");
        assert!(plan.iter().all(|s| !s.starts_with("SCAN") && !s.contains("TEMP B-TREE")), "{plan:?}");
    }
}

async fn row_counts(env: &Env, id: &str) -> (u64, String) {
    // A write after the projection is ordered behind the view steps and the rows they release.
    for _ in 0..2 {
        env.store.set_status(id, SessionStatus::Ok, None).await.unwrap();
    }
    let v: serde_json::Value = serde_json::from_str(&env.store.summary(id).await.unwrap().unwrap()).unwrap();
    (v["messageCount"].as_u64().unwrap(), v["preview"].as_str().unwrap().to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forks_count_their_base_rows_through_the_lineage() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three"), user("b4", "four")]).await;
    assert_eq!(row_counts(&env, "b0").await, (4, "one".into()));
    // A later rewind in the base does not reach the fork.
    let (_base, _) = env.commit(base, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    assert_eq!(row_counts(&env, "b0").await, (1, "one".into()));
    let child = env.create("c0", Some(("b0", 4))).await;
    let (child, _) = env.commit(child, vec![user("c1", "own")]).await;
    assert_eq!(row_counts(&env, "c0").await, (4, "one".into()), "base rows 1..3 and its own");
    // Rewound into the base: only the base rows below the cut remain.
    let (_child, _) = env.commit(child, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    assert_eq!(row_counts(&env, "c0").await, (1, "one".into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_amend_reaches_a_compaction_replacement_entry() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "before"), user("b", "second")]).await;
    let compacted = rec(json!({"k":"compacted","cid":"c1","replacement":{"inline":[
        {"iid":"r1","body":{"role":"user","content":"kept summary"}},
        {"iid":"r2","body":{"role":"assistant","content":"kept reply"}}]}}));
    let (w, _) = env.commit(w, vec![compacted, user("c", "after")]).await;
    assert_eq!(row_counts(&env, "s1").await, (3, "kept summary".into()));
    let amend = rec(json!({"k":"amend","iid":"r1","refs":[],"body":{"inline":{"role":"user","content":"edited summary"}}}));
    let (_w, _) = env.commit(w, vec![amend]).await;
    assert_eq!(row_counts(&env, "s1").await, (3, "edited summary".into()));
}

/// The `content` text of each message of `context_bodies`.
async fn model_context(env: &Env, levels: Vec<LineageLevel>, cut: Option<u64>, limit: usize) -> Vec<(String, String)> {
    let bodies = context_bodies(env, levels, cut, limit).await;
    bodies.into_iter().map(|(iid, body)| (iid, body["content"].as_str().unwrap_or_default().to_owned())).collect()
}

/// The whole model context of `levels`, read in pages of `limit` rows through the four
/// lane steps.
async fn context_bodies(
    env: &Env,
    levels: Vec<LineageLevel>,
    cut: Option<u64>,
    limit: usize,
) -> Vec<(String, serde_json::Value)> {
    use crate::context::*;
    let (io, cpu) = (tokens().interactive_io, tokens().cpu_interactive);
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let (store, sessions, lv) = (env.store.clone(), env.data.join("sessions"), levels.clone());
        let page = io
            .submit(&CancellationToken::new(), move |l| store.context_page_on_lane(l, &sessions, &lv, cut, cursor, limit))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let decoded = cpu.submit(&CancellationToken::new(), move |l| decode_context(l, page)).unwrap().await.unwrap().unwrap();
        let next = decoded.next;
        let (decoded, blobs) = if decoded.needs_blobs() {
            let store = BlobStore::new(&env.data);
            io.submit(&CancellationToken::new(), move |l| {
                let b = read_context_blobs(l, &store, &decoded).unwrap();
                (decoded, b)
            })
            .unwrap()
            .await
            .unwrap()
        } else {
            (decoded, ContextBlobs::default())
        };
        let messages = cpu.submit(&CancellationToken::new(), move |l| finish_context(l, decoded, blobs)).unwrap().await.unwrap().unwrap();
        out.extend(messages.into_iter().map(|m| (m.iid, m.body)));
        match next {
            Some(c) => cursor = Some(c),
            None => return out,
        }
    }
}

/// A 1.4.5 media reference part (`attachment-reference.mjs` `mediaPartToReference`: the
/// part carries the reference `info` object) and a plain text part (no key) keep Node's
/// `JSON.stringify` bytes through the log, a body blob and the model-context read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_reference_parts_keep_their_stored_bytes() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let node = |pad: usize| {
        format!(
            concat!(
                r#"{{"role":"user","content":[{{"type":"text","text":"see{}"}},"#,
                r#"{{"type":"text","text":"[Attachment kept on disk]","attachmentReference":{{"attachmentRef":"{}","#,
                r#""kind":"pdf","filename":"a.pdf","mimeType":"application/pdf","sizeBytes":12,"pageCount":1,"textPages":1}}}}]}}"#
            ),
            "x".repeat(pad),
            "a".repeat(64)
        )
    };
    let (small, large) = (node(0), node(300 << 10));
    let item = |iid: &str, bytes: &str| {
        let body: serde_json::Value = serde_json::from_str(bytes).unwrap();
        let record = json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"refs":[],
            "body":{"inline":body}});
        crate::encode::encode_record(serde_json::from_value(record).unwrap()).unwrap()
    };
    let (inline, blob) = (item("a", &small), item("b", &large));
    assert_eq!((inline.blobs().len(), blob.blobs().len()), (0, 1), "the large body is a blob");
    assert_eq!(&blob.blobs()[0].bytes, large.as_bytes(), "the blob holds Node's bytes");
    let (_w, _) = env.commit(w, vec![inline, blob]).await;
    let log = std::fs::read(env.dir("s1").join(log_name(0))).unwrap();
    assert!(log.windows(small.len()).any(|w| w == small.as_bytes()), "the log holds Node's bytes");
    let got = context_bodies(&env, lineage(&[("s1", None)]), None, 10).await;
    let got: Vec<String> = got.iter().map(|(_, body)| serde_json::to_string(body).unwrap()).collect();
    assert_eq!(got, [small, large]);
}

/// A deleted session is hidden at once but keeps its files while a fork reads them; the
/// mark is in the log, so a rebuild keeps it. Deleting the last fork removes the fork and
/// then the base in one purge, files and index rows alike.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_base_keeps_its_files_until_its_last_fork_is_deleted() {
    let env = Env::new();
    let deleted = || rec(json!({"k":"meta","change":{"inline":{"set":{"deleted":true},"unset":[]}}}));
    let p = env.create("p0", None).await;
    let (p, _) = env.commit(p, vec![item("p1"), item("p2")]).await;
    let c = env.create("c0", Some(("p0", 3))).await;
    let (c, _) = env.commit(c, vec![item("c1")]).await;
    let (p, _) = env.commit(p, vec![deleted()]).await;
    drop(p);
    assert_eq!((env.store.summary("p0").await.unwrap(), env.store.title("p0").await.unwrap()), (None, None));
    assert_eq!((env.store.deleted("p0").await.unwrap(), env.store.deleted("c0").await.unwrap()), (Some(true), Some(false)));
    assert!(env.store.summary("c0").await.unwrap().is_some());
    let purge = || env.store.purge_deleted(tokens().maintenance_io, env.data.clone());
    assert!(purge().await.unwrap().is_empty(), "the fork reads the base");
    assert!(env.dir("p0").join(log_name(0)).is_file());
    let fork = lineage(&[("c0", None), ("p0", Some(3))]);
    assert_eq!(iids(&env.store.history_page(fork, None, None, 10).await.unwrap().0), ["c1", "p2", "p1"]);
    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    assert_eq!(open_index(other.path()).unwrap().deleted("p0").await.unwrap(), Some(true), "a rebuild keeps the mark");

    let (c, _) = env.commit(c, vec![deleted()]).await;
    drop(c);
    assert_eq!(purge().await.unwrap(), ["c0", "p0"]);
    assert!(!env.dir("p0").exists() && !env.dir("c0").exists());
    assert_eq!((env.store.deleted("p0").await.unwrap(), env.store.deleted("c0").await.unwrap()), (None, None));
    let db = rusqlite::Connection::open(env.data.join(INDEX_FILE)).unwrap();
    let left: i64 = db
        .query_row(
            "SELECT (SELECT count(*) FROM history WHERE session IN ('p0','c0'))
                  + (SELECT count(*) FROM message_rows WHERE session IN ('p0','c0'))
                  + (SELECT count(*) FROM fork_edges)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    assert!(purge().await.unwrap().is_empty());
}

/// Opening the store runs the boot purge before it returns the store. A crash right after a
/// purge unlinked the first log file leaves a folder no rebuild indexes; a half-finished
/// create leaves an empty folder or one holding only the first file's publish tmp; a crash
/// before a delete's purge leaves a complete deleted session. The open removes all of them,
/// with a rebuild and without one (the index still holding their rows); a complete live
/// session stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_the_store_removes_what_a_crash_left_before_any_thread_opens() {
    let env = Env::new();
    let deleted = || rec(json!({"k":"meta","change":{"inline":{"set":{"deleted":true},"unset":[]}}}));
    for id in ["d0", "x0"] {
        let w = env.create(id, None).await;
        let (w, _) = env.commit(w, vec![item("i1"), deleted()]).await;
        drop(w);
    }
    let kept = env.create("k0", None).await;
    drop(kept);
    // The purge's first step on d0, then the crash.
    std::fs::remove_file(env.dir("d0").join(log_name(0))).unwrap();
    std::fs::create_dir_all(env.dir("e0")).unwrap();
    std::fs::create_dir_all(env.dir("t0")).unwrap();
    std::fs::write(crate::fsio::tmp_path(&env.dir("t0").join(log_name(0))), b"half").unwrap();
    let folders = |data: &Path| -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(data.join("sessions"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    };

    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let rebuilt = open_index(other.path()).unwrap();
    assert_eq!(folders(other.path()), ["k0"], "gone when the open returns");
    for id in ["d0", "x0", "e0", "t0"] {
        assert_eq!(rebuilt.deleted(id).await.unwrap(), None, "{id}");
    }
    assert!(rebuilt.summary("k0").await.unwrap().is_some());

    // Without a rebuild the index still holds d0's and x0's rows: the open drops them too.
    assert_eq!(env.store.deleted("d0").await.unwrap(), Some(true));
    let reopened = open_index(&env.data).unwrap();
    assert_eq!(folders(&env.data), ["k0"]);
    for id in ["d0", "x0"] {
        assert_eq!(reopened.deleted(id).await.unwrap(), None, "{id}");
    }
    assert!(reopened.summary("k0").await.unwrap().is_some());
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_model_context_starts_at_the_newest_compaction_with_amends_applied() {
    let env = Env::new();
    let own = || lineage(&[("s1", None)]);
    let w = env.create("s1", None).await;
    // A hidden model row (a skill row) is part of the context; a display row is not.
    let hidden = rec(json!({"k":"item","iid":"h","role":"user","form":"message","model":true,"visible":false,"refs":[],
        "body":{"inline":{"content":"skill","role":"user"}}}));
    let display = rec(json!({"k":"item","iid":"x","form":"display","model":false,"visible":true,"refs":[],
        "body":{"inline":{"content":"shown"}}}));
    let (w, _) = env.commit(w, vec![user("a", "one"), hidden, display, answer("b")]).await;
    assert_eq!(model_context(&env, own(), None, 10).await, pairs(&[("a", "one"), ("h", "skill"), ("b", "b")]));
    // Compaction at 5 keeps b; c follows. Amends reach a replacement entry and an item.
    let compacted = rec(json!({"k":"compacted","cid":"k1","replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}},
        {"iid":"b","body":{"role":"assistant","content":"b kept"}}]}}));
    let (w, _) = env.commit(w, vec![compacted, user("c", "two")]).await;
    let amend = |iid: &str, text: &str| {
        rec(json!({"k":"amend","iid":iid,"refs":[],"body":{"inline":{"role":"user","content":text}}}))
    };
    let (w, _) = env.commit(w, vec![amend("sum", "summary 2"), amend("c", "two 2")]).await;
    let want = pairs(&[("sum", "summary 2"), ("b", "b kept"), ("c", "two 2")]);
    for limit in [1, 2, 10] {
        assert_eq!(model_context(&env, own(), None, limit).await, want, "pages of {limit}");
    }
    // An out-of-line body is read from its blob.
    let mut big = user("d", "").record().clone();
    if let crate::schema::record::Record::Item(r) = &mut big {
        r.body = crate::schema::blob::Slot::Inline(json!({"role":"user","content":"y".repeat(300 << 10)}));
    }
    let (w, _) = env.commit(w, vec![crate::encode::encode_record(big).unwrap()]).await;
    let got = model_context(&env, own(), None, 10).await;
    assert_eq!((got.len(), got[3].0.as_str(), got[3].1.len()), (4, "d", 300 << 10));
    // A rewind before the amends (frame 7) restores the earlier versions; one before the
    // compaction (frame 5) restores the earlier context.
    let (w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":7,"reason":"edit"}))]).await;
    assert_eq!(model_context(&env, own(), None, 10).await, pairs(&[("sum", "summary"), ("b", "b kept"), ("c", "two")]));
    let (_w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":5,"reason":"edit"}))]).await;
    assert_eq!(model_context(&env, own(), None, 10).await, pairs(&[("a", "one"), ("h", "skill"), ("b", "b")]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_model_context_follows_the_fork_lineage_as_of_the_fork() {
    let env = Env::new();
    let base = env.create("b0", None).await;
    let (base, _) = env.commit(base, vec![user("b1", "one"), user("b2", "two"), user("b3", "three"), user("b4", "four")]).await;
    // c0 forks at 4 (b1..b3); later base amends and rewinds do not reach it.
    let child = env.create("c0", Some(("b0", 4))).await;
    let amend = rec(json!({"k":"amend","iid":"b1","refs":[],"body":{"inline":{"role":"user","content":"one 2"}}}));
    let (base, _) = env.commit(base, vec![amend]).await;
    let (_base, _) = env.commit(base, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    let (child, _) = env.commit(child, vec![user("c1", "own")]).await;
    let levels = lineage(&[("c0", None), ("b0", Some(4))]);
    let want = pairs(&[("b1", "one"), ("b2", "two"), ("b3", "three"), ("c1", "own")]);
    for limit in [1, 3, 10] {
        assert_eq!(model_context(&env, levels.clone(), None, limit).await, want, "pages of {limit}");
    }
    // A grandchild at the end of c0 (frames 4, 5) sees the whole chain.
    let grand = env.create("g0", Some(("c0", 6))).await;
    let (_grand, _) = env.commit(grand, vec![user("g1", "leaf")]).await;
    let deep = lineage(&[("g0", None), ("c0", Some(6)), ("b0", Some(4))]);
    assert_eq!(model_context(&env, deep, None, 2).await.len(), 5);
    // Rewound into the base: the base below the cut, then the child's new rows.
    let (child, _) = env.commit(child, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    let (child, _) = env.commit(child, vec![user("c2", "again")]).await;
    assert_eq!(model_context(&env, levels.clone(), Some(2), 10).await, pairs(&[("b1", "one"), ("c2", "again")]));
    // The child's own compaction starts its context: no base rows.
    let compacted = rec(json!({"k":"compacted","cid":"k1","replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}}]}}));
    let (_child, _) = env.commit(child, vec![compacted]).await;
    assert_eq!(model_context(&env, levels, Some(2), 10).await, pairs(&[("sum", "summary")]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_context_cursor_goes_stale_when_the_history_changes() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two")]).await;
    let (store, sessions) = (env.store.clone(), env.data.join("sessions"));
    let page = tokens()
        .interactive_io
        .submit(&CancellationToken::new(), move |l| {
            store.context_page_on_lane(l, &sessions, &lineage(&[("s1", None)]), None, None, 1).unwrap()
        })
        .unwrap()
        .await
        .unwrap();
    let cursor = page.next.expect("a second page");
    let (_w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":2,"reason":"edit"}))]).await;
    let (store, sessions) = (env.store.clone(), env.data.join("sessions"));
    let again = tokens()
        .interactive_io
        .submit(&CancellationToken::new(), move |l| {
            store.context_page_on_lane(l, &sessions, &lineage(&[("s1", None)]), None, Some(cursor), 1)
        })
        .unwrap()
        .await
        .unwrap();
    assert!(matches!(again, Err(crate::context::ContextError::Db(DbError::CursorStale))));
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

/// Every row of every table, sorted per table.
fn dump(db: &Path) -> Vec<(String, Vec<String>)> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
    let tables: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
            let width = stmt.column_count();
            let mut rows: Vec<String> = stmt
                .query_map([], |r| {
                    (0..width).map(|i| r.get::<_, rusqlite::types::Value>(i)).collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .map(|row| format!("{:?}", row.unwrap()))
                .collect();
            rows.sort();
            (table, rows)
        })
        .collect()
}

fn worker_head(id: &str, created: u64, worker: serde_json::Value) -> CatalogHead {
    let mut h = head(id, "task", "t");
    h.header.insert("createdAt".into(), json!(created));
    h.header.insert("worker".into(), worker);
    h
}

fn ids(rows: &[crate::worker::WorkerRow]) -> Vec<&str> {
    rows.iter().map(|r| r.session.as_str()).collect()
}

/// The worker index follows every header write of a session's `worker` map and answers
/// the registry's lookups by tag, owner and host pid, newest session first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_rows_are_indexed_by_tag_owner_and_host_pid() {
    use crate::worker::WorkerScope::*;
    let env = Env::new();
    let s = &env.store;
    let upsert = |h: CatalogHead| async move { s.upsert(h, DirtyMark::Clear).await.unwrap() };
    upsert(worker_head("w1", 10, json!({"tag":" a ","parentSessionId":"p1","clientHostPid":"7","status":"idle"}))).await;
    upsert(worker_head("w2", 30, json!({"tag":"a","parentSessionId":"","ownerSessionId":"p1","clientHostPid":7.9}))).await;
    upsert(worker_head("w3", 20, json!({"tag":"b","parentSessionId":"p2","clientHostPid":8}))).await;
    upsert(worker_head("w4", 40, json!({"parentSessionId":"p2","reapedAt":"2026-01-01T00:00:00.000Z"}))).await;
    // A Lead pool row and a session without a map are not worker rows.
    upsert(worker_head("lead", 50, json!({"tag":"a","agent":"Lead","parentSessionId":"p1"}))).await;
    upsert(head("plain", "task", "t")).await;

    let rows = s.worker_rows(Some("a"), Owner("p1".into())).await.unwrap();
    assert_eq!(ids(&rows), ["w2", "w1"]);
    assert_eq!(rows[1].worker["status"], "idle");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&rows[1].summary).unwrap()["id"], "w1");
    assert_eq!(ids(&s.worker_rows(None, Owner("p2".into())).await.unwrap()), ["w4", "w3"]);
    assert_eq!(ids(&s.worker_rows(None, HostPid(7)).await.unwrap()), ["w2", "w1"]);
    assert_eq!(ids(&s.worker_rows(Some("b"), HostPid(8)).await.unwrap()), ["w3"]);
    assert_eq!(ids(&s.worker_rows(Some(""), All).await.unwrap()), ["w4"]);
    assert_eq!(ids(&s.worker_rows(None, All).await.unwrap()), ["w4", "w2", "w3", "w1"]);
    // A header write moves the row; dropping the map or deleting the session removes it.
    upsert(worker_head("w2", 30, json!({"tag":"b","parentSessionId":"p2"}))).await;
    assert_eq!(ids(&s.worker_rows(Some("a"), All).await.unwrap()), ["w1"]);
    assert_eq!(ids(&s.worker_rows(Some("b"), Owner("p2".into())).await.unwrap()), ["w2", "w3"]);
    upsert(head("w3", "task", "t")).await;
    s.mark_deleted("w1").await.unwrap();
    assert_eq!(ids(&s.worker_rows(None, All).await.unwrap()), ["w4", "w2"]);

    // Every lookup is a seek on its index, never a scan of the sessions.
    let conn = rusqlite::Connection::open(env.data.join(INDEX_FILE)).unwrap();
    let sqls = crate::worker::ROWS_SQL.iter().flatten().copied().chain([AGENT_ONLY_SQL, crate::worker::NEWEST_TAG_SQL]);
    for sql in sqls {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let args: Vec<rusqlite::types::Value> =
            (0..stmt.parameter_count()).map(|_| rusqlite::types::Value::Integer(1)).collect();
        let plan: Vec<String> =
            stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3)).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(plan.iter().all(|p| p.contains("USING INDEX") || p.contains("TEMP B-TREE")), "{sql}: {plan:?}");
    }
}

/// An agent-only session header created at `created` (no `createdAt` when `None`), last
/// updated at `updated`, with `fields` on top.
fn tagged(id: &str, created: Option<u64>, updated: u64, fields: serde_json::Value) -> CatalogHead {
    let mut h = head(id, "task", "t");
    h.header.insert("visibility".into(), json!("agent-only"));
    h.header.insert("updatedAt".into(), json!(updated));
    if let Some(created) = created {
        h.header.insert("createdAt".into(), json!(created));
    }
    for (k, v) in fields.as_object().unwrap() {
        h.header.insert(k.clone(), v.clone());
    }
    h
}

/// The newest session per tag is 1.4.5 `lastTagSession` over the agent registry: an
/// agent-only (or legacy `owner: agent`) session's own `agentTag` and parent link, open or
/// closed, with or without a worker map, never a Lead pool session; newest `createdAt`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_newest_session_per_tag_follows_the_session_agent_tag() {
    let env = Env::new();
    let s = &env.store;
    for h in [
        tagged("t1", Some(10), 1, json!({"agentTag":" a ","parentSessionId":"p1"})),
        tagged("t2", Some(30), 1, json!({"agentTag":"a","ownerSessionId":"p1","closed":true,"worker":{"tag":"other"}})),
        tagged("t3", Some(40), 1, json!({"agentTag":"a","parentSessionId":"p2"})),
        tagged("t4", Some(50), 1, json!({"agentTag":"a","parentSessionId":"p1","agent":"lead"})),
        tagged("t5", Some(60), 1, json!({"parentSessionId":"p1","worker":{"tag":"a","parentSessionId":"p1"}})),
        // Not in the agent registry: an ordinary session, and a parent link to itself.
        tagged("t6", Some(70), 1, json!({"agentTag":"a","parentSessionId":"p1","visibility":"ordinary"})),
        tagged("t7", Some(80), 1, json!({"agentTag":"a","parentSessionId":"t7"})),
        tagged("t8", Some(90), 1, json!({"agentTag":"a","parentSessionId":"p1","sourceName":"lead"})),
    ] {
        s.upsert(h, DirtyMark::Clear).await.unwrap();
    }
    assert_eq!(s.newest_tag_session("a", "p1").await.unwrap().unwrap().session, "t2");
    assert_eq!(s.newest_tag_session("a", "p2").await.unwrap().unwrap().session, "t3");
    assert!(s.newest_tag_session("other", "p1").await.unwrap().is_none());
    // A legacy `owner: agent` child is in the registry.
    let legacy = json!({"agentTag":"a","parentSessionId":"p1","visibility":"","owner":"agent"});
    s.upsert(tagged("t9", Some(35), 1, legacy), DirtyMark::Clear).await.unwrap();
    assert_eq!(s.newest_tag_session("a", "p1").await.unwrap().unwrap().session, "t9");
    // A header write that retags the session moves it.
    s.upsert(tagged("t9", Some(35), 1, json!({"agentTag":"b","parentSessionId":"p1"})), DirtyMark::Clear).await.unwrap();
    s.upsert(tagged("t2", Some(30), 1, json!({"agentTag":"b","ownerSessionId":"p1"})), DirtyMark::Clear).await.unwrap();
    let newest = s.newest_tag_session("a", "p1").await.unwrap().unwrap();
    assert_eq!(newest.session, "t1");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&newest.summary).unwrap()["id"], "t1");
}

/// Equal or missing `createdAt` (0 in 1.4.5, where a later session wins only when strictly
/// newer) goes to the session first in the registry walk: the newest `updatedAt`, then id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_newest_session_per_tag_breaks_created_ties_by_the_registry_walk() {
    let env = Env::new();
    let s = &env.store;
    let tag = |t: &str| json!({"agentTag": t, "parentSessionId": "p1"});
    for h in [
        // Equal `createdAt`: the newer `updatedAt` is walked first.
        tagged("e1", Some(70), 9, tag("eq")),
        tagged("e2", Some(70), 5, tag("eq")),
        // Equal both: id order.
        tagged("f2", Some(70), 5, tag("both")),
        tagged("f1", Some(70), 5, tag("both")),
        // Missing `createdAt` ties at 0, and loses to any positive one.
        tagged("m1", None, 3, tag("missing")),
        tagged("m2", None, 8, tag("missing")),
        tagged("m3", Some(0), 9, tag("missing")),
        tagged("n1", None, 9, tag("some")),
        tagged("n2", Some(1), 1, tag("some")),
    ] {
        s.upsert(h, DirtyMark::Clear).await.unwrap();
    }
    let newest = |t: &'static str| async move { s.newest_tag_session(t, "p1").await.unwrap().unwrap().session };
    assert_eq!(newest("eq").await, "e1");
    assert_eq!(newest("both").await, "f1");
    assert_eq!(newest("missing").await, "m3");
    assert_eq!(newest("some").await, "n2");
}

/// The agent-only sessions (declared, or a legacy `owner: agent` child) are listed for
/// rehydration; a rebuild of an index without the worker columns fills them from the logs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_only_sessions_are_listed_and_a_rebuild_fills_the_worker_index() {
    let env = Env::new();
    let mut child = head("c1", "task", "t");
    child.header.insert("visibility".into(), json!("agent-only"));
    env.store.upsert(child, DirtyMark::Clear).await.unwrap();
    let mut legacy = head("c2", "task", "t");
    legacy.header.insert("owner".into(), json!("agent"));
    legacy.header.insert("parentSessionId".into(), json!("p1"));
    env.store.upsert(legacy, DirtyMark::Clear).await.unwrap();
    env.store.upsert(head("o1", "task", "t"), DirtyMark::Clear).await.unwrap();
    let listed: Vec<String> = env
        .store
        .agent_only_sessions()
        .await
        .unwrap()
        .iter()
        .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap()["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(listed, ["c1", "c2"]);

    let w = env.create("s1", None).await;
    let change = json!({"k":"meta","change":{"inline":{"set":{"worker":{"tag":"t1","parentSessionId":"p9"}},"unset":[]}}});
    let (w, _) = env.commit(w, vec![rec(change)]).await;
    drop(w);
    assert_eq!(ids(&env.store.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())).await.unwrap()), ["s1"]);

    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let db = other.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let old = rusqlite::Connection::open(&db).unwrap();
    old.execute_batch(crate::schema::sql::INDEX_DDL).unwrap();
    old.execute_batch(&format!(
        "DROP INDEX sessions_worker_tag; DROP INDEX sessions_worker_owner; DROP INDEX sessions_worker_pid;
         DROP INDEX sessions_workers; ALTER TABLE sessions DROP COLUMN worker_tag;
         PRAGMA user_version = {};",
        crate::schema::sql::INDEX_USER_VERSION - 1
    ))
    .unwrap();
    drop(old);
    let store = open_index(other.path()).unwrap();
    let rows = store.worker_rows(Some("t1"), crate::worker::WorkerScope::Owner("p9".into())).await.unwrap();
    assert_eq!(ids(&rows), ["s1"]);
    assert_eq!(rows[0].worker, *json!({"tag":"t1","parentSessionId":"p9"}).as_object().unwrap());
}

/// The catalog keeps the header's raw `title` (1.4.5 `readStoredSessionMetadata`:
/// `session.title || null`) beside the cleaned list title, and the rebuild of an index of
/// the previous version (no `title` column) fills it from the logs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_raw_title_is_kept_and_an_index_without_it_is_rebuilt_with_it() {
    let env = Env::new();
    let raw = "  Fix\nthe   build  ";
    env.store.upsert(head("s1", "task", raw), DirtyMark::Clear).await.unwrap();
    env.store.upsert(head("s2", "task", ""), DirtyMark::Clear).await.unwrap();
    assert_eq!(env.store.title("s1").await.unwrap().as_deref(), Some(raw));
    assert_eq!(env.store.title("s2").await.unwrap(), None);
    assert_eq!(env.store.title("absent").await.unwrap(), None);
    let listed: serde_json::Value = serde_json::from_str(&env.store.summary("s1").await.unwrap().unwrap()).unwrap();
    assert_eq!(listed["title"], "Fix the build");

    let w = env.create("s3", None).await;
    drop(w);
    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let db = other.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let old = rusqlite::Connection::open(&db).unwrap();
    old.execute_batch(crate::schema::sql::INDEX_DDL).unwrap();
    old.execute_batch(&format!(
        "ALTER TABLE sessions DROP COLUMN title; PRAGMA user_version = {};",
        crate::schema::sql::INDEX_USER_VERSION - 1
    ))
    .unwrap();
    drop(old);
    let store = open_index(other.path()).unwrap();
    // `session()` writes the header `{"title":"t"}`.
    assert_eq!(store.title("s3").await.unwrap().as_deref(), Some("t"));
}

/// The sessions whose reference set (`offloadSources`) names a session are one index read, with a copy still being
/// made by this boot (a mark another boot left is no copy in progress); a deleted one is not listed. A session whose
/// header holds no set, or one computed under earlier rules (no `offloadSourcesRules`: the review's `["sess_b"]` of a
/// transcript naming `TOOL-RESULTS/SESS_A/` too), is unknown, not empty, until a scan of its transcript at the ordinal
/// it is projected to is stored (a scan at another ordinal is not), and an earlier-rules set's rows stay (a set only
/// grows); a set taken out of a header leaves its session unknown and its rows kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_sessions_whose_reference_set_names_a_session_are_one_index_read() {
    let env = Env::new();
    let rules = crate::offload_sources::RULES;
    let with = |id: &str, fields: serde_json::Value| {
        let mut head = head(id, "task", "t");
        head.header.extend(fields.as_object().unwrap().clone());
        head
    };
    let known = |sources: serde_json::Value| json!({"offloadSources": sources, "offloadSourcesRules": rules});
    let mut marked = known(json!(["a"]));
    marked.as_object_mut().unwrap().extend([("offloadInheriting".to_owned(), json!("a")), ("offloadInheritingBoot".to_owned(), json!("this-boot"))]);
    env.store.upsert(with("c", known(json!(["a", "b"]))), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("h", marked), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("x", known(json!(["b"]))), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("e", known(json!([]))), DirtyMark::Clear).await.unwrap();
    let mut gone = known(json!(["a"]));
    gone.as_object_mut().unwrap().insert("deleted".to_owned(), json!(true));
    env.store.upsert(with("gone", gone), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("u", json!({})), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("o", json!({"offloadSources": ["b"]})), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("p", json!({"offloadSources": ["b"], "offloadSourcesRules": rules - 1})), DirtyMark::Clear).await.unwrap();
    let found = env.store.offload_referencers("a", "this-boot").await.unwrap();
    assert_eq!((found.sessions, found.copying), (vec!["c".to_owned(), "h".to_owned()], Some(("h".to_owned(), "a".to_owned()))));
    let unknown: Vec<&str> = found.unknown.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(unknown, ["o", "p", "u"], "the sessions holding no set or one of earlier rules are unknown");
    let at = found.unknown[2].1;
    for (id, ordinal) in &found.unknown[..2] {
        env.store.record_offload_scan(id, *ordinal, Vec::new()).await.unwrap();
    }
    assert_eq!(env.store.offload_referencers("a", "an-earlier-boot").await.unwrap().copying, None, "a mark another boot left");
    env.store.record_offload_scan("u", at + 1, vec!["a".into()]).await.unwrap();
    assert_eq!(env.store.offload_referencers("a", "this-boot").await.unwrap().unknown, [("u".to_owned(), at)], "a scan at another ordinal");
    env.store.record_offload_scan("u", at, vec!["a".into()]).await.unwrap();
    let found = env.store.offload_referencers("a", "this-boot").await.unwrap();
    assert_eq!((found.sessions, found.unknown), (vec!["c".to_owned(), "h".to_owned(), "u".to_owned()], Vec::new()));
    env.store.upsert(with("h", known(json!(["b"]))), DirtyMark::Clear).await.unwrap();
    env.store.upsert(with("c", json!({})), DirtyMark::Clear).await.unwrap();
    let found = env.store.offload_referencers("a", "this-boot").await.unwrap();
    assert_eq!((found.sessions, found.copying), (vec!["c".to_owned(), "u".to_owned()], None));
    assert_eq!(found.unknown.into_iter().map(|(id, _)| id).collect::<Vec<_>>(), ["c"]);
    // The earlier-rules sets of `o` and `p`, scanned to nothing, still count.
    assert_eq!(env.store.offload_referencers("b", "this-boot").await.unwrap().sessions, ["c", "h", "o", "p", "x"]);
}

/// The index holds no user data (FORMAT.md §8): a `user_version` 8 index (no `user_name` column) is not refused or altered, it is
/// rebuilt from the logs, and the rebuilt row carries the name the user gave, which only the log header held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_index_without_the_user_name_is_rebuilt_with_it() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let change = json!({"k":"meta","change":{"inline":{"set":{"title":"Mine","titleSource":"user"},"unset":[]}}});
    let (w, _) = env.commit(w, vec![rec(change)]).await;
    drop(w);
    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let db = other.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let old = rusqlite::Connection::open(&db).unwrap();
    old.execute_batch(crate::schema::sql::INDEX_DDL).unwrap();
    old.execute_batch(&format!("ALTER TABLE sessions DROP COLUMN user_name; PRAGMA user_version = {};", crate::schema::sql::INDEX_USER_VERSION - 1))
        .unwrap();
    drop(old);
    let store = open_index(other.path()).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(version, crate::schema::sql::INDEX_USER_VERSION);
    let name: Option<String> = conn.query_row("SELECT user_name FROM sessions WHERE id = 's1'", [], |r| r.get(0)).unwrap();
    assert_eq!(name.as_deref(), Some("Mine"));
    drop(store);
}

/// An index written before `message_rows` carried frame locations (`user_version` 1) is
/// never opened as it is: the open rebuilds it from the logs, equal to a fresh projection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_index_of_the_previous_shape_is_rebuilt_from_the_logs() {
    let env = Env::new();
    // A header without `updatedAt` takes the projection's clock (`Date.now()`), which two
    // projections never share.
    let dated = || rec(json!({"k":"meta","change":{"inline":{"set":{"updatedAt":1700000000000u64},"unset":[]}}}));
    let base = env.create("b0", None).await;
    let rewind = rec(json!({"k":"rewind","to_ordinal":3,"reason":"edit"}));
    let (base, _) = env.commit(base, vec![dated(), item("b1"), user("b2", "first ask"), rewind, item("b3")]).await;
    drop(base);
    let child = env.create("c0", Some(("b0", 4))).await;
    let (child, _) = env.commit(child, vec![dated()]).await;
    let (child, _) = env.commit(child, vec![user("c1", "second ask"), answer("c2")]).await;
    drop(child);
    let fresh = env.data.join("fresh.sqlite");
    project_index(&env.data, &fresh, &["b0".to_owned(), "c0".to_owned()]).unwrap();

    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let db = other.path().join(INDEX_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let old = rusqlite::Connection::open(&db).unwrap();
    old.execute_batch(crate::schema::sql::INDEX_DDL).unwrap();
    old.execute_batch(
        "ALTER TABLE message_rows DROP COLUMN file_no;
         ALTER TABLE message_rows DROP COLUMN frame_offset;
         ALTER TABLE message_rows DROP COLUMN frame_len;
         PRAGMA user_version = 1;",
    )
    .unwrap();
    drop(old);

    let store = open_index(other.path()).unwrap();
    let version: i32 = rusqlite::Connection::open(&db)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, crate::schema::sql::INDEX_USER_VERSION);
    let rebuilt = dump(&db);
    assert!(rebuilt.iter().any(|(t, rows)| t == "sessions" && rows.len() == 2));
    let want = dump(&fresh);
    for ((table, got), (_, want)) in rebuilt.iter().zip(&want) {
        assert_eq!(got, want, "{table}");
    }
    assert_eq!(rebuilt.len(), want.len());
    drop(store);
}

/// A rebuild over one log without a readable `session` frame and one with a bad frame in
/// the middle indexes every other session; the first is unlisted, the second keeps the
/// rows before its damage, and both carry their damage.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rebuild_marks_unreadable_logs_damaged_and_indexes_the_rest() {
    let env = Env::new();
    let b = env.create("b0", None).await;
    let (b, _) = env.commit(b, vec![user("b1", "ask"), answer("b2")]).await;
    drop(b);
    let y = env.create("y0", None).await;
    // Two writes: the damaged record is a write of its own (a damaged group is damaged whole, FORMAT.md §3.6).
    let (y, _) = env.commit(y, vec![user("y1", "kept"), answer("y2")]).await;
    let (y, _) = env.commit(y, vec![user("y3", "lost")]).await;
    drop(y);
    let z = env.create("z0", Some(("y0", 4))).await;
    drop(z);

    let other = tempfile::tempdir().unwrap();
    let sessions = other.path().join("sessions");
    copy_tree(&env.data.join("sessions"), &sessions);
    std::fs::create_dir_all(sessions.join("x0")).unwrap();
    std::fs::write(sessions.join("x0").join(log_name(0)), b"not a log\n").unwrap();
    let y_log = sessions.join("y0").join(log_name(0));
    let mut bytes = std::fs::read(&y_log).unwrap();
    let at = bytes.windows(4).rposition(|w| w == b"lost").unwrap();
    bytes[at] = b'L';
    std::fs::write(&y_log, bytes).unwrap();

    let store = open_index(other.path()).unwrap();
    for id in ["b0", "y0", "z0"] {
        assert!(store.summary(id).await.unwrap().is_some(), "{id}");
    }
    assert_eq!(store.summary("x0").await.unwrap(), None);
    let conn = rusqlite::Connection::open(other.path().join(INDEX_FILE)).unwrap();
    let state = |id: &str| -> (String, Option<serde_json::Value>, i64) {
        conn.query_row("SELECT status, damage, row_count FROM sessions WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.map(|d| serde_json::from_str(&d).unwrap()), r.get(2)?))
        })
        .unwrap()
    };
    assert_eq!(state("b0"), ("ok".into(), None, 2));
    let (status, damage, rows) = state("x0");
    let damage = damage.unwrap();
    assert_eq!((status.as_str(), rows), ("damaged", 0));
    assert_eq!(damage["path"], sessions.join("x0").join(log_name(0)).to_string_lossy().as_ref());
    assert!(!damage["error"].as_str().unwrap().is_empty());
    let (status, damage, rows) = state("y0");
    let damage = damage.unwrap();
    assert_eq!((status.as_str(), rows), ("damaged", 2));
    assert_eq!((damage["file_no"].as_u64(), damage["ordinal"].as_u64()), (Some(0), Some(3)));
    assert_eq!(damage["path"], y_log.to_string_lossy().as_ref());
    drop(store);
}

/// Through the writer's codec, so a long entry moves to a blob.
fn model_switch(iid: &str, ordinal: u64, model: &str, at: i64) -> Encoded {
    let record = json!({"k":"model_switch","anchor":{"iid":iid,"ordinal":ordinal},
        "entry":{"inline":{"provider":"openai","modelId":model,"at":at}}});
    crate::encode::encode_record(serde_json::from_value(record).unwrap()).unwrap()
}

/// The model ids of the boundaries on every divider of the lineage's display history.
async fn divider_switches(store: &SqliteStore, levels: Vec<LineageLevel>) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for level in 0..levels.len() {
        for d in store.dividers(levels.clone(), None, level, 0, u64::MAX).await.unwrap() {
            out.push((d.cid, d.model_switches.into_iter().map(|m| m.model_id).collect()));
        }
    }
    out
}

/// 1.4.5 anchors a switch on whatever message `modelSwitchAnchorIndex` picks, a compaction's
/// summary or context ack included, and bounds no model id. A boundary on a replacement
/// entry is the divider's: by entry position, then oldest level first, then record order;
/// it lives while the compaction does. A 300 KiB model id goes to a blob and reads back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_switches_anchor_on_a_compaction_entry_and_hold_any_model_id() {
    let env = Env::new();
    let w = env.create("s1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), user("b", "two")]).await;
    // The compaction at 3 replaces the context with a summary and an ack and keeps b.
    let compacted = rec(json!({"k":"compacted","cid":"k1","summary_iid":"sum","replacement":{"inline":[
        {"iid":"sum","body":{"role":"user","content":"summary"}},
        {"iid":"ack","body":{"role":"assistant","content":"."}},
        {"iid":"b","body":{"role":"user","content":"two"}}]}}));
    let (w, _) = env.commit(w, vec![compacted]).await;
    let long = "m".repeat(1000);
    let huge = "h".repeat(300 << 10);
    let big = model_switch("ack", 3, &huge, 80);
    assert_eq!(big.blobs().len(), 1, "a 300 KiB entry is a blob");
    let (w, _) = env.commit(
        w,
        vec![
            model_switch("ack", 3, "m1", 40),
            model_switch("sum", 3, "m2", 50),
            model_switch("zz", 3, "never", 60),
            model_switch("ack", 3, &long, 70),
            big,
        ],
    )
    .await;
    let base = || lineage(&[("s1", None)]);
    // The anchor ordinal of a replacement entry is its frame's; a plain row has none.
    let entry = |levels: Vec<LineageLevel>, iid: &str| {
        let (store, iid) = (env.store.clone(), iid.to_owned());
        async move { store.compaction_entry(levels, None, iid).await.unwrap().map(|e| (e.ordinal, e.cid)) }
    };
    let k1 = Some((3, "k1".to_owned()));
    assert_eq!(
        (entry(base(), "sum").await, entry(base(), "ack").await, entry(base(), "a").await, entry(base(), "zz").await),
        (k1.clone(), k1.clone(), None, None)
    );
    let all = |first: &[&str]| first.iter().map(|m| m.to_string()).chain([long.clone(), huge.clone()]).collect::<Vec<_>>();
    assert_eq!(divider_switches(&env.store, base()).await, [("k1".to_owned(), all(&["m2", "m1"]))]);
    // A replacement entry has no history row: no row carries these boundaries.
    let (rows, _) = env.store.history_page(base(), None, None, 50).await.unwrap();
    assert!(rows.iter().all(|r| r.model_switches.is_empty()));
    // A fork at 9 sees the base's up to its fork point, then its own; the base's later one
    // (9) is not the fork's.
    let (w, _) = env.commit(w, vec![model_switch("sum", 3, "m5", 90)]).await;
    let child = env.create("c0", Some(("s1", 9))).await;
    let (child, _) = env.commit(child, vec![model_switch("sum", 3, "m4", 100)]).await;
    let fork = || lineage(&[("c0", None), ("s1", Some(9))]);
    assert_eq!(divider_switches(&env.store, fork()).await, [("k1".to_owned(), all(&["m2", "m4", "m1"]))]);
    assert_eq!(entry(fork(), "sum").await, k1, "a fork finds its base's summary");
    assert_eq!(divider_switches(&env.store, base()).await, [("k1".to_owned(), all(&["m2", "m5", "m1"]))]);
    // A rebuild from the logs reads the same, the blob entry included.
    let expected = (divider_switches(&env.store, base()).await, divider_switches(&env.store, fork()).await);
    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let blobs = crate::schema::blob::BLOB_DIR;
    copy_tree(&env.data.join(blobs), &other.path().join(blobs));
    let rebuilt = open_index(other.path()).unwrap();
    assert_eq!((divider_switches(&rebuilt, base()).await, divider_switches(&rebuilt, fork()).await), expected);
    // A rewind before the compaction removes its divider and its boundaries.
    let (w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":3,"reason":"edit"}))]).await;
    assert!(divider_switches(&env.store, base()).await.is_empty());
    assert_eq!(entry(base(), "sum").await, None, "a rewound compaction holds no entry");
    drop((w, child));
}

/// Each page row with the model ids of its boundaries.
fn switched(rows: &[HistoryRow]) -> Vec<(String, Vec<String>)> {
    rows.iter()
        .map(|r| (r.iid.clone(), r.model_switches.iter().map(|m| m.model_id.as_str().to_owned()).collect()))
        .collect()
}

/// A `model_switch` belongs to its anchor row (the 1.4.5 anchor message's
/// `meta.modelSwitches`): shown on that row while it is live, through a rewind that covers
/// the record but keeps the anchor (a retry), in a fork up to its fork point and past a cut
/// that keeps the anchor; gone with the anchor. It is no history row, and a rebuild from the
/// logs gives the same pages.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_switches_follow_their_anchor_row() {
    let env = Env::new();
    let page = |levels: Vec<LineageLevel>, cut: Option<u64>| {
        let store = env.store.clone();
        async move { switched(&store.history_page(levels, cut, None, 50).await.unwrap().0) }
    };
    let row = |iid: &str, models: &[&str]| (iid.to_owned(), models.iter().map(|m| m.to_string()).collect::<Vec<_>>());
    let base = || lineage(&[("b0", None)]);
    let w = env.create("b0", None).await;
    // a1 (1) answered; p1 (2) the trailing prompt: the switches (3, 4) anchor on a1.
    let (w, _) = env.commit(w, vec![item("a1"), item("p1")]).await;
    let (w, _) = env.commit(w, vec![model_switch("a1", 1, "m1", 10), model_switch("a1", 1, "m2", 20)]).await;
    let rows = env.store.history_page(base(), None, None, 50).await.unwrap().0;
    assert_eq!(
        serde_json::to_value(&rows[1].model_switches).unwrap(),
        json!([{"provider":"openai","modelId":"m1","at":10}, {"provider":"openai","modelId":"m2","at":20}])
    );
    // A retry rewinds the prompt (5) over the switch records; the anchor and its boundaries stay.
    let rewind = rec(json!({"k":"rewind","to_ordinal":2,"reason":"rewind"}));
    let (w, _) = env.commit(w, vec![rewind, item("p2")]).await;
    assert_eq!((w.fold().rows, w.fold().visible_rows), (2, 2));
    // 7 names an iid that is not row 6's: never shown. 8 anchors on p2.
    let (w, _) = env.commit(w, vec![model_switch("zz", 6, "m3", 30), model_switch("p2", 6, "m5", 50)]).await;
    assert_eq!(page(base(), None).await, [row("p2", &["m5"]), row("a1", &["m1", "m2"])]);
    // A fork at 9; the base's later switch (9) is not the fork's, the fork's own (11) not the base's.
    let (w, _) = env.commit(w, vec![model_switch("a1", 1, "m6", 60)]).await;
    let child = env.create("c0", Some(("b0", 9))).await;
    let (child, _) = env.commit(child, vec![item("c1"), model_switch("a1", 1, "m7", 70)]).await;
    let fork = || lineage(&[("c0", None), ("b0", Some(9))]);
    assert_eq!(page(fork(), None).await, [row("c1", &[]), row("p2", &["m5"]), row("a1", &["m1", "m2", "m7"])]);
    assert_eq!(page(base(), None).await, [row("p2", &["m5"]), row("a1", &["m1", "m2", "m6"])]);
    // The fork rewinds into the base range (12): p2 is cut, a1 keeps every boundary.
    let rewind = rec(json!({"k":"rewind","to_ordinal":6,"reason":"edit"}));
    let (child, _) = env.commit(child, vec![rewind]).await;
    let cut = child.fold().base_cut;
    assert_eq!(page(fork(), cut).await, [row("a1", &["m1", "m2", "m7"])]);
    // A rewind that removes the anchor removes its boundaries; a new row with its iid has none.
    let rewind = rec(json!({"k":"rewind","to_ordinal":1,"reason":"edit"}));
    let (w, _) = env.commit(w, vec![rewind, item("a1")]).await;
    assert_eq!(page(base(), None).await, [row("a1", &[])]);
    assert_eq!(page(fork(), cut).await, [row("a1", &["m1", "m2", "m7"])], "the fork's view is its own");
    // A boundary must anchor on an earlier row.
    let (w, refused) = env.append(w, vec![model_switch("a1", 12, "m8", 80)]).await;
    assert!(refused.is_err(), "anchor at its own ordinal");
    let expected = (page(base(), None).await, page(fork(), cut).await);
    drop((w, child));
    // A rebuild from the logs projects the same boundaries.
    let other = tempfile::tempdir().unwrap();
    copy_tree(&env.data.join("sessions"), &other.path().join("sessions"));
    let rebuilt = open_index(other.path()).unwrap();
    let pages = (
        switched(&rebuilt.history_page(base(), None, None, 50).await.unwrap().0),
        switched(&rebuilt.history_page(fork(), cut, None, 50).await.unwrap().0),
    );
    assert_eq!(pages, expected);
}

fn session_list_golden() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-list/golden.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// `isLeadVisibleRow` over the list rows Node's `_sessionSummary` built (preview and message
/// count included).
#[test]
fn the_lead_visibility_predicate_equals_nodes() {
    use crate::sqlite::lead::is_lead_visible_row;
    let golden = session_list_golden();
    for entry in golden["sessions"].as_array().unwrap() {
        let summary = entry["summary"].as_object().unwrap();
        assert_eq!(is_lead_visible_row(summary), entry["leadVisible"], "{}", entry["record"]["id"]);
    }
}

/// `decodeCatalogCursor` / `encodeCatalogCursor`: accepted and refused cursors, and the cursor Node
/// names after a row.
#[test]
fn catalog_cursors_equal_nodes() {
    use crate::sqlite::lead::{decode_catalog_cursor, encode_catalog_cursor};
    let golden = session_list_golden();
    for case in golden["cursors"].as_array().unwrap() {
        let got = decode_catalog_cursor(case["cursor"].as_str());
        match case.get("error") {
            Some(_) => assert!(got.is_err(), "{}", case["cursor"]),
            None => {
                let want = case["decoded"].as_object().map(|d| (d["activity"].as_f64().unwrap(), d["id"].as_str().unwrap().to_owned()));
                assert_eq!(got.unwrap().map(|c| (c.activity, c.id)), want, "{}", case["cursor"]);
            }
        }
    }
    for walk in golden["walks"].as_array().unwrap() {
        for page in walk["pages"].as_array().unwrap() {
            let Some(next) = page["nextCursor"].as_str() else { continue };
            let after = decode_catalog_cursor(Some(next)).unwrap().unwrap();
            let last = golden["sessions"].as_array().unwrap().iter().find(|s| s["record"]["id"].as_str() == Some(after.id.as_str()));
            let row = last.unwrap()["summary"].as_object().unwrap();
            assert_eq!(encode_catalog_cursor(row), next);
        }
    }
}

/// The pages `listStoredSessionSummaryPage` answers: order, the limit rules, `nextCursor`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lead_pages_equal_nodes() {
    use crate::sqlite::lead::decode_catalog_cursor;
    use crate::sqlite::lead::encode_catalog_cursor;
    let env = Env::new();
    let golden = session_list_golden();
    for entry in golden["sessions"].as_array().unwrap() {
        let mut header = entry["record"].as_object().unwrap().clone();
        header.remove("messages");
        let id = header["id"].as_str().unwrap().to_owned();
        env.store.upsert(CatalogHead { session: id, log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.unwrap();
    }
    for walk in golden["walks"].as_array().unwrap() {
        // `listStoredSessionSummaryPage`: `floor(Number(limit))`, 1..=1000, else 50.
        let size = match walk["limit"].as_f64().map(f64::floor) {
            Some(n) if n > 0.0 => n.min(1000.0) as usize,
            _ => 50,
        };
        for page in walk["pages"].as_array().unwrap() {
            let after = decode_catalog_cursor(page["cursor"].as_str()).unwrap();
            let got = env.store.lead_page(after, crate::sqlite::lead::LeadFilter::default(), size).await.unwrap();
            let ids: Vec<&str> = got.rows.iter().map(|r| r.row["id"].as_str().unwrap()).collect();
            let want: Vec<&str> = page["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(ids, want, "limit {} cursor {}", walk["limit"], page["cursor"]);
            let next = got.more.then(|| encode_catalog_cursor(&got.rows.last().unwrap().row));
            assert_eq!(next.as_deref(), page["nextCursor"].as_str());
        }
    }
}
/// `thread/list`'s `archived` and `cwd` filters apply before the page is cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lead_pages_filter_before_they_are_cut() {
    use crate::sqlite::lead::LeadFilter;
    let env = Env::new();
    for (id, updated, cwd, archived_at) in [("f1", 30, "C:/a", 5), ("f2", 20, "C:/b", 0), ("f3", 10, "C:/a", 0)] {
        let mut h = head(id, "task", "Title");
        h.header.insert("updatedAt".into(), updated.into());
        h.header.insert("cwd".into(), cwd.into());
        if archived_at > 0 {
            h.header.insert("archivedAt".into(), archived_at.into());
        }
        env.store.upsert(h, DirtyMark::Clear).await.unwrap();
    }
    let ids = |page: crate::sqlite::lead::LeadPage| page.rows.iter().map(|r| r.row["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let all = env.store.lead_page(None, LeadFilter::default(), 10).await.unwrap();
    assert_eq!(ids(all), ["f1", "f2", "f3"]);
    let live = env.store.lead_page(None, LeadFilter { archived: Some(false), cwd: None }, 10).await.unwrap();
    assert_eq!(ids(live), ["f2", "f3"]);
    let archived = env.store.lead_page(None, LeadFilter { archived: Some(true), cwd: None }, 10).await.unwrap();
    assert_eq!((ids(archived.clone()), archived.rows[0].archived), (vec!["f1".to_owned()], true));
    let here = env.store.lead_page(None, LeadFilter { archived: Some(false), cwd: Some("C:/a".into()) }, 1).await.unwrap();
    assert_eq!((ids(here.clone()), here.more), (vec!["f3".to_owned()], false));
    let cut = env.store.lead_page(None, LeadFilter { archived: None, cwd: Some("C:/a".into()) }, 1).await.unwrap();
    assert_eq!((ids(cut.clone()), cut.more), (vec!["f1".to_owned()], true));
}

/// The header of a session as the sweep and the heartbeat's catalog read it.
fn listed_head(id: &str, fields: serde_json::Value) -> CatalogHead {
    let mut header = fields.as_object().unwrap().clone();
    header.insert("id".into(), json!(id));
    CatalogHead { session: id.into(), log_id: LOG_ID.into(), base_session: None, header }
}

/// One query lists every session with the fields the idle sweep decides from (its owner, status,
/// timestamps, activity baseline, message count) and its newest log file's mtime; the heartbeat's
/// catalog reads the same listing without the agent-only sessions, in pages.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_listing_serves_the_idle_sweep_and_the_heartbeat_catalog() {
    use crate::sqlite::listing::RecordStamp;
    use crate::sqlite::lead::{decode_catalog_cursor, encode_catalog_cursor};
    let env = Env::new();
    let w = env.create("l1", None).await;
    let (w, _) = env.commit(w, vec![user("a", "one"), answer("b")]).await;
    drop(w);
    drop(env.create("l2", None).await);
    drop(env.create("l3", None).await);
    env.store
        .upsert(
            listed_head("l1", json!({"owner": "cli", "status": "running", "createdAt": 100, "updatedAt": 200, "lastHeartbeatAt": 300, "sourceName": "agent:mixy@run"})),
            DirtyMark::Keep,
        )
        .await
        .unwrap();
    env.store
        .upsert(listed_head("l2", json!({"owner": "agent", "visibility": "agent-only", "createdAt": 120, "updatedAt": 150})), DirtyMark::Keep)
        .await
        .unwrap();
    env.store.upsert(listed_head("l3", json!({"createdAt": 90, "updatedAt": 100, "closed": true})), DirtyMark::Keep).await.unwrap();
    let log = |id: &str| env.dir(id).join(log_name(0));
    std::fs::File::options().write(true).open(log("l1")).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(5000)).unwrap();
    std::fs::remove_file(log("l3")).unwrap();

    let swept = env.store.sweep_sessions(env.data.join("sessions")).await.unwrap();
    let by = |id: &str| swept.iter().find(|s| s.id == id).unwrap().clone();
    assert_eq!(swept.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["l1", "l2", "l3"], "agent-only sessions are swept too");
    let l1 = by("l1");
    assert_eq!(
        (l1.owner.as_str(), l1.status.as_str(), l1.closed, l1.created_at, l1.updated_at, l1.last_heartbeat_at, l1.activity, l1.message_count, l1.record),
        ("cli", "running", false, 100, 200, 300, 300, 2, RecordStamp::At(5_000_000)),
    );
    assert_eq!(by("l2").owner, "agent");
    let l3 = by("l3");
    assert_eq!((l3.owner.as_str(), l3.status.as_str(), l3.closed, l3.record), ("user", "closed", true, RecordStamp::Absent), "no owner lists as the summary row's 'user'");

    let ids = |rows: Vec<crate::sqlite::listing::Listed>| rows.iter().map(|r| r.row["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let first = env.store.list_sessions(false, None, Some(1)).await.unwrap();
    assert_eq!(first[0].row["sourceName"], "agent:mixy@run");
    let cursor = encode_catalog_cursor(&first[0].row);
    assert_eq!(ids(first), ["l1"]);
    let rest = env.store.list_sessions(false, decode_catalog_cursor(Some(&cursor)).unwrap(), None).await.unwrap();
    assert_eq!(ids(rest), ["l3"], "agent-only l2 is left out of the catalog");
    assert_eq!(ids(env.store.list_sessions(true, None, None).await.unwrap()), ["l1", "l2", "l3"]);
}
/// The sweep's conversation count is Node's `conversationCountOf`: user and assistant messages only
/// (`message_rows.counted`, the rule `messageCount` is kept by), never tool or system ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_listed_message_count_is_the_user_and_assistant_messages() {
    let env = Env::new();
    let w = env.create("c1", None).await;
    let (_w, _) = env
        .commit(
            w,
            vec![
                message("u1", json!({"role":"user","content":"hi"})),
                message("t1", json!({"role":"assistant","content":"plan","toolCalls":[{"id":"c1"}]})),
                message("r1", json!({"role":"tool","content":"out","toolCallId":"c1"})),
                message("s1", json!({"role":"system","content":"note"})),
                message("a1", json!({"role":"assistant","content":"done"})),
            ],
        )
        .await;
    let swept = env.store.sweep_sessions(env.data.join("sessions")).await.unwrap();
    assert_eq!(swept[0].message_count, 3);
}
