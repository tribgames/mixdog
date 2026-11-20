//! The terminal guard: what keeps the terminal and the process in a sane state however the session ends.
//!
//! * [`TerminalGuard`] / [`TerminalRestorer`]: the terminal restore (drain the queued input, write
//!   [`crate::modes::restore_sequence`]) that happens once, whoever asks first.
//! * [`StderrGuard`]: stderr goes to `mixdog-tui.stderr.log` while the full-screen UI owns the terminal.
//! * [`SignalCleanup`]: SIGINT, SIGTERM and SIGHUP (Windows: Ctrl+C, Ctrl+Break and the console close event) run the
//!   terminal restore, the cleanup with a deadline and the exit with code 128+n; a dead stdio does the same with code 1
//!   (`stdio-dead`); a second request while the cleanup runs forces the exit.
//! * [`install_panic_hook`]: a panic that ends the program restores the terminal before the message is printed.
//! * [`schedule_hard_exit`]: the timer that writes the reset again and ends the process when the normal exit hangs.
//!
//! The behaviour is that of `installTuiStderrGuard`, `registerStdioDeathGuards`, `scheduleHardExit` and `restoreTerminal`
//! in `src/tui/index.jsx` and of `installProcessSignalCleanup` in `src/runtime/shared/process-shutdown.mjs`.

use std::any::Any;
use std::io::{self, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use mixdog_fsio::{File, OpenOptions, Unlaned};

use crate::console::RawConsole;
use crate::modes::{TerminalModes, hard_exit_sequence, is_off_word, restore_sequence};
use crate::reader::drain_stdin;

/// `MIXDOG_TUI_EXIT_WAIT_MS` default: how long the cleanup may take.
pub const EXIT_WAIT_TIMEOUT_MS: u64 = 2500;
/// `MIXDOG_TUI_HARD_EXIT_DELAY_MS` default.
pub const HARD_EXIT_DELAY_MS: u64 = 500;
/// The size a log may grow to before it is cut (`PLUGIN_LOG_MAX_BYTES`).
pub const PLUGIN_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// The tail kept when a log is cut (`PLUGIN_LOG_KEEP_BYTES`).
pub const PLUGIN_LOG_KEEP_BYTES: u64 = 2 * 1024 * 1024;
/// The file name of the TUI's stderr log.
pub const STDERR_LOG_NAME: &str = "mixdog-tui.stderr.log";

/// The exit codes of `signalExitCode`: 128 plus the signal number.
pub fn signal_exit_code(signal: &str) -> i32 {
    match signal {
        "SIGINT" => 130,
        "SIGTERM" => 143,
        "SIGHUP" => 129,
        "SIGBREAK" => 149,
        _ => 1,
    }
}

/// `positiveIntEnv`: `Number(value)` floored when it is finite and above zero, else `fallback` (an unset variable is
/// `Number(undefined)`, NaN).
pub fn positive_int(value: Option<String>, fallback: u64) -> u64 {
    let number = value.as_deref().map_or(f64::NAN, mixdog_js::string_to_number);
    if number.is_finite() && number > 0.0 { number.floor() as u64 } else { fallback }
}

/// The exit timings the environment sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitSettings {
    /// `MIXDOG_TUI_EXIT_WAIT_MS` (default 2500 ms): how long disposing the session may take.
    pub wait_timeout: Duration,
    /// `MIXDOG_TUI_HARD_EXIT_DELAY_MS` (default 500 ms).
    pub hard_exit_delay: Duration,
    /// `MIXDOG_TUI_HARD_EXIT`: on unless `0`, `false`, `no` or `off`.
    pub hard_exit_enabled: bool,
}

/// Runs `work` on a thread of its own and waits at most `limit` for it; true when it finished in time.
fn run_bounded(name: &str, limit: Duration, work: impl FnOnce() + Send + 'static) -> bool {
    let (done_tx, done_rx) = mpsc::channel();
    let spawned = thread::Builder::new().name(name.to_string()).spawn(move || {
        // A panic inside the work is its own failure; the wait below is what the caller needs.
        let _ = panic::catch_unwind(AssertUnwindSafe(work));
        let _ = done_tx.send(());
    });
    spawned.is_ok() && done_rx.recv_timeout(limit).is_ok()
}

