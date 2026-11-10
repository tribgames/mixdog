//! Memory start: the stored model identity, and the started stack end to end.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use crate::memory::boot::{MemoryBoot, MemoryStack};
use crate::memory::embed::config::{self, DEFAULT_MODEL_ID};
use crate::memory::runtime::RuntimeFlags;
use crate::memory::sensitive::SensitiveStore;
use crate::memory::session_search::ingest::IngestSession;

/// `_initStore`'s dimensions: the saved measurement of this identity wins (a model the profiles do
/// not list opens without being loaded), then the profile; an unlisted model with no saved
/// measurement has no source without the model.
#[tokio::test(flavor = "multi_thread")]
async fn dimensions_come_from_the_saved_measurement_then_the_profile() {
    use crate::memory::boot::resolve_dims;
    let lane = mixdog_rt::testing::tokens().durability_io;
    let dir = tempfile::tempdir().expect("dir");
    let unlisted = config::identity(None, "acme/unlisted", None);

    let err = resolve_dims(dir.path(), lane, &unlisted, "acme/unlisted", None).await.expect_err("no source");
    assert!(err.message().contains("embedding dims unavailable without an embedding model"), "{}", err.message());

    let mut saved = unlisted.clone();
    saved["dims"] = json!(777);
    std::fs::write(dir.path().join("embedding-meta.json"), saved.to_string()).expect("write");
    assert_eq!(resolve_dims(dir.path(), lane, &unlisted, "acme/unlisted", None).await.expect("saved"), 777);

    // The saved value belongs to its identity: another dtype is another measurement.
    let other = config::identity(None, "acme/unlisted", Some("q8"));
    assert!(resolve_dims(dir.path(), lane, &other, "acme/unlisted", None).await.is_err());

    // A listed model needs no measurement.
    let listed = config::identity(None, DEFAULT_MODEL_ID, None);
    assert_eq!(resolve_dims(dir.path(), lane, &listed, DEFAULT_MODEL_ID, None).await.expect("profile"), 384);
}

/// A start that fails after the postmaster is up stops it before the error leaves (`pg_ctl stop`), and one that succeeds does not.
#[tokio::test(start_paused = true)]
async fn a_failed_open_over_a_running_cluster_stops_the_cluster() {
    use crate::memory::boot::release_on_failure;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let stopped = AtomicUsize::new(0);
    let release = || async { stopped.fetch_add(1, Ordering::SeqCst); };

    let failed: Result<(), &str> = release_on_failure(async { Err("schema") }, release()).await;
    assert_eq!(failed, Err("schema"), "the open's own error is the one returned");
    assert_eq!(stopped.load(Ordering::SeqCst), 1);

    let opened: Result<u8, &str> = release_on_failure(async { Ok(1) }, release()).await;
    assert_eq!(opened, Ok(1));
    assert_eq!(stopped.load(Ordering::SeqCst), 1, "a good open keeps the cluster");
}

/// Node's `metaKey` (`index.mjs` `_initStore`), which `openDatabase` stores as
/// `embedding.current_model`; the same key under Node must not reset the vectors.
#[test]
fn the_stored_model_identity_is_nodes_meta_key() {
    assert_eq!(
        config::identity(None, DEFAULT_MODEL_ID, None),
        json!({ "provider": null, "model": "Xenova/multilingual-e5-small", "dtype": "q8", "format": "mixdog-embedding-v3" }),
    );
    assert_eq!(
        config::identity(Some("local"), "Xenova/bge-m3", Some("Q4 ")),
        json!({ "provider": "local", "model": "Xenova/bge-m3", "dtype": "q4", "format": "mixdog-embedding-v3" }),
    );
}

/// One deadline for a thing a test waits for, so a hang fails naming it instead of stalling the suite.
async fn within<T>(what: &str, waited: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(5), waited).await.unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

/// Node starts the memory runtime at the first memory call, never at daemon boot (`registerMemoryRuntimeLazy`, `daemon.mjs:202`), and its ready signal does not wait
/// for PostgreSQL: a fresh profile must not download or initialise anything while the stack is built, and a data directory that holds a cluster opens it only
/// when the host asks for the background start. Neither the install nor the start needs a network or a postmaster here: the install is a counter that fails.
#[tokio::test(flavor = "multi_thread")]
async fn a_stack_installs_and_starts_nothing_until_the_database_is_used() {
    use crate::memory::boot::PgRuntimeSource;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let installs = Arc::new(AtomicUsize::new(0));
    let dir = tempfile::tempdir().expect("dir");
    let counted = installs.clone();
    let stack = MemoryStack::start(MemoryBoot {
        data_dir: dir.path().to_owned(),
        pg_runtime: PgRuntimeSource::Install(Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(crate::memory::error::MemoryError::Runtime("no network in this test".to_owned())) })
        })),
        embedder: None,
        embedding_provider: None,
        flags: RuntimeFlags::default(),
        progress: None,
        sensitive: Arc::new(SensitiveStore::default()),
        lane: mixdog_rt::testing::tokens().durability_io,
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        transcripts: None,
        cycles: None,
        backfill: None,
        processes: crate::tidy::process::Processes::for_tests(),
        cancel: tokio_util::sync::CancellationToken::new(),
    })
    .await
    .expect("the stack is built without a database");
    assert_eq!(installs.load(Ordering::SeqCst), 0, "building the stack installs nothing");

    // A fresh profile has no cluster: the background start has nothing to open.
    within("the background start on a fresh profile to decide", stack.open_in_background()).await.expect("the background task");
    assert_eq!(installs.load(Ordering::SeqCst), 0, "no cluster on disk, so no background start");

    // The first use opens the database, and a failed opening is tried again by the next use.
    assert!(stack.db().client().await.is_err());
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    assert!(stack.db().client().await.is_err());
    assert_eq!(installs.load(Ordering::SeqCst), 2);

    // A cluster on disk is opened by the background start.
    std::fs::create_dir_all(dir.path().join("pgdata")).expect("pgdata");
    std::fs::write(dir.path().join("pgdata").join("PG_VERSION"), "16\n").expect("version");
    within("the background start of an existing cluster to end", stack.open_in_background()).await.expect("the background task");
    assert_eq!(installs.load(Ordering::SeqCst), 3, "an existing cluster starts after ready");

    stack.stop().await.expect("a stack that never opened has nothing to stop");
}

