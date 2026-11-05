//! Child-exit notifications. On Unix a worker's exit is noticed (and its group killed) *before* the
//! worker is reaped, which needs SIGCHLD; the pool registers for it once, at construction, and every
//! worker's reader waits on that one source. Failing to register is a startup error of the pool.

use tokio::sync::watch;

/// The pool could not start.
#[derive(Debug)]
pub enum ExtHostError {
    /// SIGCHLD could not be registered, so worker exits cannot be observed before the reap.
    ChildExitSignal(std::io::Error),
}

impl std::fmt::Display for ExtHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChildExitSignal(error) => write!(f, "cannot watch for child exits (SIGCHLD): {error}"),
        }
    }
}

impl std::error::Error for ExtHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::ChildExitSignal(error) => Some(error),
        }
    }
}

/// A counter that changes whenever any child of this process changed state.
#[derive(Clone)]
pub(crate) struct ChildExits(#[cfg_attr(not(unix), allow(dead_code, reason = "only Unix waits on it"))] watch::Receiver<u64>);

impl ChildExits {
    /// Registers for child-exit signals. Must run inside the Tokio runtime.
    #[cfg(unix)]
    pub(crate) fn watch() -> Result<Self, ExtHostError> {
        use tokio::signal::unix::SignalKind;
        use tokio::signal::unix::signal;

        let mut sigchld = signal(SignalKind::child()).map_err(ExtHostError::ChildExitSignal)?;
        let (tx, rx) = watch::channel(0u64);
        mixdog_rt::spawn("exthost.sigchld", mixdog_rt::TaskClass::Work, async move {
            // Ends when every receiver is gone (the dispatcher, the browser service and every
            // owner hold one, so while any child lives this keeps running). If the task is
            // dropped instead (the runtime shuts down), receivers see `changed` fail; the
            // owners then signal their still-unreaped leaders and reap (see `owner::Owner`).
            loop {
                tokio::select! {
                    _ = sigchld.recv() => {
                        tx.send_modify(|n| *n = n.wrapping_add(1));
                    }
                    () = tx.closed() => break,
                }
            }
        });
        Ok(Self(rx))
    }

    /// Windows: a job object kills the whole tree, and nothing needs the signal.
    #[cfg(not(unix))]
    #[allow(clippy::unnecessary_wraps, reason = "same signature as the Unix constructor")]
    pub(crate) fn watch() -> Result<Self, ExtHostError> {
        Ok(Self(watch::channel(0u64).1))
    }

    /// Resolves after the next child-state change; `false` when the notifier is gone and no more
    /// will come.
    #[cfg(unix)]
    pub(crate) async fn changed(&mut self) -> bool {
        self.0.changed().await.is_ok()
    }
}
