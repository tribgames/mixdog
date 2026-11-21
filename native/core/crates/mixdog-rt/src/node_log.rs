//! The lines the Node core wrote to its stderr, and where they go. They are not developer diagnostics: the daemon's sink turns
//! each into a `<data>/daemon.log` row (`[<ISO>] <text>`, or `[<ISO>] [console.warn] <text>`), and the memory worker's stderr is
//! mirrored into `<data>/memory-runtime-proxy.log` as `[<ISO>] <text>`. A Rust line that stands for one of them goes through
//! [`emit`] (the macros [`node_stderr!`], [`node_console_warn!`], [`node_console_error!`] and [`memory_stderr!`]), never
//! `tracing`: `tracing` stays the developer channel, filtered by `RUST_LOG`.
//!
//! The process installs one [`Sink`] ([`install`]). Until one is installed (the CLI, a test process) a line is written bare to
//! the process's stderr, newline-terminated.

/// A line the daemon writes with `process.stderr.write`.
#[macro_export]
macro_rules! node_stderr {
    ($($arg:tt)+) => {
        $crate::node_log::emit($crate::node_log::Origin::Daemon, $crate::node_log::Channel::Stderr, &::std::format!($($arg)+))
    };
}

/// A line the daemon writes with `console.warn`.
#[macro_export]
macro_rules! node_console_warn {
    ($($arg:tt)+) => {
        $crate::node_log::emit($crate::node_log::Origin::Daemon, $crate::node_log::Channel::ConsoleWarn, &::std::format!($($arg)+))
    };
}

/// A line the daemon writes with `console.error`.
#[macro_export]
macro_rules! node_console_error {
    ($($arg:tt)+) => {
        $crate::node_log::emit($crate::node_log::Origin::Daemon, $crate::node_log::Channel::ConsoleError, &::std::format!($($arg)+))
    };
}

/// A line of a turn's trace in the daemon log: the core's own (Node has no such line), naming the session, turn, send and
/// attempt it belongs to. It goes where the daemon's stderr lines go, never into a [`node_log::capture`](crate::node_log::capture)
/// of Node's lines; a test reads it with [`node_log::capture_trace`](crate::node_log::capture_trace).
#[macro_export]
macro_rules! turn_trace {
    ($($arg:tt)+) => {
        $crate::node_log::emit_trace(&::std::format!($($arg)+))
    };
}

/// A line the memory worker writes with `process.stderr.write` (`__mixdogMemoryLog`).
#[macro_export]
macro_rules! memory_stderr {
    ($($arg:tt)+) => {
        $crate::node_log::emit($crate::node_log::Origin::MemoryWorker, $crate::node_log::Channel::Stderr, &::std::format!($($arg)+))
    };
}

use std::cell::RefCell;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

/// The Node process a line comes from; each has its own log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The daemon (`daemon.mjs`): its stderr is `daemon.log`.
    Daemon,
    /// The memory worker the daemon forks (`runtime/memory`): its stderr is `memory-runtime-proxy.log`.
    MemoryWorker,
}

/// How Node wrote the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    /// `process.stderr.write(line)`.
    Stderr,
    /// `console.warn(line)`.
    ConsoleWarn,
    /// `console.error(line)`.
    ConsoleError,
}

impl Channel {
    /// The `console` method of the redirect's `[console.<method>] ` tag; `None` for a raw stderr chunk.
    pub fn console_method(self) -> Option<&'static str> {
        match self {
            Channel::Stderr => None,
            Channel::ConsoleWarn => Some("warn"),
            Channel::ConsoleError => Some("error"),
        }
    }
}

/// Takes one line without its newline.
pub type Sink = Arc<dyn Fn(Origin, Channel, &str) + Send + Sync>;

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

thread_local! {
    static LOCAL: RefCell<Option<Sink>> = const { RefCell::new(None) };
    static TRACE_LOCAL: RefCell<Option<Sink>> = const { RefCell::new(None) };
}

tokio::task_local! {
    static PROVIDER: (String, std::cell::Cell<&'static str>);
}

/// Scope only this provider future's polls, not the executor thread or other sessions on it.
pub async fn provider_work<F: std::future::Future>(identity: String, phase: &'static str, work: F) -> F::Output {
    PROVIDER.scope((identity, std::cell::Cell::new(phase)), work).await
}

/// `work` under the provider work the task that calls this traces, at its current phase ([`crate::carry_task_locals`]).
pub(crate) fn carry<F: std::future::Future>(work: F) -> impl std::future::Future<Output = F::Output> {
    let provider = PROVIDER.try_with(|(identity, phase)| (identity.clone(), std::cell::Cell::new(phase.get()))).ok();
    crate::within_local(&PROVIDER, provider, work)
}

pub fn provider_boundary(submission: u64, attempt: u64, phase: &'static str) {
    let _ = PROVIDER.try_with(|(identity, current)| {
        current.set(phase);
        emit_trace(&format!("[provider] {identity} phase={phase} submission={submission} exchange={attempt}"));
    });
}

/// Makes `sink` the process's destination for Node stderr lines.
pub fn install(sink: Sink) {
    *SINK.lock().unwrap_or_else(PoisonError::into_inner) = Some(sink);
}

/// The bytes of a line written straight to the descriptor, before any redirect.
pub fn bare(line: &str) -> String {
    format!("{line}\n")
}

type CapturedLines = Arc<Mutex<Vec<(Origin, Channel, String)>>>;

/// The lines [`emit`] gets on this thread while the guard lives, in order, instead of the installed sink.
pub fn capture() -> (CapturedLines, CaptureGuard) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let into = lines.clone();
    let sink: Sink = Arc::new(move |origin, channel, line| {
        into.lock().unwrap_or_else(PoisonError::into_inner).push((origin, channel, line.to_owned()));
    });
    let previous = LOCAL.with(|local| local.replace(Some(sink)));
    (lines, CaptureGuard { previous })
}

