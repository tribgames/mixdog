//! The core's `OpIndex` (P §9.4): routes `op/status` to the gate of the asked scope.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ops::OpIndex;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;

use super::gate::OpGate;

/// The op gates of thread scopes, owned by the thread directory: a thread's gate belongs to
/// its actor, which writes the scope's records.
#[async_trait]
pub trait ThreadOpGates: Send + Sync {
    async fn gate(&self, thread: &ThreadId, ctx: &CallContext) -> Result<OpGate, CoreError>;
}

pub struct CoreOpIndex {
    /// Fixed at composition; read without a lock.
    domains: HashMap<Arc<str>, OpGate>,
    threads: Arc<dyn ThreadOpGates>,
}

impl CoreOpIndex {
    /// `domains` are the gates of the non-thread scopes (`config`, `account`, `agent`, …).
    pub fn new(domains: impl IntoIterator<Item = OpGate>, threads: Arc<dyn ThreadOpGates>) -> Self {
        let domains = domains
            .into_iter()
            .filter_map(|gate| match gate.scope() {
                OpScope::Domain(name) => Some((name.clone(), gate.clone())),
                OpScope::Thread(_) => None,
            })
            .collect();
        Self { domains, threads }
    }
}

#[async_trait]
impl OpIndex for CoreOpIndex {
    async fn status(
        &self,
        scope: &OpScope,
        ids: &[OpId],
        fence: bool,
        ctx: &CallContext,
    ) -> Result<Vec<OpStatus>, CoreError> {
        let gate = match scope {
            OpScope::Thread(thread) => self.threads.gate(thread, ctx).await?,
            OpScope::Domain(name) => {
                self.domains
                    .get(name)
                    .cloned()
                    .ok_or_else(|| CoreError::InvalidParams {
                        path: "scope".into(),
                        expected: "an op scope of this core".into(),
                    })?
            }
        };
        gate.status(ids, fence, ctx).await
    }
}
