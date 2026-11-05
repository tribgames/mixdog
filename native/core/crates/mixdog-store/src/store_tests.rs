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
        let store = SqliteStore::open(tokens().sqlite_writer_thread, tokens().interactive_io, &data.join("store.sqlite")).unwrap();
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
    rec(json!({"k":"item","iid":iid,"role":"user","form":"message","model":true,"visible":true,"prompt":text,
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
    let db = env.data.join("store.sqlite");
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
    assert_eq!(hit("changed").await, [after.clone()]);
    assert_eq!(hit("wo").await, [after.clone()]);
    assert!(hit("ünïcode spec").await.is_empty(), "the old title fold was replaced");
    assert_eq!(hit("").await, [after.clone()], "chat rows are not searchable");
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
    let title_fold: String = rusqlite::Connection::open(env.data.join("store.sqlite"))
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
    let dividers = env.store.dividers(lineage(&[("s1", None)]), None, 0, u64::MAX).await.unwrap();
    assert_eq!(dividers.iter().map(|d| (d.cid.as_str(), d.boundary, d.pos.ordinal)).collect::<Vec<_>>(), [("k1", 3, 5)]);
    // Rewinding before the compaction removes both the divider and the marks.
    let (_w, _) = env.commit(w, vec![rec(json!({"k":"rewind","to_ordinal":5,"reason":"edit"}))]).await;
    assert!(env.store.dividers(lineage(&[("s1", None)]), None, 0, u64::MAX).await.unwrap().is_empty());
    assert!(page(&env).await.iter().all(|r| !r.archived));
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
        crate::message_index::add_item(&tx, "s", i + 1, &format!("m{i}"), &message(&format!("text {i}"))).unwrap();
    }
    let before = tx.total_changes();
    crate::message_index::amend(&tx, "s", "m0", 2001, &message("edited")).unwrap();
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
    let conn = rusqlite::Connection::open(env.data.join("store.sqlite")).unwrap();
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
