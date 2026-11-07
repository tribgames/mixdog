//! The one listener of the agent status signals (`agent-tool.mjs` `stopStatusSources`):
//! every source that may change what `getStatus` answers asks the owner's thread to re-read its
//! agents (`SessionDirectory::agent_activity`, wp-session-29), which publishes `thread/agents/updated`
//! only when the lists differ. Nothing polls.
//!
//! Node re-reads every status scope on each signal. A background task added or finished names its
//! owner, and only that owner re-reads; every other source (an approval wait changing, a
//! worker-index write, a session record reloaded, a role's watchdog policy resolved) reaches every
//! loaded owner.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::agent_registry::signals::StatusSignals;

use super::compose_parts::LateDirectory;

/// Where the signal lands: the loaded threads and their re-read.
pub trait ActivitySink: Send + Sync {
    fn loaded(&self) -> Vec<ThreadId>;
    fn agent_activity(&self, owner: &str);
}

impl ActivitySink for LateDirectory {
    /// Before the directory is bound nothing is loaded, so a signal reaches nobody (an owner that
    /// is not loaded hears nothing, as in Node with no runtime).
    fn loaded(&self) -> Vec<ThreadId> {
        self.directory().map(|directory| directory.loaded_ids()).unwrap_or_default()
    }

    fn agent_activity(&self, owner: &str) {
        if let Some(directory) = self.directory() {
            directory.agent_activity(owner);
        }
    }
}

pub struct AgentActivity {
    sink: Arc<dyn ActivitySink>,
}

impl AgentActivity {
    pub fn new(sink: Arc<dyn ActivitySink>) -> Arc<Self> {
        Arc::new(Self { sink })
    }

    /// A source that names the session it concerns: `emitSessionActivityChange(ownerSessionId)` of a
    /// background task added or finished (`JobBoard::new`'s `on_change`).
    pub fn owner(&self, owner: &str) {
        self.sink.agent_activity(owner);
    }

    /// A source with no owner of its own: `registry.onWorkerRowsChange`, `sessionRecords.onChange`,
    /// `onSessionApprovalWaitChange`, `onRolePolicyResolved`.
    pub fn everyone(&self) {
        for thread in self.sink.loaded() {
            self.sink.agent_activity(thread.as_str());
        }
    }

    /// The registry's emitter (`StoreWorkers::bind_signals`) reaches the same listener.
    pub fn signals(self: &Arc<Self>) -> Arc<dyn StatusSignals> {
        self.clone()
    }

    /// `JobBoard::new(clock, notifier, Some(listener))`.
    pub fn name_listener(self: &Arc<Self>) -> Arc<dyn Fn(&str) + Send + Sync> {
        let this = Arc::clone(self);
        Arc::new(move |owner| this.owner(owner))
    }
}

/// The worker-index write (`registry.onWorkerRowsChange`) names no owner to Node's listener either.
impl StatusSignals for AgentActivity {
    fn worker_rows(&self, _session: &str) {
        self.everyone();
    }
}

/// The session actor's sources (`SessionDeps.agent_signals`). Node's listeners of both ignore the
/// session (`statusMayHaveChanged()` re-reads every scope): an approval a worker waits on shows in
/// its Lead's status, so its own thread is not the one to tell.
impl mixdog_core_session::session::agent_activity::AgentSignals for AgentActivity {
    fn approval_wait(&self, _session: &str) {
        self.everyone();
    }

    fn session_record(&self, _session: &str) {
        self.everyone();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Sink(Vec<&'static str>, Mutex<Vec<String>>);

    impl ActivitySink for Sink {
        fn loaded(&self) -> Vec<ThreadId> {
            self.0.iter().map(|id| ThreadId::from(*id)).collect()
        }

        fn agent_activity(&self, owner: &str) {
            self.1.lock().unwrap().push(owner.to_owned());
        }
    }

    #[test]
    fn a_named_source_reaches_its_owner_and_an_unnamed_one_every_loaded_thread() {
        let sink = Arc::new(Sink(vec!["a", "b"], Mutex::default()));
        let activity = AgentActivity::new(sink.clone());
        (activity.name_listener())("b");
        activity.everyone();
        assert_eq!(*sink.1.lock().unwrap(), ["b", "a", "b"]);
    }

    /// The session actor's sources name no owner to Node's listener: all loaded threads re-read.
    #[test]
    fn the_session_actors_signals_reach_every_loaded_thread() {
        use mixdog_core_session::session::agent_activity::AgentSignals;
        let sink = Arc::new(Sink(vec!["a", "b"], Mutex::default()));
        let activity = AgentActivity::new(sink.clone());
        activity.approval_wait("w");
        activity.session_record("w");
        assert_eq!(*sink.1.lock().unwrap(), ["a", "b", "a", "b"]);
    }

    /// A worker-index write names no owner: all loaded threads re-read.
    #[test]
    fn a_worker_index_write_reaches_every_loaded_thread() {
        let sink = Arc::new(Sink(vec!["a", "b"], Mutex::default()));
        let signals = AgentActivity::new(sink.clone()).signals();
        signals.worker_rows("w");
        assert_eq!(*sink.1.lock().unwrap(), ["a", "b"]);
    }

    #[test]
    fn before_the_directory_is_bound_a_signal_reaches_nobody() {
        let late = Arc::new(LateDirectory::default());
        let activity = AgentActivity::new(late.clone());
        activity.owner("a");
        activity.everyone();
        assert!(late.loaded().is_empty());
    }
}
