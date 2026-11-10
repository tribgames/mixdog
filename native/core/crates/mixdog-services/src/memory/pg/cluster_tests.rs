use super::*;
use crate::memory::tests::awaiting::{awaiting, awaiting_for};
use crate::memory::tests::fakes::{Fake, dead_pid, pid_file};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A postmaster that is starting up: it reads the startup packet and answers it with
/// `FATAL: the database system is starting up` (57P03).
async fn refuse_startup(mut socket: tokio::net::TcpStream) -> std::io::Result<()> {
    let len = socket.read_u32().await?;
    let mut rest = vec![0_u8; usize::try_from(len).unwrap() - 4];
    socket.read_exact(&mut rest).await?;
    let mut body = Vec::new();
    for (code, text) in [(b'S', "FATAL"), (b'V', "FATAL"), (b'C', "57P03"), (b'M', "the database system is starting up")] {
        body.push(code);
        body.extend_from_slice(text.as_bytes());
        body.push(0);
    }
    body.push(0);
    let mut reply = vec![b'E'];
    reply.extend_from_slice(&u32::try_from(body.len() + 4).unwrap().to_be_bytes());
    reply.extend_from_slice(&body);
    socket.write_all(&reply).await?;
    socket.shutdown().await
}


/// The port the start asks `healthcheckPg` through: a postmaster that answers once `up` is set. Every question is counted and announced on `seen`, so a test knows
/// the step the start has reached (the two reuse checks, then the first question of the recovery wait) without any wait of its own.
struct Probe {
    up: AtomicBool,
    calls: AtomicUsize,
    seen: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Health for Probe {
    fn healthy(&self, _port: u16) -> futures::future::BoxFuture<'static, bool> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = self.seen.send(());
        let answer = self.up.load(Ordering::SeqCst);
        Box::pin(async move { answer })
    }
}

