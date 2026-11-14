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
    MemoryStack::start(boot_over(dir, source)).await.expect("the stack is built without a database")
}

/// What a stack over `dir` whose runtime comes from `source` is built from.
fn boot_over(dir: &std::path::Path, source: PgRuntimeSource) -> MemoryBoot {
    MemoryBoot {
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
    }
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

/// An install held at a gate that it does not leave for the stop's cancel (it announces the cancel and goes on waiting), announced when it runs past the gate, and
/// ending with `outcome`.
struct Held {
    install: PgInstall,
    installs: Arc<AtomicUsize>,
    entered: tokio::sync::mpsc::UnboundedReceiver<()>,
    gate: tokio::sync::oneshot::Sender<()>,
    cancelled: tokio::sync::mpsc::UnboundedReceiver<()>,
    finished: tokio::sync::mpsc::UnboundedReceiver<()>,
}

fn held_install(outcome: impl Fn() -> crate::memory::error::Result<std::path::PathBuf> + Send + Sync + 'static) -> Held {
    let (gate, opened) = tokio::sync::oneshot::channel::<()>();
    let opened = Arc::new(tokio::sync::Mutex::new(Some(opened)));
    let (saw_cancel, cancelled) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (passed, finished) = tokio::sync::mpsc::unbounded_channel::<()>();
    let outcome = Arc::new(outcome);
    let (install, installs, entered) = install_of(move |_, cancel| {
        let (opened, saw_cancel, passed, outcome) = (opened.clone(), saw_cancel.clone(), passed.clone(), outcome.clone());
        Box::pin(async move {
            let mut gate = opened.lock().await.take().expect("one install");
            tokio::select! {
                _ = &mut gate => {}
                () = cancel.cancelled() => {
                    let _ = saw_cancel.send(());
                    let _ = gate.await;
                }
            }
            let _ = passed.send(());
            outcome()
        })
    });
    Held { install, installs, entered, gate, cancelled, finished }
}

fn failing(text: &'static str) -> impl Fn() -> crate::memory::error::Result<std::path::PathBuf> + Send + Sync + 'static {
    move || Err(MemoryError::Runtime(text.to_owned()))
}

/// Stops `stack` while its opening is held, and moves the held clock to the stop's 6 s give-up once the opening has seen the cancel (the stop's bounded wait
/// for it has begun by then); returns the stop's result.
async fn stop_past_the_give_up(stack: &Arc<MemoryStack>, cancelled: &mut tokio::sync::mpsc::UnboundedReceiver<()>) -> crate::memory::error::Result<()> {
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop().await }
    });
    awaiting_for(std::time::Duration::from_secs(5), "the opening to see the stop's cancel", cancelled.recv()).await.expect("cancelled");
    tokio::time::advance(std::time::Duration::from_secs(6)).await;
    awaiting("the stop to give up at 6 s", stopping).await.unwrap()
}

/// Two first uses while the runtime is still downloading share the one install (Node's callers all await the one shared ensure, `supervisor.mjs:659-665`),
/// wait for it rather than fail, and both see its outcome. One use goes through the `memory` schema's handle and the other through the session search's: the
/// two handles reach the database through the stack's one opening.
///
/// Both uses are polled in one round of a `join`: the first enters the install (announced), and the second, polled after it in the same round, has reached the
/// shared opening and parks on it without entering an install of its own. The install is then released at a gate.
#[tokio::test]
async fn two_first_uses_share_one_install_and_see_its_outcome() {
    let dir = tempfile::tempdir().expect("dir");
    let Held { install, installs, mut entered, gate, .. } = held_install(failing("the download failed"));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let search = stack.search().db().clone();
    let memory = stack.db();
    let mut both = Box::pin(futures::future::join(memory.client(), search.session_ids()));
    assert!(futures::poll!(&mut both).is_pending(), "both uses wait for the install");
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("the install was entered");
    assert!(entered.try_recv().is_err(), "the second use did not enter an install of its own");
    assert_eq!(installs.load(Ordering::SeqCst), 1, "one install for two uses");
    gate.send(()).expect("the install waits at the gate");
    let (one, two) = awaiting("both uses to see the install's end", both).await;
    assert_eq!((message(one), message(two)), ("postgres runtime: the download failed".to_owned(), "postgres runtime: the download failed".to_owned()));
    assert_eq!(installs.load(Ordering::SeqCst), 1);
}

