//! The stop's target, dispatch and durability against real clusters, with fences (never elapsed time) for every ordering claimed: the one stop-target
//! record names a cluster from its attach or its launch, the dispatch is one bounded step that always records an outcome, a graceful stop flushes the
//! WAL and reports a dispatch while the postmaster may still be alive, and the shutdown's own SQL is revoked at the cutoff.

use super::*;
use crate::memory::boot::StopDispatch;
use crate::memory::lifecycle::fences;
use crate::memory::pg::cluster::{PID_READ, PgRuntime, dispatch_fast_stop};

fn pg_runtime() -> PathBuf {
    PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"))
}

const LONG: std::time::Duration = std::time::Duration::from_secs(60);

/// A pid read that never ends (a busy or stalled lane): the dispatch still ends, at its bound, with a recorded `Failed`; a read that fails (not a
/// missing file) is `Failed`, never absence.
#[tokio::test(start_paused = true)]
async fn a_stalled_or_failing_pid_read_still_records_a_dispatch_outcome() {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let dir = tempfile::tempdir().expect("dir");
    let processes = crate::tidy::process::Processes::for_tests();
    let runtime = PgRuntime::new(dir.path().join("runtime"));
    *PID_READ.lock().expect("read") = Some(Box::pin(std::future::pending()));
    let begun = tokio::time::Instant::now();
    let stalled = dispatch_fast_stop(&runtime, &processes, lane, dir.path(), None, StopDispatch::ExternalStartUnresolved).await;
    assert!(matches!(&stalled, StopDispatch::Failed(text) if text.contains("did not end")), "{stalled:?}");
    assert_eq!(tokio::time::Instant::now() - begun, std::time::Duration::from_secs(3), "bounded");
    *PID_READ.lock().expect("read") = Some(Box::pin(async { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the pid file is locked")) }));
    let failing = dispatch_fast_stop(&runtime, &processes, lane, dir.path(), None, StopDispatch::ExternalStartUnresolved).await;
    assert!(matches!(&failing, StopDispatch::Failed(text) if text.contains("reading postmaster.pid failed")), "{failing:?}");
    let missing = dispatch_fast_stop(&runtime, &processes, lane, dir.path(), None, StopDispatch::ExternalStartUnresolved).await;
    assert_eq!(missing, StopDispatch::ExternalStartUnresolved, "only a missing pid file is absence");
}

/// A second core attaches to the first core's postmaster (no `handed` transition) and is revoked at the cutoff while fenced between the recorded attach
/// and its pid read (pools not published): the record named the cluster synchronously at the attach, so the stop resolves the pid itself and
/// dispatches to the attached postmaster.
#[tokio::test(flavor = "multi_thread")]
async fn an_attached_opening_revoked_before_publication_still_has_its_stop_dispatched() {
    let dir = tempfile::tempdir().expect("dir");
    let first = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    drop(awaiting_for(LONG, "the first core opens", first.db().client()).await.expect("opens"));
    let (mut entered, _release) = fences::arm("cluster-recorded");
    let second = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    let db = second.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(LONG, "the attached opening's bootstrap to be fenced", entered.recv()).await.expect("entered");
    second.arm_forced_stop(&tokio::runtime::Handle::current());
    let report = awaiting_for(LONG, "the second core's stop", second.stop_report()).await;
    assert!(report.forced, "the fenced opening (attached, not published) held the graceful stop until the cutoff, which revoked it");
    let StopDispatch::Dispatched { pid } = report.dispatch else { panic!("the attached postmaster was signalled: {:?}", report.dispatch) };
    assert!(awaiting_for(LONG, "the use of the revoked opening", using).await.unwrap().is_err());
    let gone = crate::memory::pg::cluster::await_exit(pid, tokio::time::Instant::now() + LONG).await;
    assert!(gone, "the signalled postmaster exits");
    let _ = first.stop().await;
}

/// A second core's attach is held mid-poll just before its record (no await there, so revocation cannot cut it) while the stop's first dispatch
/// decides on an empty record (`NothingOpened`). Released, the attach's transition starts the delivery itself; the opening is then held again
/// right after its record, an owned poll still running, so the local acknowledgement cannot complete. The attached postmaster is observed exiting
/// while that poll is still held, before the stop could have returned: the signal did not wait for the acknowledgement. Released, the report
/// carries the late outcome once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cluster_attached_after_the_dispatch_decided_is_signalled_before_the_acknowledgement() {
    let dir = tempfile::tempdir().expect("dir");
    let lane = mixdog_rt::testing::tokens().durability_io;
    let first = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    drop(awaiting_for(LONG, "the first core opens", first.db().client()).await.expect("opens"));
    let pid = crate::memory::pg::cluster::recorded_pid(lane, &dir.path().join("pgdata")).await.expect("pid file").expect("a pid");
    let (mut attached, release_attach) = fences::arm("pg-attached");
    let (mut recorded, release_recorded) = fences::arm("established-recorded");
    let second = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    let db = second.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(LONG, "the attach to be held before its record", attached.recv()).await.expect("entered");
    second.arm_forced_stop(&tokio::runtime::Handle::current());
    let stopping = tokio::spawn({
        let second = second.clone();
        async move { second.stop_report().await }
    });
    awaiting_for(LONG, "the first dispatch to decide", async {
        while !second.stop_decided() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    drop(release_attach);
    awaiting_for(LONG, "the opening to be held after its record", recorded.recv()).await.expect("entered");
    let gone = crate::memory::pg::cluster::await_exit(pid, tokio::time::Instant::now() + LONG).await;
    assert!(gone, "the attached postmaster was signalled while an owned poll still held the acknowledgement");
    assert!(!stopping.is_finished(), "the stop is still waiting for its acknowledgement");
    drop(release_recorded);
    let report = awaiting_for(LONG, "the stop", stopping).await.expect("stop task");
    assert_eq!(report.dispatch, StopDispatch::NothingOpened, "the first dispatch decided before the attach was recorded");
    assert_eq!(report.late_dispatch, Some(StopDispatch::Dispatched { pid }), "the late delivery's outcome, reported once");
    assert!(awaiting_for(LONG, "the use of the revoked opening", using).await.unwrap().is_err());
    let _ = first.stop().await;
}

/// The opening fenced after `pg_ctl start` was spawned and before its cluster is ready: at the cutoff the record names a start handed to the OS, so
/// the stop either reaches its postmaster (its pid file exists) or reports `ExternalStartUnresolved`; it never claims nothing was started.
#[tokio::test(flavor = "multi_thread")]
async fn an_opening_fenced_after_the_os_launch_is_dispatched_or_reported_unresolved() {
    let dir = tempfile::tempdir().expect("dir");
    let (mut entered, release) = fences::arm("pg-launched");
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    let db = stack.db();
    let using = tokio::spawn(async move { db.client().await.map(drop) });
    awaiting_for(LONG, "the start to be handed to the OS", entered.recv()).await.expect("entered");
    stack.arm_forced_stop(&tokio::runtime::Handle::current());
    let report = awaiting_for(LONG, "the stop", stack.stop_report()).await;
    drop(release);
    assert!(
        matches!(report.dispatch, StopDispatch::Dispatched { .. } | StopDispatch::ExternalStartUnresolved),
        "a launched start is never reported as nothing opened: {:?}",
        report.dispatch
    );
    assert!(awaiting_for(LONG, "the use of the revoked opening", using).await.unwrap().is_err());
    // Cleanup: the postmaster the launch left, once it wrote its pid file, is stopped.
    let pgdata = dir.path().join("pgdata");
    let lane = mixdog_rt::testing::tokens().durability_io;
    let deadline = tokio::time::Instant::now() + LONG;
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(pid)) = crate::memory::pg::cluster::recorded_pid(lane, &pgdata).await {
            let cluster =
                crate::memory::pg::cluster::PgCluster::over(PgRuntime::new(pg_runtime()), dir.path(), 0, lane, crate::tidy::process::Processes::for_tests());
            let _ = cluster.stop(std::time::Duration::from_secs(15)).await;
            assert!(crate::memory::pg::cluster::await_exit(pid, tokio::time::Instant::now() + LONG).await);
            break;
        }
        if matches!(report.dispatch, StopDispatch::Dispatched { .. }) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Suspends or resumes the postmaster's main thread (an OS-level fence: the shutdown it was asked for cannot proceed). On Windows only that thread is
/// suspended, so the postmaster's signal-pipe thread still takes the request `pg_ctl stop -W` delivers; on Unix the whole process is stopped and the
/// `SIGINT` stays pending.
fn suspend(pid: u32, suspended: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME};
        #[repr(C)]
        struct ThreadEntry32 {
            size: u32,
            usage: u32,
            thread_id: u32,
            owner_process_id: u32,
            base_priority: i32,
            delta_priority: i32,
            flags: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateToolhelp32Snapshot(flags: u32, process: u32) -> HANDLE;
            fn Thread32First(snapshot: HANDLE, entry: *mut ThreadEntry32) -> i32;
            fn Thread32Next(snapshot: HANDLE, entry: *mut ThreadEntry32) -> i32;
        }
        const TH32CS_SNAPTHREAD: u32 = 0x4;
        // SAFETY: plain Win32 calls on handles opened here; the entry is sized as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            let mut entry = ThreadEntry32 {
                size: std::mem::size_of::<ThreadEntry32>() as u32,
                usage: 0,
                thread_id: 0,
                owner_process_id: 0,
                base_priority: 0,
                delta_priority: 0,
                flags: 0,
            };
            let mut main = None;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                // Threads are listed in creation order: the first of the process is its main thread.
                if entry.owner_process_id == pid {
                    main = Some(entry.thread_id);
                    break;
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, main.expect("the postmaster's main thread"));
            assert!(!thread.is_null(), "{}", std::io::Error::last_os_error());
            let previous = if suspended { SuspendThread(thread) } else { ResumeThread(thread) };
            CloseHandle(thread);
            assert_ne!(previous, u32::MAX, "{}", std::io::Error::last_os_error());
        }
    }
    #[cfg(unix)]
    // SAFETY: a stop/continue signal to the test's own postmaster.
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, if suspended { libc::SIGSTOP } else { libc::SIGCONT }), 0);
    }
}

