use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use tempfile::TempDir;

use crate::memory::pg::cluster::{PgCluster, PgRuntime};
use crate::memory::pg::db::{Db, Schema};

/// Where a test's cluster starts scanning for a port: one the OS just handed out, so parallel tests and other builds on this machine
/// start apart, and never inside a range Windows reserves (Hyper-V / WinNAT keep 100-port blocks, 58284-58824 on 2026-11-12, that
/// refuse every bind: a fixed range landed inside them and the scan of its 200 ports took 410 s and failed).
///
/// A start scans upward (`cluster::PORT_SPAN` ports): a port among the last `PORT_SPAN` of the range has fewer than that above it, so
/// it is held and another is asked for. There are only `PORT_SPAN` such ports, so this ends.
pub fn preferred_port() -> u16 {
    let mut held = Vec::new();
    loop {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("the OS has a free port");
        let port = listener.local_addr().expect("a bound address").port();
        if port <= u16::MAX - crate::memory::pg::cluster::PORT_SPAN {
            return port;
        }
        held.push(listener);
    }
}

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
        let preferred = preferred_port();
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

    #[allow(clippy::disallowed_methods, reason = "test teardown: reads the stopped cluster's pid file")]
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
        // The postmaster's pid, read before the stop removes its file.
        let postmaster = std::fs::read_to_string(self.cluster.data_dir().join("postmaster.pid")).ok().and_then(|text| text.lines().next()?.trim().parse::<u32>().ok());
        let _ = stop.status();
        // `pg_ctl -w` returns once postmaster.pid is gone (its own 60 s deadline). On Windows the temp directory is removed
        // next and a file still open in the exiting postmaster would keep it: its exit is awaited, with a deadline.
        #[cfg(windows)]
        if let Some(pid) = postmaster {
            wait_for_exit(pid, POSTMASTER_EXIT);
        }
        #[cfg(not(windows))]
        let _ = postmaster;
    }
}

impl Drop for TestPg {
    fn drop(&mut self) {
        self.stop_immediate();
    }
}

const POSTMASTER_EXIT: Duration = Duration::from_secs(30);

/// Waits on the process's handle for its exit, failing (unless the test already fails) when it has not exited by `limit`.
#[cfg(windows)]
fn wait_for_exit(pid: u32, limit: Duration) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    // SAFETY: plain Win32 calls on a handle this function opens and closes; a null handle (the process is gone) is not used.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        let waited = WaitForSingleObject(handle, limit.as_millis() as u32);
        CloseHandle(handle);
        if waited != WAIT_OBJECT_0 && !std::thread::panicking() {
            panic!("the stopped test cluster's postmaster (pid {pid}) did not exit within {limit:?}");
        }
    }
}
