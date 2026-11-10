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

use super::awaiting::{awaiting, awaiting_for};
use super::fakes::{Fake, pid_file};
use crate::memory::boot::{PgInstall, PgRuntimeSource};
use crate::memory::error::MemoryError;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Node's text for a use after the stop began (`supervisor.mjs:648`).
const SHUTTING_DOWN: &str = "[supervisor-pg] process is shutting down; PG start refused";

/// A stack over `dir` whose runtime comes from `source`.
async fn stack_over(dir: &std::path::Path, source: PgRuntimeSource) -> Arc<MemoryStack> {
    MemoryStack::start(MemoryBoot {
        data_dir: dir.to_owned(),
        pg_runtime: source,
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
    .expect("the stack is built without a database")
}

/// An install that counts its entries, announces each on the returned channel and then runs `run` with the stack's cancel.
fn install_of<F>(run: F) -> (PgInstall, Arc<AtomicUsize>, tokio::sync::mpsc::UnboundedReceiver<()>)
where
    F: Fn(usize, tokio_util::sync::CancellationToken) -> futures::future::BoxFuture<'static, crate::memory::error::Result<std::path::PathBuf>> + Send + Sync + 'static,
{
    let entries = Arc::new(AtomicUsize::new(0));
    let (entered, announced) = tokio::sync::mpsc::unbounded_channel();
    let counted = entries.clone();
    let install: PgInstall = Arc::new(move |cancel| {
        let nth = counted.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = entered.send(());
        run(nth, cancel)
    });
    (install, entries, announced)
}

fn message<T>(used: Result<T, MemoryError>) -> String {
    match used {
        Ok(_) => panic!("the use succeeded"),
        Err(error) => error.message(),
    }
}

/// Node starts the memory runtime at the first memory call, never at daemon boot (`registerMemoryRuntimeLazy`, `daemon.mjs:202`), and its ready signal does not wait
/// for PostgreSQL: a fresh profile must not download or initialise anything while the stack is built, and a data directory that holds a cluster opens it only
/// when the host asks for the background start. Neither the install nor the start needs a network or a postmaster here: the install is a counter that fails.
#[tokio::test(flavor = "multi_thread")]
async fn a_stack_installs_and_starts_nothing_until_the_database_is_used() {
    let dir = tempfile::tempdir().expect("dir");
    let (install, installs, _entered) = install_of(|_, _| Box::pin(async { Err(MemoryError::Runtime("no network in this test".to_owned())) }));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    assert_eq!(installs.load(Ordering::SeqCst), 0, "building the stack installs nothing");

    // A fresh profile has no cluster: the background start has nothing to open.
    awaiting("the background start on a fresh profile to decide", stack.open_in_background()).await.expect("the background task");
    assert_eq!(installs.load(Ordering::SeqCst), 0, "no cluster on disk, so no background start");

    // The first use opens the database, and a failed opening is tried again by the next use.
    assert!(stack.db().client().await.is_err());
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    assert!(stack.db().client().await.is_err());
    assert_eq!(installs.load(Ordering::SeqCst), 2);

    // A cluster on disk is opened by the background start.
    std::fs::create_dir_all(dir.path().join("pgdata")).expect("pgdata");
    std::fs::write(dir.path().join("pgdata").join("PG_VERSION"), "16\n").expect("version");
    awaiting("the background start of an existing cluster to end", stack.open_in_background()).await.expect("the background task");
    assert_eq!(installs.load(Ordering::SeqCst), 3, "an existing cluster starts after ready");

    stack.stop().await.expect("a stack that never opened has nothing to stop");
}

/// A failed download is not remembered (`supervisor.mjs:659`): the next use runs the install again, and when that succeeds the opening goes on to the cluster step
/// (here `initdb` of an empty runtime, which is where it fails) instead of repeating the install's error.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_install_is_retried_by_the_next_use_and_a_good_one_goes_on_to_the_cluster() {
    let dir = tempfile::tempdir().expect("dir");
    let runtime = dir.path().join("runtime");
    let (install, installs, _entered) = install_of(move |nth, _| {
        let runtime = runtime.clone();
        Box::pin(async move { if nth == 1 { Err(MemoryError::Runtime("download failed: network".to_owned())) } else { Ok(runtime) } })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    assert!(message(stack.db().client().await).contains("download failed: network"));
    let second = message(stack.db().client().await);
    assert!(second.contains("initdb"), "the retry's install succeeded and the opening reached initdb: {second}");
    assert_eq!(installs.load(Ordering::SeqCst), 2);
    stack.stop().await.expect("stop");
}

/// Two first uses while the runtime is still downloading share the one install (Node's callers all await the one `initPromise`, `http-router.mjs:34-46`), wait for
/// it rather than fail, and both see its outcome.
///
/// Both uses are polled in one round of a `join`: the first enters the install (announced), and the second, polled after it in the same round, has reached the
/// shared opening and parks on it without entering an install of its own. The install is then released at a gate.
#[tokio::test]
async fn two_first_uses_share_one_install_and_see_its_outcome() {
    let dir = tempfile::tempdir().expect("dir");
    let (gate, opened) = tokio::sync::oneshot::channel::<()>();
    let opened = Arc::new(tokio::sync::Mutex::new(Some(opened)));
    let (install, installs, mut entered) = install_of(move |_, _| {
        let opened = opened.clone();
        Box::pin(async move {
            let gate = opened.lock().await.take().expect("one install");
            let _ = gate.await;
            Err(MemoryError::Runtime("the download failed".to_owned()))
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let (first, second) = (stack.db(), stack.db());
    let mut both = Box::pin(futures::future::join(first.client(), second.client()));
    assert!(futures::poll!(&mut both).is_pending(), "both uses wait for the install");
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("the install was entered");
    assert!(entered.try_recv().is_err(), "the second use did not enter an install of its own");
    assert_eq!(installs.load(Ordering::SeqCst), 1, "one install for two uses");
    gate.send(()).expect("the install waits at the gate");
    let (one, two) = awaiting("both uses to see the install's end", both).await;
    assert_eq!((message(one), message(two)), ("postgres runtime: the download failed".to_owned(), "postgres runtime: the download failed".to_owned()));
    assert_eq!(installs.load(Ordering::SeqCst), 1);
}

/// A stop while the install is held ends it and starts nothing; both waiting uses end with the install's cancellation, and a use after the stop gets Node's text.
#[tokio::test]
async fn a_stop_ends_the_install_the_uses_wait_for() {
    let dir = tempfile::tempdir().expect("dir");
    let (install, installs, mut entered) = install_of(|_, cancel| {
        Box::pin(async move {
            cancel.cancelled().await;
            Err(MemoryError::Runtime("cancelled".to_owned()))
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let (first, second) = (stack.db(), stack.db());
    let mut both = Box::pin(futures::future::join(first.client(), second.client()));
    assert!(futures::poll!(&mut both).is_pending());
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    // The uses are what drive the opening, so they are polled while the stop waits for it.
    let (stopped, (one, two)) = awaiting("the stop and both uses under a held install", async { tokio::join!(stack.stop(), both) }).await;
    stopped.expect("stop ends the install in progress");
    assert!(message(one).contains("cancelled") && message(two).contains("cancelled"));
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    assert!(!dir.path().join("pgdata").join("PG_VERSION").exists(), "a cancelled install initialises nothing");
    assert_eq!(message(stack.db().client().await), SHUTTING_DOWN);
}

/// Node bounds its wait for an opening in flight at stop by 6 s and then goes on (`stopOwnedPgForShutdown`, `supervisor.mjs:790-800`). An opening that ignores the
/// cancel (an install that never ends) holds the stop for exactly that, on a clock the test moves.
#[tokio::test(start_paused = true)]
async fn a_stop_gives_up_on_an_opening_that_ignores_the_cancel_after_six_seconds() {
    let dir = tempfile::tempdir().expect("dir");
    let (seen, mut cancelled) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (install, _installs, mut entered) = install_of(move |_, cancel| {
        let seen = seen.clone();
        Box::pin(async move {
            cancel.cancelled().await;
            let _ = seen.send(());
            std::future::pending().await
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.is_err() });
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop().await }
    });
    // The install saw the cancel, so the stop is in its bounded wait for the opening.
    awaiting_for(std::time::Duration::from_secs(5), "the stop to cancel the opening", cancelled.recv()).await.expect("cancelled");
    tokio::time::advance(std::time::Duration::from_millis(5_999)).await;
    assert!(!stopping.is_finished(), "still waiting for the opening at 5.999 s");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    awaiting("the stop to give up at 6 s", stopping).await.unwrap().expect("stop goes on without the opening");
    using.abort();
}

/// A stop while the opening waits for an alive postmaster that does not answer (the cluster step of a restart after the core was killed): the wait observes the
/// cancel, so the stop returns at once instead of after the wait's 30 s, and the postmaster that is not ours is left alone. The "postmaster" is a listener that
/// takes the probe's connections and drops them; its third connection is the recovery wait's first question (the two reuse checks come before it).
#[tokio::test]
async fn a_stop_ends_the_opening_that_waits_for_an_alive_postmaster() {
    let dir = tempfile::tempdir().expect("dir");
    let pgdata = dir.path().join("pgdata");
    std::fs::create_dir_all(&pgdata).unwrap();
    std::fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
    let postmaster = Fake::new(dir.path(), "postgres");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    pid_file(&pgdata, postmaster.id(), listener.local_addr().unwrap().port());
    let (accepted, mut connections) = tokio::sync::mpsc::unbounded_channel::<()>();
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
            let _ = accepted.send(());
        }
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(dir.path().join("runtime"))).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(|_| ()) });
    for question in 1..=3 {
        awaiting_for(std::time::Duration::from_secs(10), &format!("the probe's question {question} of the start"), connections.recv()).await.expect("accepting");
    }
    awaiting_for(std::time::Duration::from_secs(5), "the stop to end the wait", stack.stop()).await.expect("stop");
    let ended = awaiting_for(std::time::Duration::from_secs(5), "the use to end", using).await.unwrap();
    assert_eq!(message(ended), "postgres runtime: the start was cancelled before postgres was ready");
    assert!(pgdata.join("postmaster.pid").exists(), "a postmaster that is not ours is left alone");
    server.abort();
    let _ = server.await;
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
