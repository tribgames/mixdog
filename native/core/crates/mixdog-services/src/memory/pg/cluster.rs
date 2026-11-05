//! The PostgreSQL cluster behind memory and session search: one bundled
//! runtime (`bin/`, `lib/`, `share/`, pgvector included), one data directory.
//! `PgCluster::ensure` attaches to a postmaster that already serves the data
//! directory, else initialises it when empty and starts one. The core is the
//! only process of its data dir, so there is no secondary-attach protocol.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::process::Command;

use crate::memory::error::{MemoryError, Result};

/// First port tried for a product postmaster, and how many ports above it are scanned.
pub const DEFAULT_PORT: u16 = 55432;
const PORT_SPAN: u16 = 200;
const START_DEADLINE: Duration = Duration::from_secs(30);
const READY_POLL: Duration = Duration::from_millis(100);

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

    fn command(&self, name: &str) -> Command {
        let mut command = Command::new(self.bin(name));
        let lib = self.dir.join("lib");
        if cfg!(target_os = "linux") {
            command.env("LD_LIBRARY_PATH", lib);
        } else if cfg!(target_os = "macos") {
            command.env("DYLD_LIBRARY_PATH", lib);
        } else {
            // Windows keeps the DLLs beside the executables.
            let mut path = std::ffi::OsString::from(self.dir.join("bin"));
            path.push(";");
            path.push(std::env::var_os("PATH").unwrap_or_default());
            command.env("PATH", path);
        }
        command.stdin(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }
}

/// A running postmaster serving one data directory.
#[derive(Debug, Clone)]
pub struct PgCluster {
    runtime: PgRuntime,
    data_dir: PathBuf,
    port: u16,
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
fn read_postmaster_port(data_dir: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(data_dir.join("postmaster.pid")).ok()?;
    text.lines().nth(3)?.trim().parse().ok().filter(|port| *port > 0)
}

async fn accepts_connections(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).await.is_ok()
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

async fn run(mut command: Command, what: &str) -> Result<std::process::Output> {
    let output = command.output().await?;
    if output.status.success() {
        return Ok(output);
    }
    let text = [&output.stderr, &output.stdout]
        .iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_owned())
        .find(|text| !text.is_empty())
        .unwrap_or_else(|| format!("status {}", output.status));
    Err(MemoryError::Runtime(format!("{what} failed: {text}")))
}

/// `initdb -L` input directory. On Windows initdb embeds its share path in
/// bootstrap SQL as system-code-page bytes, which a UTF-8 cluster rejects when
/// the path is not ASCII; such a share directory is reached through an ASCII
/// junction that is removed afterwards.
struct ShareDir {
    link: Option<PathBuf>,
}

impl ShareDir {
    async fn prepare(runtime: &PgRuntime) -> Result<Self> {
        let share = runtime.dir.join("share");
        if !cfg!(windows) || share.to_string_lossy().is_ascii() {
            return Ok(Self { link: None });
        }
        let root = PathBuf::from(std::env::var_os("ProgramData").unwrap_or_default())
            .join(format!("mixdog-initdb-{}", uuid::Uuid::new_v4().simple()));
        tokio::fs::create_dir_all(&root).await?;
        let link = root.join("share");
        let mut mklink = Command::new("cmd");
        mklink.arg("/C").arg("mklink").arg("/J").arg(&link).arg(&share);
        run(mklink, "mklink").await?;
        Ok(Self { link: Some(link) })
    }

    fn path(&self) -> Option<&Path> {
        self.link.as_deref()
    }

    async fn release(self) {
        if let Some(link) = self.link {
            // Both removals are non-recursive: the runtime share is never touched.
            let _ = tokio::fs::remove_dir(&link).await;
            if let Some(root) = link.parent() {
                let _ = tokio::fs::remove_dir(root).await;
            }
        }
    }
}

impl PgCluster {
    /// Attach to the cluster that serves `data_dir`, or initialise and start it.
    pub async fn ensure(runtime: PgRuntime, data_dir: impl Into<PathBuf>, preferred_port: u16) -> Result<Self> {
        let data_dir = data_dir.into();
        tokio::fs::create_dir_all(&data_dir).await?;
        if let Some(port) = read_postmaster_port(&data_dir)
            && accepts_connections(port).await {
                return Ok(Self { runtime, data_dir, port });
            }
        if !data_dir.join("PG_VERSION").exists() {
            Self::init(&runtime, &data_dir).await?;
        }
        let port = free_port(preferred_port).await?;
        let log = data_dir.join("pg.log");
        let mut start = runtime.command("pg_ctl");
        start
            .arg("start")
            .arg("-D")
            .arg(&data_dir)
            .arg("-l")
            .arg(&log)
            .arg("-o")
            .arg(format!("-p {port} -h 127.0.0.1"));
        // pg_ctl returns once the postmaster is spawned; readiness is probed here.
        // The postmaster inherits pg_ctl's stdio, so captured pipes would never
        // reach EOF; its output goes to the log file instead.
        start.stdout(Stdio::null()).stderr(Stdio::null());
        if !start.status().await?.success() {
            let log_text = tokio::fs::read_to_string(&log).await.unwrap_or_default();
            return Err(MemoryError::Runtime(format!("pg_ctl start failed: {}", log_text.trim())));
        }
        let deadline = tokio::time::Instant::now() + START_DEADLINE;
        loop {
            if accepts_connections(port).await && read_postmaster_port(&data_dir) == Some(port) {
                return Ok(Self { runtime, data_dir, port });
            }
            if tokio::time::Instant::now() >= deadline {
                let log_text = tokio::fs::read_to_string(&log).await.unwrap_or_default();
                return Err(MemoryError::Runtime(format!("postgres did not become ready on port {port}: {}", log_text.trim())));
            }
            tokio::time::sleep(READY_POLL).await;
        }
    }

    async fn init(runtime: &PgRuntime, data_dir: &Path) -> Result<()> {
        let share = ShareDir::prepare(runtime).await?;
        let mut initdb = runtime.command("initdb");
        initdb.arg("-D").arg(data_dir);
        if let Some(path) = share.path() {
            initdb.arg("-L").arg(path);
        }
        initdb.args(["--auth-local=trust", "--no-locale", "-E", "UTF8", "-U", "postgres"]);
        let result = run(initdb, "initdb").await;
        share.release().await;
        result?;
        let conf = data_dir.join("postgresql.conf");
        let mut text = tokio::fs::read_to_string(&conf).await?;
        text.push_str(CLUSTER_CONF);
        tokio::fs::write(&conf, text).await?;
        Ok(())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Bounded fast shutdown: open transactions roll back, clients disconnect.
    pub async fn stop(&self, timeout: Duration) -> Result<()> {
        let seconds = timeout.as_secs().max(1);
        let mut stop = self.runtime.command("pg_ctl");
        stop.args(["stop", "-m", "fast", "-w", "-t"]).arg(seconds.to_string()).arg("-D").arg(&self.data_dir);
        match run(stop, "pg_ctl stop").await {
            Ok(_) => Ok(()),
            // No postmaster.pid means nothing was running.
            Err(_) if read_postmaster_port(&self.data_dir).is_none() => Ok(()),
            Err(error) => Err(error),
        }
    }
}
