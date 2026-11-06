//! An abort signal that remembers who aborted it and why. Node's `abortError` throws the reason
//! when it is an `Error` and `String(reason)` otherwise, so the text of a cancelled wait depends
//! on the source: the agent job says [`JOB_CANCELLED`], a parent session's signal brings its own
//! reason, and a bare `abort()` reads [`ABORTED`].

use std::sync::{Arc, Mutex, PoisonError};

use tokio_util::sync::CancellationToken;

/// What `signal.abort()` with no reason reads in Node (the `AbortError` DOMException's message).
pub const ABORTED: &str = "This operation was aborted";

/// The reason the agent job's own controller aborts with before it is admitted (`job-start.mjs`).
pub const JOB_CANCELLED: &str = "agent task cancelled before resource admission";

#[derive(Clone, Default)]
pub struct Cancel {
    token: CancellationToken,
    reason: Arc<Mutex<Option<String>>>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// A run's own token as a signal. It carries no reason of its own, so a wait it ends reads
    /// as a bare `abort()` ([`ABORTED`]).
    pub fn from_token(token: &CancellationToken) -> Self {
        Self { token: token.clone(), reason: Arc::default() }
    }

    /// `abort(reason)`; the first abort keeps its reason.
    pub fn abort(&self, reason: &str) {
        let mut slot = self.reason.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(reason.to_owned());
        }
        drop(slot);
        self.token.cancel();
    }

    /// `abort()` with no reason.
    pub fn abort_default(&self) {
        self.abort(ABORTED);
    }

    pub fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Resolves when aborted.
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }

    /// `abortError(signal).message`.
    pub fn reason(&self) -> String {
        self.reason.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_else(|| ABORTED.to_owned())
    }

    /// `composeAgentDispatchAbortSignal`: aborts with the reason of the first source to abort
    /// (the first already-aborted one in declaration order). Needs a running runtime.
    pub fn linked(sources: &[Cancel]) -> Self {
        let linked = Self::new();
        if let Some(done) = sources.iter().find(|s| s.is_aborted()) {
            linked.abort(&done.reason());
            return linked;
        }
        if sources.is_empty() {
            return linked;
        }
        let (out, sources) = (linked.clone(), sources.to_vec());
        tokio::spawn(async move {
            let waits = sources.iter().map(|s| Box::pin(s.token.cancelled()));
            let (_, index, _) = futures::future::select_all(waits).await;
            out.abort(&sources[index].reason());
        });
        linked
    }
}