//! The PostgreSQL cluster behind memory and session search: one bundled
//! runtime (`bin/`, `lib/`, `share/`, pgvector included), one data directory.
//! `PgCluster::ensure` attaches to a postmaster that already serves the data
//! directory, else initialises it when empty and starts one. The core is the
//! only process of its data dir, so there is no secondary-attach protocol.

//!
//! Every child but `pg_ctl start` (`initdb`, `pg_ctl status|reload|stop`) runs under the one process
//! manager through [`Processes`], with Node's limits (`runtime/memory/lib/pg/process.mjs`): `status`
//! 3 s, `reload` 5 s, `stop` its `-t` seconds plus one; `initdb` has none, as in Node, and is ended by
//! the caller's cancel. `pg_ctl start` is spawned outside the manager and not waited for (the
//! readiness poll, 30 s, is its bound), as Node spawns it: the manager holds each child's tree in a
//! job that ends with this process, and the postmaster must outlive a killed core as Node's
//! outlives a killed daemon, so the next core attaches to it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::{DurabilityIo, TaskClass};
use tokio_postgres::NoTls;
use tokio_util::sync::CancellationToken;

use super::db;
use crate::memory::error::{MemoryError, Result};
use crate::model_install::fsio;
use crate::tidy::process::{ProcessResult, Processes, RunOptions};

/// First port tried for a product postmaster, and how many ports above it are scanned.
pub const DEFAULT_PORT: u16 = 55432;
const PORT_SPAN: u16 = 200;
const START_DEADLINE: Duration = Duration::from_secs(30);
/// `await delay(250)` of Node's `startAndWaitReady`.
const READY_POLL: Duration = Duration::from_millis(250);

/// The `-t` of the stop of an abandoned start (`STOP_SECONDS` of the memory stack's own stop).
const STOP_TIMEOUT_SECONDS: u64 = 15;
/// `pg_ctl status` (`timeoutMs: 3_000`).
const STATUS_LIMIT: Duration = Duration::from_secs(3);
/// `pg_ctl reload` (`timeoutMs: 5_000`).
const RELOAD_LIMIT: Duration = Duration::from_secs(5);
/// How long a start that lost a race waits for the winner's postmaster (`existingWaitMs`).
const EXISTING_WAIT: Duration = Duration::from_secs(15);
/// One readiness probe: `healthcheckPg`'s `connectionTimeoutMillis: 2000`.
const HEALTH_LIMIT: Duration = Duration::from_secs(2);

/// A bundled PostgreSQL runtime directory.
#[derive(Debug, Clone)]
pub struct PgRuntime {
    dir: PathBuf,
}

impl PgRuntime {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn bin(&self, name: &str) -> PathBuf {
        let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
        self.dir.join("bin").join(file)
    }