/// A real slow PostgreSQL shutdown: right before the fast-shutdown request is delivered, the postmaster's main thread is OS-suspended, so the
/// delivered shutdown cannot proceed. The graceful stop (WAL flushed before the dispatch) observes the postmaster still alive at the cutoff and returns with that recorded;
/// resumed, the postmaster finishes its shutdown, observed here.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_reports_its_dispatch_while_a_suspended_postmaster_is_still_alive() {
    let dir = tempfile::tempdir().expect("dir");
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    drop(awaiting_for(LONG, "the stack opens", stack.db().client()).await.expect("opens"));
    let lane = mixdog_rt::testing::tokens().durability_io;
    let postmaster = crate::memory::pg::cluster::recorded_pid(lane, &dir.path().join("pgdata")).await.expect("pid file").expect("a postmaster");
    let (mut entered, release) = fences::arm("dispatching");
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop_report().await }
    });
    awaiting_for(LONG, "the stop to reach its dispatch", entered.recv()).await.expect("entered");
    suspend(postmaster, true);
    let _ = release.send(());
    let report = awaiting_for(LONG, "the stop", stopping).await.unwrap();
    let alive = mixdog_statefile::process_exists(postmaster);
    suspend(postmaster, false);
    assert_eq!(report.dispatch, StopDispatch::Dispatched { pid: postmaster }, "{report:?}");
    assert!(!report.forced && report.flushed, "a graceful stop flushed the WAL before its dispatch: {report:?}");
    assert_eq!(report.postmaster_exited, Some(false), "the exit was observed only inside the cutoff, and had not happened");
    assert!(alive, "the stop returned while the postmaster was still alive");
    assert!(crate::memory::pg::cluster::await_exit(postmaster, tokio::time::Instant::now() + LONG).await, "resumed, the postmaster exits");
}

