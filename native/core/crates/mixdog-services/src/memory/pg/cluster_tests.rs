use super::*;
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

/// A process that stays alive and answers nothing, whose image is named `image_name` (a postmaster is told by its image's name, `isPostgresPid`).
fn fake_process(dir: &Path, image_name: &str) -> std::process::Child {
    let (source, name, args): (&str, String, &[&str]) = if cfg!(windows) {
        (r"C:\Windows\System32\PING.EXE", format!("{image_name}.exe"), &["-n", "60", "127.0.0.1"])
    } else {
        ("/bin/sleep", image_name.to_owned(), &["60"])
    };
    let image = dir.join(name);
    std::fs::copy(source, &image).expect("copy an image");
    std::process::Command::new(image).args(args).stdout(std::process::Stdio::null()).spawn().expect("spawn")
}

/// A process id that was alive a moment ago and is not any more.
fn dead_pid(dir: &Path) -> u32 {
    let mut gone = fake_process(dir, "postgres");
    let pid = gone.id();
    gone.kill().unwrap();
    gone.wait().unwrap();
    pid
}

fn pid_file(dir: &Path, pid: u32, port: u16) {
    std::fs::write(dir.join("postmaster.pid"), format!("{pid}\n{}\n1\n{port}\n", dir.display())).unwrap();
}

/// The probe of a postmaster that answers once `up` is set; every call is counted.
fn probe_of(up: Arc<std::sync::atomic::AtomicBool>, calls: Arc<std::sync::atomic::AtomicUsize>) -> impl Fn(u16) -> futures::future::BoxFuture<'static, bool> + Send + Sync {
    move |_| {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let answer = up.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { answer })
    }
}

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize};

async fn ensure_over(dir: &Path, wait: Duration, probe: Probe<'_>) -> Result<PgCluster> {
    let lane = mixdog_rt::testing::tokens().durability_io;
    // The directory holds a cluster (`PG_VERSION`) and no runtime: a start that gets as far as running `pg_ctl` fails there.
    std::fs::write(dir.join("PG_VERSION"), "16\n").unwrap();
    PgCluster::ensure_with(PgRuntime::new(dir.join("no-runtime")), dir, 55_900, lane, Processes::for_tests(), &CancellationToken::new(), wait, probe).await
}

/// `waitForPostmasterReady` (`supervisor.mjs:339-352`) on a held clock: it probes every 250 ms, is still waiting one poll before 30 s and gives up at 30 s.
#[tokio::test(start_paused = true)]
async fn an_alive_postmaster_that_never_answers_is_waited_for_until_exactly_the_deadline() {
    let calls = Arc::new(AtomicUsize::new(0));
    let probe = probe_of(Arc::new(AtomicBool::new(false)), calls.clone());
    let own = std::process::id();
    let waiting = tokio::spawn(async move { await_recovery(own, 1, RECOVERY_WAIT, &probe).await });
    tokio::time::advance(RECOVERY_WAIT - READY_POLL).await;
    assert!(!waiting.is_finished(), "still waiting one poll before the deadline");
    tokio::time::advance(READY_POLL).await;
    assert_eq!(waiting.await.unwrap(), Recovery::AliveNotReady);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 121, "a probe at the start and one every 250 ms to the deadline");
}

#[tokio::test(start_paused = true)]
async fn a_postmaster_that_finishes_recovery_while_waited_for_is_attached() {
    let up = Arc::new(AtomicBool::new(false));
    let probe = probe_of(up.clone(), Arc::new(AtomicUsize::new(0)));
    let own = std::process::id();
    let waiting = tokio::spawn(async move { await_recovery(own, 1, RECOVERY_WAIT, &probe).await });
    tokio::time::advance(Duration::from_secs(10)).await;
    assert!(!waiting.is_finished());
    up.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::advance(READY_POLL).await;
    assert_eq!(waiting.await.unwrap(), Recovery::Ready);
}