    /// The environment a child runs in (`libEnv`): this process's, with the runtime's libraries
    /// reachable.
    fn env(&self) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        let lib = self.dir.join("lib").to_string_lossy().into_owned();
        if cfg!(target_os = "linux") {
            env.insert("LD_LIBRARY_PATH".to_owned(), lib);
        } else if cfg!(target_os = "macos") {
            env.insert("DYLD_LIBRARY_PATH".to_owned(), lib);
        } else {
            // Windows keeps the DLLs beside the executables.
            let key = env.keys().find(|key| key.eq_ignore_ascii_case("PATH")).cloned().unwrap_or_else(|| "PATH".to_owned());
            let path = format!("{};{}", self.dir.join("bin").display(), env.get(&key).map_or("", String::as_str));
            env.insert(key, path);
        }
        env
    }

    /// One child to its end under `limit` (zero: none) and `cancel`; `Err` is the failure text.
    async fn run(&self, processes: &Processes, name: &str, args: &[String], limit: Duration, cancel: Option<&CancellationToken>) -> Result<ProcessResult> {
        let env = self.env();
        let bin = self.bin(name);
        let options = RunOptions { env: Some(&env), timeout: limit, cancel, ..RunOptions::new(&self.dir) };
        let done = processes.run(&bin.to_string_lossy(), args, options).await;
        if done.code == 0 && !done.timed_out && done.error.is_empty() {
            return Ok(done);
        }
        let text = [done.stderr.as_str(), done.stdout.as_str(), done.error.as_str()]
            .into_iter()
            .map(str::trim)
            .find(|text| !text.is_empty())
            .map_or_else(|| format!("status {}", done.code), str::to_owned);
        Err(MemoryError::Runtime(format!("{name} failed: {text}")))
    }

    /// `pg_ctl status -D`: whether a server runs on the data directory (exit 0), within 3 s.
    pub async fn status(&self, processes: &Processes, data_dir: &Path) -> Result<bool> {
        let args = ["status".to_owned(), "-D".to_owned(), data_dir.to_string_lossy().into_owned()];
        match self.run(processes, "pg_ctl", &args, STATUS_LIMIT, None).await {
            Ok(_) => Ok(true),
            // pg_ctl answers 3 for "no server running".
            Err(error) if error.message().contains("no server running") => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// `pg_ctl reload -D`: the running server re-reads its configuration, within 5 s.
    pub async fn reload(&self, processes: &Processes, data_dir: &Path) -> Result<()> {
        let args = ["reload".to_owned(), "-D".to_owned(), data_dir.to_string_lossy().into_owned()];
        self.run(processes, "pg_ctl", &args, RELOAD_LIMIT, None).await.map(drop)
    }
}

/// A running postmaster serving one data directory.
#[derive(Clone)]
pub struct PgCluster {
    runtime: PgRuntime,
    data_dir: PathBuf,
    port: u16,
    /// The lane the data directory's files are read and written on.
    lane: DurabilityIo,
    /// The process manager the cluster's children run under.
    processes: Processes,
}

/// Settings every cluster created here starts with. A single-user local
/// store: small shared buffers, no JIT, relaxed commit durability (the stored
/// history is rebuilt from the session store after a crash).
const CLUSTER_CONF: &str = "
# mixdog overrides
default_transaction_isolation = 'read committed'
listen_addresses = '127.0.0.1'
log_min_messages = warning
log_line_prefix = '%t [%p]: '
synchronous_commit = off
checkpoint_timeout = 15min
max_wal_size = 2GB
wal_compression = on
wal_init_zero = off
wal_recycle = off
checkpoint_completion_target = 0.9
bgwriter_lru_maxpages = 1000
bgwriter_delay = 50ms
max_connections = 32
jit = off
shared_buffers = 32MB
wal_buffers = 1MB
work_mem = 4MB
maintenance_work_mem = 64MB
";

/// The port line (fourth) of `postmaster.pid`, when a postmaster recorded one.
async fn read_postmaster_pid(lane: DurabilityIo, data_dir: &Path) -> Option<u32> {
    let text = fsio::read_to_string(lane, &data_dir.join("postmaster.pid")).await.ok()?;
    text.lines().next()?.trim().parse().ok()
}

async fn read_postmaster_port(lane: DurabilityIo, data_dir: &Path) -> Option<u16> {
    let text = fsio::read_to_string(lane, &data_dir.join("postmaster.pid")).await.ok()?;
    text.lines().nth(3)?.trim().parse().ok().filter(|port| *port > 0)
}

/// `healthcheckPg`: a session on the port answers `SELECT 1`. A bare TCP connect is not readiness:
/// a postmaster that is still starting up accepts the socket and then refuses every session with
/// `FATAL: the database system is starting up` (57P03).
async fn healthcheck(port: u16) -> bool {
    let probe = async {
        let Ok((client, connection)) = db::config(port, "postgres", None).connect(NoTls).await else {
            return false;
        };
        tokio::select! {
            answered = client.simple_query("SELECT 1") => answered.is_ok(),
            _ = connection => false,
        }
    };
    tokio::time::timeout(HEALTH_LIMIT, probe).await.unwrap_or(false)
}

/// The text of a start a stop ended.
const CANCELLED_START: &str = "the start was cancelled before postgres was ready";

/// How long an alive postmaster that does not answer yet (crash recovery, a start another process began) is waited for (`waitForPostmasterReady`'s `timeoutMs`).
const RECOVERY_WAIT: Duration = Duration::from_secs(30);

/// `isPostgresPid`: the pid's process is a postgres (a pid a reboot handed to another program is not a postmaster). Where the name cannot be read it is taken as alive.
async fn is_postgres_pid(processes: &Processes, pid: u32) -> bool {
    if cfg!(windows) {
        let args = ["/FI".to_owned(), format!("PID eq {pid}"), "/FO".to_owned(), "CSV".to_owned(), "/NH".to_owned()];
        let done = processes.run("tasklist", &args, RunOptions { timeout: Duration::from_secs(15), ..RunOptions::new(Path::new(".")) }).await;
        return done.code != 0 || done.stdout.to_lowercase().contains("postgres");
    }
    if cfg!(target_os = "linux") {
        return std::fs::read_to_string(format!("/proc/{pid}/comm")).map_or(true, |comm| comm.contains("postgres"));
    }
    let args = ["-o".to_owned(), "comm=".to_owned(), "-p".to_owned(), pid.to_string()];
    let done = processes.run("ps", &args, RunOptions { timeout: Duration::from_secs(15), ..RunOptions::new(Path::new(".")) }).await;
    done.code != 0 || done.stdout.contains("postgres")
}

/// `healthcheckPg` as a test holds it: a postmaster that does not answer, and the moment each question is asked.
#[cfg(test)]
pub(crate) trait Health: Send + Sync {
    fn healthy(&self, port: u16) -> futures::future::BoxFuture<'static, bool>;
}

/// What a start asks and waits on: the readiness probe, the wait for an alive postmaster that does not answer yet (`waitForPostmasterReady`'s
/// `timeoutMs`, 30 s) and the wait for the spawn lock (`withFileLock(…, { timeoutMs: 30_000 })`, `supervisor.mjs:618`). A release build has only Node's
/// (the session probe and the two 30 s waits) and carries nothing: the fields exist in a test build alone.
#[derive(Clone)]
pub(crate) struct Start {
    #[cfg(test)]
    pub health: std::sync::Arc<dyn Health>,
    #[cfg(test)]
    pub recovery_wait: Duration,
    #[cfg(test)]
    pub lock_wait: Duration,
    /// Holds a start between its admission and the spawn of `pg_ctl start`.
    #[cfg(test)]
    pub before_spawn: Option<std::sync::Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>>,
}

impl Start {
    /// Node's: the session probe and 30 s for each wait.
    pub(crate) fn node() -> Self {
        #[cfg(test)]
        {
            struct SessionHealth;
            impl Health for SessionHealth {
                fn healthy(&self, port: u16) -> futures::future::BoxFuture<'static, bool> {
                    Box::pin(healthcheck(port))
                }
            }
            Self { health: std::sync::Arc::new(SessionHealth), recovery_wait: RECOVERY_WAIT, lock_wait: SPAWN_LOCK_WAIT, before_spawn: None }
        }
        #[cfg(not(test))]
        Self {}
    }

    #[cfg(not(test))]
    async fn healthy(&self, port: u16) -> bool {
        healthcheck(port).await
    }

    #[cfg(test)]
    async fn healthy(&self, port: u16) -> bool {
        self.health.healthy(port).await
    }

    #[cfg(not(test))]
    fn recovery_wait(&self) -> Duration {
        RECOVERY_WAIT
    }

    #[cfg(test)]
    fn recovery_wait(&self) -> Duration {
        self.recovery_wait
    }

    #[cfg(not(test))]
    fn lock_wait(&self) -> Duration {
        SPAWN_LOCK_WAIT
    }

    #[cfg(test)]
    fn lock_wait(&self) -> Duration {
        self.lock_wait
    }
}