impl Probe {
    fn new() -> (Arc<Self>, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let (seen, questions) = tokio::sync::mpsc::unbounded_channel();
        (Arc::new(Self { up: AtomicBool::new(false), calls: AtomicUsize::new(0), seen }), questions)
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

/// `n` questions of the probe, under one deadline that names what is awaited.
async fn questions(seen: &mut tokio::sync::mpsc::UnboundedReceiver<()>, n: usize, what: &str) {
    for _ in 0..n {
        awaiting_for(Duration::from_secs(10), what, seen.recv()).await.expect("the probe is alive");
    }
}

type Starting = tokio::task::JoinHandle<Result<PgCluster>>;

/// The cluster directory of the profile `dir`, created.
fn pgdata(dir: &Path) -> PathBuf {
    let pgdata = dir.join("pgdata");
    std::fs::create_dir_all(&pgdata).unwrap();
    pgdata
}

/// A start over the profile `dir` (whose cluster exists and which holds no runtime: a start that gets as far as running `pg_ctl` fails there), run as a task.
fn start_in(dir: &Path, probe: &Arc<Probe>, recovery_wait: Duration, lock_wait: Duration, cancel: &CancellationToken) -> Starting {
    std::fs::write(pgdata(dir).join("PG_VERSION"), "16\n").unwrap();
    let (dir, probe, cancel) = (dir.to_owned(), probe.clone(), cancel.clone());
    tokio::spawn(async move {
        let lane = mixdog_rt::testing::tokens().durability_io;
        let start = Start { health: probe, recovery_wait, lock_wait, before_spawn: None };
        PgCluster::ensure(PgRuntime::new(dir.join("no-runtime")), &dir, 55_900, lane, Processes::for_tests(), &cancel, &start, &|| true).await
    })
}

/// A start that is waiting for an alive, silent postmaster: the two reuse checks and the first question of the recovery wait are in.
async fn waiting_start(dir: &Path, port: u16) -> (Fake, Arc<Probe>, tokio::sync::mpsc::UnboundedReceiver<()>, CancellationToken, Starting) {
    let postmaster = Fake::new(dir, "postgres");
    pid_file(&pgdata(dir), postmaster.id(), port);
    let (probe, mut seen) = Probe::new();
    let cancel = CancellationToken::new();
    let starting = start_in(dir, &probe, RECOVERY_WAIT, SPAWN_LOCK_WAIT, &cancel);
    questions(&mut seen, 3, "the start to reach the recovery wait (two reuse checks, then the first question of the wait)").await;
    assert_eq!(probe.calls(), 3);
    (postmaster, probe, seen, cancel, starting)
}

/// One explicit quarter second of the held clock, and the probe question that follows it.
async fn step(seen: &mut tokio::sync::mpsc::UnboundedReceiver<()>) {
    tokio::time::advance(READY_POLL).await;
    questions(seen, 1, "the next question of the recovery wait after a quarter second").await;
}

/// `waitForPostmasterReady` (`supervisor.mjs:342-352`), through the start, on a clock the test moves a quarter second at a time. The wait began (the probe's
/// third question), the start is still waiting at 29.75 s, and at 30.0 s, after the question made at that instant, it refuses with Node's text.
#[tokio::test(start_paused = true)]
async fn a_start_waits_thirty_seconds_for_an_alive_postmaster_and_then_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let (postmaster, probe, mut seen, _cancel, starting) = waiting_start(dir.path(), 55_901).await;
    for taken in 1..=119 {
        step(&mut seen).await;
        assert_eq!(probe.calls(), 3 + taken, "one question per quarter second");
        assert!(!starting.is_finished(), "still waiting at {} ms", taken * 250);
    }
    step(&mut seen).await;
    assert_eq!(probe.calls(), 123, "the last question is the one at 30 s");
    let refused = awaiting("the refusal at 30 s", starting).await.unwrap().err().expect("refused");
    assert_eq!(refused.message(), format!("postgres runtime: [supervisor-pg] existing postmaster PID {} remains alive but unhealthy; refusing concurrent start", postmaster.id()));
    assert!(dir.path().join("pgdata").join("postmaster.pid").exists(), "the file of an alive postmaster stays");
}

/// The same wait, the postmaster coming up at 10 s: the next question attaches to it and the start starts nothing.
#[tokio::test(start_paused = true)]
async fn a_start_attaches_to_a_postmaster_that_comes_up_while_it_is_waited_for() {
    let dir = tempfile::tempdir().unwrap();
    let (_postmaster, probe, mut seen, _cancel, starting) = waiting_start(dir.path(), 55_902).await;
    for _ in 1..=40 {
        step(&mut seen).await;
        assert!(!starting.is_finished());
    }
    probe.up.store(true, Ordering::SeqCst);
    step(&mut seen).await;
    let cluster = awaiting("the attach", starting).await.unwrap().expect("attached");
    assert_eq!(probe.calls(), 3 + 41);
    assert_eq!(cluster.port(), 55_902);
    assert!(dir.path().join("pgdata").join("postmaster.pid").exists());
}

/// A stop (the start's cancel) ends the wait at once, with no quarter second passing and no further question.
#[tokio::test(start_paused = true)]
async fn a_stop_ends_the_wait_for_an_alive_postmaster() {
    let dir = tempfile::tempdir().unwrap();
    let (_postmaster, probe, _seen, cancel, starting) = waiting_start(dir.path(), 55_906).await;
    cancel.cancel();
    let ended = awaiting_for(Duration::from_secs(5), "the cancelled wait to end", starting).await.unwrap().err().expect("cancelled");
    assert_eq!(ended.message(), "postgres runtime: the start was cancelled before postgres was ready");
    assert_eq!(probe.calls(), 3, "no question after the cancel");
    assert!(dir.path().join("pgdata").join("postmaster.pid").exists(), "a postmaster that is not ours is left alone");
}

/// A killed core's postmaster is gone and leaves its file: Node removes it and starts a postmaster of its own (here the start gets as far as `pg_ctl`, which the
/// empty runtime lacks).
#[tokio::test]
async fn a_start_removes_the_pid_file_of_a_dead_postmaster_and_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    pid_file(&pgdata(dir.path()), dead_pid(dir.path()), 55_903);
    let (probe, _seen) = Probe::new();
    let starting = start_in(dir.path(), &probe, RECOVERY_WAIT, SPAWN_LOCK_WAIT, &CancellationToken::new());
    let failed = awaiting("the start to fail at pg_ctl", starting).await.unwrap().err().expect("no runtime to start");
    assert!(failed.message().contains("pg_ctl"), "the start reached pg_ctl: {}", failed.message());
    assert!(!dir.path().join("pgdata").join("postmaster.pid").exists(), "the stale file is removed");
}

/// A pid a reboot handed to another program is not a postmaster (`isPostgresPid`): its file is stale too.
#[tokio::test]
async fn a_pid_file_naming_a_live_process_that_is_not_postgres_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let other = Fake::new(dir.path(), "notapostmaster");
    pid_file(&pgdata(dir.path()), other.id(), 55_904);
    let (probe, _seen) = Probe::new();
    let starting = start_in(dir.path(), &probe, RECOVERY_WAIT, SPAWN_LOCK_WAIT, &CancellationToken::new());
    let failed = awaiting("the start to fail at pg_ctl", starting).await.unwrap().err().expect("no runtime to start");
    assert!(failed.message().contains("pg_ctl"), "{}", failed.message());
    assert!(!dir.path().join("pgdata").join("postmaster.pid").exists());
}

