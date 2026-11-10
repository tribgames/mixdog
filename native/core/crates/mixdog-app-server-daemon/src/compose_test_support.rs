//! What the tests that compose the real core share. Composing runs `ensure_runtime` for the bundled PostgreSQL runtime and starts the memory stack on it; with no runtime
//! installed in the data directory that DOWNLOADS it, so these tests never start from an empty one. They are the integration tests of the memory crate's kind
//! (`#[ignore]`, `MIXDOG_PG_RUNTIME` names an unpacked runtime directory, as in `mixdog-services`' `memory/tests/boot.rs`): the runtime is copied once into the layout
//! `ensure_runtime` reads as installed (`<data>/runtime/runtime-<key>`, the `.version-sha256` stamp, `active-version`), so no network is touched.
//!
//! Each such test runs in a child process of its own ([`in_child`]) over a directory of its own, which the parent removes once the child has ended. A
//! composed core's SQLite stores outlive its stop: `state/core.sqlite` and `index/store.sqlite` are still open after `ComposedCore::stop`, after the
//! core is dropped and after its runtime is dropped (the session directory, the app feed and the other parts that hold them stay alive), and on
//! Windows an open file cannot be removed. Only the end of the process that held them makes the removal certain.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_services::memory::pg::runtime_install::{Manifest, Platform, install_key, ver_dir};

/// Set only in a composed test's child process: the directory the test works in.
const CHILD_DIR: &str = "MIXDOG_COMPOSED_TEST_DIR";
/// How long a composed test's child may run: compositions and stops are bounded at their own waits; this bounds the whole. Under the time nextest
/// gives these tests (720 s, `.config/nextest.toml`), so the parent's cleanup runs before nextest would end the parent.
const CHILD_LIMIT: Duration = Duration::from_secs(600);
/// How long a killed process, or what a process started, may take to end, and the bound of each `pg_ctl` the cleanup runs.
const CLEANUP_LIMIT: Duration = Duration::from_secs(60);
/// `pg_ctl stop -t`: the fast shutdown's own wait, under `CLEANUP_LIMIT`.
const PG_STOP_SECONDS: &str = "30";

/// The data directory of a composed test working in `dir` (`<dir>/data`), with the runtime of `MIXDOG_PG_RUNTIME` installed in it.
pub fn data_in(dir: &Path) -> PathBuf {
    let data = dir.join("data");
    install(&data);
    data
}

/// Runs a test that composes the real core: in the child process (this test binary, run for this test alone) `body` runs on a runtime built by
/// `runtime` over the test's own directory. The parent waits for the child at most `CHILD_LIMIT` (over it, the child is killed with every process
/// it started: on Windows its job object) and, on Windows, for every process the child started to have ended; then it stops any PostgreSQL
/// cluster still running in the test's directory, by its data directory (`pg_ctl stop`), however the child ended, and removes the directory. A
/// child that failed or ran over its limit, a process of it that did not end, a cluster that could not be stopped and a directory that could not
/// be removed each fail the test, all of them reported.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs the test's child process and removes the test's own directory")]
pub fn in_child<F, Fut>(module: &str, name: &str, mut runtime: tokio::runtime::Builder, body: F)
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if let Some(dir) = std::env::var_os(CHILD_DIR) {
        let runtime = runtime.enable_all().build().expect("the test's runtime");
        runtime.block_on(body(PathBuf::from(dir)));
        return;
    }
    let test = format!("{}::{name}", module.split_once("::").map_or(module, |(_, path)| path));
    let dir = tempfile::tempdir().expect("the test's own directory");
    let mut child = std::process::Command::new(std::env::current_exe().expect("the test binary"));
    child.args(["--exact", &test, "--ignored", "--nocapture", "--test-threads=1"]).env(CHILD_DIR, dir.path());
    let mut failures = Vec::new();
    match run_bounded(child, CHILD_LIMIT, "the child test process") {
        Ok(output) if output.status.success() => {}
        Ok(output) => failures.push(format!("the child test process failed: {}", output.status)),
        Err(failure) => failures.push(failure),
    }
    failures.extend(stop_clusters(dir.path()));
    let path = dir.path().to_owned();
    if let Err(error) = dir.close() {
        failures.push(format!("the test's directory {} was not removed after the child ended: {error}; still held: {:?}", path.display(), held_files(&path)));
    }
    assert!(failures.is_empty(), "{test}:\n{}", failures.join("\n"));
}