/// The shutdown's last finalizer, fenced inside its SQL (the WAL flush's transaction begun, its commit not sent): it holds the graceful stop until the
/// cutoff, where the revocation destroys it with its connection; the stop reports no flush and is dispatched without waiting further.
#[tokio::test(flavor = "multi_thread")]
async fn a_finalizer_fenced_inside_its_sql_is_revoked_at_the_cutoff() {
    let dir = tempfile::tempdir().expect("dir");
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    drop(awaiting_for(LONG, "the stack opens", stack.db().client()).await.expect("opens"));
    let (mut entered, _release) = fences::arm("wal-flush");
    stack.arm_forced_stop(&tokio::runtime::Handle::current());
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop_report().await }
    });
    awaiting_for(LONG, "the WAL flush to be fenced inside its transaction", entered.recv()).await.expect("entered");
    let report = awaiting_for(LONG, "the stop", stopping).await.unwrap();
    assert!(report.forced && !report.flushed, "{report:?}");
    assert!(matches!(report.dispatch, StopDispatch::Dispatched { .. }), "{:?}", report.dispatch);
    assert_eq!(stack.db().scope().running() + stack.db().scope().transport().running(), 0);
}

/// The port line of the cluster's `postmaster.pid` (an observer of its own connects there).
fn postmaster_port(dir: &std::path::Path) -> u16 {
    #[allow(clippy::disallowed_methods, reason = "test observation of the pid file")]
    let text = std::fs::read_to_string(dir.join("pgdata").join("postmaster.pid")).expect("pid file");
    text.lines().nth(3).expect("port line").trim().parse().expect("port")
}

