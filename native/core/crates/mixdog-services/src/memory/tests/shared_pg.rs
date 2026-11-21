//! One Postgres cluster shared across test processes: nextest runs each test in its own process, so a cluster per process
//! would cost an `initdb` and a postmaster per test.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::memory::pg::cluster::{PgCluster, PgRuntime, Start};
use crate::memory::pg::db::Db;

/// How long the cluster stays after the last lease is gone (the next test of a run is usually there within it).
const IDLE: Duration = Duration::from_secs(20);
/// How long a start waits for the supervisor's `ready`.
const READY_WAIT: Duration = Duration::from_secs(240);
/// The template database every test database is made from.
const TEMPLATE: &str = "mixdog_template";
/// Connections the shared postmaster accepts: parallel tests hold five per pool, several pools each.
const MAX_CONNECTIONS: u32 = 1000;
const SUPERVISE_ENV: &str = "MIXDOG_TEST_PG_SUPERVISE";

pub(super) struct Shared {
    pub port: u16,
    pub profile: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Ready {
    port: u16,
    profile: PathBuf,
}

fn check_profile(base: &Path, profile: &Path) {
    assert_eq!(profile.parent(), Some(base), "a supervisor's profile is a direct scratch child");
    assert!(profile.file_name().unwrap_or_default().to_string_lossy().starts_with("cluster-"), "a generated test profile");
    assert!(!std::fs::symlink_metadata(profile).expect("test profile").file_type().is_symlink(), "test profile must not be a link");
    assert_eq!(profile.canonicalize().expect("test profile").parent(), Some(base.canonicalize().expect("scratch directory").as_path()));
}

fn open_lock_file(path: &Path) -> File {
    OpenOptions::new().create(true).read(true).write(true).truncate(false).open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The only recursively cleaned cluster directory is one freshly created by this
/// supervisor. On abnormal process termination its owner.json remains for diagnosis;
/// future supervisors never follow its PID file or reuse/delete its directory.
struct OwnedProfile {
    directory: Option<tempfile::TempDir>,
    runtime: PathBuf,
    base: PathBuf,
}

/// The lease of this process: held until it exits.
static LEASE: OnceLock<(PathBuf, File)> = OnceLock::new();

#[cfg(windows)]
fn job_forbids_breakaway() -> bool {
    use windows_sys::Win32::System::JobObjects::{
        IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, QueryInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // nextest 0.9.151 / nextest-runner 0.129.0 create_job() sets BREAKAWAY_OK.
    // Other runners can forbid it. Only a positively identified job restriction
    // selects the old owned-cluster path; query/spawn/auth/database failures remain errors.
    unsafe {
        let mut in_job = 0;
        assert_ne!(IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job), 0, "query current job: {}", std::io::Error::last_os_error());
        if in_job == 0 {
            return false;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        assert_ne!(
            QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
                std::ptr::null_mut()
            ),
            0,
            "query job limits: {}",
            std::io::Error::last_os_error()
        );
        limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) == 0
    }
}

/// This process's standard handles with their inheritance off, restored when dropped.
#[cfg(windows)]
struct NotInherited(Vec<(windows_sys::Win32::Foundation::HANDLE, u32)>);

#[cfg(windows)]
impl NotInherited {
    fn std_handles() -> Self {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT, SetHandleInformation};
        let raw = [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()];
        let mut saved = Vec::new();
        for handle in raw {
            let handle = handle as windows_sys::Win32::Foundation::HANDLE;
            let mut flags = 0u32;
            // SAFETY: plain Win32 calls on this process's own standard handles; a null or invalid handle makes the call fail and is skipped.
            unsafe {
                if !handle.is_null()
                    && GetHandleInformation(handle, &mut flags) != 0
                    && flags & HANDLE_FLAG_INHERIT != 0
                    && SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) != 0
                {
                    saved.push((handle, flags & HANDLE_FLAG_INHERIT));
                }
            }
        }
        Self(saved)
    }
}

#[cfg(windows)]
impl Drop for NotInherited {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        for (handle, flags) in &self.0 {
            // SAFETY: as in `std_handles`.
            unsafe { SetHandleInformation(*handle, HANDLE_FLAG_INHERIT, *flags) };
        }
    }
}