/// The opening is the stack's own task: when every use that waited for it is gone, it still runs to its end (Node's shared promise keeps running whatever its
/// callers do), and the next use starts after it rather than finding it stalled.
#[tokio::test]
async fn an_opening_runs_to_its_end_when_every_use_is_dropped() {
    let dir = tempfile::tempdir().expect("dir");
    let Held { install, installs, mut entered, gate, mut finished, .. } = held_install(failing("the download failed"));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    using.abort();
    assert!(using.await.unwrap_err().is_cancelled(), "the only use is gone");
    gate.send(()).expect("the install waits at the gate");
    awaiting_for(std::time::Duration::from_secs(5), "the install to run past its gate with no use waiting", finished.recv()).await.expect("finished");
    assert_eq!(installs.load(Ordering::SeqCst), 1);
    stack.stop().await.expect("stop");
}

/// Every use is dropped, then the stack stops: the opening, still the stack's, sees the cancel and the stop joins it at once, with no time passing on the held
/// clock (it does not sit out the 6 s give-up).
#[tokio::test(start_paused = true)]
async fn a_stop_cancels_and_joins_an_opening_nobody_waits_for() {
    let dir = tempfile::tempdir().expect("dir");
    let (seen, mut cancelled) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (install, _installs, mut entered) = install_of(move |_, cancel| {
        let seen = seen.clone();
        Box::pin(async move {
            cancel.cancelled().await;
            let _ = seen.send(());
            Err(MemoryError::Runtime("cancelled".to_owned()))
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    using.abort();
    assert!(using.await.unwrap_err().is_cancelled(), "the only use is gone");
    let before = tokio::time::Instant::now();
    awaiting_for(std::time::Duration::from_secs(5), "the stop of an opening nobody waits for", stack.stop()).await.expect("stop");
    assert_eq!(tokio::time::Instant::now(), before, "the stop joined the cancelled opening without waiting out its bound");
    awaiting_for(std::time::Duration::from_secs(5), "the install to see the cancel", cancelled.recv()).await.expect("cancelled");
    assert!(!dir.path().join("pgdata").exists(), "the cancelled opening started nothing");
}

/// A use after the stop began is refused with Node's text before it can join an opening still in flight (`ensurePgInstance` checks shutdown first,
/// `supervisor.mjs:647-665`): here the opening ignores the cancel and the stop has given up on it.
#[tokio::test(start_paused = true)]
async fn a_use_after_stop_is_refused_while_an_opening_is_in_flight() {
    let dir = tempfile::tempdir().expect("dir");
    let Held { install, installs, mut entered, gate, mut cancelled, .. } = held_install(failing("the download failed"));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    let stopped = stop_past_the_give_up(&stack, &mut cancelled).await;
    let refused = awaiting_for(std::time::Duration::from_secs(5), "a use after the stop", stack.db().client()).await.map(drop);
    drop(gate);
    let first = awaiting("the first use to end with its opening", using).await.unwrap();
    stopped.expect("stop goes on without the opening");
    assert_eq!(message(refused), SHUTTING_DOWN);
    assert!(first.is_err());
    assert_eq!(installs.load(Ordering::SeqCst), 1, "the refused use started no opening");
}

/// An opening that ignores the stop's cancel and ends after the stop gave up on it starts nothing: the cluster step is never begun once the stack is stopping, so
/// no postmaster is left without an owner (Node's exit hook stops one an abandoned opening published, `supervisor.mjs:793-835`; here there is none to stop).
#[tokio::test(start_paused = true)]
async fn an_opening_that_ends_after_the_stop_gave_up_starts_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    let runtime = dir.path().join("runtime");
    let Held { install, mut entered, gate, mut cancelled, .. } = held_install(move || Ok(runtime.clone()));
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    let stopped = stop_past_the_give_up(&stack, &mut cancelled).await;
    gate.send(()).expect("the install waits at the gate");
    let ended = awaiting("the abandoned opening to end", using).await.unwrap();
    stopped.expect("stop goes on without the opening");
    assert_eq!(message(ended), SHUTTING_DOWN);
    assert!(!dir.path().join("pgdata").exists(), "the abandoned opening began no cluster step");
}

/// An opening whose task panics is forgotten like one that failed (Node forgets its shared ensure whenever it settles, `supervisor.mjs:659-665`): the next
/// use starts a new opening instead of getting the same failure for good.
#[tokio::test]
async fn an_opening_that_panics_is_forgotten_and_the_next_use_opens_again() {
    let dir = tempfile::tempdir().expect("dir");
    let (install, installs, _entered) = install_of(|nth, _| {
        Box::pin(async move {
            assert!(nth != 1, "the first install panics");
            Err(MemoryError::Runtime("the download failed".to_owned()))
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let first = message(awaiting("the use whose opening panics", stack.db().client()).await);
    let second = message(awaiting("the next use", stack.db().client()).await);
    stack.stop().await.expect("stop");
    assert!(first.contains("panicked"), "{first}");
    assert_eq!(second, "postgres runtime: the download failed");
    assert_eq!(installs.load(Ordering::SeqCst), 2, "the next use ran a new opening");
}

/// A postmaster start admitted before the stop began (its last check passed, `pg_ctl start` not yet spawned) is waited for only within the stop's 6 s, as
/// Node's stop gives up on its opening (`supervisor.mjs:790-800`): held between its admission and the spawn, the stop is pending before 6 s and has
/// returned at 6 s; the abandoned start then goes on to `pg_ctl` on its own. What such a start leaves (a postmaster outside the core's job) is attached to
/// and stopped by the next core: `a_core_after_a_killed_one_attaches_to_its_postmaster_and_stops_it`.
#[tokio::test(start_paused = true)]
async fn a_stop_gives_up_on_a_postmaster_start_admitted_before_it_at_six_seconds() {
    struct Silent;
    impl crate::memory::pg::cluster::Health for Silent {
        fn healthy(&self, _port: u16) -> futures::future::BoxFuture<'static, bool> {
            Box::pin(async { false })
        }
    }
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir_all(dir.path().join("pgdata")).expect("pgdata");
    std::fs::write(dir.path().join("pgdata").join("PG_VERSION"), "16\n").expect("version");
    let (admitted, mut admissions) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let held = Arc::new(std::sync::Mutex::new(Some(held)));
    let before_spawn: Arc<dyn Fn(u16) -> futures::future::BoxFuture<'static, ()> + Send + Sync> = Arc::new(move |_| {
        let _ = admitted.send(());
        let held = held.lock().expect("held").take().expect("one start");
        Box::pin(async move {
            let _ = held.await;
        })
    });
    let start = crate::memory::pg::cluster::Start { health: Arc::new(Silent), recovery_wait: std::time::Duration::ZERO, lock_wait: std::time::Duration::ZERO, before_spawn: Some(before_spawn) };
    let stack = MemoryStack::start_with(boot_over(dir.path(), PgRuntimeSource::Dir(dir.path().join("runtime"))), start).await.expect("built");
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(std::time::Duration::from_secs(10), "the start to be admitted", admissions.recv()).await.expect("admitted");
    let mut stopping = Box::pin(stack.stop());
    let waiting = futures::poll!(&mut stopping).is_pending();
    tokio::time::advance(std::time::Duration::from_millis(5_999)).await;
    let pending_before = futures::poll!(&mut stopping).is_pending();
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    let at_six = match futures::poll!(&mut stopping) {
        std::task::Poll::Pending => None,
        std::task::Poll::Ready(stopped) => Some(stopped),
    };
    let returned_at_six = at_six.is_some();
    release.send(()).expect("the start waits at the gate");
    let stopped = match at_six {
        Some(stopped) => stopped,
        None => awaiting("the stop once the start ended", stopping).await,
    };
    let used = awaiting("the use of the abandoned opening", using).await.unwrap();
    assert!(waiting && pending_before, "the stop waits for the admitted start within its 6 s");
    assert!(returned_at_six, "the stop returns at 6 s, as Node's gives up on its opening");
    stopped.expect("stop");
    assert!(message(used).contains("pg_ctl"), "the abandoned start went on to pg_ctl on its own");
}

/// The spawn lock is Node's file, `<profile>/pg-spawn.lock` beside the cluster (`supervisor.mjs:618`), so the two exclude each other: while a holder (as a Node
/// process would) has it, a use whose start does not wait is refused before the cluster is touched; once it is released, the next use goes on to `initdb`.
#[tokio::test]
async fn the_spawn_lock_is_nodes_file_beside_the_cluster() {
    struct Silent;
    impl crate::memory::pg::cluster::Health for Silent {
        fn healthy(&self, _port: u16) -> futures::future::BoxFuture<'static, bool> {
            Box::pin(async { false })
        }
    }
    let dir = tempfile::tempdir().expect("dir");
    let lock_file = dir.path().join("pg-spawn.lock");
    let (taken, held) = tokio::sync::oneshot::channel();
    let hold = mixdog_statefile::hold_lock(&lock_file, &mixdog_statefile::LockOpts::default(), move |outcome| {
        let _ = taken.send(outcome);
    });
    awaiting("the holder to take the spawn lock", held).await.unwrap().expect("the lock is taken");
    let start = crate::memory::pg::cluster::Start { health: Arc::new(Silent), recovery_wait: std::time::Duration::ZERO, lock_wait: std::time::Duration::ZERO, before_spawn: None };
    let stack = MemoryStack::start_with(boot_over(dir.path(), PgRuntimeSource::Dir(dir.path().join("runtime"))), start).await.expect("built");
    let refused = message(awaiting("the use while Node's lock is held", stack.db().client()).await);
    hold.release_and_wait();
    let next = message(awaiting("the use after the lock is released", stack.db().client()).await);
    stack.stop().await.expect("stop");
    assert!(refused.contains("atomic lock contended (try-once)") && refused.contains(&lock_file.display().to_string()), "{refused}");
    assert!(next.contains("initdb"), "{next}");
}

/// A stop while the install is held ends it and starts nothing; both waiting uses end with the install's cancellation, and a use after the stop gets Node's text.
/// Node's proxy answers a call whose memory child is still starting at 90 s after the child's spawn (60 s ready timeout, `daemon-spawn.mjs:62`, then
/// 30 s for a live port, `:141`), and every call arriving meanwhile shares that spawn (`start.mjs:40-44`): a call waits for a held install until 90 s
/// after the opening's launch, a call joining 50 s later is answered at the same instant, and the opening goes on.
#[tokio::test(start_paused = true)]
async fn a_memory_call_waits_for_a_held_install_until_ninety_seconds_after_its_launch() {
    use crate::memory::service::RUNTIME_READY_WAIT;
    let dir = tempfile::tempdir().expect("dir");
    let (install, installs, mut entered) = install_of(|_, cancel| {
        Box::pin(async move {
            cancel.cancelled().await;
            Err(MemoryError::Runtime("cancelled".to_owned()))
        })
    });
    let stack = stack_over(dir.path(), PgRuntimeSource::Install(install)).await;
    let module = stack.module();
    let mut first = Box::pin(module.ready());
    assert!(futures::poll!(&mut first).is_pending());
    awaiting_for(std::time::Duration::from_secs(5), "the install to be entered", entered.recv()).await.expect("entered");
    tokio::time::advance(std::time::Duration::from_secs(50)).await;
    // A call that arrives 50 s later joins the same opening and its limit.
    let mut second = Box::pin(module.ready());
    assert!(futures::poll!(&mut second).is_pending());
    tokio::time::advance(RUNTIME_READY_WAIT - std::time::Duration::from_secs(50) - std::time::Duration::from_millis(1)).await;
    let pending_before = futures::poll!(&mut first).is_pending() && futures::poll!(&mut second).is_pending();
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    let (one, two) = (futures::poll!(&mut first), futures::poll!(&mut second));
    let answered = matches!(one, std::task::Poll::Ready(Err(_))) && matches!(two, std::task::Poll::Ready(Err(_)));
    let still_installing = installs.load(Ordering::SeqCst) == 1 && !stack.is_open();
    stack.stop().await.expect("stop");
    assert!(pending_before, "both calls wait until 90 s after the launch");
    assert!(answered, "both calls are answered at 90 s after the launch");
    assert!(still_installing, "the opening itself goes on past the calls' limit");
}

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
    let pending_before = !stopping.is_finished();
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    let stopped = awaiting("the stop to give up at 6 s", stopping).await.unwrap();
    // The use waits on an opening that never ends: it is ended here, before any assertion.
    using.abort();
    let _ = using.await;
    assert!(pending_before, "still waiting for the opening at 5.999 s");
    stopped.expect("stop goes on without the opening");
}

/// The cycles' host seams, none of which a held run calls.
pub(super) fn idle_cycles() -> crate::memory::boot::CycleBoot {
    struct Off;
    impl crate::memory::cycles::CycleConfig for Off {
        fn memory_section(&self) -> serde_json::Value {
            json!({})
        }
        fn cycles_enabled(&self) -> bool {
            false
        }
        fn maintenance_preset(&self) -> Option<serde_json::Value> {
            None
        }
    }
    struct NoAgent;
    #[async_trait::async_trait]
    impl crate::memory::cycles::Cycle1Llm for NoAgent {
        async fn call(&self, _request: &crate::memory::cycles::Cycle1Request, _cancel: &tokio_util::sync::CancellationToken, _prompt: &str) -> Result<String, String> {
            Err("no agent in this test".to_owned())
        }
    }
    struct NeverFires;
    impl crate::bots::delivery::env::RetryTimer for NeverFires {
        fn arm(&self, _delay: std::time::Duration, _fire: Box<dyn FnOnce() + Send>) {}
    }
    crate::memory::boot::CycleBoot { config: Arc::new(Off), llm: Arc::new(NoAgent), timer: Arc::new(NeverFires) }
}

/// A stack over `dir` whose opening published a cluster (its `postmaster.pid` names a port, its runtime has no `pg_ctl`: the release's `pg_ctl stop` runs and
/// fails, so the stop's error says it ran) and whose cycle run is held until the returned sender sends.
async fn opened_stack_with_a_held_cycle(dir: &std::path::Path) -> (Arc<MemoryStack>, tokio::sync::oneshot::Sender<()>) {
    let mut boot = boot_over(dir, PgRuntimeSource::Dir(dir.join("runtime")));
    boot.cycles = Some(idle_cycles());
    let stack = MemoryStack::start(boot).await.expect("built");
    let pgdata = dir.join("pgdata");
    std::fs::create_dir_all(&pgdata).expect("pgdata");
    pid_file(&pgdata, std::process::id(), 55_999);
    let lane = mixdog_rt::testing::tokens().durability_io;
    let cluster = crate::memory::pg::cluster::PgCluster::over(crate::memory::pg::cluster::PgRuntime::new(dir.join("runtime")), dir, 55_999, lane, crate::tidy::process::Processes::for_tests());
    stack.opened_over(cluster);
    let release = stack.cycles().expect("cycles").hold_run();
    (stack, release)
}

/// Node asks PostgreSQL to stop at `PG_FORCED_STOP_AT_MS` (4.2 s, `daemon-stop-budget.mjs:18`) into the shutdown whatever teardown still runs
/// (`daemon-pg-stop.mjs:36-41`): with a cycle run that never ends, the stop is pending at 4.199 s, and at 4.2 s, with the clock not moved again, the cycle is
/// abandoned (its run aborted) and `pg_ctl stop` has run.
#[tokio::test(start_paused = true)]
async fn a_cycle_that_never_ends_holds_the_postgres_stop_only_until_nodes_forced_stop_point() {
    let dir = tempfile::tempdir().expect("dir");
    let (stack, mut release) = opened_stack_with_a_held_cycle(dir.path()).await;
    let begun = tokio::time::Instant::now();
    let mut stopping = Box::pin(stack.stop());
    let waiting = futures::poll!(&mut stopping).is_pending();
    tokio::time::advance(std::time::Duration::from_millis(4_199)).await;
    let pending_before = futures::poll!(&mut stopping).is_pending();
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    let stopped = awaiting("the stop past the forced point", stopping).await;
    // The aborted run drops what it held.
    awaiting("the abandoned cycle run to be aborted", release.closed()).await;
    let at = tokio::time::Instant::now() - begun;
    assert!(waiting && pending_before, "the stop waits for the cycle until the forced point");
    assert_eq!(at, std::time::Duration::from_millis(4_200), "the PostgreSQL stop ran at the forced point");
    assert!(message(stopped).contains("pg_ctl failed"), "the release ran `pg_ctl stop`");
}

/// A teardown that ends before the forced point changes nothing: the cycle run ends at 1 s and the stop goes straight on to `pg_ctl stop`, at 1 s.
#[tokio::test(start_paused = true)]
async fn a_teardown_that_ends_early_stops_postgres_without_waiting_for_the_forced_point() {
    let dir = tempfile::tempdir().expect("dir");
    let (stack, release) = opened_stack_with_a_held_cycle(dir.path()).await;
    let begun = tokio::time::Instant::now();
    let mut stopping = Box::pin(stack.stop());
    let waiting = futures::poll!(&mut stopping).is_pending();
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    release.send(()).expect("the run is held");
    let stopped = awaiting("the stop after the cycle ended", stopping).await;
    let at = tokio::time::Instant::now() - begun;
    assert!(waiting, "the stop waits for the cycle run");
    assert_eq!(at, std::time::Duration::from_secs(1), "the stop did not wait for the forced point");
    assert!(message(stopped).contains("pg_ctl failed"), "the release ran `pg_ctl stop`");
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
    let stopped = awaiting_for(std::time::Duration::from_secs(5), "the stop to end the wait", stack.stop()).await;
    let ended = awaiting_for(std::time::Duration::from_secs(5), "the use to end", using).await.unwrap();
    server.abort();
    let _ = server.await;
    stopped.expect("stop");
    assert_eq!(message(ended), "postgres runtime: the start was cancelled before postgres was ready");
    assert!(pgdata.join("postmaster.pid").exists(), "a postmaster that is not ours is left alone");
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

/// The postmaster's pid in the profile's cluster (line one of `postmaster.pid`), when there is one.
fn postmaster_pid(profile: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(profile.join("pgdata").join("postmaster.pid")).ok()?.lines().next()?.trim().parse().ok()
}

/// A core killed while its PostgreSQL runs (it never stops the stack), then a second core on the same profile: as Node's (`tryReusePgInstance`'s
/// `postmaster.pid` attach, `supervisor.mjs:437-452`, then `stopPgForShutdown` of the attached `_live`, `:715-729`), the second attaches to the surviving
/// postmaster instead of starting another, and its stop ends that postmaster. The server log is Node's `<profile>/pg.log`, outside the cluster.
///
/// The first core is a child process (this test binary running [`a_killed_core`]) that opens the stack and is then killed, so whatever its death takes
/// with it (the jobs of its process manager) goes as it would with a killed core.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
#[allow(clippy::disallowed_methods, reason = "test setup: the killed core is a child process")]
async fn a_core_after_a_killed_one_attaches_to_its_postmaster_and_stops_it() {
    use std::io::BufRead as _;
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("temp dir");
    let mut killed = std::process::Command::new(std::env::current_exe().expect("this test binary"))
        .args(["--exact", "memory::tests::boot::a_killed_core", "--ignored", "--nocapture"])
        .env(KILLED_CORE_PROFILE, dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the first core");
    let stdout = killed.stdout.take().expect("its output");
    let opened = awaiting(
        "the first core to open its database",
        tokio::task::spawn_blocking(move || std::io::BufReader::new(stdout).lines().map_while(std::result::Result::ok).any(|line| line == OPENED)),
    )
    .await
    .expect("the reader");
    let _ = killed.kill();
    let _ = killed.wait();
    assert!(opened, "the first core opened its database");
    let first = postmaster_pid(dir.path()).expect("the first core's postmaster");
    let second = stack_over(dir.path(), PgRuntimeSource::Dir(runtime)).await;
    drop(awaiting("the second core's first use", second.db().client()).await.expect("the second core opens"));
    let attached = postmaster_pid(dir.path());
    let stopped = awaiting("the second core's stop", second.stop()).await;
    let alive = mixdog_statefile::process_exists(first);
    stopped.expect("the stop ends the postmaster");
    assert_eq!(attached, Some(first), "the second core attached to the surviving postmaster");
    assert!(!alive, "the attached postmaster is stopped by the second core's stop");
    assert!(dir.path().join("pg.log").exists() && !dir.path().join("pgdata").join("pg.log").exists(), "the server log is Node's <profile>/pg.log");
}

/// Where [`a_killed_core`] opens its stack.
const KILLED_CORE_PROFILE: &str = "MIXDOG_TEST_KILLED_CORE_PROFILE";
/// The line [`a_killed_core`] prints once its database is open.
const OPENED: &str = "the killed core's database is open";

/// The first core of [`a_core_after_a_killed_one_attaches_to_its_postmaster_and_stops_it`], run by it as a child process: it opens a stack over the
/// profile it is given, says so, and waits to be killed. Run without that profile (as a test of its own) it has nothing to do.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: the child process of a_core_after_a_killed_one_attaches_to_its_postmaster_and_stops_it"]
#[allow(clippy::disallowed_methods, reason = "test setup: reads the parent's environment and waits on its stdin")]
async fn a_killed_core() {
    let Some(profile) = std::env::var_os(KILLED_CORE_PROFILE) else { return };
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let stack = stack_over(std::path::Path::new(&profile), PgRuntimeSource::Dir(runtime)).await;
    drop(stack.db().client().await.expect("the first core opens"));
    println!("{OPENED}");
    // The parent kills this process; its stdin ends only then.
    let _ = tokio::task::spawn_blocking(|| std::io::stdin().read_line(&mut String::new())).await;
}

/// A use after the stop of a stack that is open is refused with Node's text (`ensurePgInstance` refuses before its fast path, `supervisor.mjs:647-650`).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_use_after_the_stop_of_an_open_stack_is_refused() {
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("temp dir");
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(runtime)).await;
    drop(awaiting("the first use", stack.db().client()).await.expect("opens"));
    awaiting("the stop", stack.stop()).await.expect("stops");
    assert_eq!(message(stack.db().client().await), SHUTTING_DOWN);
}

mod shared_open;
/// A port that was free when the start looked for one and is taken before the postmaster binds it (another cluster starting on the
/// machine: `at_quit_the_last_client_leaves…` failed on it) moves the start to the next port instead of failing it. The port is taken in
/// the gap the start leaves between its choice and the spawn.
#[tokio::test(flavor = "multi_thread")]
async fn a_port_taken_between_the_choice_and_the_bind_moves_the_start_to_the_next_port() {
    use crate::memory::pg::cluster::{PgCluster, PgRuntime, Start};
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("dir");
    let preferred = super::support::preferred_port();
    // The port the start chose first (whichever it was: another process may hold `preferred` already), taken before its postmaster binds.
    let taken = Arc::new(std::sync::Mutex::new(None::<(u16, std::net::TcpListener)>));
    let holder = taken.clone();
    let mut start = Start::node();
    start.before_spawn = Some(Arc::new(move |chosen| {
        let mut holder = holder.lock().expect("holder");
        if holder.is_none() {
            *holder = Some((chosen, std::net::TcpListener::bind(("127.0.0.1", chosen)).expect("the chosen port is still free")));
        }
        Box::pin(async {})
    }));
    let cluster = PgCluster::ensure(PgRuntime::new(&runtime), dir.path(), preferred, mixdog_rt::testing::tokens().durability_io, crate::tidy::process::Processes::for_tests(), &tokio_util::sync::CancellationToken::new(), &start, &|| true)
        .await
        .expect("the start moves on to the next port");
    let first = taken.lock().expect("holder").as_ref().expect("the start reached its spawn").0;
    assert!(cluster.port() > first, "the start used the port that was taken ({first}): {}", cluster.port());
    cluster.stop(std::time::Duration::from_secs(15)).await.expect("stops");
}

/// A start ended while its `initdb` runs (a quit during the first memory start; a killed core's job ends `initdb` the same way) leaves no `pgdata`, so
/// the next start makes the cluster instead of starting a half-made one, which has no `postgres` database and never answers. In Node the `initdb`
/// outlived its daemon and finished the cluster.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_start_ended_during_initdb_leaves_no_cluster_and_the_next_start_makes_one() {
    use crate::memory::pg::cluster::{PgCluster, PgRuntime, Start};
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let dir = tempfile::tempdir().expect("dir");
    let ensure = |cancel: tokio_util::sync::CancellationToken| {
        let (runtime, profile) = (PgRuntime::new(&runtime), dir.path().to_owned());
        async move {
            let processes = crate::tidy::process::Processes::for_tests();
            PgCluster::ensure(runtime, &profile, super::support::preferred_port(), mixdog_rt::testing::tokens().durability_io, processes, &cancel, &Start::node(), &|| true).await
        }
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let ended = tokio::spawn(ensure(cancel.clone()));
    let begun = dir.path().join("pgdata.init").join("PG_VERSION");
    awaiting("initdb to begin the cluster", async {
        while !begun.exists() {
            mixdog_rt::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    cancel.cancel();
    assert!(awaiting("the ended start", ended).await.expect("the start's task").is_err(), "the start ended with its initdb");
    assert!(!dir.path().join("pgdata").exists(), "an ended initdb leaves no cluster");
    let cluster = awaiting("the next start", ensure(tokio_util::sync::CancellationToken::new())).await.expect("the next start makes the cluster");
    assert!(!dir.path().join("pgdata.init").exists(), "the cluster was renamed into place");
    cluster.stop(std::time::Duration::from_secs(15)).await.expect("stops");
}