/// Runs `command` to its end under `limit` in a [`Tree`] of its own, its output collected when the command pipes it. Over the limit the tree is
/// killed and the process given `CLEANUP_LIMIT` to end. Returns once the process has ended and what it started in its tree has too (bounded by
/// `CLEANUP_LIMIT`); `Err` says what happened, naming `what`.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: waits for a process the harness started")]
fn run_bounded(mut command: std::process::Command, limit: Duration, what: &str) -> Result<std::process::Output, String> {
    let tree = Tree::new().map_err(|error| format!("{what}: no process tree: {error}"))?;
    let mut child = command.spawn().map_err(|error| format!("{what} did not start: {error}"))?;
    if let Err(error) = tree.hold(&child) {
        let ended = child.kill().and_then(|()| child.wait()).map_or_else(|error| error.to_string(), |status| status.to_string());
        return Err(format!("{what} could not be put in a process tree: {error}; it was killed ({ended})"));
    }
    let (done, ended) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let output = child.wait_with_output();
        let _ = done.send(());
        output
    });
    let mut overrun = None;
    if ended.recv_timeout(limit).is_err() {
        let killed = tree.kill().err().map_or_else(String::new, |error| format!("; the kill failed: {error}"));
        if ended.recv_timeout(CLEANUP_LIMIT).is_err() {
            return Err(format!("{what} ran over {limit:?} and was still running {CLEANUP_LIMIT:?} after it was killed{killed}"));
        }
        overrun = Some(format!("{what} ran over {limit:?} and was killed{killed}"));
    }
    let output = waiter.join().expect("the waiting thread").map_err(|error| format!("{what} could not be waited for: {error}"))?;
    tree.wait_empty(CLEANUP_LIMIT).map_err(|error| format!("{what} ended ({}), but {error}", output.status))?;
    match overrun {
        Some(overrun) => Err(format!("{overrun} ({})", output.status)),
        None => Ok(output),
    }
}

/// A process and everything it starts, as one unit to kill and to see end: a job object of the test (nested above the jobs the process makes
/// for its own children, so a cluster the core started through `mixdog-spawn` is in it). Closing it kills whatever is left.
#[cfg(windows)]
struct Tree {
    job: windows_sys::Win32::Foundation::HANDLE,
    /// The completion port the job reports to: its "last process ended" message is what `wait_empty` waits for.
    port: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Tree {
    /// `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` (winnt.h), which windows-sys does not export.
    const ACTIVE_PROCESS_ZERO: u32 = 4;

    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::IO::CreateIoCompletionPort;
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: plain constructors; each handle is checked and owned by the `Tree` (closed in `drop`).
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if port.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(error);
        }
        let tree = Self { job, port };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: std::ptr::null_mut(), CompletionPort: port };
        // SAFETY: the job handle is valid and each structure is passed with its own size.
        let set = unsafe {
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, std::ptr::addr_of!(limits).cast(), std::mem::size_of_val(&limits) as u32) != 0
                && SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, std::ptr::addr_of!(association).cast(), std::mem::size_of_val(&association) as u32) != 0
        };
        if set { Ok(tree) } else { Err(std::io::Error::last_os_error()) }
    }

    /// Puts the just-started `child` in the job: everything it starts from then on is in it too.
    #[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
    fn hold(&self, child: &std::process::Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: both handles are valid; the child's is open while `child` lives.
        let held = unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.job, child.as_raw_handle()) };
        if held != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    fn kill(&self) -> std::io::Result<()> {
        // SAFETY: the job handle is valid.
        let killed = unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) };
        if killed != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    /// Waits, at most `limit`, for the job's message that its last process has ended.
    fn wait_empty(&self, limit: Duration) -> Result<(), String> {
        use windows_sys::Win32::System::IO::{GetQueuedCompletionStatus, OVERLAPPED};
        let deadline = std::time::Instant::now() + limit;
        loop {
            let left = u32::try_from(deadline.saturating_duration_since(std::time::Instant::now()).as_millis()).unwrap_or(u32::MAX);
            let (mut message, mut key, mut overlapped) = (0u32, 0usize, std::ptr::null_mut::<OVERLAPPED>());
            // SAFETY: the port handle is valid and every out pointer points at a local.
            let got = unsafe { GetQueuedCompletionStatus(self.port, &mut message, &mut key, &mut overlapped, left) };
            if got == 0 && overlapped.is_null() {
                return Err(format!("what it started had not all ended {limit:?} later ({})", std::io::Error::last_os_error()));
            }
            if message == Self::ACTIVE_PROCESS_ZERO {
                return Ok(());
            }
        }
    }
}