fn panic_text(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "panic".to_string()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The terminal restore.

/// Where terminal control bytes go.
pub type Sink = Arc<dyn Fn(&[u8]) -> io::Result<()> + Send + Sync>;

fn stdout_sink() -> Sink {
    Arc::new(|bytes| {
        let mut out = io::stdout().lock();
        out.write_all(bytes)?;
        out.flush()
    })
}

/// The restore of the terminal, shareable with signal handlers, timers and the panic hook. Every clone shares one latch:
/// the restore runs once.
#[derive(Clone)]
pub struct TerminalRestorer {
    modes: Arc<TerminalModes>,
    sink: Sink,
}

impl TerminalRestorer {
    /// A restorer writing to stdout.
    pub fn new(modes: Arc<TerminalModes>) -> TerminalRestorer {
        TerminalRestorer { modes, sink: stdout_sink() }
    }

    /// A restorer writing to `sink`.
    pub fn with_sink(modes: Arc<TerminalModes>, sink: Sink) -> TerminalRestorer {
        TerminalRestorer { modes, sink }
    }

    pub fn modes(&self) -> &Arc<TerminalModes> {
        &self.modes
    }

    /// Writes control bytes to the terminal. A fatal error here ([`is_stdio_fatal`]) means the terminal is gone: hand it
    /// to [`SignalCleanup::stdio_dead`].
    pub fn write(&self, text: &str) -> io::Result<()> {
        (self.sink)(text.as_bytes())
    }

    /// Restores the terminal: the queued input is drained, then [`restore_sequence`] is written. Idempotent; a write
    /// error is ignored (the terminal may be closing).
    pub fn restore(&self) {
        if !self.modes.take_restore() {
            return;
        }
        drain_stdin();
        let _ = (self.sink)(restore_sequence().as_bytes());
    }

    /// The restore as a hook for [`CleanupConfig`].
    pub fn hook(&self) -> Hook {
        let restorer = self.clone();
        Arc::new(move |_reason| restorer.restore())
    }
}

/// Raw mode and the terminal restore of a session; dropping it restores the terminal (the end of `process.on('exit')`).
pub struct TerminalGuard {
    restorer: TerminalRestorer,
    _raw: Option<RawConsole>,
}

impl TerminalGuard {
    /// A guard over `raw` (when raw mode is on) writing to stdout.
    pub fn new(modes: Arc<TerminalModes>, raw: Option<RawConsole>) -> TerminalGuard {
        TerminalGuard { restorer: TerminalRestorer::new(modes), _raw: raw }
    }

    pub fn restorer(&self) -> TerminalRestorer {
        self.restorer.clone()
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restorer.restore();
    }
}

/// Makes a panic of the main thread (which ends the program) restore the terminal before the panic message is printed.
/// A panic on another thread is left to the code that catches it: the screen stays as it is.
pub fn install_panic_hook(restorer: TerminalRestorer) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if thread::current().name() == Some("main") {
            restorer.restore();
        }
        previous(info);
    }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The hard exit.

/// Starts the timer that, [`ExitSettings::hard_exit_delay`] later, writes the terminal reset again and ends the process
/// with `code` (the normal exit may hang on something that will not stop). Nothing happens when
/// `MIXDOG_TUI_HARD_EXIT` turned it off. The thread does not keep the process alive.
pub fn schedule_hard_exit(settings: &ExitSettings, code: i32) {
    if !settings.hard_exit_enabled {
        return;
    }
    let delay = settings.hard_exit_delay;
    let spawned = thread::Builder::new().name("mixdog-term-hard-exit".into()).spawn(move || {
        // park_timeout may return early (a spurious wake-up): wait out the whole delay.
        let deadline = Instant::now() + delay;
        while let Some(left) = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) {
            thread::park_timeout(left);
        }
        let sink = stdout_sink();
        // A stdout that does not take the bytes must not keep the process from ending.
        run_bounded("mixdog-term-hard-exit-write", Duration::from_millis(200), move || {
            let _ = sink(hard_exit_sequence().as_bytes());
        });
        std::process::exit(code);
    });
    drop(spawned);
}

// ---------------------------------------------------------------------------------------------------------------------
// The stderr guard.

/// The log `installTuiStderrGuard` writes: `MIXDOG_TUI_STDERR_LOG`, else `mixdog-tui.stderr.log` in
/// `MIXDOG_RUNTIME_ROOT`, else in `<temp>/mixdog` (an empty variable counts as unset).
pub fn stderr_log_path(var: &impl Fn(&str) -> Option<String>, temp_dir: &Path) -> PathBuf {
    let non_empty = |name: &str| var(name).filter(|value| !value.is_empty());
    if let Some(path) = non_empty("MIXDOG_TUI_STDERR_LOG") {
        return PathBuf::from(path);
    }
    let root = non_empty("MIXDOG_RUNTIME_ROOT").map_or_else(|| temp_dir.join("mixdog"), PathBuf::from);
    root.join(STDERR_LOG_NAME)
}

/// `rotateBoundedLog`: a file above `max_bytes` is cut to its last `keep_bytes`; a missing or unreadable file is left.
pub fn rotate_bounded_log(path: &Path, max_bytes: u64, keep_bytes: u64) {
    let Ok(metadata) = mixdog_fsio::metadata(&Unlaned, path) else {
        return;
    };
    if metadata.len() <= max_bytes {
        return;
    }
    let Ok(content) = mixdog_fsio::read(&Unlaned, path) else {
        return;
    };
    let keep = usize::try_from(keep_bytes).unwrap_or(usize::MAX);
    let start = content.len().saturating_sub(keep);
    // A log that cannot be cut stays as it is.
    let _ = mixdog_fsio::write(&Unlaned, path, &content[start..]);
}

#[cfg(unix)]
const NULL_DEVICE: &str = "/dev/null";
#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";

#[cfg(unix)]
mod redirect {
    use std::os::fd::AsRawFd;