/// `<dataDir>/pg-spawn.lock`'s acquisition timeout (`supervisor.mjs:618`).
const SPAWN_LOCK_WAIT: Duration = Duration::from_secs(30);

/// What `waitForPostmasterReady` (`supervisor.mjs:339-352`) answers: the postmaster came up, stayed alive without coming up for `wait`, or exited while waited for.
#[derive(Debug, PartialEq, Eq)]
enum Recovery {
    Ready,
    AliveNotReady,
    Gone,
    /// The start's own cancel (a stop) came first.
    Cancelled,
}

/// `waitForPostmasterReady`: probes every `READY_POLL` while the pid lives, giving up at `wait` (Node's `Date.now()` deadline; here the runtime's clock, which a test holds).
async fn await_recovery(pid: u32, port: u16, start: &Start, cancel: &CancellationToken) -> Recovery {
    let deadline = tokio::time::Instant::now() + start.recovery_wait();
    while mixdog_statefile::process_exists(pid) {
        if start.healthy(port).await {
            return Recovery::Ready;
        }
        if tokio::time::Instant::now() >= deadline {
            return Recovery::AliveNotReady;
        }
        // A stop ends the wait (Node's wait is not cancellable; its stop gives up on an opening after 6 s, `supervisor.mjs:793`).
        tokio::select! {
            () = cancel.cancelled() => return Recovery::Cancelled,
            () = tokio::time::sleep(READY_POLL) => {}
        }
    }
    Recovery::Gone
}

