use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tempfile::TempDir;

use crate::memory::pg::cluster::{PgCluster, PgRuntime};
use crate::memory::pg::db::{Db, Schema};

static NEXT_PORT: AtomicU16 = AtomicU16::new(0);

/// A throwaway cluster in a temp directory.
pub struct TestPg {
    pub cluster: PgCluster,
    pub dir: TempDir,
    runtime: PathBuf,
}

impl TestPg {
    pub async fn start() -> Self {
        let runtime = PathBuf::from(
            std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"),
        );
        let dir = tempfile::tempdir().expect("temp dir");
        // Parallel tests (and other builds on this machine) scan from different starts.
        let offset = NEXT_PORT.fetch_add(1, Ordering::Relaxed);
        let preferred = 57000 + (std::process::id() % 800) as u16 * 8 + offset;
        let cluster = PgCluster::ensure(PgRuntime::new(&runtime), dir.path(), preferred, mixdog_rt::testing::tokens().durability_io, crate::tidy::process::Processes::for_tests(), &tokio_util::sync::CancellationToken::new(), &crate::memory::pg::cluster::Start::node(), &|| true)
            .await
            .expect("postgres starts");
        Self { cluster, dir, runtime }
    }

    pub async fn db(&self, schema: Schema) -> Db {
        Db::open(&self.cluster, schema).await.expect("db opens")
    }

    /// A kill of the postmaster (an immediate stop: no checkpoint, crash recovery at the next
    /// start), then a start on the same data directory.
    pub async fn kill_and_restart(&mut self) {
        self.stop_immediate();
        self.cluster = PgCluster::ensure(PgRuntime::new(&self.runtime), self.dir.path(), self.cluster.port(), mixdog_rt::testing::tokens().durability_io, crate::tidy::process::Processes::for_tests(), &tokio_util::sync::CancellationToken::new(), &crate::memory::pg::cluster::Start::node(), &|| true)
            .await
            .expect("postgres starts again");
    }

    fn stop_immediate(&self) {
        let mut stop = Command::new(self.runtime.join("bin").join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }));
        stop.args(["stop", "-m", "immediate", "-w", "-D"])
            .arg(self.cluster.data_dir())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            stop.creation_flags(0x0800_0000);
            let path = format!("{};{}", self.runtime.join("bin").display(), std::env::var("PATH").unwrap_or_default());
            stop.env("PATH", path);
        }
        let _ = stop.status();
    }
}

impl Drop for TestPg {
    fn drop(&mut self) {
        self.stop_immediate();
        std::thread::sleep(Duration::from_millis(200));
    }
}
