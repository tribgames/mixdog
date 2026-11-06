//! The compaction hooks of a session (`session-hooks.mjs` `preCompactHook` / `postCompactHook`):
//! `PreCompact` and `PostCompact` over the hook bus. The payload is the bus's
//! ([`mixdog_mcp::hook_bus::HookBus::compact`], recorded from Node in
//! `mixdog-mcp/tests/golden/compact.json`); this layer supplies what the session knows: its
//! working directory and the common fields of its hook payloads (`hookCommonPayload`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_mcp::hook_bus::{HookBus, HookCommon};

/// A session's hook payload context: its working directory and common fields.
pub type SessionHookContext = Arc<dyn Fn(&ThreadId) -> (PathBuf, HookCommon) + Send + Sync>;

/// `session.preCompactHook({ trigger })` and `session.postCompactHook({ trigger })`. Best-effort
/// by contract: a hook never breaks a compaction, so neither returns anything.
#[async_trait]
pub trait CompactHooks: Send + Sync {
    async fn pre(&self, thread: &ThreadId, trigger: &str);
    async fn post(&self, thread: &ThreadId, trigger: &str);
}

pub struct BusCompactHooks {
    bus: Arc<HookBus>,
    context: SessionHookContext,
}

impl BusCompactHooks {
    pub fn new(bus: Arc<HookBus>, context: SessionHookContext) -> Self {
        Self { bus, context }
    }
}

#[async_trait]
impl CompactHooks for BusCompactHooks {
    async fn pre(&self, thread: &ThreadId, trigger: &str) {
        let (cwd, common) = (self.context)(thread);
        self.bus.compact(false, thread.as_str(), trigger, &cwd, &common).await;
    }

    async fn post(&self, thread: &ThreadId, trigger: &str) {
        let (cwd, common) = (self.context)(thread);
        self.bus.compact(true, thread.as_str(), trigger, &cwd, &common).await;
    }
}