/// Commits made with asynchronous commit before the stop are covered when the stop reports `flushed`: at the dispatch (fenced right before it), the
/// cluster's flush position is at or past the WAL position read after the last such commit.
#[tokio::test(flavor = "multi_thread")]
async fn a_flushed_stop_covers_the_asynchronous_commits_made_before_it() {
    let dir = tempfile::tempdir().expect("dir");
    let stack = stack_over(dir.path(), PgRuntimeSource::Dir(pg_runtime())).await;
    let db = stack.db();
    drop(awaiting_for(LONG, "the stack opens", db.client()).await.expect("opens"));
    for n in 0..20 {
        db.execute("INSERT INTO meta(key, value) VALUES ($1, '1'::jsonb) ON CONFLICT(key) DO NOTHING", &[&format!("async-commit-{n}")]).await.expect("commit");
    }
    let last: String = db.query("SELECT pg_current_wal_insert_lsn()::text", &[]).await.expect("lsn")[0].get(0);
    let observer = crate::memory::pg::db::Db::open_in(postmaster_port(dir.path()), crate::memory::pg::db::DATABASE, crate::memory::pg::db::Schema::Memory)
        .expect("observer");
    let observing = observer.client().await.expect("the observer's connection");
    let (mut entered, release) = fences::arm("dispatching");
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop_report().await }
    });
    awaiting_for(LONG, "the stop to reach its dispatch", entered.recv()).await.expect("entered");
    let covered: bool = observing.query_one("SELECT pg_current_wal_flush_lsn() >= $1::text::pg_lsn", &[&last]).await.expect("flush lsn").get(0);
    drop(observing);
    let _ = release.send(());
    let report = awaiting_for(LONG, "the stop", stopping).await.unwrap();
    assert!(report.flushed, "{report:?}");
    assert!(covered, "a flushed stop covers every asynchronous commit made before it");
}

/// A start whose cleanup left a postmaster running keeps its target (with its pid), so the stop is still dispatched; only evidence that no
/// postmaster runs clears it.
#[tokio::test]
async fn a_failed_start_with_a_surviving_postmaster_keeps_its_stop_target() {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let dir = tempfile::tempdir().expect("dir");
    let pgdata = dir.path().join("pgdata");
    std::fs::create_dir_all(&pgdata).expect("pgdata");
    let record = crate::memory::pg::cluster::StopRecord::new(pgdata.clone(), lane, crate::tidy::process::Processes::for_tests(), true);
    let runtime = PgRuntime::new(dir.path().join("runtime"));
    record.handed(&runtime);
    // The surviving "postmaster": a live process named by the pid file.
    pid_file(&pgdata, std::process::id(), 55_998);
    record.failed_start().await;
    assert_ne!(record.dispatch().await, StopDispatch::NothingOpened, "the surviving postmaster is still the stop's target");
    let cleared = crate::memory::pg::cluster::StopRecord::new(pgdata.clone(), lane, crate::tidy::process::Processes::for_tests(), true);
    std::fs::remove_file(pgdata.join("postmaster.pid")).expect("no pid file");
    cleared.handed(&runtime);
    cleared.failed_start().await;
    assert_eq!(cleared.dispatch().await, StopDispatch::NothingOpened, "cleared only on evidence that no postmaster runs");
}