fn assert_database_name(name: &str) {
    assert!(
        name.starts_with('t') && name.len() <= 63 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
        "generated test database identifier"
    );
}

/// Whether some live process holds a lease; the leases of dead processes (their lock is free) are removed.
fn leases_held(leases: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(leases) else {
        return true;
    };
    let mut held = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file) = OpenOptions::new().read(true).write(true).open(&path) else {
            held = true;
            continue;
        };
        match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                drop(file);
                let _ = std::fs::remove_file(&path);
            }
            Err(_) => held = true,
        }
    }
    held
}

#[test]
fn publication_is_excluded_from_scans_until_the_lease_is_locked() {
    let scratch = tempfile::tempdir().expect("scratch");
    let leases = scratch.path().join("leases");
    std::fs::create_dir(&leases).unwrap();
    let gate = open_lock_file(&scratch.path().join("start.lock"));
    gate.lock().unwrap();
    let path = leases.join(format!("{}.lease", uuid::Uuid::new_v4().simple()));
    let lease = OpenOptions::new().create_new(true).read(true).write(true).open(&path).unwrap();
    let scanner = open_lock_file(&scratch.path().join("start.lock"));
    assert!(matches!(scanner.try_lock(), Err(TryLockError::WouldBlock)), "no scan in the creation/locking gap");
    lease.lock().unwrap();
    drop(gate);
    scanner.lock().unwrap();
    assert!(leases_held(&leases));
    assert!(path.exists());
    drop(lease);
    assert!(!leases_held(&leases));
    assert!(!path.exists());
}