    use mixdog_fsio::File;

    /// The descriptor that was stderr.
    pub(super) struct Saved(i32);

    pub(super) fn redirect_stderr(target: &File) -> Option<Saved> {
        // SAFETY: duplicates stderr; the copy is closed by `restore`.
        let saved = unsafe { libc::dup(2) };
        if saved < 0 {
            return None;
        }
        // SAFETY: the descriptor was just created; close-on-exec keeps it from child processes.
        unsafe {
            libc::fcntl(saved, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        // SAFETY: both descriptors are open.
        if unsafe { libc::dup2(target.as_raw_fd(), 2) } < 0 {
            // SAFETY: closes the copy made above.
            unsafe {
                libc::close(saved);
            }
            return None;
        }
        Some(Saved(saved))
    }

    pub(super) fn restore(saved: Saved) {
        // SAFETY: puts the saved descriptor back on 2 and closes the copy.
        unsafe {
            libc::dup2(saved.0, 2);
            libc::close(saved.0);
        }
    }
}

#[cfg(windows)]
mod redirect {
    use std::os::windows::io::AsRawHandle;

    use mixdog_fsio::File;
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, SetStdHandle};

    /// The handle that was stderr (as an integer, so that the guard stays `Send`).
    pub(super) struct Saved(isize);

    pub(super) fn redirect_stderr(target: &File) -> Option<Saved> {
        // SAFETY: reads the process's standard handle.
        let saved = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        // SAFETY: the handle is owned by `target`, which the guard keeps open until `restore`.
        if unsafe { SetStdHandle(STD_ERROR_HANDLE, target.as_raw_handle()) } == 0 {
            return None;
        }
        Some(Saved(saved as isize))
    }

    pub(super) fn restore(saved: Saved) {
        // SAFETY: puts the previous standard handle back.
        unsafe {
            SetStdHandle(STD_ERROR_HANDLE, saved.0 as _);
        }
    }
}

struct ActiveRedirect {
    saved: redirect::Saved,
    _log: File,
}

/// stderr redirected to the TUI's log for the time the full-screen UI owns the terminal (the Rust tracing subscriber of
/// the TUI writes there too). Nothing is redirected when `MIXDOG_TUI_ALLOW_STDERR=1`. When the log cannot be opened the
/// diagnostics are dropped instead (the null device), never shown over the screen. Restored by
/// [`StderrGuard::restore`] or when dropped.
pub struct StderrGuard {
    active: Option<ActiveRedirect>,
    log_path: Option<PathBuf>,
}

impl Drop for StderrGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Signal cleanup and the stdio-death guard.

/// A step of the cleanup; the argument is the reason (`SIGINT`, `stdio-dead`, `forced-cleanup`, ...).
pub type Hook = Arc<dyn Fn(&str) + Send + Sync>;

/// What [`SignalCleanup`] does. The hooks are those of `installProcessSignalCleanup`.
pub struct CleanupConfig {
    /// Names the process in log lines.
    pub name: String,
    /// The deadline of `cleanup` ([`ExitSettings::cleanup_timeout`] for the TUI).
    pub timeout: Duration,
    /// Whether a signal ends the process once the cleanup ran.
    pub exit: bool,
    /// Runs first, on the signal's thread: restores the terminal.
    pub before_cleanup: Option<Hook>,
    /// The long step (disposing the session): runs on a thread of its own and is abandoned after `timeout`.
    pub cleanup: Option<Hook>,
    /// Runs last.
    pub after_cleanup: Option<Hook>,
    /// Restores the terminal when the exit is forced (a second request, or the cleanup's deadline).
    pub restore_terminal: Option<Hook>,
    /// Where the log lines go (default: stderr).
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// Ends the process with the code (default: [`std::process::exit`]).
    pub exit_process: Arc<dyn Fn(i32) + Send + Sync>,
}

impl CleanupConfig {
    pub fn new(name: impl Into<String>) -> CleanupConfig {
        CleanupConfig {
            name: name.into(),
            timeout: Duration::from_millis(6500),
            exit: true,
            before_cleanup: None,
            cleanup: None,
            after_cleanup: None,
            restore_terminal: None,
            log: Arc::new(|line| {
                let mut err = io::stderr().lock();
                // A stderr that is gone has nowhere to complain to.
                let _ = writeln!(err, "{line}");
            }),
            exit_process: Arc::new(|code| std::process::exit(code)),
        }
    }
}

/// How one cleanup run goes.
#[derive(Clone, Debug, Default)]
pub struct RunOptions {
    /// The exit code.
    pub code: i32,
    /// Whether the process ends afterwards.
    pub should_exit: bool,
    /// The failure that started the run, logged first.
    pub error: Option<String>,
}

/// The stream whose death is reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioSource {
    Stdin,
    Stdout,
    Stderr,
}

impl StdioSource {
    fn name(self) -> &'static str {
        match self {
            StdioSource::Stdin => "stdin",
            StdioSource::Stdout => "stdout",
            StdioSource::Stderr => "stderr",
        }
    }
}