/// The stop decided while the start was still `Handed` (no pid file: unresolved); the cluster then becomes ready: the transition only marks it, and
/// the controller's late dispatch (after its acknowledgement, owned by the stop) signals it and records the outcome, so the schedule does not end with
/// a live cluster, a requested stop and no dispatch. Without a late transition there is no late dispatch.
#[tokio::test]
async fn a_cluster_reached_after_the_dispatch_decided_is_dispatched_by_the_controller() {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let dir = tempfile::tempdir().expect("dir");
    let pgdata = dir.path().join("pgdata");
    std::fs::create_dir_all(&pgdata).expect("pgdata");
    let record = crate::memory::pg::cluster::StopRecord::new(pgdata.clone(), lane, crate::tidy::process::Processes::for_tests(), true);
    let runtime = PgRuntime::new(dir.path().join("runtime"));
    record.handed(&runtime);
    assert_eq!(record.dispatch().await, StopDispatch::ExternalStartUnresolved);
    assert_eq!(record.late_dispatch().await, None, "nothing came late yet");
    record.reached(&runtime, Some(std::process::id()));
    let late = record.late_dispatch().await.expect("the late transition is dispatched by the controller");
    assert_eq!(record.late_dispatch().await, None, "dispatched once");
    // A live pid that is no postgres: delivered through `pg_ctl` on Windows (absent here, so `Failed`), left alone on Unix.
    assert_ne!(late, StopDispatch::NothingOpened, "{late:?}");
}

/// A retry timer that never fires (the watcher's sweep and debounces stay armed).
struct NeverFires;

impl crate::bots::delivery::env::RetryTimer for NeverFires {
    fn arm(&self, _delay: std::time::Duration, _fire: Box<dyn FnOnce() + Send>) {}
}

/// The shutdown's offset write and trace drain, each fenced inside its own SQL (connection checked out, statement not yet answered) in a stack with
/// the watcher and tracing on: the offset write is released and completes, the trace write is held until the cutoff, where the revocation destroys it
/// with its connection; nothing of either is left outstanding.
#[tokio::test(flavor = "multi_thread")]
async fn the_offset_write_and_the_trace_drain_are_owned_finalizers_fenced_inside_their_sql() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(crate::memory::trace::trace_marker_path(dir.path()), "").expect("tracing on");
    let projects = dir.path().join("projects");
    std::fs::create_dir_all(&projects).expect("projects");
    let sink = crate::memory::transcript::watcher::TranscriptSink::default();
    let folders = Arc::new(mixdog_workspace::watcher::FolderWatcher::new(sink.change_sink()).expect("folders"));
    let mut boot = boot_over(dir.path(), PgRuntimeSource::Dir(pg_runtime()));
    boot.transcripts = Some(crate::memory::boot::TranscriptWatch { projects_root: projects, folders, sink, timer: Arc::new(NeverFires) });
    let stack = MemoryStack::start(boot).await.expect("built");
    drop(awaiting_for(LONG, "the stack opens", stack.db().client()).await.expect("opens"));
    awaiting_for(LONG, "the watcher and the trace store to be running", async {
        while !stack.background_ready() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let trace = stack.trace_sink().expect("tracing is on");
    let now = chrono::Utc::now().timestamp_millis();
    let row = json!({"kind": "tool", "session_id": "finalizers", "tool_name": "read", "tool_ms": 1, "ts": now});
    mixdog_trace::RowSink::row(&*trace, row.as_object().expect("an object"), now);
    let (mut offsets, release_offsets) = fences::arm("state.transcript_offsets");
    let (mut traced, _held) = fences::arm("trace-sql");
    stack.arm_forced_stop(&tokio::runtime::Handle::current());
    let stopping = tokio::spawn({
        let stack = stack.clone();
        async move { stack.stop_report().await }
    });
    awaiting_for(LONG, "the offset write to be fenced inside its statement", offsets.recv()).await.expect("offsets");
    let _ = release_offsets.send(());
    awaiting_for(LONG, "the trace write to be fenced inside its session", traced.recv()).await.expect("trace");
    let report = awaiting_for(LONG, "the stop at the cutoff", stopping).await.unwrap();
    assert!(report.forced && !report.flushed, "{report:?}");
    assert!(matches!(report.dispatch, StopDispatch::Dispatched { .. }), "{:?}", report.dispatch);
    assert_eq!(stack.db().scope().running() + stack.db().scope().transport().running(), 0);
}
