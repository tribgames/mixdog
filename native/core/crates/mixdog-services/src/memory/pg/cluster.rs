//! The PostgreSQL cluster behind memory and session search: one bundled
//! runtime (`bin/`, `lib/`, `share/`, pgvector included), one data directory.
//! `PgCluster::ensure` attaches to a postmaster that already serves the data
//! directory, else initialises it when empty and starts one. The core is the
//! only process of its data dir, so there is no secondary-attach protocol.

//!
//! Every child (`initdb`, `pg_ctl start|status|reload|stop`) runs under the one process manager
//! through [`Processes`], with Node's limits (`runtime/memory/lib/pg/process.mjs`): `status` 3 s,
//! `reload` 5 s, `stop` its `-t` seconds plus one; `initdb` has none, as in Node, and is ended by
//! the caller's cancel; `pg_ctl start` is not waited for (the readiness poll, 30 s, is its bound).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
type StartRun = tokio::task::JoinHandle<Result<ProcessResult>>;

impl PgCluster {
    /// Attach to the cluster that serves `data_dir`, or initialise and start it. `cancel` ends an
    /// `initdb` in progress (it has no time limit, as in Node).
    pub async fn ensure(
        runtime: PgRuntime,
        data_dir: impl Into<PathBuf>,
        preferred_port: u16,
        lane: DurabilityIo,
        processes: Processes,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let data_dir = data_dir.into();
        fsio::create_dir_all(lane, &data_dir).await?;
        if let Some(port) = read_postmaster_port(lane, &data_dir).await
            && healthcheck(port).await {
                return Ok(Self { runtime, data_dir, port, lane, processes });
            }
        if !fsio::exists(lane, &data_dir.join("PG_VERSION")).await? {
            Self::init(lane, &processes, &runtime, &data_dir, cancel).await?;
        }
        let port = free_port(preferred_port).await?;
        let log = data_dir.join("pg.log");
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
        let mut started: Option<StartRun> = Some({
            let (runtime, processes) = (runtime.clone(), processes.clone());
            mixdog_rt::spawn("services.memory.pg-start", TaskClass::Work, async move {
                runtime.run(&processes, "pg_ctl", &args, Duration::ZERO, None).await
            })
        });
        let deadline = tokio::time::Instant::now() + START_DEADLINE;
        let mut early: Option<MemoryError> = None;
        loop {
            if healthcheck(port).await && read_postmaster_port(lane, &data_dir).await == Some(port) {
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
                let log_text = fsio::read_to_string(lane, &log).await.unwrap_or_default();
                return Err(Self { runtime, data_dir, port, lane, processes }
                    .abandon(MemoryError::Runtime(format!("postgres did not become ready on port {port}: {}", log_text.trim())))
                    .await);
            }
            // A stop during startup ends the wait: the daemon is going down, not waiting for a database it will not use.
            tokio::select! {
                () = cancel.cancelled() => {
                    return Err(Self { runtime, data_dir, port, lane, processes }
                        .abandon(MemoryError::Runtime("the start was cancelled before postgres was ready".to_owned()))
                        .await);
                }
                () = tokio::time::sleep(READY_POLL) => {}
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
mod tests {
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
}