/// What happened to the stream.
#[derive(Clone, Copy, Debug)]
pub enum StdioEvent<'a> {
    /// The input ended (end of file).
    Ended,
    /// The stream closed.
    Closed,
    /// A read or write failed; fatal only when [`is_stdio_fatal`] says so.
    Error(&'a io::Error),
}

/// Whether a stream error means the stream is truly gone (a broken pipe, an I/O error, a closed handle) rather than a
/// transient condition such as a would-block or an interruption.
pub fn is_stdio_fatal(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::BrokenPipe {
        return true;
    }
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EIO)
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_HANDLE, ERROR_BROKEN_PIPE, ERROR_NO_DATA.
        matches!(error.raw_os_error(), Some(6 | 109 | 232))
    }
}

const CLEANUP_THREAD: &str = "mixdog-term-cleanup";

struct Timer {
    cancelled: Mutex<bool>,
    wake: Condvar,
}

struct Inner {
    config: CleanupConfig,
    running: AtomicBool,
    removed: AtomicBool,
    timer: Mutex<Option<Arc<Timer>>>,
}

impl Inner {
    fn log(&self, line: &str) {
        (self.config.log)(line);
    }

    fn call(&self, hook: &Option<Hook>, reason: &str) -> Result<(), String> {
        let Some(hook) = hook else {
            return Ok(());
        };
        panic::catch_unwind(AssertUnwindSafe(|| hook(reason))).map_err(|payload| panic_text(&*payload))
    }

    /// The cleanup, on a thread of its own, abandoned after the deadline.
    fn run_cleanup(&self, reason: &str) -> Result<(), String> {
        let Some(cleanup) = self.config.cleanup.clone() else {
            return Ok(());
        };
        let (done_tx, done_rx) = mpsc::channel();
        let reason_owned = reason.to_string();
        let spawned = thread::Builder::new().name(CLEANUP_THREAD.into()).spawn(move || {
            let outcome = panic::catch_unwind(AssertUnwindSafe(|| cleanup(&reason_owned))).map_err(|p| panic_text(&*p));
            let _ = done_tx.send(outcome);
        });
        if let Err(error) = spawned {
            return Err(error.to_string());
        }
        match done_rx.recv_timeout(self.config.timeout) {
            Ok(outcome) => outcome,
            Err(_) => Err(format!("{} shutdown timed out after {}ms", self.config.name, self.config.timeout.as_millis().max(1))),
        }
    }

    /// The forced exit: the terminal restore gets a moment, then the process ends.
    fn hard_exit(&self, code: i32) {
        if let Some(restore) = self.config.restore_terminal.clone() {
            run_bounded("mixdog-term-forced-restore", Duration::from_millis(500), move || restore("forced-cleanup"));
        }
        (self.config.exit_process)(code);
    }

    fn start_timer(self: &Arc<Inner>, delay: Duration, code: i32) -> Arc<Timer> {
        let timer = Arc::new(Timer { cancelled: Mutex::new(false), wake: Condvar::new() });
        let inner = Arc::clone(self);
        let thread_timer = Arc::clone(&timer);
        let spawned = thread::Builder::new().name("mixdog-term-forced-exit".into()).spawn(move || {
            let guard = thread_timer.cancelled.lock().unwrap_or_else(PoisonError::into_inner);
            let (guard, waited) = thread_timer.wake.wait_timeout_while(guard, delay, |cancelled| !*cancelled).unwrap_or_else(PoisonError::into_inner);
            let cancelled = *guard;
            drop(guard);
            if waited.timed_out() && !cancelled {
                inner.hard_exit(code);
            }
        });
        drop(spawned);
        timer
    }

    fn cancel_timer(&self) {
        let timer = self.timer.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(timer) = timer {
            *timer.cancelled.lock().unwrap_or_else(PoisonError::into_inner) = true;
            timer.wake.notify_all();
        }
    }
}

/// The signal and stdio-death cleanup of `installProcessSignalCleanup`.
#[derive(Clone)]
pub struct SignalCleanup {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SignalCleanup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalCleanup").field("name", &self.inner.config.name).finish_non_exhaustive()
    }
}

impl SignalCleanup {
    /// Installs the handlers: SIGINT, SIGTERM and SIGHUP on Unix; Ctrl+C, Ctrl+Break and the console close event on
    /// Windows. A signal runs the cleanup and, when `config.exit`, ends the process with 128 plus the signal number.
    /// Once the cleanup began (or after [`SignalCleanup::uninstall`]) a further signal takes its default action.
    pub fn install(config: CleanupConfig) -> SignalCleanup {
        let inner = Arc::new(Inner { config, running: AtomicBool::new(false), removed: AtomicBool::new(false), timer: Mutex::new(None) });
        signals::install(&inner);
        SignalCleanup { inner }
    }

