//! The settings reconcile every turn starts with (Node `await reconcileTurnSettings()` of the turn
//! preparation, `turn/turn-run/turn-prepare.mjs`): a gate that moved since the last turn reaches
//! this one through the thread's header, before the request is assembled.
//!
//! The settings host reads the session directory, which is built over the run factory that
//! calls it, so it is a late cell: bound once, after the directory exists. A turn that starts
//! before the bind fails with a typed text instead of running on stale gates.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;

use super::late::Bound;

/// What a turn start does to the thread's settings.
#[async_trait]
pub trait TurnSettings: Send + Sync + 'static {
    /// The thread's header once its settings follow the live ones: an empty thread (`conversation` false)
    /// that has a prompt identity is rebuilt whole, any other takes the moved tool gates and connectors
    /// without touching its prefix (`reconcileSession`).
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String>;

    /// `refreshDeferredMcpToolCatalog(session)`: the thread's MCP catalog follows the live registry. A host
    /// with no MCP catalog has nothing to refresh.
    async fn refresh_mcp(&self, _thread: &ThreadId) -> Result<(), String> {
        Ok(())
    }

    /// `awaitInitialMcpConnect()`: returns once the thread's initial MCP connect settled or its startup budget passed.
    /// A host with no MCP scope has nothing to wait for.
    async fn await_initial_mcp(&self, _thread: &ThreadId) {}

    /// `migrateToolExposureAtBoundary(session, messages)` at a request boundary: `rows` is the transcript the request is
    /// built from. The thread's header once migrated, `None` when there was nothing to migrate or a tool call waits for
    /// its result. A host with no deferred surface migrates nothing.
    async fn migrate_exposure(&self, _thread: &ThreadId, _rows: &[serde_json::Value]) -> Result<Option<Header>, String> {
        Ok(None)
    }

    /// `currentAgents()` (`agent-profile-fold.mjs`): the agents `header`'s Lead may delegate to now, as its prompt
    /// would list them, for the turn's agent list reminder; `None` for a session that gets none.
    async fn current_agents(&self, _thread: &ThreadId, _header: &Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, String> {
        Ok(None)
    }

    /// `orchestrationInstructions(mode)`: the text a carried orchestration mode notice ends with.
    async fn orchestration_instructions(&self, _mode: &str) -> Result<String, String> {
        Err("this host has no orchestration instructions".to_owned())
    }
}

/// The MCP catalog of one thread, refreshed through the turn settings.
pub struct SettingsMcp {
    pub settings: Arc<dyn TurnSettings>,
    pub thread: ThreadId,
}

#[async_trait]
impl mixdog_agent::env::McpCatalog for SettingsMcp {
    /// A refresh that fails is logged; like Node's (`catch` around the reconcile) it never breaks the call.
    async fn refresh(&self) {
        if let Err(error) = self.settings.refresh_mcp(&self.thread).await {
            tracing::warn!("[mcp] catalog refresh failed: {error}");
        }
    }
}

/// [`TurnSettings`] bound after the directory exists.
#[derive(Default)]
pub struct LateTurnSettings(OnceLock<Arc<dyn TurnSettings>>);

impl LateTurnSettings {
    /// Binds the host; a second bind is refused.
    pub fn bind(&self, host: Arc<dyn TurnSettings>) -> Result<(), Arc<dyn TurnSettings>> {
        self.0.set(host)
    }
}

#[async_trait]
impl TurnSettings for LateTurnSettings {
    async fn reconcile(&self, thread: &ThreadId, conversation: bool) -> Result<Header, String> {
        match self.0.get() {
            Some(host) => host.reconcile(thread, conversation).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }

    async fn refresh_mcp(&self, thread: &ThreadId) -> Result<(), String> {
        match self.0.get() {
            Some(host) => host.refresh_mcp(thread).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }

    async fn await_initial_mcp(&self, thread: &ThreadId) {
        if let Some(host) = self.0.get() {
            host.await_initial_mcp(thread).await;
        }
    }

    async fn migrate_exposure(&self, thread: &ThreadId, rows: &[serde_json::Value]) -> Result<Option<Header>, String> {
        match self.0.get() {
            Some(host) => host.migrate_exposure(thread, rows).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }

    async fn current_agents(&self, thread: &ThreadId, header: &Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, String> {
        match self.0.get() {
            Some(host) => host.current_agents(thread, header).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }

    async fn orchestration_instructions(&self, mode: &str) -> Result<String, String> {
        match self.0.get() {
            Some(host) => host.orchestration_instructions(mode).await,
            None => Err("the turn settings are not bound yet".to_owned()),
        }
    }
}

impl Bound for LateTurnSettings {
    fn cell(&self) -> &'static str {
        "turn settings"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed;

    #[async_trait]
    impl TurnSettings for Fixed {
        async fn reconcile(&self, _: &ThreadId, _: bool) -> Result<Header, String> {
            Ok(Header::from_iter([("fold".to_owned(), serde_json::Value::Bool(true))]))
        }
    }

    /// A turn before the bind fails with a text; after it the host's header is the turn's.
    #[tokio::test]
    async fn an_unbound_cell_refuses_the_turn_and_a_bound_one_answers() {
        let cell = LateTurnSettings::default();
        let thread = ThreadId::from("t1");
        assert!(!cell.is_bound());
        assert!(cell.reconcile(&thread, false).await.is_err());
        assert!(cell.bind(Arc::new(Fixed)).is_ok());
        assert!(cell.is_bound());
        assert_eq!(cell.reconcile(&thread, false).await.unwrap()["fold"], true);
        assert!(cell.bind(Arc::new(Fixed)).is_err(), "a second bind is refused");
    }
}