#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: both handles are owned by the `Tree` and closed once; closing the job kills what is left in it.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
            windows_sys::Win32::Foundation::CloseHandle(self.port);
        }
    }
}

/// A process, killed by its pid. What it started is not tracked: a cluster it started detaches (`pg_ctl start` gives the postmaster a session of
/// its own) and is stopped by its data directory (`stop_clusters`).
#[cfg(unix)]
struct Tree(std::sync::OnceLock<libc::pid_t>);

#[cfg(unix)]
impl Tree {
    fn new() -> std::io::Result<Self> {
        Ok(Self(std::sync::OnceLock::new()))
    }

    #[allow(clippy::disallowed_types, reason = "test harness: a process the harness started")]
    fn hold(&self, child: &std::process::Child) -> std::io::Result<()> {
        let pid = libc::pid_t::try_from(child.id()).map_err(std::io::Error::other)?;
        let _ = self.0.set(pid);
        Ok(())
    }

    fn kill(&self) -> std::io::Result<()> {
        let pid = *self.0.get().expect("a held process");
        // SAFETY: kill has no memory preconditions. `pid` is the harness's own child, whose waiter had not reported it reaped when the limit
        // passed.
        if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    fn wait_empty(&self, _: Duration) -> Result<(), String> {
        Ok(())
    }
}

/// Stops every PostgreSQL cluster still running in a data directory of the test working in `dir` (`<dir>/data`, `<dir>/<sub>/data`), by that
/// directory: `pg_ctl status`, then `pg_ctl stop -m fast` with the runtime installed beside it. Returns what failed.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs pg_ctl on the test's own data directories")]
fn stop_clusters(dir: &Path) -> Vec<String> {
    let mut data_dirs = vec![dir.join("data")];
    if let Ok(entries) = std::fs::read_dir(dir) {
        data_dirs.extend(entries.flatten().map(|entry| entry.path().join("data")));
    }
    let mut failures = Vec::new();
    for data in data_dirs {
        let pgdata = data.join("pgdata");
        if !pgdata.join("postmaster.pid").exists() {
            continue;
        }
        let pg_ctl = |args: &[&str]| {
            let key = std::fs::read_to_string(data.join("runtime").join("active-version")).map_err(|error| format!("the runtime of {} is not readable: {error}", data.display()))?;
            let runtime = ver_dir(&data.join("runtime"), key.trim());
            let mut command = std::process::Command::new(runtime.join("bin").join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }));
            command.args(args).arg("-D").arg(&pgdata).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            #[cfg(target_os = "linux")]
            command.env("LD_LIBRARY_PATH", runtime.join("lib"));
            #[cfg(target_os = "macos")]
            command.env("DYLD_LIBRARY_PATH", runtime.join("lib"));
            run_bounded(command, CLEANUP_LIMIT, &format!("pg_ctl {} -D {}", args[0], pgdata.display()))
        };
        // `pg_ctl status`: 0 running, 3 not running (a postmaster.pid left by a killed cluster).
        match pg_ctl(&["status"]) {
            Ok(output) if output.status.code() == Some(3) => {}
            Ok(output) if output.status.success() => match pg_ctl(&["stop", "-m", "fast", "-w", "-t", PG_STOP_SECONDS]) {
                Ok(stopped) if stopped.status.success() => eprintln!("stopped the cluster still running in {}", pgdata.display()),
                Ok(stopped) => failures.push(format!("pg_ctl stop -D {}: {} {}", pgdata.display(), stopped.status, String::from_utf8_lossy(&stopped.stderr).trim())),
                Err(failure) => failures.push(failure),
            },
            Ok(output) => failures.push(format!("pg_ctl status -D {}: {} {}", pgdata.display(), output.status, String::from_utf8_lossy(&output.stderr).trim())),
            Err(failure) => failures.push(failure),
        }
    }
    failures
}

