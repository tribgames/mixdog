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
        self.store.upsert(head(id, "task", "Title"), DirtyMark::Set).await.unwrap();
        let (dir, deps, rec) = (self.dir(id), self.deps(), session(id, base));
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_rows_equal_nodes_session_summary_on_the_corpus() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/migration/session-summary/summaries.json"
    ))
    .unwrap();
    let root = corpus_root();
    assert!(root.join("v145").is_dir(), "the migration corpus is missing at {}; set MIXDOG_MIGRATION_CORPUS", root.display());
    let mut bad = Vec::new();
    let entries = fixture["sessions"].as_array().unwrap();
    assert!(entries.len() > 50);
    for entry in entries {
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

/// The whole model context of `levels`, read in pages of `limit` rows through the four
/// lane steps.
async fn model_context(env: &Env, levels: Vec<LineageLevel>, cut: Option<u64>, limit: usize) -> Vec<(String, String)> {
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
        out.extend(messages.into_iter().map(|m| (m.iid, m.body["content"].as_str().unwrap_or_default().to_owned())));
        match next {
            Some(c) => cursor = Some(c),
            None => return out,
        }
    }
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
    let (y, _) = env.commit(y, vec![user("y1", "kept"), answer("y2"), user("y3", "lost")]).await;
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