    /// Runs the cleanup for `reason`: `before_cleanup`, `cleanup` (with the deadline), `after_cleanup`, then, when
    /// `options.should_exit`, the exit. When a run is already going, false is returned and, if `should_exit`, the exit is
    /// forced (the terminal restored, the process ended). A hook that fails or panics is logged and the run goes on.
    pub fn run(&self, reason: &str, options: RunOptions) -> bool {
        let inner = &self.inner;
        if inner.running.swap(true, Ordering::SeqCst) {
            if options.should_exit {
                inner.hard_exit(options.code);
            }
            return false;
        }
        inner.removed.store(true, Ordering::SeqCst);
        let name = &inner.config.name;

        if options.should_exit {
            let delay = (inner.config.timeout + Duration::from_secs(1)).max(Duration::from_secs(1));
            let timer = inner.start_timer(delay, options.code);
            *inner.timer.lock().unwrap_or_else(PoisonError::into_inner) = Some(timer);
        }
        if let Some(error) = &options.error {
            inner.log(&format!("[{name}] {reason}: {error}"));
        }
        let steps = [inner.call(&inner.config.before_cleanup, reason), inner.run_cleanup(reason), inner.call(&inner.config.after_cleanup, reason)];
        for step in steps.into_iter().flat_map(Result::err) {
            inner.log(&format!("[{name}] cleanup failed: {step}"));
        }
        inner.cancel_timer();
        inner.running.store(false, Ordering::SeqCst);
        if options.should_exit {
            (inner.config.exit_process)(options.code);
        }
        true
    }

    /// A dead stdio surface is fatal: the cleanup runs with the reason `stdio-dead`, code 1 and the exit. An `Error` that
    /// is not [`is_stdio_fatal`] is ignored (false is returned): backpressure and resize noise must not end the session.
    pub fn stdio_dead(&self, source: StdioSource, event: StdioEvent<'_>) -> bool {
        let error = match event {
            StdioEvent::Error(error) => {
                if !is_stdio_fatal(error) {
                    return false;
                }
                error.to_string()
            }
            StdioEvent::Ended => format!("stdio end (source: {})", source.name()),
            StdioEvent::Closed => format!("stdio close (source: {})", source.name()),
        };
        self.run("stdio-dead", RunOptions { code: 1, should_exit: true, error: Some(error) });
        true
    }

    /// Takes the handlers off: later signals take their default action, and a pending forced exit is dropped.
    pub fn uninstall(&self) {
        self.inner.removed.store(true, Ordering::SeqCst);
        signals::uninstall(&self.inner);
        self.inner.cancel_timer();
    }
}

#[cfg(unix)]
mod signals {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::thread;

    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    use super::{Inner, RunOptions, SignalCleanup, signal_exit_code};

    fn signal_name(signal: i32) -> &'static str {
        match signal {
            SIGINT => "SIGINT",
            SIGTERM => "SIGTERM",
            SIGHUP => "SIGHUP",
            _ => "SIGNAL",
        }
    }

    pub(super) fn install(inner: &Arc<Inner>) {
        let mut signals = match Signals::new([SIGINT, SIGTERM, SIGHUP]) {
            Ok(signals) => signals,
            Err(error) => {
                inner.log(&format!("[{}] signal handlers were not installed: {error}", inner.config.name));
                return;
            }
        };
        let inner = Arc::clone(inner);
        let spawned = thread::Builder::new().name("mixdog-term-signals".into()).spawn({
            let inner = Arc::clone(&inner);
            move || {
                for signal in signals.forever() {
                    if inner.removed.load(Ordering::SeqCst) {
                        // No listener any more: the default action, as Node does.
                        let _ = signal_hook::low_level::emulate_default_handler(signal);
                        continue;
                    }
                    let cleanup = SignalCleanup { inner: Arc::clone(&inner) };
                    let name = signal_name(signal);
                    // On a thread of its own so that a second signal during the cleanup is seen here.
                    let _ = thread::Builder::new().name("mixdog-term-signal-run".into()).spawn(move || {
                        let options = RunOptions { code: signal_exit_code(name), should_exit: cleanup.inner.config.exit, error: None };
                        cleanup.run(name, options);
                    });
                }
            }
        });
        if let Err(error) = spawned {
            inner.log(&format!("[{}] signal handlers were not installed: {error}", inner.config.name));
        }
    }

    pub(super) fn uninstall(_inner: &Arc<Inner>) {}
}