/// What Node does with a `postmaster.pid` it finds while the cluster does not answer (`supervisor.mjs:571-613`): a postmaster that is alive owns the data
/// directory, so it is waited for up to `wait` and attached to when it comes up (recovery after a kill), and a start beside it is refused; the file of a
/// dead one is removed so the new postmaster does not start over it. `Some(port)` is an attached postmaster; `None` means the directory is free to start.
async fn settle_leftover_postmaster(lane: DurabilityIo, processes: &Processes, data_dir: &Path, start: &Start, cancel: &CancellationToken) -> Result<Option<u16>> {
    // `readPostmasterInfo` (`supervisor.mjs:288-300`): line one is the pid, line four the port.
    let Some(pid) = read_postmaster_pid(lane, data_dir).await else { return Ok(None) };
    // `pm.pid && pm.port && await isPostmasterAlive(pm.pid)`: a live pid (`isPidAlive`, EPERM counts as alive) whose process is a postgres.
    if let Some(port) = read_postmaster_port(lane, data_dir).await
        && mixdog_statefile::process_exists(pid)
        && is_postgres_pid(processes, pid).await
    {
        mixdog_rt::memory_stderr!("[supervisor-pg] postmaster PID {pid} alive but not ready — awaiting recovery");
        match await_recovery(pid, port, start, cancel).await {
            Recovery::Ready => {
                mixdog_rt::memory_stderr!("[supervisor-pg] attaching to recovered PG pid={pid} port={port}");
                return Ok(Some(port));
            }
            Recovery::AliveNotReady => {
                return Err(MemoryError::Runtime(format!("[supervisor-pg] existing postmaster PID {pid} remains alive but unhealthy; refusing concurrent start")));
            }
            Recovery::Cancelled => return Err(MemoryError::Runtime(CANCELLED_START.to_owned())),
            Recovery::Gone => {}
        }
    }
    mixdog_rt::memory_stderr!("[supervisor-pg] postmaster PID {pid} dead — removing stale postmaster.pid");
    let _ = fsio::remove_file(lane, &data_dir.join("postmaster.pid")).await;
    Ok(None)
}

/// `PG_LOG_MAX_BYTES` (`supervisor.mjs:67`).
const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// `rotateLogIfNeeded` (`supervisor.mjs:92-108`), which `_startFresh` runs before every fresh start (`:359`), never on an attach: a log larger than
/// 10 MB is renamed to `<log>.1`, the one archive kept (an older archive is removed first); a missing log, or any failure, leaves things as they are.
#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
async fn rotate_log_if_needed(lane: DurabilityIo, log: &Path) {
    let log = log.to_owned();
    let _ = crate::lane::io_on_lane(lane, move || {
        if std::fs::metadata(&log)?.len() > LOG_MAX_BYTES {
            let mut archive = log.clone().into_os_string();
            archive.push(".1");
            let _ = std::fs::remove_file(&archive);
            std::fs::rename(&log, archive)?;
        }
        Ok(())
    })
    .await;
}

async fn free_port(preferred: u16) -> Result<u16> {
    let last = preferred.saturating_add(PORT_SPAN);
    for port in preferred..=last {
        if tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return Ok(port);
        }
    }
    Err(MemoryError::Runtime(format!("no free port in {preferred}-{last}")))
}

/// `initdb -L` input directory. On Windows initdb embeds its share path in
/// bootstrap SQL as system-code-page bytes, which a UTF-8 cluster rejects when
/// the path is not ASCII; such a share directory is reached through an ASCII
/// junction that is removed afterwards.
struct ShareDir {
    link: Option<PathBuf>,
}

