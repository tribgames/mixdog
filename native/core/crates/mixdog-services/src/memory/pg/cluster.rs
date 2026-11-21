//! The PostgreSQL cluster behind memory and session search: one bundled
//! runtime (`bin/`, `lib/`, `share/`, pgvector included), one data directory.
//! `PgCluster::ensure` attaches to a postmaster that already serves the data
//! directory, else makes the cluster when the directory holds none (in
//! `pgdata.init`, renamed to `pgdata` once whole) and starts one. The core is the
//! only process of its data dir, so there is no secondary-attach protocol.
//!
//! Every child but `pg_ctl start` (`initdb`, `pg_ctl status|reload|stop`) runs under the one process
//! manager through [`Processes`], with these limits: `status` 3 s, `reload` 5 s, `stop` its `-t`
//! seconds plus one; `initdb` has none and is ended by the caller's cancel. `pg_ctl start` is spawned
//! outside the manager and not waited for (the readiness poll, 30 s, is its bound). A quitting core
//! stops it, and on Windows it is put in a kill-on-close job the core holds for its life
//! (`OWNED_SERVERS`), so the server ends with the core even when the core is killed. A postmaster left
//! by a killed core elsewhere is still attached to through `postmaster.pid`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::{DurabilityIo, LaneToken, TaskClass};
use tokio_postgres::NoTls;
use tokio_util::sync::CancellationToken;

use super::db;
use crate::memory::error::{MemoryError, Result};
use crate::model_install::fsio;
use crate::tidy::process::{ProcessResult, Processes, RunOptions};

/// First port tried for a product postmaster, and how many ports above it are scanned.
pub const DEFAULT_PORT: u16 = 55432;
pub(crate) const PORT_SPAN: u16 = 200;
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

/// The setting a sensitive scrub relies on (`session_search/db.rs` `scrub`): a WAL segment past
/// the redo point is deleted, never renamed for reuse with its old bytes. Appended once to the
/// configuration of a cluster made before it; a cluster made here has it from `CLUSTER_CONF` and `init`.
const SCRUB_CONF_MARKER: &str = "# mixdog overrides v5 — no WAL segment reuse";
const SCRUB_CONF: &str = "
# mixdog overrides v5 — no WAL segment reuse
wal_recycle = off
";

/// Appends `SCRUB_CONF` to `postgresql.conf` when it lacks it (before the postmaster reads it).
async fn ensure_scrub_conf(lane: DurabilityIo, data_dir: &Path) -> Result<()> {
    let conf = data_dir.join("postgresql.conf");
    // No configuration file: nothing to append to, the postmaster's own start reports it.
    if !fsio::exists(lane, &conf).await? {
        return Ok(());
    }
    let mut text = fsio::read_to_string(lane, &conf).await?;
    if text.contains(SCRUB_CONF_MARKER) {
        return Ok(());
    }
    text.push_str(SCRUB_CONF);
    fsio::write(lane, &conf, text.into_bytes()).await?;
    Ok(())
}

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
    mixdog_rt::time::timeout(HEALTH_LIMIT, probe).await.unwrap_or(false)
}

/// The text of a start a stop ended.
const CANCELLED_START: &str = "the start was cancelled before postgres was ready";

/// How long an alive postmaster that does not answer yet (crash recovery, a start another process began) is waited for (`waitForPostmasterReady`'s `timeoutMs`).
const RECOVERY_WAIT: Duration = Duration::from_secs(30);

/// `isPostgresPid`: the pid's process is a postgres (a pid a reboot handed to another program is not a postmaster). Where the name cannot be read it is taken as alive.
#[allow(clippy::disallowed_methods, reason = "Linux only: one read of procfs, which is memory and not a disk")]
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
    /// Holds a start between its admission and the spawn of `pg_ctl start`; it is told the port the start chose.
    #[cfg(test)]
    pub before_spawn: Option<std::sync::Arc<dyn Fn(u16) -> futures::future::BoxFuture<'static, ()> + Send + Sync>>,
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
            () = mixdog_rt::time::sleep(READY_POLL) => {}
        }
    }
    Recovery::Gone
}

