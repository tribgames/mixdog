//! What follows a session runtime's life: Node's `createToolApproval` registers a chat's approval
//! queue with the delegated-approval host when the runtime is created and adopts the requests
//! waiting for it (`adoptDelegatedApprovals`); closing the runtime unregisters it and drops its
//! copies. Here the actor tells [`RuntimeHooks`] when it starts and stops.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;

use super::delegated_host::{Answered, ApprovalQueue, DelegatedApprovalHost, QueueHandle};
use super::handoff_questions::{HandoffQuestions, SectionPublisher};

#[cfg(test)]
mod tests;

pub trait RuntimeHooks: Send + Sync {
    /// The thread's actor is running (called on its task, so a tokio runtime is current).
    fn started(&self, thread: &ThreadId);
    /// The thread's actor has stopped: its copies are dropped unanswered, as a closing runtime does.
    fn stopped(&self, thread: &ThreadId);
}

/// For a core that holds no handed-off question copies.
pub struct NoRuntimeHooks;

impl RuntimeHooks for NoRuntimeHooks {
    fn started(&self, _: &ThreadId) {}
    fn stopped(&self, _: &ThreadId) {}
}

/// The question copies of every running session runtime. The section feed (`ThreadState`) is built
/// over the session directory, which is built over the deps that carry this hook, so it is bound
/// afterwards; a runtime that starts before the bind holds no copies.
pub struct HandoffQuestionsHub {
    host: Arc<DelegatedApprovalHost>,
    threads: OnceLock<Arc<dyn ThreadState>>,
    held: Mutex<Vec<(ThreadId, Arc<HandoffQuestions>, QueueHandle)>>,
    /// The publishers' drain tasks, for the tests to await.
    #[cfg(test)]
    publishers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl HandoffQuestionsHub {
    pub fn new(host: Arc<DelegatedApprovalHost>) -> Arc<Self> {
        Arc::new(Self { host, threads: OnceLock::new(), held: Mutex::default(), #[cfg(test)] publishers: Mutex::default() })
    }

    /// Takes the drain tasks of every publisher started so far.
    #[cfg(test)]
    fn take_publishers(&self) -> Vec<tokio::task::JoinHandle<()>> {
        std::mem::take(&mut *self.publishers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    /// Binds the section feed; a second bind is refused.
    pub fn bind(&self, threads: Arc<dyn ThreadState>) -> Result<(), Arc<dyn ThreadState>> {
        self.threads.set(threads)
    }

    fn held(&self) -> MutexGuard<'_, Vec<(ThreadId, Arc<HandoffQuestions>, QueueHandle)>> {
        self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The question branch of the thread's `finishToolApproval`: `None` when it holds no such copy.
    pub fn finish_question(&self, thread: &ThreadId, id: &str, answered: &Answered) -> Option<bool> {
        let queue = self.held().iter().find(|(owner, _, _)| owner == thread).map(|(_, queue, _)| queue.clone())?;
        queue.finish_question(id, answered)
    }
}

impl RuntimeHooks for HandoffQuestionsHub {
    fn started(&self, thread: &ThreadId) {
        let Some(threads) = self.threads.get() else { return };
        self.stopped(thread);
        let id = thread.as_str().to_owned();
        let (publisher, task) = SectionPublisher::start(threads.clone(), thread.clone());
        #[cfg(test)]
        self.publishers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(task);
        #[cfg(not(test))]
        drop(task);
        let queue = HandoffQuestions::new(Arc::new(move || id.clone()), Arc::new(publisher));
        let handle = self.host.register_queue(queue.clone());
        self.held().push((thread.clone(), queue.clone(), handle));
        for delegated in self.host.delegated_approvals_for(thread.as_str()) {
            queue.offer(&delegated);
        }
    }

    fn stopped(&self, thread: &ThreadId) {
        let gone = {
            let mut held = self.held();
            let at = held.iter().position(|(owner, _, _)| owner == thread);
            at.map(|at| held.remove(at))
        };
        if let Some((_, queue, handle)) = gone {
            queue.close();
            self.host.unregister_queue(&handle);
        }
    }
}