/// Two first uses while the runtime is still downloading share the one install (Node's callers all await the one `initPromise`, `http-router.mjs:34-46`), wait for
/// it rather than fail, and both see its outcome; a stop while it is held ends it and starts nothing.
///
/// The runtime is current-thread, so the order is the scheduler's: both uses are spawned before the test waits, the first is polled first and raises `entered` from inside
/// the install, and the second, queued before the test's own wake-up, has been polled (and is parked on the one opening) by the time the test resumes.
#[tokio::test]
async fn two_first_uses_share_one_install_and_a_stop_ends_it() {
    use crate::memory::boot::PgRuntimeSource;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let installs = Arc::new(AtomicUsize::new(0));
    let (entered, mut entries) = tokio::sync::mpsc::unbounded_channel::<()>();
    let dir = tempfile::tempdir().expect("dir");
    let (counted, signal) = (installs.clone(), entered);
    let stack = MemoryStack::start(MemoryBoot {
        data_dir: dir.path().to_owned(),
        // The install is held until the stack's own cancel (what `stop` raises) releases it, as a download in progress is.
        pg_runtime: PgRuntimeSource::Install(Arc::new(move |cancel| {
            counted.fetch_add(1, Ordering::SeqCst);
            signal.send(()).expect("the test listens");
            Box::pin(async move {
                cancel.cancelled().await;
                Err(crate::memory::error::MemoryError::Runtime("cancelled".to_owned()))
            })
        })),
        embedder: None,
        embedding_provider: None,
        flags: RuntimeFlags::default(),
        progress: None,
        sensitive: Arc::new(SensitiveStore::default()),
        lane: mixdog_rt::testing::tokens().durability_io,
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        transcripts: None,
        cycles: None,
        backfill: None,
        processes: crate::tidy::process::Processes::for_tests(),
        cancel: tokio_util::sync::CancellationToken::new(),
    })
    .await
    .expect("stack");
    let (first, second) = (stack.db(), stack.db());
    let one = tokio::spawn(async move { first.client().await.is_err() });
    let two = tokio::spawn(async move { second.client().await.is_err() });
    within("the first use to enter the install", entries.recv()).await.expect("the install was entered");
    assert!(!one.is_finished() && !two.is_finished(), "both uses wait for the install");
    assert_eq!(installs.load(Ordering::SeqCst), 1, "one install for two uses");
    assert!(entries.try_recv().is_err(), "the second use did not enter an install of its own");
    stack.stop().await.expect("stop ends the install in progress");
    let (first, second) = (within("the first use to end", one).await.unwrap(), within("the second use to end", two).await.unwrap());
    assert!(first && second, "both uses see the install's end");
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    assert!(!dir.path().join("pgdata").join("PG_VERSION").exists(), "a cancelled install initialises nothing");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_started_stack_serves_the_close_ingest_and_the_turn_search_copy() {
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("temp dir");
    let stack = MemoryStack::start(MemoryBoot {
        data_dir: dir.path().to_owned(),
        pg_runtime: crate::memory::boot::PgRuntimeSource::Dir(runtime),
        embedder: None,
        embedding_provider: None,
        flags: RuntimeFlags::default(),
        progress: None,
        sensitive: Arc::new(SensitiveStore::default()),
        lane: mixdog_rt::testing::tokens().durability_io,
        maintenance: mixdog_rt::testing::tokens().maintenance_io,
        transcripts: None,
        cycles: None,
        backfill: None,
        processes: crate::tidy::process::Processes::for_tests(),
        cancel: tokio_util::sync::CancellationToken::new(),
    })
    .await
    .expect("memory starts");
    let messages = vec![
        json!({ "role": "user", "content": "Please remember that the build uses the g-tools target." }),
        json!({ "role": "assistant", "content": "Noted: the build uses the g-tools target." }),
    ];
    let text = stack
        .module()
        .memory(json!({ "action": "ingest_session", "sessionId": "boot-1", "cwd": dir.path().to_string_lossy(), "messages": messages }))
        .await;
    assert!(text.starts_with("ingest_session:"), "{text}");
    stack.search().ingest_turn(IngestSession { id: "boot-1".into(), messages, agent_only: false });
    stack.search().settle("boot-1").await;
    assert!(stack.search().db().session_ids().await.expect("ids").contains("boot-1"));
    stack.stop().await.expect("stops");
}