/// What Node does with a `postmaster.pid` it finds while the cluster does not answer (`supervisor.mjs:571-613`): a postmaster that is alive owns the data
/// directory, so it is waited for up to `wait` and attached to when it comes up (recovery after a kill), and a start beside it is refused; the file of a
/// dead one is removed so the new postmaster does not start over it. `Some(port)` is an attached postmaster; `None` means the directory is free to start.
async fn settle_leftover_postmaster(
    lane: DurabilityIo,
    processes: &Processes,
    data_dir: &Path,
    start: &Start,
    cancel: &CancellationToken,
) -> Result<Option<u16>> {
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
                return Err(MemoryError::Runtime(format!(
                    "[supervisor-pg] existing postmaster PID {pid} remains alive but unhealthy; refusing concurrent start"
                )));
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

/// A replay's core (feature `assigned-pg-port`, never in an ordinary build): the port the replay chose outside the scanned range
/// (`MIXDOG_ASSIGNED_PG_PORT`), so no core beside it, scanning from [`DEFAULT_PORT`], can take it between the probe and the bind.
#[cfg(feature = "assigned-pg-port")]
fn assigned_port() -> Option<u16> {
    std::env::var("MIXDOG_ASSIGNED_PG_PORT").ok()?.parse().ok()
}

#[cfg(not(feature = "assigned-pg-port"))]
fn assigned_port() -> Option<u16> {
    None
}

async fn free_port(preferred: u16) -> Result<u16> {
    let last = preferred.saturating_add(PORT_SPAN);
    for port in preferred..=last {
        // A postmaster on Windows listens with SO_REUSEADDR, so a second bind to its port succeeds: a free port is one nothing answers on too.
        let held = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok();
        if !held && tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
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
        let root = PathBuf::from(std::env::var_os("ProgramData").unwrap_or_default()).join(format!("mixdog-initdb-{}", uuid::Uuid::new_v4().simple()));
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

/// The `initdb` arguments. initdb flushes every file it writes (nine to fourteen seconds alone beside builds, two or three without),
/// and sixteen clusters started at once queue on the same disk for minutes; where this process's own flushes are elided (a test
/// run), initdb's, a child's, are too (`--no-sync`).
fn initdb_args(data_dir: &Path, share: Option<&Path>, syncs_elided: bool) -> Vec<String> {
    let mut args = vec!["-D".to_owned(), data_dir.to_string_lossy().into_owned()];
    if let Some(path) = share {
        args.extend(["-L".to_owned(), path.to_string_lossy().into_owned()]);
    }
    args.extend(["--auth-local=trust", "--no-locale", "-E", "UTF8", "-U", "postgres"].map(str::to_owned));
    if syncs_elided {
        args.push("--no-sync".to_owned());
    }
    args
}

/// The waits before the second, third and fourth removal attempts; every later one waits 200 ms (`renameWithRetrySync`'s schedule, without its
/// jitter).
const REMOVE_BACKOFF_MS: [u64; 3] = [25, 50, 100];
/// Removal attempts in all (`renameWithRetrySync`'s 24, about four seconds of waiting).
const REMOVE_ATTEMPTS: usize = 24;

/// Removes the directory `path` (and what it holds when `recursive`; a missing one is then no error), retried while Windows refuses it for a
/// moment: a scanner or an indexer holding it or a file in it, or a process of an `initdb` just ended still tearing down. Any other answer, and
/// the last refusal, is the removal's.
async fn remove_dir_with_retry(lane: DurabilityIo, path: &Path, recursive: bool) -> std::io::Result<()> {
    let mut attempt: usize = 0;
    loop {
        let removed = if recursive { fsio::remove_dir_all(lane, path).await } else { fsio::remove_dir(lane, path).await };
        match removed {
            Err(error) if attempt + 1 < REMOVE_ATTEMPTS && refused_for_now(&error) => {
                let wait = REMOVE_BACKOFF_MS.get(attempt).copied().unwrap_or(200);
                mixdog_rt::time::sleep(Duration::from_millis(wait)).await;
                attempt += 1;
            }
            removed => return removed,
        }
    }
}

/// A `data_dir` without `PG_VERSION` that holds something is renamed to `<data_dir>.broken-<unix seconds>` (never deleted) and the path is warned
/// about in the daemon log; an empty one is removed and a missing one is left. Node's `initdb` refuses such a directory for good; the core makes the cluster anew.
async fn quarantine_without_cluster(lane: DurabilityIo, data_dir: &Path) -> Result<()> {
    match remove_dir_with_retry(lane, data_dir, false).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => {
            let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
            let mut name = data_dir.file_name().unwrap_or_default().to_owned();
            name.push(format!(".broken-{seconds}"));
            let aside = data_dir.with_file_name(name);
            fsio::rename(lane, data_dir, &aside)
                .await
                .map_err(|error| MemoryError::Runtime(format!("{} holds no cluster (no PG_VERSION) and cannot be moved aside: {error}", data_dir.display())))?;
            // The daemon log (the daemon's node_log sink), not `tracing`, which the default subscriber hides.
            mixdog_rt::node_console_warn!(
                "[pg-process] the memory database folder {} has no PG_VERSION; it was kept as {} and a new database is made",
                data_dir.display(),
                aside.display()
            );
            Ok(())
        }
    }
}

/// A Windows refusal that clears in moments: `ERROR_ACCESS_DENIED` (an entry pending deletion), `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`.
fn refused_for_now(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

impl std::fmt::Debug for PgCluster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgCluster").field("data_dir", &self.data_dir).field("port", &self.port).finish_non_exhaustive()
    }
}

/// The jobs of the servers this core started (Windows): kill-on-close, held until the process ends, so no PostgreSQL this core started
/// outlives it. A server that was stopped leaves an empty job behind, which costs a handle.
#[cfg(windows)]
static OWNED_SERVERS: std::sync::Mutex<Vec<mixdog_exthost::Containment>> = std::sync::Mutex::new(Vec::new());

/// `pg_ctl start`'s outcome while it is being waited for: it is not waited for to exit (Node
/// spawns it and polls readiness), so this only reports an exit that came before readiness.
type StartRun = tokio::task::JoinHandle<Result<()>>;

#[cfg(test)]
thread_local! {
    /// The process id of the `pg_ctl` this thread's last `spawn_start` made.
    static SPAWNED_START: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

/// Spawns `pg_ctl start` with piped output, never killed by its starter. The server ends with the core: a
/// quitting core stops it (`stop_for_quit`), and on Windows this child is created suspended and put in a kill-on-close job the core holds for its
/// life ([`OWNED_SERVERS`]) before it runs, so the postmaster `pg_ctl` starts through `cmd`, and every backend, are in that job and end when a core
/// that was killed lets go of it. PostgreSQL recovers from its log at the next start. The child is not given to the process manager, whose
/// job belongs to one call. Its stdout and stderr are drained as they come, and the run ends when the child has exited and both pipes have
/// closed: the postmaster inherits the pipe ends (pg_ctl starts it with handle inheritance on), so for a postmaster that started they stay open
/// for its life and only the readiness probe ends the wait.
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
    command.creation_flags(0x0800_0000 | 0x0000_0004 | 0x0000_4000); // CREATE_NO_WINDOW, as Node's windowsHide; CREATE_SUSPENDED until it is in its job; BELOW_NORMAL_PRIORITY_CLASS, which the postmaster and every backend inherit (Node's memory process ran below normal and so did its PostgreSQL)
    #[cfg(unix)]
    {
        // SAFETY: only async-signal-safe operations run between fork and exec.
        unsafe {
            command.pre_exec(|| {
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(|error| MemoryError::Runtime(format!("pg_ctl failed: {error}")))?;
    #[cfg(test)]
    SPAWNED_START.with(|pid| pid.set(child.id()));
    #[cfg(windows)]
    match mixdog_exthost::Containment::attach(&child) {
        Ok(job) => OWNED_SERVERS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(job),
        Err(error) => {
            // A child left suspended would never start: it is ended, and the start fails with the reason.
            let _ = child.start_kill();
            return Err(MemoryError::Runtime(format!("pg_ctl failed: the server could not be bound to this core ({error})")));
        }
    }
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
    let (stdout, stderr) = (
        stdout.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stderr.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    );
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
    /// Node's `r.stderr || r.stdout`, then trimmed (`startPg`, `startFailure`, `process.mjs:459-467`): a stderr of only whitespace is chosen over stdout
    /// and trims to nothing. `None` when the chosen text is empty after the trim.
    fn text(&self) -> Option<String> {
        let read = |stream: &std::sync::Mutex<Vec<u8>>| String::from_utf8_lossy(&stream.lock().expect("output")).into_owned();
        let stderr = read(&self.stderr);
        let chosen = if stderr.is_empty() { read(&self.stdout) } else { stderr };
        Some(chosen.trim().to_owned()).filter(|text| !text.is_empty())
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

/// The port of the postmaster `data_dir` records, when it answers.
async fn healthy_postmaster_port(lane: DurabilityIo, data_dir: &Path, start: &Start) -> Option<u16> {
    let port = read_postmaster_port(lane, data_dir).await?;
    start.healthy(port).await.then_some(port)
}

/// A start failure's text: what `pg_ctl` said, then the server log.
fn start_failure_detail(said: String, log_text: &str) -> String {
    let log = log_text.trim();
    [said, if log.is_empty() { String::new() } else { format!("postgres log:\n{log}") }]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a cluster start reports to its owner, synchronously at the point each fact becomes true: `admit` is the last check before `pg_ctl start` is
/// spawned (no await between them), and `established` runs in the poll that attached to a postmaster or saw a started one ready, before `ensure`
/// returns, with no await between the fact and the call. A plain `Fn() -> bool` admits and records nothing (tests).
pub(crate) trait Launch {
    fn admit(&self) -> bool;
    fn established(&self, cluster: PgCluster) -> PgCluster;
}

impl<F: Fn() -> bool> Launch for F {
    fn admit(&self) -> bool {
        self()
    }

    fn established(&self, cluster: PgCluster) -> PgCluster {
        cluster
    }
}

impl PgCluster {
    /// Attaches to or starts the cluster of the profile data directory `profile`: the cluster is `<profile>/pgdata`, the
    /// spawn lock `<profile>/pg-spawn.lock` and the server log `<profile>/pg.log`, both outside the cluster (an
    /// `initdb` refuses a directory that holds anything, and a postmaster in crash recovery fsyncs every file of its directory). The prelock reuse of a
    /// postmaster that answers, then the spawn lock (30 s) around the reuse again, the leftover postmaster, `initdb` and the start. A lock another starter
    /// holds for the whole wait falls back to one more reuse and else fails. `cancel` ends an `initdb` in progress (it has no time limit)
    /// and a wait for another starter's lock or postmaster; a start is never begun once it is cancelled or `admit` refuses it, and one that was
    /// begun is waited for until it is ready (so the caller, if still there, can stop it) or has failed.
    #[allow(clippy::too_many_arguments, reason = "Keep the cluster lifecycle boundary explicit, including admission, cancellation and process ownership")]
    pub(crate) async fn ensure(
        runtime: PgRuntime,
        profile: &Path,
        preferred_port: u16,
        lane: DurabilityIo,
        processes: Processes,
        cancel: &CancellationToken,
        start: &Start,
        launch: &(dyn Launch + Send + Sync),
    ) -> Result<Self> {
        let data_dir = profile.join("pgdata");
        // `pgdata` itself is made only by `init`, whole.
        fsio::create_dir_all(lane, profile).await?;
        if let Some(port) = healthy_postmaster_port(lane, &data_dir, start).await {
            // A test's hold of this poll between the attach and its record (a thread preempted there), which no revocation can cut.
            #[cfg(test)]
            crate::memory::lifecycle::fences::hold("pg-attached");
            return Ok(launch.established(Self { runtime, data_dir, port, lane, processes }));
        }
        let _spawn_lock = match take_spawn_lock(&profile.join("pg-spawn.lock"), start.lock_wait(), cancel).await {
            Ok(hold) => hold,
            Err(LockWait::Timeout(error)) => {
                if let Some(port) = healthy_postmaster_port(lane, &data_dir, start).await {
                    return Ok(launch.established(Self { runtime, data_dir, port, lane, processes }));
                }
                mixdog_rt::memory_stderr!("[supervisor-pg] spawn-lock wait ended: {error}");
                return Err(MemoryError::Runtime("[supervisor-pg] spawn-lock acquire timeout (concurrent supervisor risk)".to_owned()));
            }
            Err(LockWait::Failed(message)) => return Err(MemoryError::Runtime(message)),
        };
        if let Some(port) = healthy_postmaster_port(lane, &data_dir, start).await {
            return Ok(launch.established(Self { runtime, data_dir, port, lane, processes }));
        }
        if let Some(port) = settle_leftover_postmaster(lane, &processes, &data_dir, start, cancel).await? {
            return Ok(launch.established(Self { runtime, data_dir, port, lane, processes }));
        }
        let log = profile.join("pg.log");
        rotate_log_if_needed(lane, &log).await;
        if !fsio::exists(lane, &data_dir.join("PG_VERSION")).await? {
            Self::init(lane, &processes, &runtime, &data_dir, cancel).await?;
        }
        ensure_scrub_conf(lane, &data_dir).await?;
        // A port that was free when `free_port` looked can be taken by another process before the postmaster binds it (another
        // cluster starting on this machine): the start then fails with a bind error in the log and goes on from the next port.
        let mut from = preferred_port;
        'attempt: loop {
            let assigned = assigned_port();
            let port = match assigned {
                Some(port) => port,
                None => free_port(from).await?,
            };
            let logged_before = fsio::read_to_string(lane, &log).await.map_or(0, |text| text.len());
            #[cfg(test)]
            if let Some(gate) = &start.before_spawn {
                gate(port).await;
            }
            // The last check before the postmaster starts, in the same poll as the spawn (no await between them): `admit` refuses once the owner's stop
            // began, and records an admitted start as handed to the OS before it is spawned.
            if cancel.is_cancelled() || !launch.admit() {
                return Err(MemoryError::Runtime(CANCELLED_START.to_owned()));
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
            let (run, output) = spawn_start(&runtime, &args).map_err(|error| MemoryError::Runtime(format!("pg_ctl start failed: {}", error.message())))?;
            #[cfg(test)]
            crate::memory::lifecycle::fences::pass("pg-launched").await;
            let mut started: Option<StartRun> = Some(run);
            let deadline = tokio::time::Instant::now() + START_DEADLINE;
            let mut early: Option<MemoryError> = None;
            loop {
                if start.healthy(port).await && read_postmaster_port(lane, &data_dir).await == Some(port) {
                    return Ok(launch.established(Self { runtime, data_dir, port, lane, processes }));
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
                        return Ok(launch.established(Self { runtime, data_dir, port: winner, lane, processes }));
                    }
                    let log_text = fsio::read_to_string(lane, &log).await.unwrap_or_default();
                    // A port the replay assigned is the only one it may take: its bind failure is the start's.
                    if assigned.is_none()
                        && log_text.get(logged_before..).is_some_and(|new| new.contains("could not create any TCP/IP sockets"))
                        && port < preferred_port.saturating_add(PORT_SPAN)
                    {
                        from = port + 1;
                        continue 'attempt;
                    }
                    let detail = start_failure_detail(error.message(), &log_text);
                    return Err(MemoryError::Runtime(format!("pg_ctl start failed: {detail}")));
                }
                if tokio::time::Instant::now() >= deadline {
                    let log_text = fsio::read_to_string(lane, &log).await.unwrap_or_default();
                    let detail = start_failure_detail(output.text().unwrap_or_default(), &log_text);
                    let detail = if detail.is_empty() { "(readiness probe timed out after 30s; no pg_ctl or postgres log output)".to_owned() } else { detail };
                    return Err(Self { runtime, data_dir, port, lane, processes }
                        .abandon(MemoryError::Runtime(format!("pg_ctl start failed: {detail}")))
                        .await);
                }
                // A stop does not end this wait: a postmaster that is coming up has not written its pid file yet, so a
                // stop now would miss it. It is waited for (30 s at most) and the caller, which sees the stop, stops it.
                mixdog_rt::time::sleep(READY_POLL).await;
            }
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
            mixdog_rt::time::sleep(READY_POLL).await;
        }
    }

    /// `initdb`, then the configuration appended. The cancel and the core's kill-on-close job end an `initdb` in progress, and a `pgdata` it left
    /// half made (`PG_VERSION`, no `postgres` database) would be taken for a cluster by every later start.
    /// So the cluster is made in `pgdata.init` and becomes `pgdata` in one rename once both steps are done: an init that is ended leaves no `pgdata`,
    /// and the next start makes the cluster again.
    async fn init(lane: DurabilityIo, processes: &Processes, runtime: &PgRuntime, data_dir: &Path, cancel: &CancellationToken) -> Result<()> {
        let staging = data_dir.with_extension("init");
        // `data_dir` holds no cluster here (no `PG_VERSION`): an empty one, which earlier builds made before `initdb`, is removed, and one that holds
        // anything is renamed aside (kept, never deleted) and told to the user, where Node's `initdb` refuses it for good (a deliberate difference).
        // What an ended init left in `staging` is never a cluster.
        quarantine_without_cluster(lane, data_dir).await?;
        remove_dir_with_retry(lane, &staging, true).await?;
        let share = ShareDir::prepare(lane, processes, runtime).await?;
        let args = initdb_args(&staging, share.path(), mixdog_fsio::elide::syncs_elided());
        // No time limit, as in Node (`runChild` without `timeoutMs`); the cancel ends it.
        let result = runtime.run(processes, "initdb", &args, Duration::ZERO, Some(cancel)).await;
        share.release(lane).await;
        result?;
        let conf = staging.join("postgresql.conf");
        let mut text = fsio::read_to_string(lane, &conf).await?;
        text.push_str(CLUSTER_CONF);
        text.push_str(SCRUB_CONF);
        fsio::write(lane, &conf, text.into_bytes()).await?;
        // Retried while Windows still holds a file of the new tree (a scanner, an indexer).
        let target = data_dir.to_owned();
        let renamed = lane
            .submit_wait(&CancellationToken::new(), move |proof| mixdog_statefile::rename_with_retry(proof, &staging, &target))
            .await
            .map_err(std::io::Error::other)?;
        renamed.await.map_err(std::io::Error::other)??;
        Ok(())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    #[cfg(test)]
    pub(crate) fn runtime(&self) -> &PgRuntime {
        &self.runtime
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The cluster of `<profile>/pgdata` on `port` as a start would hand it over, without starting anything.
    #[cfg(test)]
    pub(crate) fn over(runtime: PgRuntime, profile: &Path, port: u16, lane: DurabilityIo, processes: Processes) -> Self {
        Self { runtime, data_dir: profile.join("pgdata"), port, lane, processes }
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

/// What the memory stop did with PostgreSQL. A dispatch is a delivered signal, never an observed exit: whether the postmaster exited is a separate
/// observation ([`await_exit`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopDispatch {
    /// A fast-shutdown request was delivered to the postmaster `pid`.
    Dispatched { pid: u32 },
    /// No postmaster was running for the data directory.
    AlreadyAbsent,
    /// A secondary process: the cluster belongs to the primary, which stops it.
    SecondaryNotOwned,
    /// Nothing was opened and no start was handed to the OS.
    NothingOpened,
    /// A start was handed to the OS before the stop and no postmaster of it could be reached yet (no pid file): it cannot be recalled. On Windows it
    /// runs in the core's kill-on-close job ([`OWNED_SERVERS`]) and ends with the core; on Unix the next launch reconciles it
    /// (`settle_leftover_postmaster`).
    ExternalStartUnresolved,
    /// The delivery failed.
    Failed(String),
}

/// The whole dispatch's bound: the target's pid (from the record, else one read of `postmaster.pid`), the liveness check and the delivery. On Windows
/// the delivery is `pg_ctl stop -W`, which only sends the signal (`pgkill` over the postmaster's signal pipe) and exits.
const DISPATCH_LIMIT: Duration = Duration::from_secs(3);

/// Replaces the next pid read of a dispatch (a stalled lane, a failing read).
#[cfg(test)]
pub(crate) static PID_READ: std::sync::Mutex<Option<futures::future::BoxFuture<'static, std::io::Result<Option<u32>>>>> = std::sync::Mutex::new(None);

/// The pid line of `postmaster.pid`: `Ok(None)` only when there is no pid file (or it holds no line yet); any other failure is an error, never
/// absence.
async fn read_pid_checked(lane: DurabilityIo, data_dir: &Path) -> std::io::Result<Option<u32>> {
    #[cfg(test)]
    {
        let replaced = PID_READ.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(read) = replaced {
            return read.await;
        }
    }
    match fsio::read_to_string(lane, &data_dir.join("postmaster.pid")).await {
        Ok(text) => match text.lines().next().map(str::trim).filter(|line| !line.is_empty()) {
            None => Ok(None),
            Some(line) => line.parse().map(Some).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// The postmaster's pid as recorded in `data_dir` now (the opening records it once its cluster is attached or started).
pub(crate) async fn recorded_pid(lane: DurabilityIo, data_dir: &Path) -> std::io::Result<Option<u32>> {
    read_pid_checked(lane, data_dir).await
}

/// Delivers PostgreSQL's fast-shutdown request (`SIGINT`) to the postmaster of `data_dir` and returns without waiting for it to exit: one bounded
/// step ([`DISPATCH_LIMIT`]) that always ends in an outcome. `known` is the pid the stop's record holds; without one the pid file is read, and
/// `missing` is the outcome when it names none. A failed read is `Failed`, never absence. Unix signals the pid directly; Windows has no signals, so
/// `pg_ctl stop -m fast -W` (no wait) delivers it.
pub(crate) async fn dispatch_fast_stop(
    runtime: &PgRuntime,
    processes: &Processes,
    lane: DurabilityIo,
    data_dir: &Path,
    known: Option<u32>,
    missing: StopDispatch,
) -> StopDispatch {
    let delivery = deliver_fast_stop(runtime, processes, lane, data_dir, known, missing);
    match mixdog_rt::time::timeout(DISPATCH_LIMIT, delivery).await {
        Ok(outcome) => outcome,
        Err(_) => StopDispatch::Failed(format!("the stop's dispatch did not end within {} s", DISPATCH_LIMIT.as_secs())),
    }
}

#[cfg_attr(unix, allow(unused_variables, reason = "the runtime delivers the signal on Windows only"))]
async fn deliver_fast_stop(
    runtime: &PgRuntime,
    processes: &Processes,
    lane: DurabilityIo,
    data_dir: &Path,
    known: Option<u32>,
    missing: StopDispatch,
) -> StopDispatch {
    let pid = match known {
        Some(pid) => pid,
        None => match read_pid_checked(lane, data_dir).await {
            Ok(Some(pid)) => pid,
            Ok(None) => return missing,
            Err(error) => return StopDispatch::Failed(format!("reading postmaster.pid failed: {error}")),
        },
    };
    if !mixdog_statefile::process_exists(pid) {
        return StopDispatch::AlreadyAbsent;
    }
    #[cfg(unix)]
    {
        // A pid the OS handed to another program since is no postmaster (`isPostmasterAlive`): it is never signalled.
        if !is_postgres_pid(processes, pid).await {
            return StopDispatch::AlreadyAbsent;
        }
        // SAFETY: a signal to the pid of the stop's record (or the data directory's pid file), checked alive and a postgres just above.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) } == 0 {
            return StopDispatch::Dispatched { pid };
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return StopDispatch::AlreadyAbsent;
        }
        StopDispatch::Failed(error.to_string())
    }
    #[cfg(windows)]
    {
        let args: Vec<String> = ["stop", "-m", "fast", "-W", "-D"].into_iter().map(str::to_owned).chain([data_dir.to_string_lossy().into_owned()]).collect();
        match runtime.run(processes, "pg_ctl", &args, DISPATCH_LIMIT, None).await {
            Ok(_) => StopDispatch::Dispatched { pid },
            Err(_) if !mixdog_statefile::process_exists(pid) => StopDispatch::AlreadyAbsent,
            Err(error) => StopDispatch::Failed(error.message()),
        }
    }
}

/// What the stop must reach: nothing, a start handed to the OS whose cluster is not known ready, or a cluster attached to or started (its pid once known).
#[derive(Clone, Default)]
pub(crate) enum StopTarget {
    #[default]
    None,
    Handed(PgRuntime),
    Cluster {
        runtime: PgRuntime,
        pid: Option<u32>,
    },
}

#[derive(Default)]
struct RecordState {
    target: StopTarget,
    /// The stop has read the record for its dispatch.
    decided: bool,
    /// The delivery a transition after that decision started itself, synchronously in its own step ([`initiate_fast_stop`]); the stop's controller
    /// only collects its outcome, after its local acknowledgement ([`StopRecord::late_dispatch`]).
    late: Option<Initiated>,
}

/// A fast-stop delivery started without awaiting anything: its outcome, or (Windows) the `pg_ctl stop` child it runs in, owned by the record.
enum Initiated {
    Done(StopDispatch),
    #[cfg(windows)]
    Running {
        pid: u32,
        child: Box<std::process::Child>,
    },
}

/// The pid a stop signals: `known`, else the first line of `postmaster.pid`; the outcome that ends the stop when there is none.
#[allow(clippy::disallowed_methods, reason = "one synchronous read of the small pid file, inside the transition's step, which must not await")]
fn stop_target_pid(data_dir: &Path, known: Option<u32>) -> std::result::Result<u32, StopDispatch> {
    if let Some(pid) = known {
        return Ok(pid);
    }
    match std::fs::read_to_string(data_dir.join("postmaster.pid")) {
        Ok(text) => match text.lines().next().map(str::trim).filter(|line| !line.is_empty()).map(str::parse::<u32>) {
            Some(Ok(pid)) => Ok(pid),
            None => Err(StopDispatch::AlreadyAbsent),
            Some(Err(error)) => Err(StopDispatch::Failed(format!("reading postmaster.pid failed: {error}"))),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(StopDispatch::AlreadyAbsent),
        Err(error) => Err(StopDispatch::Failed(format!("reading postmaster.pid failed: {error}"))),
    }
}

/// Starts the fast-stop delivery to the postmaster of `data_dir` synchronously, for a transition that finds the stop already decided: nothing here
/// awaits, so neither revocation nor an executor that stops driving tasks can hold it back. The pid is `known` or read from the pid file (one small
/// synchronous read). Unix signals the postmaster directly; Windows spawns `pg_ctl stop -m fast -W`, whose child the record owns and the controller
/// collects within [`DISPATCH_LIMIT`].
#[allow(clippy::disallowed_methods, reason = "one synchronous read of the small pid file, inside the transition's step, which must not await")]
#[cfg_attr(unix, allow(unused_variables, reason = "the runtime delivers the signal on Windows only"))]
fn initiate_fast_stop(runtime: &PgRuntime, data_dir: &Path, known: Option<u32>) -> Initiated {
    let pid = match stop_target_pid(data_dir, known) {
        Ok(pid) => pid,
        Err(outcome) => return Initiated::Done(outcome),
    };
    if !mixdog_statefile::process_exists(pid) {
        return Initiated::Done(StopDispatch::AlreadyAbsent);
    }
    #[cfg(unix)]
    {
        // A pid the OS handed to another program is no postmaster: it is never signalled (`is_postgres_pid`, read without a child process here).
        if !postgres_named(pid) {
            return Initiated::Done(StopDispatch::AlreadyAbsent);
        }
        // SAFETY: a signal to the pid of the stop's record (or the data directory's pid file), checked alive and a postgres just above.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) } == 0 {
            return Initiated::Done(StopDispatch::Dispatched { pid });
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Initiated::Done(StopDispatch::AlreadyAbsent);
        }
        Initiated::Done(StopDispatch::Failed(error.to_string()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // A std child, not a tokio one: its stderr, once the child has ended, is read without a worker of tokio's blocking pool, which a stop
        // within DISPATCH_LIMIT cannot wait for.
        #[allow(clippy::disallowed_types, reason = "a tokio child reads its stderr on the blocking pool, which the stop's dispatch limit cannot wait for")]
        let spawned = std::process::Command::new(runtime.bin("pg_ctl"))
            .args(["stop", "-m", "fast", "-W", "-D"])
            .arg(data_dir)
            .env_clear()
            .envs(runtime.env())
            .current_dir(&runtime.dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW, as Node's windowsHide
            .spawn();
        match spawned {
            Ok(child) => Initiated::Running { pid, child: Box::new(child) },
            Err(error) => Initiated::Done(StopDispatch::Failed(format!("pg_ctl failed: {error}"))),
        }
    }
}

/// Whether `pid`'s process is named postgres, read without a child process (Linux procfs, macOS `proc_name`); unreadable is taken as postgres.
#[cfg(unix)]
#[allow(clippy::disallowed_methods, reason = "Linux only: one read of procfs, which is memory and not a disk")]
fn postgres_named(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/proc/{pid}/comm")).map_or(true, |comm| comm.contains("postgres"))
    }
    #[cfg(target_os = "macos")]
    {
        let mut name = [0u8; 256];
        // SAFETY: the buffer and its length are this function's own.
        let len = unsafe { libc::proc_name(pid as libc::c_int, name.as_mut_ptr().cast(), name.len() as u32) };
        len <= 0 || String::from_utf8_lossy(&name[..len as usize]).contains("postgres")
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        true
    }
}

impl Initiated {
    /// The outcome of what was started, collected within [`DISPATCH_LIMIT`]: a `pg_ctl stop` that does not end in time is ended and `Failed`.
    async fn collect(self) -> StopDispatch {
        match self {
            Self::Done(outcome) => outcome,
            #[cfg(windows)]
            Self::Running { pid, mut child } => {
                let until = tokio::time::Instant::now() + DISPATCH_LIMIT;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) if status.success() => return StopDispatch::Dispatched { pid },
                        Ok(Some(status)) => {
                            if !mixdog_statefile::process_exists(pid) {
                                return StopDispatch::AlreadyAbsent;
                            }
                            let mut text = String::new();
                            if let Some(mut stderr) = child.stderr.take() {
                                let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
                            }
                            let text = text.trim();
                            return StopDispatch::Failed(format!("pg_ctl failed: {}", if text.is_empty() { status.to_string() } else { text.to_owned() }));
                        }
                        Ok(None) if tokio::time::Instant::now() < until => mixdog_rt::time::sleep(Duration::from_millis(20)).await,
                        Ok(None) => {
                            // Not waited for: Windows ends a process asynchronously, and this step returns within its limit.
                            let _ = child.kill();
                            return StopDispatch::Failed(format!("the stop's dispatch did not end within {} s", DISPATCH_LIMIT.as_secs()));
                        }
                        Err(error) => return StopDispatch::Failed(format!("pg_ctl failed: {error}")),
                    }
                }
            }
        }
    }
}

/// The one record of the cluster a memory stack's stop must reach, under one lock from the moment a start is handed to the OS or a postmaster is
/// attached to until it is stopped. Every transition happens under that lock, synchronously where its fact becomes true ([`Launch`]), and the stop
/// reads it once. A transition that arrives after the stop decided starts the delivery itself, synchronously in that step, and the stop's controller
/// collects its outcome after the acknowledgement: no schedule leaves a known live cluster unsignalled while the stop waits for local work, nor ends
/// without a dispatch or an unresolved report. `None` is written only by a stop that succeeded or by evidence that no postmaster is left.
pub(crate) struct StopRecord {
    data_dir: PathBuf,
    lane: DurabilityIo,
    processes: Processes,
    /// A secondary process never stops the shared cluster.
    owned: bool,
    state: std::sync::Mutex<RecordState>,
}

impl StopRecord {
    pub(crate) fn new(data_dir: PathBuf, lane: DurabilityIo, processes: Processes, owned: bool) -> Arc<Self> {
        Arc::new(Self { data_dir, lane, processes, owned, state: std::sync::Mutex::default() })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, RecordState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// An admitted start, recorded before it is spawned.
    pub(crate) fn handed(&self, runtime: &PgRuntime) {
        self.state().target = StopTarget::Handed(runtime.clone());
    }

    /// A cluster attached to or started is ready (its pid possibly not known yet). Synchronous, under the lock: after the stop's decision it starts
    /// the delivery itself, in this step ([`initiate_fast_stop`]), and the record owns what it started.
    pub(crate) fn reached(&self, runtime: &PgRuntime, pid: Option<u32>) {
        let mut state = self.state();
        state.target = StopTarget::Cluster { runtime: runtime.clone(), pid };
        if state.decided && self.owned && state.late.is_none() {
            state.late = Some(initiate_fast_stop(runtime, &self.data_dir, pid));
        }
    }

    /// Whether the stop has read the record for its dispatch.
    #[cfg(test)]
    pub(crate) fn decided(&self) -> bool {
        self.state().decided
    }

    /// The pid of the cluster reached, once read.
    pub(crate) fn known_pid(&self, pid: u32) {
        if let StopTarget::Cluster { pid: known @ None, .. } = &mut self.state().target {
            *known = Some(pid);
        }
    }

    /// The cluster was stopped (a stop that succeeded).
    pub(crate) fn cleared(&self) {
        self.state().target = StopTarget::None;
    }

    /// A start that failed: the record keeps what is left. Only evidence that no postmaster runs clears it; a postmaster that survived its start's
    /// cleanup is recorded as reached (with its pid), and a failed read keeps the start unresolved.
    pub(crate) async fn failed_start(&self) {
        let StopTarget::Handed(runtime) = self.state().target.clone() else { return };
        let read = mixdog_rt::time::timeout(DISPATCH_LIMIT, read_pid_checked(self.lane, &self.data_dir)).await;
        match read {
            Ok(Ok(Some(pid))) if mixdog_statefile::process_exists(pid) => self.reached(&runtime, Some(pid)),
            Ok(Ok(_)) => {
                let mut state = self.state();
                if matches!(state.target, StopTarget::Handed(_)) {
                    state.target = StopTarget::None;
                }
            }
            _ => {}
        }
    }

    /// The stop's dispatch: the record is read once (and marked decided in the same critical section), then delivered within one bound.
    pub(crate) async fn dispatch(&self) -> StopDispatch {
        if !self.owned {
            return StopDispatch::SecondaryNotOwned;
        }
        let target = {
            let mut state = self.state();
            state.decided = true;
            state.target.clone()
        };
        let (runtime, known, missing) = match target {
            StopTarget::None => return StopDispatch::NothingOpened,
            StopTarget::Handed(runtime) => (runtime, None, StopDispatch::ExternalStartUnresolved),
            StopTarget::Cluster { runtime, pid } => (runtime, pid, StopDispatch::AlreadyAbsent),
        };
        dispatch_fast_stop(&runtime, &self.processes, self.lane, &self.data_dir, known, missing).await
    }

    /// The outcome of the delivery a transition after the stop's decision started, collected by the controller once the local revocation is
    /// acknowledged (when no transition can follow): `None` when nothing came late. Bounded like the first dispatch; taken once.
    pub(crate) async fn late_dispatch(&self) -> Option<StopDispatch> {
        let started = self.state().late.take()?;
        Some(started.collect().await)
    }
}

/// The postmaster `pid`'s exit, observed until `until`: `true` once it is gone. Only the graceful stop waits here, inside its cutoff.
pub(crate) async fn await_exit(pid: u32, until: tokio::time::Instant) -> bool {
    const POLL: Duration = Duration::from_millis(50);
    loop {
        if !mixdog_statefile::process_exists(pid) {
            return true;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        mixdog_rt::time::sleep(POLL.min(until.saturating_duration_since(tokio::time::Instant::now()))).await;
    }
}

#[cfg(test)]
#[path = "cluster_tests.rs"]
mod tests;