/// The files under `dir` that cannot be removed now (a process still holds them).
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: lists the test's own files that cannot be removed")]
fn held_files(dir: &Path) -> Vec<String> {
    let mut held = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return held };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            held.extend(held_files(&path));
        } else if std::fs::remove_file(&path).is_err() {
            held.push(path.display().to_string());
        }
    }
    held
}

#[allow(clippy::disallowed_methods, reason = "test fixture: copies an unpacked runtime into the layout `ensure_runtime` reads")]
pub fn install(data: &Path) {
    let source = std::path::PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME names a bundled postgres runtime dir"));
    let manifest = Manifest::bundled().expect("the bundled manifest");
    let (asset, _) = manifest.select(&Platform::current()).expect("the manifest has a runtime for this platform");
    let key = install_key(&manifest.version(), &asset.sha256);
    let base = data.join("runtime");
    let target = ver_dir(&base, &key);
    copy_tree(&source, &target);
    std::fs::write(target.join(".version-sha256"), &asset.sha256).expect("the stamp");
    std::fs::write(base.join("active-version"), &key).expect("the active version");
}

#[allow(clippy::disallowed_methods, reason = "test fixture")]
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the target directory");
    for entry in std::fs::read_dir(from).expect("the runtime directory") {
        let entry = entry.expect("a runtime entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("an entry type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("a runtime file");
        }
    }
}

/// What a user's settings hold once a provider is signed in and a model is chosen: the provider in `mixdog-config.json`, its listed model in the catalog cache the core cold-starts
/// from (`catalogs/snapshot.json`), and the preset `default` names. The provider needs no key (`auth: none`) and its address is never called by a test that starts no turn.
#[allow(clippy::disallowed_methods, reason = "test fixture: the settings files a user's setup would have written")]
pub fn seed_default_model(data: &Path) {
    const PROVIDER: &str = "custom-test";
    const MODEL: &str = "test-model";
    let config = serde_json::json!({ "agent": {
        "providers": { PROVIDER: {
            "type": "custom", "schemaVersion": 2, "name": "test", "protocol": "openai-chat",
            "baseURL": "http://127.0.0.1:9", "auth": "none", "enabled": true,
            "modelOverrides": { MODEL: { "manual": true } },
        } },
        "default": "main",
        "presets": [{ "id": "main", "name": "main", "provider": PROVIDER, "model": MODEL }],
    } });
    std::fs::write(data.join("mixdog-config.json"), config.to_string()).expect("the settings file");
    let snapshot = serde_json::json!({ "generation": 1, "models": { PROVIDER: [{
        "id": MODEL, "provider": PROVIDER, "displayName": null, "rates": {}, "vision": "unknown",
        "functionCalling": "unknown", "reasoning": "unknown", "fastMode": "unknown",
        "reasoningEfforts": [], "source": "native", "manual": true,
    }] } });
    std::fs::create_dir_all(data.join("catalogs")).expect("the catalog directory");
    std::fs::write(data.join("catalogs").join("snapshot.json"), snapshot.to_string()).expect("the catalog cache");
}

/// The catalog's HTTP port in every real-core test: a client that cannot connect, so the boot warm-up (200 ms after
/// the composition starts) never reaches a network.
pub fn offline_http() -> std::sync::Arc<dyn mixdog_ai::transport::http::HttpSend> {
    std::sync::Arc::new(OfflineHttp)
}

struct OfflineHttp;

#[async_trait::async_trait]
impl mixdog_ai::transport::http::HttpSend for OfflineHttp {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}