impl ShareDir {
    async fn prepare(lane: DurabilityIo, processes: &Processes, runtime: &PgRuntime) -> Result<Self> {
        let share = runtime.dir.join("share");
        if !cfg!(windows) || share.to_string_lossy().is_ascii() {
            return Ok(Self { link: None });
        }
        let root = PathBuf::from(std::env::var_os("ProgramData").unwrap_or_default())
            .join(format!("mixdog-initdb-{}", uuid::Uuid::new_v4().simple()));
        fsio::create_dir_all(lane, &root).await?;
        let link = root.join("share");
        // Node makes the junction synchronously (`symlinkSync`); a child here gets `status`'s
        // short limit.
        let args = ["/C".to_owned(), "mklink".to_owned(), "/J".to_owned(), link.to_string_lossy().into_owned(), share.to_string_lossy().into_owned()];
        let env = runtime.env();
        let options = RunOptions { env: Some(&env), timeout: STATUS_LIMIT, ..RunOptions::new(&root) };
        let made = processes.run("cmd", &args, options).await;
        if made.code != 0 || made.timed_out {
            let text = [made.stderr.trim(), made.stdout.trim(), made.error.as_str()].into_iter().find(|t| !t.is_empty()).unwrap_or("no output").to_owned();
            return Err(MemoryError::Runtime(format!("mklink failed: {text}")));
        }
        Ok(Self { link: Some(link) })
    }

    fn path(&self) -> Option<&Path> {
        self.link.as_deref()
    }

    async fn release(self, lane: DurabilityIo) {
        if let Some(link) = self.link {
            // Both removals are non-recursive: the runtime share is never touched. A failure of
            // either is logged and never replaces initdb's own result (`process.mjs:313-321`).
            if let Err(error) = fsio::remove_dir(lane, &link).await {
                mixdog_rt::memory_stderr!("[pg-process] initdb share junction cleanup failed: {error}");
            }
            if let Some(root) = link.parent()
                && let Err(error) = fsio::remove_dir(lane, root).await
            {
                mixdog_rt::memory_stderr!("[pg-process] initdb share junction cleanup failed: {error}");
            }
        }
    }
}

impl std::fmt::Debug for PgCluster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgCluster").field("data_dir", &self.data_dir).field("port", &self.port).finish_non_exhaustive()
    }
}

/// `pg_ctl start`'s outcome while it is being waited for: it is not waited for to exit (Node
/// spawns it and polls readiness), so this only reports an exit that came before readiness.
type StartRun = tokio::task::JoinHandle<Result<()>>;

/// `pg_ctl start` as Node's `startAndWaitReady` spawns it (`process.mjs:375-400`: `spawn` with piped output and `windowsHide`, never killed by its
/// starter). On Windows Node's child is in libuv's job, which lets the processes it starts leave it silently, so the postmaster `pg_ctl` starts belongs to
/// no job of the daemon and outlives it (`process.mjs:378-385`); this child is not given to the process manager, whose job would end the postmaster
/// with this process: `tokio::process::Command` assigns its child to no job, unlike [`Processes`], whose every child is put in a kill-on-close job
/// (`mixdog-spawn/src/contain.rs`, `Containment::create`). Its stdout and stderr are drained as they come, as Node's `data` listeners do, and the run
/// ends when the child has exited and both pipes have closed (Node's `close` event): the postmaster inherits the pipe ends (pg_ctl starts it with handle
/// inheritance on), so for a postmaster that started they stay open for its life and only the readiness probe ends the wait, as in Node.
fn spawn_start(runtime: &PgRuntime, args: &[String]) -> Result<(StartRun, StartOutput)> {
    use tokio::io::AsyncReadExt as _;
    let mut command = tokio::process::Command::new(runtime.bin("pg_ctl"));
    command
        .args(args)
        .env_clear()
        .envs(runtime.env())
        .current_dir(&runtime.dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, as Node's windowsHide
    let mut child = command.spawn().map_err(|error| MemoryError::Runtime(format!("pg_ctl failed: {error}")))?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let output = StartOutput::default();
    let drain = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, into: Arc<std::sync::Mutex<Vec<u8>>>| async move {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = [0u8; 4096];
        while let Ok(read) = pipe.read(&mut chunk).await
            && read > 0
        {
            keep_tail(&mut into.lock().expect("output"), &chunk[..read]);
        }
    };
    let (stdout, stderr) = (stdout.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), stderr.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>));
    let captured = output.clone();
    let run = mixdog_rt::spawn("services.memory.pg-start", TaskClass::Work, async move {
        let (status, (), ()) = tokio::join!(child.wait(), drain(stdout, captured.stdout.clone()), drain(stderr, captured.stderr.clone()));
        let status = status.map_err(|error| MemoryError::Runtime(format!("pg_ctl failed: {error}")))?;
        if status.success() {
            return Ok(());
        }
        let text = captured.text().unwrap_or_else(|| format!("status {}", status.code().unwrap_or(-1)));
        Err(MemoryError::Runtime(format!("pg_ctl failed: {text}")))
    });
    Ok((run, output))
}

