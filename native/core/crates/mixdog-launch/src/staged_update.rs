//! The staged update of the `mixdog` binary: `staged-update.mjs` on a native release archive instead of an npm package.
//!
//! Two phases that never touch the executable a live session runs:
//!   1. STAGE ([`run_staged_install`], in the background worker [`spawn_staged_install`] starts): the platform archive named by
//!      the release feed is downloaded (through the proxy the CLI adopts for itself), checked against the feed's size and
//!      SHA-256, unpacked, its binary asked for its version, and only then the completion marker
//!      `<data>/staging/<version>/.staged-complete.json` is written, under `.staging.lock` (`<pid> <ms>`, taken over from a dead
//!      owner or after ten minutes).
//!   2. SWAP ([`perform_pending_swap`], at the next clean start): when a completed staged version is newer than the running one
//!      and no other live session runs (`<data>/live-sessions/<pid>.pid`), the running executable is renamed aside and the staged
//!      binary put in its place; the entry then starts the executable again ([`reexec_swapped`]) and returns its exit code.
//!
//! Everything is best effort and silent: no failure may block a start or a shutdown; the swap retries at the next start. The one
//! exception is the invariant the Node swap had: a swap that can neither complete nor be rolled back never goes on to run with
//! the executable missing ([`SwapOutcome::Stranded`], reported by [`perform_pending_swap`] on stderr with exit code 1).
//!
//! `MIXDOG_DISABLE_STAGED_INSTALL` stops [`spawn_staged_install`], `MIXDOG_DISABLE_STAGED_SWAP` stops the swap, and
//! `MIXDOG_SWAP_REEXEC` marks the run a swap started, which never swaps again. The npm install is not ported: no Node is needed.

mod layout;
mod lock;
mod stage;
mod swap;

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub use layout::is_staged_complete;
pub use stage::StageOutcome;
pub use stage::probe_binary_version;
pub use stage::run_staged_install;
pub use swap::SwapOutcome;
pub use swap::perform_pending_swap_in;

/// The argument the background worker is started with: `<exe> --staged-install-worker <version>` stages that version and exits
/// (`staged-install-worker.mjs`). The entry dispatches it to [`run_staged_install_worker`] before anything else starts.
pub const STAGED_INSTALL_ARG: &str = "--staged-install-worker";

/// The release feed: a manifest of the latest release, `{ "version", "assets": { "<os>-<arch>": { "url", "sha256", "size" } } }`
/// with a zip holding the `mixdog` binary at its root per platform (the same shape as the spawn and graph release manifests).
pub const FEED_URL: &str = "https://github.com/tribgames/mixdog/releases/latest/download/mixdog-cli-manifest.json";

/// `process.env.MIXDOG_SWAP_REEXEC`: set on the run a swap started.
pub const SWAP_REEXEC_VAR: &str = "MIXDOG_SWAP_REEXEC";
const DISABLE_INSTALL_VAR: &str = "MIXDOG_DISABLE_STAGED_INSTALL";
const DISABLE_SWAP_VAR: &str = "MIXDOG_DISABLE_STAGED_SWAP";

/// What the staging and the swap need of the machine; [`Context::process`] is this process. A test sets the fields.
#[derive(Clone)]
pub struct Context {
    /// `resolvePluginData()`: the folder `staging` and `live-sessions` are in.
    pub data_dir: PathBuf,
    /// The executable a swap replaces: where this process started from.
    pub exe: PathBuf,
    /// The version this executable is.
    pub version: String,
    /// The manifest of the latest release.
    pub feed_url: String,
    /// `<os>-<arch>` as the manifest names it (`win32-x64`, `darwin-arm64`, `linux-x64`).
    pub platform: String,
    /// Whether a process may still run (`isPidAlive`).
    pub process_runs: fn(u32) -> bool,
    /// The version a binary says it is (`<binary> --version`), `None` when it says none.
    pub probe_version: fn(&Path) -> Option<String>,
    /// `MIXDOG_DISABLE_STAGED_INSTALL` is set.
    pub disable_install: bool,
    /// `MIXDOG_DISABLE_STAGED_SWAP` is set.
    pub disable_swap: bool,
    /// `MIXDOG_SWAP_REEXEC` is set.
    pub swap_reexec: bool,
    /// `isDevInstall()`: a build in a source checkout is never replaced.
    pub dev: bool,
}

impl Context {
    /// This process: the data folder, the running executable and version, the environment's switches. `None` when there is no data
    /// folder or the executable cannot be named: nothing is then staged or swapped.
    pub fn process() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let flag = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty());
        Some(Self {
            data_dir: crate::crash_capture::paths::data_dir()?,
            dev: layout::is_dev_build(&exe),
            exe,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            feed_url: FEED_URL.to_owned(),
            platform: platform_key(),
            process_runs: crate::crash_capture::process_runs,
            probe_version: stage::probe_binary_version,
            disable_install: flag(DISABLE_INSTALL_VAR),
            disable_swap: flag(DISABLE_SWAP_VAR),
            swap_reexec: flag(SWAP_REEXEC_VAR),
        })
    }

    fn live_dir(&self) -> PathBuf {
        self.data_dir.join("live-sessions")
    }

    fn pid_file(&self) -> PathBuf {
        self.live_dir().join(format!("{}.pid", std::process::id()))
    }

    /// `registerLiveSession` over this context.
    pub fn register_live_session(&self, id: &str) -> LiveSession {
        let dir = self.live_dir();
        let mut registry = LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner);
        registry.entry(dir.clone()).or_default().insert(id.to_owned());
        // Advisory: a refcount that cannot be written only means no one sees this session.
        let written = std::fs::create_dir_all(&dir)
            .and_then(|()| std::fs::write(self.pid_file(), format!("{} {}\n", std::process::id(), now_ms())));
        drop(written);
        LiveSession { pid_file: Some(self.pid_file()), dir, id: id.to_owned() }
    }

    /// `otherLiveSessionExists`: another running process has a pid file. A pid file of a process that is gone is removed on the way.
    fn other_live_session_exists(&self) -> bool {
        let Ok(entries) = std::fs::read_dir(self.live_dir()) else { return false };
        let mut alive = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".pid") else { continue };
            let pid = layout::parse_int_prefix(stem);
            if pid == 0 || pid == std::process::id() {
                continue;
            }
            if (self.process_runs)(pid) {
                alive = true;
            } else {
                // Reaped so a crashed session never wedges updates for good.
                drop(std::fs::remove_file(entry.path()));
            }
        }
        alive
    }
}