#[cfg(windows)]
mod signals {
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex, PoisonError};
    use std::thread;

    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, SetConsoleCtrlHandler};

    use super::{Inner, RunOptions, SignalCleanup, signal_exit_code};

    static CURRENT: Mutex<Option<Arc<Inner>>> = Mutex::new(None);

    fn current() -> Option<Arc<Inner>> {
        CURRENT.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Ctrl+C is `SIGINT`, Ctrl+Break `SIGBREAK` and closing the console window `SIGHUP`, as Node reports them. Other
    /// events (logoff, shutdown) keep the system's handling.
    unsafe extern "system" fn handler(kind: u32) -> i32 {
        let Some(inner) = current() else {
            return 0;
        };
        if inner.removed.load(Ordering::SeqCst) {
            return 0;
        }
        let (name, inline) = match kind {
            CTRL_C_EVENT => ("SIGINT", false),
            CTRL_BREAK_EVENT => ("SIGBREAK", false),
            CTRL_CLOSE_EVENT => ("SIGHUP", true),
            _ => return 0,
        };
        let cleanup = SignalCleanup { inner: Arc::clone(&inner) };
        let run = move || {
            let options = RunOptions { code: signal_exit_code(name), should_exit: cleanup.inner.config.exit, error: None };
            cleanup.run(name, options);
        };
        if inline {
            // The system ends the process when this returns: for the close event the cleanup runs before it does.
            run();
        } else if thread::Builder::new().name("mixdog-term-signal-run".into()).spawn(run).is_err() {
            return 0;
        }
        1
    }

    pub(super) fn install(inner: &Arc<Inner>) {
        *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(inner));
        // SAFETY: registers a handler routine with the signature the system expects.
        if unsafe { SetConsoleCtrlHandler(Some(handler), 1) } == 0 {
            inner.log(&format!("[{}] signal handlers were not installed: {}", inner.config.name, std::io::Error::last_os_error()));
        }
    }

    pub(super) fn uninstall(_inner: &Arc<Inner>) {
        // SAFETY: removes the routine registered by `install`.
        unsafe {
            SetConsoleCtrlHandler(Some(handler), 0);
        }
        *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_signal_exit_codes() {
        assert_eq!(signal_exit_code("SIGINT"), 130);
        assert_eq!(signal_exit_code("SIGTERM"), 143);
        assert_eq!(signal_exit_code("SIGHUP"), 129);
        assert_eq!(signal_exit_code("other"), 1);
    }

    #[test]
    fn positive_int_follows_javascript_number() {
        assert_eq!(positive_int(None, 7), 7);
        assert_eq!(positive_int(Some(String::new()), 7), 7);
        assert_eq!(positive_int(Some("0".into()), 7), 7);
        assert_eq!(positive_int(Some("-5".into()), 7), 7);
        assert_eq!(positive_int(Some("abc".into()), 7), 7);
        assert_eq!(positive_int(Some("Infinity".into()), 7), 7);
        assert_eq!(positive_int(Some(" 1200 ".into()), 7), 1200);
        assert_eq!(positive_int(Some("12.9".into()), 7), 12);
        assert_eq!(positive_int(Some("1e3".into()), 7), 1000);
        assert_eq!(positive_int(Some("0x10".into()), 7), 16);
    }

    #[test]
    fn the_exit_settings() {
        let defaults = ExitSettings::from_vars(vars(&[]));
        assert_eq!(defaults.wait_timeout, Duration::from_millis(2500));
        assert_eq!(defaults.hard_exit_delay, Duration::from_millis(500));
        assert!(defaults.hard_exit_enabled);
        assert_eq!(defaults.cleanup_timeout(), Duration::from_millis(3500));
        let set =
            ExitSettings::from_vars(vars(&[("MIXDOG_TUI_EXIT_WAIT_MS", "100"), ("MIXDOG_TUI_HARD_EXIT_DELAY_MS", "20"), ("MIXDOG_TUI_HARD_EXIT", "Off")]));
        assert_eq!(set.wait_timeout, Duration::from_millis(100));
        assert_eq!(set.hard_exit_delay, Duration::from_millis(20));
        assert!(!set.hard_exit_enabled);
        assert!(ExitSettings::from_vars(vars(&[("MIXDOG_TUI_HARD_EXIT", "")])).hard_exit_enabled);
    }

    #[test]
    fn the_stderr_log_path() {
        let temp = Path::new("/tmp");
        assert_eq!(stderr_log_path(&vars(&[]), temp), Path::new("/tmp").join("mixdog").join(STDERR_LOG_NAME));
        assert_eq!(stderr_log_path(&vars(&[("MIXDOG_RUNTIME_ROOT", "/run/mx")]), temp), Path::new("/run/mx").join(STDERR_LOG_NAME));
        assert_eq!(stderr_log_path(&vars(&[("MIXDOG_RUNTIME_ROOT", "/run/mx"), ("MIXDOG_TUI_STDERR_LOG", "/x/e.log")]), temp), Path::new("/x/e.log"));
        assert_eq!(
            stderr_log_path(&vars(&[("MIXDOG_TUI_STDERR_LOG", ""), ("MIXDOG_RUNTIME_ROOT", "")]), temp),
            Path::new("/tmp").join("mixdog").join(STDERR_LOG_NAME)
        );
    }

    #[test]
    fn a_log_above_the_bound_is_cut_to_its_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e.log");
        mixdog_fsio::write(&Unlaned, &path, b"0123456789").unwrap();
        rotate_bounded_log(&path, 10, 4);
        assert_eq!(mixdog_fsio::read(&Unlaned, &path).unwrap(), b"0123456789");
        rotate_bounded_log(&path, 9, 4);
        assert_eq!(mixdog_fsio::read(&Unlaned, &path).unwrap(), b"6789");
        rotate_bounded_log(&dir.path().join("missing.log"), 1, 1);
    }

    #[test]
    fn the_stdio_errors_that_are_fatal() {
        assert!(is_stdio_fatal(&io::Error::from(io::ErrorKind::BrokenPipe)));
        assert!(!is_stdio_fatal(&io::Error::from(io::ErrorKind::WouldBlock)));
        assert!(!is_stdio_fatal(&io::Error::from(io::ErrorKind::Interrupted)));
        #[cfg(unix)]
        assert!(is_stdio_fatal(&io::Error::from_raw_os_error(libc::EIO)));
    }

    struct Probe {
        log: Arc<Mutex<Vec<String>>>,
        exits: Arc<Mutex<Vec<i32>>>,
        config: CleanupConfig,
    }

    fn probe(cleanup_sleep: Duration, timeout: Duration) -> Probe {
        let log = Arc::new(Mutex::new(Vec::new()));
        let exits = Arc::new(Mutex::new(Vec::new()));
        let mut config = CleanupConfig::new("probe");
        config.timeout = timeout;
        let steps = |label: &'static str, log: &Arc<Mutex<Vec<String>>>| -> Hook {
            let log = Arc::clone(log);
            Arc::new(move |reason| log.lock().unwrap().push(format!("{label}:{reason}")))
        };
        config.before_cleanup = Some(steps("before", &log));
        config.after_cleanup = Some(steps("after", &log));
        let cleanup_log = Arc::clone(&log);
        config.cleanup = Some(Arc::new(move |reason| {
            thread::park_timeout(cleanup_sleep);
            cleanup_log.lock().unwrap().push(format!("cleanup:{reason}"));
        }));
        let line_log = Arc::clone(&log);
        config.log = Arc::new(move |line| line_log.lock().unwrap().push(format!("log:{line}")));
        let exit_list = Arc::clone(&exits);
        config.exit_process = Arc::new(move |code| exit_list.lock().unwrap().push(code));
        Probe { log, exits, config }
    }

    fn cleanup_of(config: CleanupConfig) -> SignalCleanup {
        SignalCleanup { inner: Arc::new(Inner { config, running: AtomicBool::new(false), removed: AtomicBool::new(false), timer: Mutex::new(None) }) }
    }

    #[test]
    fn a_run_goes_before_cleanup_after_then_exit() {
        let probe = probe(Duration::ZERO, Duration::from_secs(5));
        let cleanup = cleanup_of(probe.config);
        assert!(cleanup.run("SIGTERM", RunOptions { code: 143, should_exit: true, error: None }));
        assert_eq!(*probe.log.lock().unwrap(), ["before:SIGTERM", "cleanup:SIGTERM", "after:SIGTERM"].map(String::from));
        assert_eq!(*probe.exits.lock().unwrap(), [143]);
    }

    #[test]
    fn a_run_without_exit_only_cleans_up() {
        let probe = probe(Duration::ZERO, Duration::from_secs(5));
        let cleanup = cleanup_of(probe.config);
        assert!(cleanup.run("done", RunOptions::default()));
        assert!(probe.exits.lock().unwrap().is_empty());
        assert!(cleanup.run("again", RunOptions::default()), "a finished run may run again");
    }

    #[test]
    fn the_error_is_logged_first() {
        let probe = probe(Duration::ZERO, Duration::from_secs(5));
        let cleanup = cleanup_of(probe.config);
        cleanup.run("stdio-dead", RunOptions { code: 1, should_exit: false, error: Some("boom".into()) });
        assert_eq!(probe.log.lock().unwrap()[0], "log:[probe] stdio-dead: boom");
    }

    #[test]
    fn a_cleanup_past_its_deadline_is_reported_and_the_run_goes_on() {
        let probe = probe(Duration::from_millis(400), Duration::from_millis(30));
        let cleanup = cleanup_of(probe.config);
        cleanup.run("SIGINT", RunOptions { code: 130, should_exit: true, error: None });
        let log = probe.log.lock().unwrap().clone();
        assert!(log.contains(&"log:[probe] cleanup failed: probe shutdown timed out after 30ms".to_string()), "{log:?}");
        assert!(log.contains(&"after:SIGINT".to_string()));
        assert_eq!(*probe.exits.lock().unwrap(), [130]);
    }

    #[test]
    fn a_second_request_during_the_cleanup_forces_the_exit() {
        let probe = probe(Duration::from_millis(300), Duration::from_secs(5));
        let restored = Arc::new(AtomicUsize::new(0));
        let mut config = probe.config;
        let restore_count = Arc::clone(&restored);
        config.restore_terminal = Some(Arc::new(move |reason| {
            assert_eq!(reason, "forced-cleanup");
            restore_count.fetch_add(1, Ordering::SeqCst);
        }));
        let cleanup = cleanup_of(config);
        let first = cleanup.clone();
        let running = thread::spawn(move || first.run("SIGTERM", RunOptions { code: 143, should_exit: true, error: None }));
        while !cleanup.inner.running.load(Ordering::SeqCst) {
            thread::yield_now();
        }
        assert!(!cleanup.run("stdio-dead", RunOptions { code: 1, should_exit: true, error: None }));
        assert_eq!(restored.load(Ordering::SeqCst), 1);
        assert_eq!(probe.exits.lock().unwrap()[0], 1);
        assert!(running.join().unwrap());
    }

    #[test]
    fn a_panicking_hook_is_logged_and_the_run_goes_on() {
        let probe = probe(Duration::ZERO, Duration::from_secs(5));
        let mut config = probe.config;
        config.before_cleanup = Some(Arc::new(|_| panic!("restore failed")));
        let cleanup = cleanup_of(config);
        cleanup.run("SIGHUP", RunOptions { code: 129, should_exit: true, error: None });
        let log = probe.log.lock().unwrap().clone();
        assert!(log.contains(&"log:[probe] cleanup failed: restore failed".to_string()), "{log:?}");
        assert!(log.contains(&"cleanup:SIGHUP".to_string()));
        assert_eq!(*probe.exits.lock().unwrap(), [129]);
    }

    #[test]
    fn a_dead_stdio_runs_the_cleanup_with_code_one() {
        let probe = probe(Duration::ZERO, Duration::from_secs(5));
        let cleanup = cleanup_of(probe.config);
        let transient = io::Error::from(io::ErrorKind::WouldBlock);
        assert!(!cleanup.stdio_dead(StdioSource::Stdout, StdioEvent::Error(&transient)));
        assert!(probe.exits.lock().unwrap().is_empty());
        assert!(cleanup.stdio_dead(StdioSource::Stdin, StdioEvent::Ended));
        assert_eq!(*probe.exits.lock().unwrap(), [1]);
        assert!(probe.log.lock().unwrap().contains(&"log:[probe] stdio-dead: stdio end (source: stdin)".to_string()));
    }

    #[test]
    fn the_terminal_restore_happens_once() {
        let written = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink_written = Arc::clone(&written);
        let sink: Sink = Arc::new(move |bytes| {
            sink_written.lock().unwrap().extend_from_slice(bytes);
            Ok(())
        });
        let modes = TerminalModes::new(crate::modes::ModeEnv::from_vars(|_| None));
        let restorer = TerminalRestorer::with_sink(modes, sink);
        let hook = restorer.hook();
        hook("SIGINT");
        restorer.restore();
        assert_eq!(*written.lock().unwrap(), restore_sequence().into_bytes());
        assert!(restorer.modes().is_restored());
    }
}