/// What `pg_ctl start` and the postmaster that inherits its pipes have written so far: the last [`OUTPUT_TAIL`] bytes of each stream. Node keeps all of
/// it (`process.mjs:401-406`); a start's output is a few lines, so its failure text is the same, and a chatty postmaster cannot grow this without bound.
#[derive(Clone, Default)]
struct StartOutput {
    stdout: Arc<std::sync::Mutex<Vec<u8>>>,
    stderr: Arc<std::sync::Mutex<Vec<u8>>>,
}

/// How much of each stream of `pg_ctl start` is kept.
const OUTPUT_TAIL: usize = 64 * 1024;

fn keep_tail(kept: &mut Vec<u8>, more: &[u8]) {
    kept.extend_from_slice(more);
    if kept.len() > OUTPUT_TAIL {
        kept.drain(..kept.len() - OUTPUT_TAIL);
    }
}

impl StartOutput {
    /// Node's `r.stderr || r.stdout`, trimmed: `None` when both are empty.
    fn text(&self) -> Option<String> {
        let read = |stream: &std::sync::Mutex<Vec<u8>>| String::from_utf8_lossy(&stream.lock().expect("output")).trim().to_owned();
        [read(&self.stderr), read(&self.stdout)].into_iter().find(|text| !text.is_empty())
    }
}

/// Why the spawn lock was not taken.
enum LockWait {
    /// Another starter held it for the whole wait (`ELOCKTIMEOUT`).
    Timeout(String),
    Failed(String),
}

/// `withFileLock(join(dataDir, 'pg-spawn.lock'), …, { timeoutMs: 30_000 })`: the same file and the same lock (the shared lock implementation of
/// `mixdog-statefile`, which a Node process takes by the same record), held until the returned guard is dropped.
async fn take_spawn_lock(lock_file: &Path, wait: Duration, cancel: &CancellationToken) -> std::result::Result<mixdog_statefile::LockHold, LockWait> {
    let (acquired, outcome) = tokio::sync::oneshot::channel();
    let opts = mixdog_statefile::LockOpts { timeout: Some(wait), ..Default::default() };
    let hold = mixdog_statefile::hold_lock(lock_file, &opts, move |outcome| {
        let _ = acquired.send(outcome);
    });
    let outcome = tokio::select! {
        outcome = outcome => outcome,
        () = cancel.cancelled() => return Err(LockWait::Failed(CANCELLED_START.to_owned())),
    };
    match outcome {
        Ok(Ok(())) => Ok(hold),
        Ok(Err(error)) if error.code() == Some("ELOCKTIMEOUT") => Err(LockWait::Timeout(error.to_string())),
        Ok(Err(error)) => Err(LockWait::Failed(error.to_string())),
        Err(_) => Err(LockWait::Failed("the spawn lock holder ended".to_owned())),
    }
}