/// The live sessions of this process, per live-sessions folder.
static LIVE_SESSIONS: Mutex<BTreeMap<PathBuf, BTreeSet<String>>> = Mutex::new(BTreeMap::new());

/// A live session of this process (`registerLiveSession`): a swap never replaces the executable under one that runs. The pid file
/// stays while any session of this process is registered and is removed when the last one is dropped (`unregisterLiveSession`).
pub struct LiveSession {
    pid_file: Option<PathBuf>,
    dir: PathBuf,
    id: String,
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        let mut registry = LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(ids) = registry.get_mut(&self.dir) else { return };
        ids.remove(&self.id);
        if ids.is_empty() {
            registry.remove(&self.dir);
            if let Some(file) = self.pid_file.take() {
                drop(std::fs::remove_file(file));
            }
        }
    }
}

/// `registerLiveSession()` for this process. Without a data folder nothing is written and the session is only counted.
pub fn register_live_session(id: &str) -> LiveSession {
    match Context::process() {
        Some(context) => context.register_live_session(id),
        None => {
            LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).entry(PathBuf::new()).or_default().insert(id.to_owned());
            LiveSession { pid_file: None, dir: PathBuf::new(), id: id.to_owned() }
        }
    }
}

/// How many sessions of this process are registered.
pub fn live_sessions() -> usize {
    LIVE_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner).values().map(BTreeSet::len).sum()
}

/// `<os>-<arch>` as the release manifests name a platform.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis())
}

/// `performPendingSwap()`: at a clean start, a completed staged version that is newer replaces the running executable. Silent; any
/// obstacle is [`SwapOutcome::NothingStaged`] or [`SwapOutcome::Deferred`] and the running version goes on. A swap that left no
/// executable and could not restore one is reported on stderr and ends the process with 1, as the Node swap did.
pub fn perform_pending_swap() -> SwapOutcome {
    let Some(context) = Context::process() else { return SwapOutcome::NothingStaged };
    let outcome = swap::perform_pending_swap_in(&context);
    if let SwapOutcome::Stranded(backup) = &outcome {
        eprintln!("mixdog: update swap failed and could not be rolled back - backup preserved at {}", backup.display());
        std::process::exit(1);
    }
    outcome
}

/// `spawnStagedInstall(version)`: starts a detached, windowless worker that stages `version` and outlives this process. Nothing
/// is started when `MIXDOG_DISABLE_STAGED_INSTALL` is set or the version is already staged. Never fails: `false` when nothing started.
pub fn spawn_staged_install(version: &str) -> bool {
    Context::process().is_some_and(|context| spawn_worker(&context, version))
}

/// [`spawn_staged_install`] over a context.
pub fn spawn_worker(context: &Context, version: &str) -> bool {
    let version = version.trim();
    if version.is_empty() || context.disable_install || is_staged_complete(context, version) {
        return false;
    }
    let mut command = Command::new(&context.exe);
    command.arg(STAGED_INSTALL_ARG).arg(version).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: no console, no window, not stopped with this one.
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    #[cfg(unix)]
    // Its own process group: a hang-up sent to this terminal's group does not reach it.
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn().is_ok()
}

/// `staged-install-worker.mjs`: the exit code of the worker that stages `version` (0 when staged, already staged or being staged
/// by another worker; 1 otherwise).
pub fn run_staged_install_worker(version: &str) -> i32 {
    let Some(context) = Context::process() else { return 1 };
    match run_staged_install(&context, version) {
        StageOutcome::Failed(_) => 1,
        StageOutcome::Staged { .. } | StageOutcome::AlreadyStaged { .. } | StageOutcome::InProgress => 0,
    }
}

/// The re-execution after a swap (`cli.mjs`): the executable `exe` (where the swap put the new one) started again with `args`, the
/// terminal inherited and `MIXDOG_SWAP_REEXEC=1` set so it never swaps again; the exit code it ends with. `None` when it could not
/// be started: the caller then goes on in place.
pub fn reexec_swapped(exe: &Path, args: &[OsString]) -> Option<i32> {
    // No creation flag: the child shares this terminal (its console on Windows), as Node's `spawnSync` with inherited stdio did.
    let status = Command::new(exe).args(args).env(SWAP_REEXEC_VAR, "1").status().ok()?;
    Some(exit_code_of(status))
}

/// `stagedChildExitCode`: the code, or `128 + signal` for a child a signal ended, or 1.
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return 128 + signal;
    }
    status.code().unwrap_or(1)
}