/// Through the start itself. A pid file of a postmaster that is alive and silent: the start waits, then refuses with Node's text and leaves the file of the live owner.
#[tokio::test]
async fn a_start_beside_an_alive_postmaster_that_does_not_answer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut postmaster = fake_process(dir.path(), "postgres");
    pid_file(dir.path(), postmaster.id(), 55_901);
    let probe = probe_of(Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let refused = ensure_over(dir.path(), Duration::ZERO, &probe).await.err().expect("refused");
    assert_eq!(refused.message(), format!("postgres runtime: [supervisor-pg] existing postmaster PID {} remains alive but unhealthy; refusing concurrent start", postmaster.id()));
    assert!(dir.path().join("postmaster.pid").exists(), "the file of an alive postmaster stays");
    postmaster.kill().unwrap();
    postmaster.wait().unwrap();
}

/// The 30 s of `waitForPostmasterReady`, through the start on a held clock: the start is still waiting one poll before the deadline and refuses at it.
#[tokio::test(start_paused = true)]
async fn a_start_waits_thirty_seconds_for_an_alive_postmaster_before_it_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let mut postmaster = fake_process(dir.path(), "postgres");
    pid_file(dir.path(), postmaster.id(), 55_905);
    let path = dir.path().to_owned();
    let starting = tokio::spawn(async move {
        let probe = probe_of(Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        ensure_over(&path, RECOVERY_WAIT, &probe).await.err().map(|error| error.message())
    });
    tokio::time::advance(RECOVERY_WAIT - READY_POLL).await;
    assert!(!starting.is_finished(), "still waiting one poll before the deadline");
    tokio::time::advance(READY_POLL).await;
    let refused = starting.await.unwrap().expect("refused at the deadline");
    assert!(refused.contains("remains alive but unhealthy; refusing concurrent start"), "{refused}");
    postmaster.kill().unwrap();
    postmaster.wait().unwrap();
}

/// The same pid file, the postmaster coming up while it is waited for: the start attaches to it and starts nothing.
#[tokio::test]
async fn a_start_attaches_to_a_postmaster_that_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let mut postmaster = fake_process(dir.path(), "postgres");
    pid_file(dir.path(), postmaster.id(), 55_902);
    // The first probe is the start's own check of the recorded port (not up yet); the next is the recovery wait's.
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let probe = move |_: u16| -> futures::future::BoxFuture<'static, bool> {
        let call = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { call >= 1 })
    };
    let cluster = ensure_over(dir.path(), RECOVERY_WAIT, &probe).await.expect("attached");
    assert_eq!(cluster.port(), 55_902);
    assert!(dir.path().join("postmaster.pid").exists());
    postmaster.kill().unwrap();
    postmaster.wait().unwrap();
}

/// A killed core's postmaster is gone and leaves its file: Node removes it and starts a postmaster of its own (here the start gets as far as `pg_ctl`, which the empty runtime lacks).
#[tokio::test]
async fn a_start_removes_the_pid_file_of_a_dead_postmaster_and_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    pid_file(dir.path(), dead_pid(dir.path()), 55_903);
    let probe = probe_of(Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let failed = ensure_over(dir.path(), RECOVERY_WAIT, &probe).await.err().expect("no runtime to start");
    assert!(failed.message().contains("pg_ctl"), "the start reached pg_ctl: {}", failed.message());
    assert!(!dir.path().join("postmaster.pid").exists(), "the stale file is removed");
}

/// A pid a reboot handed to another program is not a postmaster (`isPostgresPid`): its file is stale too.
#[tokio::test]
async fn a_pid_file_naming_a_live_process_that_is_not_postgres_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let mut other = fake_process(dir.path(), "notapostmaster");
    pid_file(dir.path(), other.id(), 55_904);
    let probe = probe_of(Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let failed = ensure_over(dir.path(), RECOVERY_WAIT, &probe).await.err().expect("no runtime to start");
    assert!(failed.message().contains("pg_ctl"), "{}", failed.message());
    assert!(!dir.path().join("postmaster.pid").exists());
    other.kill().unwrap();
    other.wait().unwrap();
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
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok(), "the port takes connections");
    assert!(!healthcheck(port).await, "a refused session is not readiness");
    server.abort();
}