impl ExitSettings {
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> ExitSettings {
        let hard_raw = var("MIXDOG_TUI_HARD_EXIT").filter(|value| !value.is_empty()).unwrap_or_else(|| "1".to_string());
        ExitSettings {
            wait_timeout: Duration::from_millis(positive_int(var("MIXDOG_TUI_EXIT_WAIT_MS"), EXIT_WAIT_TIMEOUT_MS)),
            hard_exit_delay: Duration::from_millis(positive_int(var("MIXDOG_TUI_HARD_EXIT_DELAY_MS"), HARD_EXIT_DELAY_MS)),
            hard_exit_enabled: !is_off_word(&hard_raw),
        }
    }

    pub fn from_process() -> ExitSettings {
        ExitSettings::from_vars(|name| std::env::var(name).ok())
    }

    /// The deadline of the whole cleanup: the wait for the session plus one second.
    pub fn cleanup_timeout(&self) -> Duration {
        self.wait_timeout + Duration::from_secs(1)
    }
}
impl StderrGuard {
    /// [`StderrGuard::install_with`] over the process environment and the temporary directory.
    pub fn install() -> StderrGuard {
        StderrGuard::install_with(|name| std::env::var(name).ok(), &std::env::temp_dir())
    }

    pub fn install_with(var: impl Fn(&str) -> Option<String>, temp_dir: &Path) -> StderrGuard {
        let inactive = StderrGuard { active: None, log_path: None };
        if var("MIXDOG_TUI_ALLOW_STDERR").as_deref() == Some("1") {
            return inactive;
        }
        let path = stderr_log_path(&var, temp_dir);
        if let Some(parent) = path.parent() {
            // The log may still open when the directory exists already.
            let _ = mixdog_fsio::create_dir_all(&Unlaned, parent);
        }
        // This process never passes through a log rotation of its own: the log is bounded here, once, before it opens.
        rotate_bounded_log(&path, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
        let (log, log_path) = match OpenOptions::new().append(true).create(true).open(&Unlaned, &path) {
            Ok(log) => (log, Some(path)),
            Err(_) => match OpenOptions::new().write(true).open(&Unlaned, NULL_DEVICE) {
                Ok(null) => (null, None),
                Err(_) => return inactive,
            },
        };
        match redirect::redirect_stderr(&log) {
            Some(saved) => StderrGuard { active: Some(ActiveRedirect { saved, _log: log }), log_path },
            None => inactive,
        }
    }

    /// The file stderr goes to, when it is redirected to a log.
    pub fn log_path(&self) -> Option<&Path> {
        self.active.as_ref().and(self.log_path.as_deref())
    }

    /// Puts stderr back; a second call does nothing.
    pub fn restore(&mut self) {
        if let Some(active) = self.active.take() {
            redirect::restore(active.saved);
        }
    }
}
