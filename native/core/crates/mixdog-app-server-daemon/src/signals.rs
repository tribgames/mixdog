//! The OS stop requests and the budget that bounds the stop they start (Node
//! `standalone/daemon.mjs:1297-1310` signal handlers, `:272` `shutdown()` with its forced-exit
//! backstop).
//!
//! SIGTERM (a service stop, `kill`), SIGINT, SIGHUP (the SSH session or console ended) and, on
//! Windows, Ctrl+Break and the console close each start the ordered wind-down the same way.
//! Without these handlers the default action ends the process at once and skips the wind-down.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use crate::lifecycle::Exiter;

/// Ceiling for the whole stop, above the slowest individual step so a healthy stop finishes on its
/// own (Node `SHUTDOWN_BUDGET_MS`).
pub const SHUTDOWN_BUDGET: Duration = Duration::from_millis(15_000);

/// Which request ended the wait; [`StopSignal::name`] is the text the stop is recorded with, as
/// in Node (`shutdown('SIGTERM')`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopSignal {
    Terminate,
    Interrupt,
    HangUp,
    Break,
}

impl StopSignal {
    pub fn name(self) -> &'static str {
        match self {
            StopSignal::Terminate => "SIGTERM",
            StopSignal::Interrupt => "SIGINT",
            StopSignal::HangUp => "SIGHUP",
            StopSignal::Break => "SIGBREAK",
        }
    }
}

/// Resolves with the first stop request. The handlers are installed when this is first polled,
/// so call it before the work that must not be cut short by the default action.
#[cfg(unix)]
pub async fn stop_requested() -> io::Result<StopSignal> {
    use tokio::signal::unix::SignalKind;
    use tokio::signal::unix::signal;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut hang_up = signal(SignalKind::hangup())?;
    Ok(tokio::select! {
        _ = terminate.recv() => StopSignal::Terminate,
        _ = interrupt.recv() => StopSignal::Interrupt,
        _ = hang_up.recv() => StopSignal::HangUp,
    })
}

/// Windows: Ctrl+C is `SIGINT`, Ctrl+Break is `SIGBREAK`, and the console closing, logoff and
/// shutdown are Node's `SIGHUP`.
#[cfg(windows)]
pub async fn stop_requested() -> io::Result<StopSignal> {
    use tokio::signal::windows;
    let mut interrupt = windows::ctrl_c()?;
    let mut brk = windows::ctrl_break()?;
    let mut close = windows::ctrl_close()?;
    let mut logoff = windows::ctrl_logoff()?;
    let mut shutdown = windows::ctrl_shutdown()?;
    Ok(tokio::select! {
        _ = interrupt.recv() => StopSignal::Interrupt,
        _ = brk.recv() => StopSignal::Break,
        _ = close.recv() => StopSignal::HangUp,
        _ = logoff.recv() => StopSignal::HangUp,
        _ = shutdown.recv() => StopSignal::HangUp,
    })
}

/// Starts the stop's budget: if the process is still alive after `budget`, it ends through
/// `exiter`. The timer is a thread of its own, so a wedged async runtime cannot hold the port,
/// the singleton claim and the discovery file. It is never cancelled: a stop that finishes ends
/// the process first.
pub fn start_budget(budget: Duration, exiter: Arc<dyn Exiter>) -> io::Result<()> {
    std::thread::Builder::new().name("mixdog-stop-budget".into()).spawn(move || {
        std::thread::sleep(budget);
        tracing::error!(?budget, "stop budget exceeded, forcing exit");
        exiter.exit();
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::*;

    struct Counting(Arc<AtomicUsize>);

    impl Exiter for Counting {
        fn exit(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn an_overrunning_stop_is_forced_out() {
        let exits = Arc::new(AtomicUsize::new(0));
        start_budget(Duration::from_millis(20), Arc::new(Counting(exits.clone()))).unwrap();
        assert_eq!(exits.load(Ordering::SeqCst), 0);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while exits.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < deadline, "the budget never fired");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn signal_names_are_the_ones_node_records() {
        let names = [StopSignal::Terminate, StopSignal::Interrupt, StopSignal::HangUp, StopSignal::Break].map(StopSignal::name);
        assert_eq!(names, ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sigterm_and_sighup_start_the_stop() {
        for (number, want) in [(libc::SIGTERM, StopSignal::Terminate), (libc::SIGHUP, StopSignal::HangUp)] {
            let wait = tokio::spawn(stop_requested());
            tokio::task::yield_now().await;
            // SAFETY: raise on our own process with a handler installed above.
            assert_eq!(unsafe { libc::raise(number) }, 0);
            assert_eq!(wait.await.unwrap().unwrap(), want);
        }
    }
}