#[test]
fn releasing_one_lease_does_not_remove_another_generation() {
    let scratch = tempfile::tempdir().unwrap();
    let gate = open_lock_file(&scratch.path().join("start.lock"));
    gate.lock().unwrap();
    let leases = scratch.path().join("leases");
    std::fs::create_dir(&leases).unwrap();
    let make = || {
        let path = leases.join(format!("{}.lease", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new().create_new(true).read(true).write(true).open(&path).unwrap();
        file.lock().unwrap();
        (path, file)
    };
    let (first, a) = make();
    let (second, b) = make();
    assert_ne!(first, second);
    drop(a);
    assert!(leases_held(&leases));
    assert!(!first.exists());
    assert!(second.exists());
    drop(b);
    assert!(!leases_held(&leases));
}

fn check_base(base: &Path, runtime: &Path) {
    assert_eq!(base, base_dir(runtime), "the supervisor only owns this test binary's scratch directory");
    assert!(!std::fs::symlink_metadata(base).expect("scratch directory").file_type().is_symlink(), "scratch directory must not be a link");
    let parent = std::env::temp_dir().canonicalize().expect("temporary directory");
    assert_eq!(base.canonicalize().expect("scratch directory").parent(), Some(parent.as_path()), "scratch stays directly inside the temporary directory");
}
fn base_dir(runtime: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    // The template is made by this build's code: another build of the binary (other schema text) is another cluster.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    runtime.hash(&mut hasher);
    if let Ok(exe) = std::env::current_exe() {
        exe.hash(&mut hasher);
        if let Ok(meta) = std::fs::metadata(&exe) {
            meta.len().hash(&mut hasher);
            if let Ok(modified) = meta.modified() {
                modified.hash(&mut hasher);
            }
        }
    }
    std::env::temp_dir().join(format!("mixdog-test-pg-{:016x}", hasher.finish()))
}
pub(super) fn owned_fallback_lock(runtime: &Path) -> File {
    let base = base_dir(runtime);
    std::fs::create_dir_all(&base).expect("fallback scratch directory");
    check_base(&base, runtime);
    let lock = open_lock_file(&base.join("owned-fallback.lock"));
    lock.lock().expect("serial owned-cluster fallback");
    lock
}
impl OwnedProfile {
    fn new(base: &Path, runtime: &Path) -> Self {
        let directory = tempfile::Builder::new().prefix("cluster-").tempdir_in(base).expect("a unique profile");
        check_profile(base, directory.path());
        std::fs::write(
            directory.path().join("owner.json"),
            serde_json::to_vec(&serde_json::json!({
                "supervisorPid": std::process::id(), "generation": uuid::Uuid::new_v4().to_string(),
                "profile": directory.path(), "runtime": runtime, "testBinary": std::env::current_exe().expect("binary")
            }))
            .expect("owner JSON"),
        )
        .expect("owner record");
        Self { directory: Some(directory), runtime: runtime.to_owned(), base: base.to_owned() }
    }
}
impl Drop for OwnedProfile {
    fn drop(&mut self) {
        let Some(directory) = self.directory.take() else {
            return;
        };
        if !directory.path().exists() {
            return;
        }
        check_profile(&self.base, directory.path());
        if !stop_postmaster_of(&self.runtime, &directory.path().join("pgdata")) {
            let kept = directory.keep();
            eprintln!("shared test Postgres: bounded stop failed; retained owned generation {} with owner.json", kept.display());
        }
        // Otherwise TempDir removes this exact generated directory after the bounded stop.
    }
}
/// The shared cluster, started when no live supervisor serves one. Blocks (the first start takes seconds).
pub(super) fn acquire(runtime: &Path) -> Option<Shared> {
    #[cfg(windows)]
    if job_forbids_breakaway() {
        eprintln!("shared test Postgres: current Windows job forbids breakaway; using a test-owned cluster (same assertions)");
        return None;
    }
    let base = base_dir(runtime);
    let leases = base.join("leases");
    std::fs::create_dir_all(&base).expect("the shared cluster's directory");
    check_base(&base, runtime);
    let start_lock = open_lock_file(&base.join("start.lock"));
    start_lock.lock().expect("start.lock");
    std::fs::create_dir_all(&leases).expect("lease directory");
    assert!(!std::fs::symlink_metadata(&leases).expect("leases").file_type().is_symlink());
    // Both publication and every scan/removal hold start.lock. A scanner can never
    // observe the gap between file creation and locking. UUIDs prevent PID reuse/ABA.
    let (lease_base, _) = LEASE.get_or_init(|| {
        let path = leases.join(format!("{}.lease", uuid::Uuid::new_v4().simple()));
        let lease = OpenOptions::new().create_new(true).read(true).write(true).open(path).expect("a unique lease");
        lease.lock().expect("the lease");
        (base.clone(), lease)
    });
    assert_eq!(lease_base, &base, "one test process uses one runtime/binary generation");
    let supervisor_free = || {
        let probe = open_lock_file(&base.join("supervisor.lock"));
        match probe.try_lock() {
            Ok(()) => true,
            Err(TryLockError::WouldBlock) => false,
            Err(TryLockError::Error(e)) => panic!("supervisor.lock: {e}"),
        }
    };
    let mut spawned: Option<std::process::Child> = None;
    if supervisor_free() {
        let _ = std::fs::remove_file(base.join("ready"));
        spawned = Some(spawn_supervisor(runtime, &base));
    }
    let started = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(base.join("ready"))
            && let Ok(ready) = serde_json::from_str::<Ready>(&text)
        {
            assert!(!supervisor_free(), "ready belongs to a live supervisor holding supervisor.lock");
            check_profile(&base, &ready.profile);
            assert!(ready.port != 0);
            return Some(Shared { port: ready.port, profile: ready.profile });
        }
        if let Some(child) = spawned.as_mut()
            && let Ok(Some(status)) = child.try_wait()
        {
            let log = std::fs::read_to_string(base.join("supervisor.log")).unwrap_or_default();
            panic!("the shared test cluster's supervisor ended before it was ready ({status}):\n{log}");
        }
        if started.elapsed() > READY_WAIT {
            if let Some(child) = spawned.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let log = std::fs::read_to_string(base.join("supervisor.log")).unwrap_or_default();
            panic!("the shared test cluster was not ready within {READY_WAIT:?}:\n{log}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
#[allow(clippy::disallowed_methods, reason = "test support: the detached supervisor of the shared cluster")]
fn spawn_supervisor(runtime: &Path, base: &Path) -> std::process::Child {
    let log = File::create(base.join("supervisor.log")).expect("the supervisor's log");
    let mut command = Command::new(std::env::current_exe().expect("the test binary"));
    command
        .args(["--exact", "memory::tests::shared_pg::supervisor_entry", "--include-ignored", "--nocapture", "--test-threads=1"])
        .env(SUPERVISE_ENV, base)
        .env("MIXDOG_PG_RUNTIME", runtime)
        .stdin(Stdio::null())
        .stdout(log.try_clone().expect("the log"))
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, and out of the job of the test that starts it when the job allows.
        const FLAGS: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;
        // The supervisor outlives the test: it must not hold the pipes the test runner reads the test's output from (a held pipe
        // is a leaked test), so this process's standard handles are not inherited while it starts.
        let _closed = NotInherited::std_handles();
        command.creation_flags(FLAGS | 0x0100_0000);
        return command.spawn().expect("shared PG supervisor requires job breakaway; never fall back to the initiating test's kill-on-close job");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(windows))]
    command.spawn().expect("the supervisor starts")
}
/// A database of the shared cluster for one test, dropped by [`drop_database`].
pub(super) async fn create_database(port: u16, name: &str) {
    assert_database_name(name);
    tokio::time::timeout(Duration::from_secs(30), create_database_inner(port, name)).await.expect("test database creation completes within 30 seconds");
}
async fn create_database_inner(port: u16, name: &str) {
    let (client, connection) = tokio_postgres::connect(&format!("host=127.0.0.1 port={port} user=postgres dbname=postgres"), tokio_postgres::NoTls)
        .await
        .expect("the shared cluster answers");
    let driver = tokio::spawn(connection);
    // The template is copied only while nothing is connected to it (the supervisor's setup connection closes a moment after it
    // reported done), and copies made at the same moment may refuse each other: tried again.
    let mut tries = 0;
    loop {
        match client.batch_execute(&format!("CREATE DATABASE {name} TEMPLATE {TEMPLATE}")).await {
            Ok(()) => break,
            Err(error) if tries < 400 && error.code() == Some(&tokio_postgres::error::SqlState::OBJECT_IN_USE) => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => panic!("CREATE DATABASE {name}: {error}"),
        }
    }
    drop(client);
    let _ = driver.await;
}
pub(super) fn drop_database(port: u16, name: String) {
    assert_database_name(&name);
    // From a thread of its own: a test's runtime may be ending.
    let work = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
        runtime.block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(15), async {
                let Ok((client, connection)) =
                    tokio_postgres::connect(&format!("host=127.0.0.1 port={port} user=postgres dbname=postgres"), tokio_postgres::NoTls).await
                else {
                    return;
                };
                let driver = tokio::spawn(connection);
                let _ = client.batch_execute(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).await;
                drop(client);
                let _ = driver.await;
            })
            .await;
        });
    });
    let _ = work.join();
}
/// The supervisor, in the process `spawn_supervisor` starts. Not a test: with `MIXDOG_TEST_PG_SUPERVISE` unset it does nothing.
#[test]
#[ignore = "the supervisor process of the shared test cluster (run by the tests that use it; does nothing when run on its own)"]
fn supervisor_entry() {
    let Some(base) = std::env::var_os(SUPERVISE_ENV).map(PathBuf::from) else {
        return;
    };
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_PG_RUNTIME").expect("MIXDOG_PG_RUNTIME"));
    let tokio = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    tokio.block_on(supervise(&base, &runtime));
}
async fn ensure(runtime: &Path, profile: &Path, lane: mixdog_rt::DurabilityIo) -> crate::memory::error::Result<PgCluster> {
    PgCluster::ensure(
        PgRuntime::new(runtime),
        profile,
        super::support::preferred_port(),
        lane,
        crate::tidy::process::Processes::for_tests(),
        &CancellationToken::new(),
        &Start::node(),
        &|| true,
    )
    .await
}
async fn supervise(base: &Path, runtime: &Path) {
    check_base(base, runtime);
    let supervisor_lock = open_lock_file(&base.join("supervisor.lock"));
    if supervisor_lock.try_lock().is_err() {
        return;
    }
    // Never stop or recursively remove an old generation based on a stale PID file.
    // A new supervisor owns only the directory it just created. Windows postmasters
    // are in the supervisor's existing PgCluster kill-on-close containment.
    let profile_owner = OwnedProfile::new(base, runtime);
    let profile = profile_owner.directory.as_ref().expect("owned profile").path().to_owned();
    check_profile(base, &profile);
    let _ = std::fs::remove_file(base.join("ready"));
    let cluster = tokio::time::timeout(Duration::from_secs(180), initialize(runtime, &profile))
        .await
        .expect("shared cluster initialization completes within 180 seconds");
    let port = cluster.port();
    let ready = base.join("ready.tmp");
    std::fs::write(&ready, serde_json::to_vec(&Ready { port, profile: profile.clone() }).expect("ready JSON")).expect("ready");
    std::fs::rename(&ready, base.join("ready")).expect("ready renamed");
    let leases = base.join("leases");
    let mut last_held = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        // This same lock protects lease creation and all scans, not just the final scan.
        let start_lock = open_lock_file(&base.join("start.lock"));
        if start_lock.try_lock().is_err() {
            last_held = Instant::now();
            continue;
        }
        if leases_held(&leases) {
            last_held = Instant::now();
            continue;
        }
        if last_held.elapsed() < IDLE {
            continue;
        }
        let _ = std::fs::remove_file(base.join("ready"));
        check_profile(base, &profile);
        let _ = cluster.stop(Duration::from_secs(30)).await;
        // Stop and remove only this generation, while acquisitions remain excluded.
        drop(profile_owner);
        let _ = supervisor_lock.unlock();
        let _ = start_lock.unlock();
        println!("the shared test cluster stopped after {IDLE:?} without a lease");
        let _ = std::io::stdout().flush();
        return;
    }
}
async fn initialize(runtime: &Path, profile: &Path) -> PgCluster {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let first = ensure(runtime, profile, lane).await.expect("the shared cluster starts");
    // A cluster made here accepts 32 connections: parallel tests need more, which the postmaster reads at its start.
    first.stop(Duration::from_secs(30)).await.expect("the first start stops");
    let conf = first.data_dir().join("postgresql.conf");
    let mut text = std::fs::read_to_string(&conf).expect("postgresql.conf");
    text.push_str(&format!("\nmax_connections = {MAX_CONNECTIONS}\n"));
    std::fs::write(&conf, text).expect("postgresql.conf written");
    let cluster = ensure(runtime, profile, lane).await.expect("the shared cluster starts again");
    let port = cluster.port();
    {
        let (client, connection) = tokio_postgres::connect(&format!("host=127.0.0.1 port={port} user=postgres dbname=postgres"), tokio_postgres::NoTls)
            .await
            .expect("the cluster answers");
        let driver = tokio::spawn(connection);
        client.batch_execute(&format!("CREATE DATABASE {TEMPLATE}")).await.expect("the template database");
        drop(client);
        let _ = driver.await;
    }
    Db::bootstrap_database(port, TEMPLATE).await.expect("the template's schemas");
    cluster
}
/// `pg_ctl stop -m immediate` on a data directory (only the postmaster of that directory), when it holds a cluster.
#[allow(clippy::disallowed_methods, reason = "test support: ends only this supervisor's newly created cluster")]
fn stop_postmaster_of(runtime: &Path, data_dir: &Path) -> bool {
    if !data_dir.join("postmaster.pid").exists() {
        return true;
    }
    let bin = runtime.join("bin");
    let mut stop = Command::new(bin.join(if cfg!(windows) { "pg_ctl.exe" } else { "pg_ctl" }));
    stop.args(["stop", "-m", "immediate", "-w", "-t", "30", "-D"]).arg(data_dir).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        stop.creation_flags(0x0800_0000);
        stop.env("PATH", format!("{};{}", bin.display(), std::env::var("PATH").unwrap_or_default()));
    }
    if let Ok(mut child) = stop.spawn() {
        let start = Instant::now();
        loop {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            if start.elapsed() >= Duration::from_secs(35) {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    !data_dir.join("postmaster.pid").exists()
}
