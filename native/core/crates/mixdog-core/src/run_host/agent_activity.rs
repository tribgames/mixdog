//! The one listener of the agent status signals (`agent-tool.mjs` `stopStatusSources`):
//! every source that may change what `getStatus` answers asks the owner's thread to re-read its
//! agents (`SessionDirectory::agent_activity`, wp-session-29), which publishes `thread/agents/updated`
//! only when the lists differ. Nothing polls.
//!
//! Node re-reads every status scope on each signal. The sources that name a session pass it as the
//! owner (a background task added or finished, an approval wait changing); those that do not (a
//! worker-index write, a session record reloaded, a role's watchdog policy resolved) reach every
//! loaded owner.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;

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
    /// background task added or finished (`JobBoard::new`'s `on_change`), `onSessionApprovalWaitChange`.
    pub fn owner(&self, owner: &str) {
        self.sink.agent_activity(owner);
    }

    /// A source with no owner of its own: `registry.onWorkerRowsChange`, `sessionRecords.onChange`,
    /// `onRolePolicyResolved`.
    pub fn everyone(&self) {
        for thread in self.sink.loaded() {
            self.sink.agent_activity(thread.as_str());
        }
    }

    /// `JobBoard::new(clock, notifier, Some(listener))`.
    pub fn name_listener(self: &Arc<Self>) -> Arc<dyn Fn(&str) + Send + Sync> {
        let this = Arc::clone(self);
        Arc::new(move |owner| this.owner(owner))
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

    #[test]
    fn before_the_directory_is_bound_a_signal_reaches_nobody() {
        let late = Arc::new(LateDirectory::default());
        let activity = AgentActivity::new(late.clone());
        activity.owner("a");
        activity.everyone();
        assert!(late.loaded().is_empty());
    }
}
