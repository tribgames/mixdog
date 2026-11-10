//! An abort signal that remembers who aborted it and why. Node's `abortError` throws the reason
//! when it is an `Error` and `String(reason)` otherwise, so the text of a cancelled wait depends
//! on the source: the agent job says [`JOB_CANCELLED`], a parent session's signal brings its own
//! reason, and a bare `abort()` reads [`ABORTED`].

use std::sync::{Arc, Mutex, PoisonError};

use tokio_util::sync::CancellationToken;

use crate::interrupt::AbortReason;

/// What `signal.abort()` with no reason reads in Node (the `AbortError` DOMException's message).
pub const ABORTED: &str = "This operation was aborted";

/// The reason the agent job's own controller aborts with before it is admitted (`job-start.mjs`).
pub const JOB_CANCELLED: &str = "agent task cancelled before resource admission";

/// The `reason` of the `SessionClosedError` Node aborts a session's controller with. The provider
/// request's signal is that controller's, so a wait ended by it reads this text (`abortError`
/// returns an `Error` reason as is). Sources: `closeSession` (a job's cancel closes its worker
/// session with [`AGENT_TASK_CANCEL`]; `agent close`, session delete and teardown close with their
/// own reasons), `abortSessionTurn`, and the runtime's `abortRuntime` (a user stop, [`USER_CANCEL`]).
/// A steer aborts nothing: it queues behind the running turn.
pub fn session_closed(session_id: &str, detail: &str) -> String {
    format!("Session \"{session_id}\" closed: {detail}")
}

/// `closeSession(id, reason)`.
pub fn close_session_reason(session_id: &str, reason: &str) -> String {
    session_closed(session_id, &format!("closeSession (reason={reason})"))
}

/// `abortSessionTurn(id, reason)`.
pub fn abort_session_turn_reason(session_id: &str, reason: &str) -> String {
    session_closed(session_id, &format!("abortSessionTurn (reason={reason})"))
}

/// `abortRuntime`'s outer abort, which reaches the session's controller first when a turn is
/// active (`runtime abort (reason=…)`).
pub fn runtime_abort_reason(session_id: &str, reason: &str) -> String {
    session_closed(session_id, &format!("runtime abort (reason={reason})"))
}

/// The close reason of a cancelled agent job (`job-start.mjs`).
pub const AGENT_TASK_CANCEL: &str = "agent-task-cancel";

/// `abortRuntime`'s default reason, for a caller that names none.
pub const CLI_ABORT: &str = "cli-abort";

/// The reason of a user's Stop (`abort.mjs:118`, passed on by `abortGoalTurn` to `abortRuntime`).
pub const USER_CANCEL: &str = "user-cancel";

/// A signal's reason when a parent signal aborted with none (`linkParentSignalToSession`).
pub const PARENT_ABORTED: &str = "parent signal aborted";

/// What a session's turn is stopped with: the text Node's `SessionClosedError` carries, and the close reason it
/// names (`closeReason`, which `finalizeInterruptedTurn` reads). A path that names none in Node uses
/// [`AbortReason::Unnamed`].
#[derive(Clone, Debug, PartialEq)]
pub struct Abort {
    pub message: String,
    pub reason: AbortReason,
}

impl Abort {
    /// `closeSession(id, reason)`.
    pub fn close_session(session_id: &str, reason: &str) -> Self {
        Self { message: close_session_reason(session_id, reason), reason: AbortReason::from_name(reason) }
    }

    /// `abortSessionTurn(id, reason)`.
    pub fn abort_session_turn(session_id: &str, reason: &str) -> Self {
        Self { message: abort_session_turn_reason(session_id, reason), reason: AbortReason::from_name(reason) }
    }

    /// `abortRuntime(reason)`.
    pub fn runtime_abort(session_id: &str, reason: &str) -> Self {
        Self { message: runtime_abort_reason(session_id, reason), reason: AbortReason::from_name(reason) }
    }

    /// Teardown's `quiesce(reason)`: the runtime closes with `reason`.
    pub fn runtime_close(session_id: &str, reason: &str) -> Self {
        Self { message: session_closed(session_id, &format!("runtime close (reason={reason})")), reason: AbortReason::from_name(reason) }
    }

    /// A signal's own abort, text and close reason as it carries them.
    pub fn of_signal(signal: &Cancel) -> Self {
        Self { message: signal.reason(), reason: signal.close_reason() }
    }
}

#[derive(Clone, Default)]
pub struct Cancel {
    token: CancellationToken,
    reason: Arc<Mutex<Option<String>>>,
    /// The close reason of the first abort.
    close: Arc<Mutex<Option<AbortReason>>>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// A run's own token as a signal. It carries no reason of its own, so a wait it ends reads
    /// as a bare `abort()` ([`ABORTED`]).
    pub fn from_token(token: &CancellationToken) -> Self {
        Self { token: token.clone(), reason: Arc::default(), close: Arc::default() }
    }

    /// `controller.abort(reason)` of a source that is not a session close (an agent job's cancel, the watchdog,
    /// a parent signal): Node gives it no `closeReason`, so it reads [`AbortReason::Unnamed`]. The first abort
    /// keeps its reason.
    pub fn abort(&self, reason: &str) {
        self.abort_with(&Abort { message: reason.to_owned(), reason: AbortReason::Unnamed });
    }

    /// A session's turn stopped by `abort`; the first abort keeps its text and its close reason.
    pub fn abort_with(&self, abort: &Abort) {
        let mut slot = self.reason.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(abort.message.clone());
            *self.close.lock().unwrap_or_else(PoisonError::into_inner) = Some(abort.reason);
        }
        drop(slot);
        self.token.cancel();
    }

    /// The close reason of the first abort ([`AbortReason::Unnamed`] when it names none).
    pub fn close_reason(&self) -> AbortReason {
        (*self.close.lock().unwrap_or_else(PoisonError::into_inner)).unwrap_or(AbortReason::Unnamed)
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
            linked.abort_with(&Abort::of_signal(done));
            return linked;
        }
        if sources.is_empty() {
            return linked;
        }
        let (out, sources) = (linked.clone(), sources.to_vec());
        tokio::spawn(async move {
            let waits = sources.iter().map(|s| Box::pin(s.token.cancelled()));
            let (_, index, _) = futures::future::select_all(waits).await;
            out.abort_with(&Abort::of_signal(&sources[index]));
        });
        linked
    }
}