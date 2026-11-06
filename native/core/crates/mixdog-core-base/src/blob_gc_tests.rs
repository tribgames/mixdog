use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_store::blobs::BlobStore;
use mixdog_store::blobs::digest_of;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::state::CoreState;

use crate::blob_gc::BlobGc;
use crate::blob_gc::DEFAULT_MIN_AGE;
use crate::blob_gc::SPACING_MS;
use crate::blob_gc::STAMP_KEY;

async fn open_store(data: &std::path::Path) -> SqliteStore {
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .unwrap()
    .await
    .unwrap()
    .unwrap()
}

async fn gc(data: &std::path::Path) -> (std::sync::Arc<BlobGc>, BlobStore, CoreState) {
    let tokens = mixdog_rt::testing::tokens();
    let store = open_store(data).await;
    let (state, _) = CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &data.join("core.sqlite")).unwrap();
    let blobs = BlobStore::new(data);
    (BlobGc::new(blobs.clone(), store, state.clone(), tokens.maintenance_io, DEFAULT_MIN_AGE), blobs, state)
}

/// Publishes `bytes` as a blob (nothing references it) and returns its path.
async fn put(blobs: &BlobStore, bytes: &[u8]) -> std::path::PathBuf {
    let path = blobs.path(&digest_of(bytes));
    let (store, bytes) = (blobs.clone(), bytes.to_vec());
    LaneToken::submit(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
        drop(store.put(lane, &bytes).unwrap());
    })
    .unwrap()
    .await
    .unwrap();
    path
}

async fn present(path: &std::path::Path) -> bool {
    let path = path.to_path_buf();
    LaneToken::submit(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
        mixdog_statefile::metadata(lane, &path).is_ok()
    })
    .unwrap()
    .await
    .unwrap()
}

/// An unreferenced blob goes once it is older than the minimum age and not before; a finished
/// census is stamped, and no second one runs within the spacing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_old_unreferenced_blob_is_collected_once_per_spacing() {
    let dir = tempfile::tempdir().unwrap();
    let (gc, blobs, state) = gc(dir.path()).await;
    let path = put(&blobs, b"orphan attachment").await;
    let cancel = CancellationToken::new();
    let now = SystemTime::now();
    assert!(gc.collect(now, &cancel).await.unwrap().is_empty(), "fresh blobs stay");
    assert!(present(&path).await);

    let later = now + DEFAULT_MIN_AGE + Duration::from_secs(24 * 3600);
    let first = gc.run_if_due(1_000_000, later, &cancel).await.unwrap().expect("no stamp yet: the census runs");
    assert_eq!(first, [digest_of(b"orphan attachment")]);
    assert!(!present(&path).await);
    assert_eq!(state.meta(STAMP_KEY).await.unwrap().as_deref(), Some("1000000"));

    let again = put(&blobs, b"another orphan").await;
    assert_eq!(gc.run_if_due(1_000_000 + SPACING_MS - 1, later, &cancel).await.unwrap(), None, "within the spacing");
    assert!(present(&again).await);
    let after = gc.run_if_due(1_000_000 + SPACING_MS, later, &cancel).await.unwrap().expect("the spacing is over");
    assert_eq!(after, [digest_of(b"another orphan")]);
}

/// A trigger arms one census `START_DELAY` later and stamps it; a shutdown before then runs none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trigger_runs_one_census_after_the_delay_unless_shut_down_first() {
    let dir = tempfile::tempdir().unwrap();
    let (gc, _blobs, state) = gc(dir.path()).await;
    let clock: crate::maintenance::Clock = std::sync::Arc::new(|| 5_000_000);
    let on_error: crate::maintenance::ErrorSink = std::sync::Arc::new(|error| panic!("{error}"));

    let stopped = CancellationToken::new();
    gc.schedule(clock.clone(), on_error.clone(), stopped.clone());
    stopped.cancel();
    tokio::time::sleep(crate::blob_gc::START_DELAY + Duration::from_secs(1)).await;
    assert_eq!(state.meta(STAMP_KEY).await.unwrap(), None, "cancelled before the delay");

    gc.schedule(clock, on_error, CancellationToken::new());
    tokio::time::sleep(crate::blob_gc::START_DELAY + Duration::from_secs(1)).await;
    assert_eq!(state.meta(STAMP_KEY).await.unwrap().as_deref(), Some("5000000"));
}

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

/// A blob a real session log references (written by the store's log writer and projected into
/// the index) survives a census run long after it was written, while an unreferenced blob of
/// the same age goes: the liveness answer comes from the store, not from the test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blob_a_stored_session_references_survives_the_census() {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::encode::Encoded;
    use mixdog_store::encode::PendingBlob;
    use mixdog_store::log::LogWriter;
    use mixdog_store::log::OsIo;
    use mixdog_store::log::WriterDeps;
    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::summary::CatalogHead;
    use serde_json::json;

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let (gc, blobs, _state) = gc(dir.path()).await;
    let store = open_store(dir.path()).await;
    let kept_bytes = b"attachment a stored message points at".to_vec();
    let kept = PendingBlob { digest: digest_of(&kept_bytes), bytes: kept_bytes };
    let record = json!({"k":"item","iid":"a","role":"user","form":"message","model":true,"visible":true,
        "refs":[kept.digest.as_str()],"body":{"inline":{"content":"a","role":"user"}}});
    let item = Encoded::new(serde_json::from_value(record).unwrap(), vec![kept.clone()]).unwrap();
    let header = json!({"id":"s1","title":"t","updatedAt":1,"desktopSession":{"classification":"task","projectPath":"/p"}});
    let head = CatalogHead { session: "s1".into(), log_id: LOG_ID.into(), base_session: None, header: header.as_object().unwrap().clone() };
    store.upsert(head, DirtyMark::Set).await.unwrap();
    let session = Encoded::new(
        serde_json::from_value(json!({"k":"session","v":2,"id":"s1","log_id":LOG_ID,"header":{"inline":{"title":"t"}}})).unwrap(),
        Vec::new(),
    )
    .unwrap();
    let deps = WriterDeps { io: Arc::new(OsIo), blobs: blobs.clone(), ownership: Arc::new(MockOwnership::default()), index: Arc::new(store.clone()) };
    let log_dir = dir.path().join("sessions").join("s1");
    let create_deps = deps.clone();
    let (writer, created) = LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        LogWriter::create(lane, &log_dir, session, create_deps).unwrap()
    })
    .unwrap()
    .await
    .unwrap();
    store.project(created.projection).await.unwrap();
    let acked = LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        let mut writer = writer;
        let acked = writer.append_barrier(lane, vec![item]).unwrap();
        drop(writer);
        acked
    })
    .unwrap()
    .await
    .unwrap();
    store.project(acked.projection).await.unwrap();

    let orphan = put(&blobs, b"attachment nothing points at").await;
    let kept_path = blobs.path(&kept.digest);
    assert!(present(&kept_path).await && present(&orphan).await);
    let deleted = gc.collect(SystemTime::now() + DEFAULT_MIN_AGE + Duration::from_secs(24 * 3600), &CancellationToken::new()).await.unwrap();
    assert_eq!(deleted, [digest_of(b"attachment nothing points at")]);
    assert!(present(&kept_path).await, "referenced by s1's log");
    assert!(!present(&orphan).await);
}
