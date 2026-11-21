use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;
use super::actor::Inbox;

/// `agentStatusState()` of a session: the agent tool's status with the session as the caller.
/// Node reads it inside a `try` and answers both lists empty on any failure; so does an impl.
#[async_trait]
pub trait AgentStatus: Send + Sync {
    async fn status(&self, thread: &ThreadId) -> ThreadAgents;
}

/// The two agent-status sources the session actor emits (`agent-tool.mjs` `stopStatusSources`):
/// each may change what the agent tool's `getStatus` answers, and Node answers both with
/// `statusMayHaveChanged()`, which re-reads every status scope (neither names an owner there).
pub trait AgentSignals: Send + Sync {
    /// `onSessionApprovalWaitChange`: the approvals `session`'s turn waits on changed.
    fn approval_wait(&self, session: &str);
    /// `sessionRecords.onChange`: `session`'s stored record changed.
    fn session_record(&self, session: &str);
    /// An agent session's own turn was stopped (`abortSession`, `session-turns.mjs`): the agent jobs it started are cancelled
    /// with it (`parent Agent turn aborted`). A Lead's stop never signals this; delegated work outlives it.
    fn agent_turn_aborted(&self, _session: &str) {}
    /// While the returned guard lives, a record or row change of these sessions is not announced as it happens: what
    /// is owed is announced once when the guard drops (a batch that changes many sessions, `agent cleanup`). A
    /// listener with nothing to fan out holds nothing.
    fn hold(&self, _sessions: &[String]) -> Box<dyn Send> {
        Box::new(())
    }
}

/// The sessions whose agent-status signals a batch holds ([`AgentSignals::hold`]): a held session's signal is owed to
/// the hold instead of announced, and the hold's end announces all it is owed once.
#[derive(Default)]
pub struct SignalHolds(std::sync::Mutex<Holds>);

#[derive(Default)]
struct Holds {
    held: std::collections::HashMap<String, usize>,
    owed: std::collections::HashSet<String>,
}

impl SignalHolds {
    fn holds(&self) -> std::sync::MutexGuard<'_, Holds> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether a signal of `session` is held: then it is owed to the hold, not to be announced now.
    pub fn defer(&self, session: &str) -> bool {
        let mut holds = self.holds();
        if !holds.held.contains_key(session) {
            return false;
        }
        holds.owed.insert(session.to_owned());
        true
    }

    /// Holds the signals of `sessions` until the guard drops; `announce` then runs once if any of them is owed and no
    /// other hold still holds it.
    pub fn hold(self: &std::sync::Arc<Self>, sessions: &[String], announce: impl FnOnce() + Send + 'static) -> SignalHold {
        let mut holds = self.holds();
        for session in sessions {
            *holds.held.entry(session.clone()).or_insert(0) += 1;
        }
        SignalHold { holds: self.clone(), sessions: sessions.to_vec(), announce: Some(Box::new(announce)) }
    }
}

/// The guard of [`SignalHolds::hold`].
pub struct SignalHold {
    holds: std::sync::Arc<SignalHolds>,
    sessions: Vec<String>,
    announce: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for SignalHold {
    fn drop(&mut self) {
        let owed = {
            let mut guard = self.holds.holds();
            let holds = &mut *guard;
            for session in &self.sessions {
                match holds.held.get_mut(session) {
                    Some(count) if *count > 1 => *count -= 1,
                    _ => {
                        holds.held.remove(session);
                    }
                }
            }
            let held = &holds.held;
            let before = holds.owed.len();
            holds.owed.retain(|session| held.contains_key(session));
            holds.owed.len() < before
        };
        if owed && let Some(announce) = self.announce.take() {
            announce();
        }
    }
}

impl SessionDirectory {
    /// `JobBoard`'s `on_change(owner)`: a job of `owner` was added or finished. Only a loaded
    /// thread has a runtime to tell, as in Node; the signal never waits.
    pub fn agent_activity(&self, owner: &str) {
        self.agent_signal(owner, true);
    }

    /// The agent tool's `statusMayHaveChanged()` from a source that names no session: a loaded `thread` reads its status again,
    /// its idle clock left as it is.
    pub fn status_may_have_changed(&self, thread: &str) {
        self.agent_signal(thread, false);
    }

    fn agent_signal(&self, thread: &str, named: bool) {
        let Some(handle) = self.handle(&ThreadId::from(thread)) else { return };
        let _ = handle.inbox.try_send(Inbox::AgentActivity { named });
    }
}