/// Two starters on one data directory (`withFileLock(join(dataDir, 'pg-spawn.lock'), …)`, `supervisor.mjs:618`): while a holder has the lock, a starter that
/// does not wait is refused before it touches the directory; once the holder releases, the next one goes through to `pg_ctl`.
#[tokio::test]
async fn a_second_starter_is_refused_while_the_spawn_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let lock_file = dir.path().join("pg-spawn.lock");
    let (taken, held) = tokio::sync::oneshot::channel();
    let hold = mixdog_statefile::hold_lock(&lock_file, &mixdog_statefile::LockOpts::default(), move |outcome| {
        let _ = taken.send(outcome);
    });
    awaiting("the holder to take the spawn lock", held).await.unwrap().expect("the lock is taken");
    assert!(lock_file.exists(), "the lock is Node's file: <dataDir>/pg-spawn.lock");
    pid_file(&pgdata(dir.path()), dead_pid(dir.path()), 55_907);
    let (probe, _seen) = Probe::new();
    let refused = awaiting("the refused start", start_in(dir.path(), &probe, RECOVERY_WAIT, Duration::ZERO, &CancellationToken::new())).await.unwrap().err().expect("refused");
    assert!(refused.message().contains("atomic lock contended (try-once)"), "{}", refused.message());
    assert!(dir.path().join("pgdata").join("postmaster.pid").exists(), "the refused starter did not touch the directory");
    assert_eq!(probe.calls(), 1, "only the check before the lock ran");
    hold.release_and_wait();
    assert!(!lock_file.exists(), "released");
    let starting = start_in(dir.path(), &probe, RECOVERY_WAIT, Duration::ZERO, &CancellationToken::new());
    let failed = awaiting("the start to fail at pg_ctl", starting).await.unwrap().err().expect("no runtime to start");
    assert!(failed.message().contains("pg_ctl"), "{}", failed.message());
    assert!(!lock_file.exists(), "a start releases the lock when it ends");
}

/// `rotateLogIfNeeded` before a fresh start (`supervisor.mjs:92-108`, `:359`): a log of more than 10 MB becomes `pg.log.1`, replacing the older archive, and a
/// log of exactly 10 MB stays where it is.
#[tokio::test]
async fn a_fresh_start_rotates_a_log_over_ten_megabytes_into_the_one_archive() {
    const LIMIT: usize = 10 * 1024 * 1024;
    for (size, rotated) in [(LIMIT + 1, true), (LIMIT, false)] {
        let dir = tempfile::tempdir().unwrap();
        let (log, archive) = (dir.path().join("pg.log"), dir.path().join("pg.log.1"));
        let content = vec![b'x'; size];
        std::fs::write(&log, &content).unwrap();
        std::fs::write(&archive, b"the older archive").unwrap();
        let (probe, _seen) = Probe::new();
        let failed = awaiting("the start to fail at pg_ctl", start_in(dir.path(), &probe, RECOVERY_WAIT, SPAWN_LOCK_WAIT, &CancellationToken::new())).await.unwrap().err().expect("no runtime to start");
        assert!(failed.message().contains("pg_ctl"), "{}", failed.message());
        if rotated {
            assert!(!log.exists(), "a log over 10 MB is moved aside");
            assert_eq!(std::fs::read(&archive).unwrap(), content, "it is the one archive");
        } else {
            assert_eq!(std::fs::read(&log).unwrap(), content, "a log of 10 MB stays");
            assert_eq!(std::fs::read(&archive).unwrap(), b"the older archive");
        }
    }
}

#[tokio::test]
async fn a_postmaster_still_starting_up_is_not_ready() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let _ = refuse_startup(socket).await;
        }
    });
    let connected = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok();
    let ready = healthcheck(port).await;
    server.abort();
    let _ = server.await;
    assert!(connected, "the port takes connections");
    assert!(!ready, "a refused session is not readiness");
}

/// `pg_ctl start`'s output is kept whole at the size a start writes (Node keeps all of it, `process.mjs:401-406`, so its failure text is the same), and
/// only the last `OUTPUT_TAIL` bytes of a postmaster that keeps writing into the inherited pipe.
#[test]
fn the_start_output_keeps_a_failure_whole_and_only_the_tail_of_a_flood() {
    let failure = b"pg_ctl: another server might be running; trying to start server anyway\n";
    let mut kept = Vec::new();
    keep_tail(&mut kept, failure);
    assert_eq!(kept, failure);
    for _ in 0..(2 * OUTPUT_TAIL / failure.len()) {
        keep_tail(&mut kept, failure);
    }
    keep_tail(&mut kept, b"the last line");
    assert_eq!(kept.len(), OUTPUT_TAIL);
    assert!(kept.ends_with(b"the last line"));
}
