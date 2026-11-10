//! The OS stop requests (Node `standalone/daemon.mjs:1297-1310` signal handlers) and their route
//! into the lifecycle's one stop procedure.
//!
//! SIGTERM (a service stop, `kill`), SIGINT, SIGHUP (the SSH session or console ended) and, on
//! Windows, Ctrl+Break and the console close each start the ordered wind-down the same way.
//! Without these handlers the default action ends the process at once and skips the wind-down.

use std::io;
use std::sync::Arc;

use crate::lifecycle::Lifecycle;
use crate::lifecycle::StopMode;
use crate::lifecycle::StopReason;

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

/// Starts the one stop procedure for an OS stop request: `stop{whenIdle, quit}` (LR §5.1).
///
/// The drain commits at once. The idle wait ends only when the busy count reaches zero and
/// nothing times it. Then the final barriers, the connection close and the release run (§5.3).
/// There is deliberately no forced-exit timer: Node's `shutdown()` backstop
/// (`standalone/daemon.mjs:272`, 15 s) is the divergence `decisions.md` records, because a forced
/// exit would cut a durable write in flight and §5.1 allows no timer-based force.
///
/// A request that arrives while a stop is already under way is not an error.
pub fn stop_for(lifecycle: &Arc<Lifecycle>, signal: StopSignal) {
    // Node's `shutdown('SIGTERM')` (`daemon.mjs:1298-1308`): the stop steps abort the agent runs with the signal's name.
    lifecycle.note_trigger(signal.name());
    match lifecycle.stop(StopMode::WhenIdle, StopReason::Quit, None) {
        Ok(()) => tracing::info!(signal = signal.name(), "stop requested"),
        Err(error) => tracing::warn!(signal = signal.name(), %error, "stop request not taken"),
    }
}

/// Waits for the first OS stop request and hands it to [`stop_for`].
pub async fn stop_on_signal(lifecycle: &Arc<Lifecycle>) -> io::Result<StopSignal> {
    let signal = stop_requested().await?;
    stop_for(lifecycle, signal);
    Ok(signal)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::lifecycle::ActivityInfo;
    use crate::lifecycle::ActivityKind;
    use crate::lifecycle::CorePort;
    use crate::lifecycle::DrainNotice;
    use crate::lifecycle::LifecycleConfig;
    use crate::lifecycle::Ports;
    use crate::lifecycle::Running;
    use crate::lifecycle::testing::Recorder;

    /// A core whose final barrier is a durable write that stays in flight until the test lets it
    /// finish.
    struct SlowWrite {
        inner: Arc<Recorder>,
        started: mpsc::Sender<()>,
        finish: Mutex<mpsc::Receiver<()>>,
    }

    impl CorePort for SlowWrite {
        fn drain_notice(&self, notice: &DrainNotice) {
            self.inner.drain_notice(notice);
        }
        fn health(&self, stalled_ms: u64) {
            self.inner.health(stalled_ms);
        }
        fn cancel_running(&self, running: &[Running]) {
            self.inner.cancel_running(running);
        }
        fn cut_new_tasks(&self) {
            self.inner.cut_new_tasks();
        }
        fn release_decision(&self, pid: u32) {
            self.inner.release_decision(pid);
        }
        fn final_barriers(&self) {
            let _ = self.started.send(());
            let _ = self.finish.lock().unwrap().recv();
            self.inner.final_barriers();
        }
        fn close_connections(&self) {
            self.inner.close_connections();
        }
        fn close_ext_host(&self) {
            self.inner.close_ext_host();
        }
        fn close_data_handles(&self) {
            self.inner.close_data_handles();
        }
    }

    #[test]
    fn a_term_signal_waits_for_work_and_a_slow_durable_write_before_the_process_exits() {
        let recorder = Arc::new(Recorder::default());
        let (started, write_started) = mpsc::channel();
        let (finish_write, finish) = mpsc::channel();
        let root = tempfile::tempdir().unwrap();
        let lifecycle = Lifecycle::new(
            LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: root.path().to_owned() },
            Ports {
                core: Arc::new(SlowWrite { inner: recorder.clone(), started, finish: Mutex::new(finish) }),
                discovery: recorder.clone(),
                exiter: recorder.clone(),
            },
        );
        lifecycle.set_serving().unwrap();
        let work = lifecycle.begin_activity(ActivityInfo { kind: ActivityKind::Turn, thread_id: Some("t".into()), turn_id: Some("u".into()), title: "turn".into() });

        stop_for(&lifecycle, StopSignal::Terminate);
        // The idle wait: a turn runs, so the process neither exits nor starts its barriers, however long it takes.
        assert!(write_started.recv_timeout(Duration::from_millis(300)).is_err());
        assert!(!recorder.has_exited());

        drop(work);
        write_started.recv().expect("the final barrier never started");
        // The durable write is in flight: the process is still there.
        assert!(!recorder.has_exited());

        finish_write.send(()).unwrap();
        recorder.wait_exit();
        let events = recorder.events();
        let at = |name: &str| events.iter().position(|e| e == name).unwrap_or_else(|| panic!("{name} missing in {events:?}"));
        assert!(at("final_barriers") < at("exit"), "{events:?}");
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