impl PgCluster {
    /// `_doEnsure`'s cluster part (`supervisor.mjs:479-628`) for the profile data directory `profile`: the cluster is `<profile>/pgdata` (`_pgdataDir`), the
    /// spawn lock `<profile>/pg-spawn.lock` (`:618`) and the server log `<profile>/pg.log` (`_startFresh`, `:358`), both outside the cluster as in Node (an
    /// `initdb` refuses a directory that holds anything, and a postmaster in crash recovery fsyncs every file of its directory). The prelock reuse of a
    /// postmaster that answers, then the spawn lock (30 s) around the reuse again, the leftover postmaster, `initdb` and the start. A lock another starter
    /// holds for the whole wait falls back to one more reuse and else fails (`:619-627`). `cancel` ends an `initdb` in progress (it has no time limit, as in
    /// Node), and a wait for another starter's lock or postmaster; a start is never begun once it is cancelled or `admit` refuses it, and one that was
    /// begun is waited for until it is ready (so the caller, if still there, can stop it) or has failed.
    pub(crate) async fn ensure(
        runtime: PgRuntime,
        profile: &Path,
        preferred_port: u16,
        lane: DurabilityIo,
        processes: Processes,
        cancel: &CancellationToken,
        start: &Start,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Self> {
        let data_dir = profile.join("pgdata");
        fsio::create_dir_all(lane, &data_dir).await?;
        if let Some(port) = read_postmaster_port(lane, &data_dir).await
            && start.healthy(port).await
        {
            return Ok(Self { runtime, data_dir, port, lane, processes });
        }
        let _spawn_lock = match take_spawn_lock(&profile.join("pg-spawn.lock"), start.lock_wait(), cancel).await {
            Ok(hold) => hold,
            Err(LockWait::Timeout(error)) => {
                if let Some(port) = read_postmaster_port(lane, &data_dir).await
                    && start.healthy(port).await
                {
                    return Ok(Self { runtime, data_dir, port, lane, processes });
                }
                mixdog_rt::memory_stderr!("[supervisor-pg] spawn-lock wait ended: {error}");
                return Err(MemoryError::Runtime("[supervisor-pg] spawn-lock acquire timeout (concurrent supervisor risk)".to_owned()));
            }
            Err(LockWait::Failed(message)) => return Err(MemoryError::Runtime(message)),
        };
        if let Some(port) = read_postmaster_port(lane, &data_dir).await
            && start.healthy(port).await
        {
            return Ok(Self { runtime, data_dir, port, lane, processes });
        }
        if let Some(port) = settle_leftover_postmaster(lane, &processes, &data_dir, start, cancel).await? {
            return Ok(Self { runtime, data_dir, port, lane, processes });
        }
        let log = profile.join("pg.log");
        rotate_log_if_needed(lane, &log).await;
        if !fsio::exists(lane, &data_dir.join("PG_VERSION")).await? {
            Self::init(lane, &processes, &runtime, &data_dir, cancel).await?;
        }
        let port = free_port(preferred_port).await?;
        // The last check before the postmaster starts, made with the spawn: `admit` refuses once the owner's stop began (a cancelled start begins no
        // postmaster: nothing would own it). An admitted start the stop gives up on at 6 s goes on as Node's does.
        if cancel.is_cancelled() || !admit() {
            return Err(MemoryError::Runtime(CANCELLED_START.to_owned()));
        }
        #[cfg(test)]
        if let Some(gate) = &start.before_spawn {
            gate().await;
        }
        let args: Vec<String> = [
            "start".to_owned(),
            "-D".to_owned(),
            data_dir.to_string_lossy().into_owned(),
            "-l".to_owned(),
            log.to_string_lossy().into_owned(),
            "-o".to_owned(),
            format!("-p {port} -h 127.0.0.1"),
        ]
        .into();
        // Not waited for, as in Node: `pg_ctl start` is spawned and readiness is polled; the
        // postmaster outlives it. An exit before readiness is a start failure.
        let (run, output) = spawn_start(&runtime, &args).map_err(|error| MemoryError::Runtime(format!("pg_ctl start failed: {}", error.message())))?;
        let mut started: Option<StartRun> = Some(run);
        let deadline = tokio::time::Instant::now() + START_DEADLINE;
        let mut early: Option<MemoryError> = None;
        loop {
            if start.healthy(port).await && read_postmaster_port(lane, &data_dir).await == Some(port) {
                return Ok(Self { runtime, data_dir, port, lane, processes });
            }
            if started.as_ref().is_some_and(tokio::task::JoinHandle::is_finished)
                && let Some(done) = started.take()
            {
                match done.await {
                    Ok(Err(error)) => early = Some(error),
                    Ok(Ok(_)) => {}
                    Err(error) => early = Some(MemoryError::Runtime(format!("pg_ctl start: {error}"))),
                }
            }
            if let Some(error) = &early {
                // A start that lost a race to another postmaster on this data dir attaches to it.
                if error.message().contains("another server might be running")
                    && let Some(winner) = Self::await_race_winner(&runtime, &processes, lane, &data_dir).await
                {
                    return Ok(Self { runtime, data_dir, port: winner, lane, processes });
                }
                let log_text = fsio::read_to_string(lane, &log).await.unwrap_or_default();
                let detail = [error.message(), if log_text.trim().is_empty() { String::new() } else { format!("postgres log:\n{}", log_text.trim()) }]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                return Err(MemoryError::Runtime(format!("pg_ctl start failed: {detail}")));
            }
            if tokio::time::Instant::now() >= deadline {
                // Node's `startFailure` of a timed-out start (`process.mjs:459-467`): the output drained so far, then the server log.
                let log_text = fsio::read_to_string(lane, &log).await.unwrap_or_default();
                let detail = [output.text().unwrap_or_default(), if log_text.trim().is_empty() { String::new() } else { format!("postgres log:\n{}", log_text.trim()) }]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let detail = if detail.is_empty() { "(readiness probe timed out after 30s; no pg_ctl or postgres log output)".to_owned() } else { detail };
                return Err(Self { runtime, data_dir, port, lane, processes }.abandon(MemoryError::Runtime(format!("pg_ctl start failed: {detail}"))).await);
            }
            // A stop does not end this wait (Node's `startAndWaitReady` takes none): a postmaster that is coming up has not written its pid file yet, so a
            // stop now would miss it. It is waited for (30 s at most) and the caller, which sees the stop, stops it.
            tokio::time::sleep(READY_POLL).await;
        }
    }

    /// A start this process began and gives up on: the postmaster it spawned may still come up, so it is stopped before the error leaves (nothing owns it afterwards).
    async fn abandon(self, error: MemoryError) -> MemoryError {
        if let Err(stop) = self.stop(Duration::from_secs(STOP_TIMEOUT_SECONDS)).await {
            tracing::warn!(error = %stop.message(), "[pg-process] stopping the postmaster of an abandoned start");
        }
        error
    }

    /// `attachRaceWinner`: probes `pg_ctl status` (3 s), then waits up to 15 s for the winner's
    /// postmaster to accept connections; its port when it does.
    async fn await_race_winner(runtime: &PgRuntime, processes: &Processes, lane: DurabilityIo, data_dir: &Path) -> Option<u16> {
        mixdog_rt::memory_stderr!("[pg-process] pg_ctl start: \"another server might be running\" — probing status");
        match runtime.status(processes, data_dir).await {
            Ok(running) => tracing::info!(running, "[pg-process] pg_ctl status after a lost start race"),
            Err(error) => tracing::info!(error = %error.message(), "[pg-process] pg_ctl status after a lost start race"),
        }
        let deadline = tokio::time::Instant::now() + EXISTING_WAIT;
        loop {
            if let Some(port) = read_postmaster_port(lane, data_dir).await
                && healthcheck(port).await
            {
                let pid = read_postmaster_pid(lane, data_dir).await.unwrap_or_default();
                mixdog_rt::memory_stderr!("[pg-process] attaching to race winner pid={pid} port={port}");
                return Some(port);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(READY_POLL).await;
        }
    }

    async fn init(lane: DurabilityIo, processes: &Processes, runtime: &PgRuntime, data_dir: &Path, cancel: &CancellationToken) -> Result<()> {
        let share = ShareDir::prepare(lane, processes, runtime).await?;
        let mut args = vec!["-D".to_owned(), data_dir.to_string_lossy().into_owned()];
        if let Some(path) = share.path() {
            args.extend(["-L".to_owned(), path.to_string_lossy().into_owned()]);
        }
        args.extend(["--auth-local=trust", "--no-locale", "-E", "UTF8", "-U", "postgres"].map(str::to_owned));
        // No time limit, as in Node (`runChild` without `timeoutMs`); the cancel ends it.
        let result = runtime.run(processes, "initdb", &args, Duration::ZERO, Some(cancel)).await;
        share.release(lane).await;
        result?;
        let conf = data_dir.join("postgresql.conf");
        let mut text = fsio::read_to_string(lane, &conf).await?;
        text.push_str(CLUSTER_CONF);
        fsio::write(lane, &conf, text.into_bytes()).await?;
        Ok(())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// `stopPg`: bounded fast shutdown, open transactions roll back and clients disconnect.
    /// `pg_ctl -t` is `timeout` in whole seconds (rounded up, at least one); the child is
    /// ended one second after that.
    pub async fn stop(&self, timeout: Duration) -> Result<()> {
        let seconds = timeout.as_millis().div_ceil(1000).max(1) as u64;
        let args: Vec<String> = ["stop", "-m", "fast", "-w", "-t"]
            .into_iter()
            .map(str::to_owned)
            .chain([seconds.to_string(), "-D".to_owned(), self.data_dir.to_string_lossy().into_owned()])
            .collect();
        match self.runtime.run(&self.processes, "pg_ctl", &args, Duration::from_secs(seconds + 1), None).await {
            Ok(_) => Ok(()),
            // No postmaster.pid means nothing was running.
            Err(_) if read_postmaster_port(self.lane, &self.data_dir).await.is_none() => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
#[path = "cluster_tests.rs"]
mod tests;
