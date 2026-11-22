//! Who can still deliver a completion to a session. A completion receipt (`mixdog_store::completion_receipts`) is asked
//! about only by the producer of its execution delivering the result again: the agent board re-announcing a finished job, a
//! restart notice retried until it is stored, a shell job this runtime holds. A session keeps a receipt while one of them
//! holds the execution and lets it go after.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::exec::ExecRuntime;

use super::agent_registry::AgentRegistry;

/// What the producers answer of the executions they hold for a session. `T`: how an execution is named.
#[derive(Clone, Debug, PartialEq)]
pub enum Holding<T> {
    /// These, and no other.
    Held(T),
    /// Not listed this time (a read that failed): nothing is let go of, and the question is worth asking again later.
    Later,
    /// Never listed by this process (the start could not settle what the last process left): nothing is let go of
    /// until the next start, and asking again changes nothing.
    Never,
}

/// The executions whose completion can still be delivered to a session.
#[async_trait]
pub trait HeldCompletions: Send + Sync {
    /// The execution ids held for `owner`. Answered once the producers can tell: a start still settling what the last
    /// process left is waited for, not answered around.
    async fn held(&self, owner: &ThreadId) -> Holding<Vec<String>>;
}

/// The producers, bound once they exist: a session composed before them asks through this.
#[derive(Default)]
pub struct CompletionHolders(OnceLock<Arc<dyn HeldCompletions>>);

impl CompletionHolders {
    pub fn bind(&self, holders: Arc<dyn HeldCompletions>) -> Result<(), &'static str> {
        self.0.set(holders).map_err(|_| "the completion holders are already bound")
    }

    pub(crate) fn bound(&self) -> Option<Arc<dyn HeldCompletions>> {
        self.0.get().cloned()
    }
}

/// The receipt ids of the executions `holders` holds for `owner`.
pub(crate) async fn held_receipts(holders: &dyn HeldCompletions, owner: &ThreadId) -> Holding<HashSet<String>> {
    match holders.held(owner).await {
        Holding::Held(held) => Holding::Held(held.iter().map(|execution| mixdog_store::completion_receipts::queue_id(execution, "")).collect()),
        Holding::Later => Holding::Later,
        Holding::Never => Holding::Never,
    }
}

/// The daemon's producers: the agent rows and board, and the shell runtime.
pub struct ProducerHolds {
    pub registry: Arc<AgentRegistry>,
    pub board: JobBoard,
    pub shells: Arc<ExecRuntime>,
}

#[async_trait]
impl HeldCompletions for ProducerHolds {
    async fn held(&self, owner: &ThreadId) -> Holding<Vec<String>> {
        let Some(mut held) = self.shells.held_by(owner).await else { return Holding::Never };
        match self.registry.held_notices(owner.as_str()).await {
            Ok(rows) => held.extend(rows),
            Err(error) => {
                tracing::warn!("[session] the agent rows of {} could not be listed; its completion receipts stay: {error}", owner.as_str());
                return Holding::Later;
            }
        }
        held.extend(self.board.held_by(owner.as_str()));
        Holding::Held(held)
    }
}