/// Ends a [`capture`].
#[must_use]
pub struct CaptureGuard {
    previous: Option<Sink>,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        LOCAL.with(|local| *local.borrow_mut() = self.previous.take());
    }
}

/// The turn-trace lines ([`turn_trace!`](crate::turn_trace)) [`emit_trace`] gets on this thread while the guard lives.
pub fn capture_trace() -> (CapturedLines, TraceCaptureGuard) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let into = lines.clone();
    let sink: Sink = Arc::new(move |origin, channel, line| {
        into.lock().unwrap_or_else(PoisonError::into_inner).push((origin, channel, line.to_owned()));
    });
    let previous = TRACE_LOCAL.with(|local| local.replace(Some(sink)));
    (lines, TraceCaptureGuard { previous })
}

/// Ends a [`capture_trace`].
#[must_use]
pub struct TraceCaptureGuard {
    previous: Option<Sink>,
}

impl Drop for TraceCaptureGuard {
    fn drop(&mut self) {
        TRACE_LOCAL.with(|local| *local.borrow_mut() = self.previous.take());
    }
}

/// Writes one turn-trace line to the daemon's log: past any capture of Node's lines.
pub fn emit_trace(line: &str) {
    if let Some(local) = TRACE_LOCAL.with(|local| local.borrow().clone()) {
        local(Origin::Daemon, Channel::Stderr, line);
        return;
    }
    let installed = SINK.lock().unwrap_or_else(PoisonError::into_inner).clone();
    match installed {
        Some(sink) => sink(Origin::Daemon, Channel::Stderr, line),
        None => {
            let _ = std::io::stderr().lock().write_all(bare(line).as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_gets_the_lines_of_its_thread_and_ends_with_its_guard() {
        let (lines, guard) = capture();
        node_stderr!("[a] {}", 1);
        node_console_warn!("[b]");
        memory_stderr!("[c]");
        drop(guard);
        assert_eq!(
            *lines.lock().unwrap(),
            vec![
                (Origin::Daemon, Channel::Stderr, "[a] 1".to_owned()),
                (Origin::Daemon, Channel::ConsoleWarn, "[b]".to_owned()),
                (Origin::MemoryWorker, Channel::Stderr, "[c]".to_owned()),
            ]
        );
    }

    #[test]
    fn the_installed_sink_gets_every_line_a_capture_does_not() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        install(Arc::new(move |origin, channel, line| into.lock().unwrap().push((origin, channel, line.to_owned()))));
        node_console_error!("[x] {}", "y");
        let captured = {
            let (lines, _guard) = capture();
            node_stderr!("[inside]");
            lines.lock().unwrap().len()
        };
        assert_eq!(captured, 1);
        assert_eq!(*seen.lock().unwrap(), vec![(Origin::Daemon, Channel::ConsoleError, "[x] y".to_owned())]);
    }
}

/// Writes one Node stderr line (`line` has no newline).
pub fn emit(origin: Origin, channel: Channel, line: &str) {
    // A replay waits on these lines (`wait` on the replay's clock).
    #[cfg(feature = "virtual-clock")]
    crate::virtual_clock::logged(line);
    let contextual = PROVIDER.try_with(|(identity, phase)| format!("{line} {identity} phase={}", phase.get())).ok();
    let line = contextual.as_deref().unwrap_or(line);
    if let Some(local) = LOCAL.with(|local| local.borrow().clone()) {
        local(origin, channel, line);
        return;
    }
    let installed = SINK.lock().unwrap_or_else(PoisonError::into_inner).clone();
    match installed {
        Some(sink) => sink(origin, channel, line),
        None => {
            let _ = std::io::stderr().lock().write_all(bare(line).as_bytes());
        }
    }
}

/// `process.env.MIXDOG_DEBUG_SESSION_LOG` is set (non-empty): the session manager's informational stderr lines are written.
pub fn debug_session_log() -> bool {
    std::env::var_os("MIXDOG_DEBUG_SESSION_LOG").is_some_and(|value| !value.is_empty())
}
