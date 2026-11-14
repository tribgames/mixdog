//! What `computer/bridge/run` is composed from: the computer pool, the one secret fill with its redactor, the one saved-login registry,
//! and the turn a saved-login fill is scoped to while the bridge runs one (the runtime's own turn number).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::secret_input::ComputerSecretHosts;
use mixdog_core_session::session::secret_input::Redact;
use mixdog_core_session::session::secret_input::SavedLoginRegistry;
use mixdog_core_session::session::secret_input::SavedLoginTurn;
use mixdog_core_session::session::secret_input::SavedLoginTurns;
use mixdog_core_session::session::secret_input::SecretFill;
use mixdog_tools::desktop::computer_bridge_run::BridgeHost;
use mixdog_tools::desktop::computer_bridge_run::BridgeSavedLogins;
use mixdog_tools::desktop::computer_bridge_run::BridgeSecrets;
use mixdog_tools::desktop::computer_bridge_run::FillTurns;
use serde_json::Map;
use serde_json::Value;

/// The pool the bridge's commands run on.
pub struct PoolBridgeHost(pub Arc<ComputerSessionPool>);

#[async_trait]
impl BridgeHost for PoolBridgeHost {
    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
        self.0.backend(session)
    }
    async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        let host = self.0.secret_host(&ThreadId::from(session)).ok_or("computer_capacity_exhausted: no helper is available for this session")?;
        host.execute(command).await
    }
    fn has_helper(&self, session: &str) -> bool {
        self.0.helper_pid(session).is_some()
    }
    async fn abort(&self, session: &str) -> bool {
        self.0.abort(session).await
    }
    async fn end_execution(&self, session: &str) -> bool {
        self.0.end_execution(session).await
    }
    async fn release(&self, session: &str) -> bool {
        self.0.release(session).await
    }
}

/// The one secret fill and the redactor that hides its values and the saved-login passwords.
pub struct FillBridgeSecrets {
    pub fill: Arc<SecretFill>,
    pub redactor: Arc<dyn Redact>,
}

#[async_trait]
impl BridgeSecrets for FillBridgeSecrets {
    fn bind(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String {
        self.fill.computer_bind(&ThreadId::from(session), request_id, window_id, reference)
    }
    async fn input(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String {
        self.fill.computer_input(&ThreadId::from(session), request_id, window_id, reference).await
    }
    fn redact(&self, session: &str, text: &str) -> String {
        self.redactor.redact(&ThreadId::from(session), text)
    }
    fn focus_armed(&self, session: &str) -> bool {
        self.fill.focus_armed(&ThreadId::from(session))
    }
    fn clear_focus(&self, session: &str) {
        self.fill.clear_focus(&ThreadId::from(session));
    }
}

/// The one registry of saved-login fills.
pub struct RegistryBridgeSavedLogins(pub Arc<SavedLoginRegistry>);

#[async_trait]
impl BridgeSavedLogins for RegistryBridgeSavedLogins {
    fn admit(&self, session: &str, turn: u64) -> Result<Box<dyn Send>, String> {
        self.0.admit(&SavedLoginTurn { session: session.to_owned(), turn }).map(|guard| Box::new(guard) as Box<dyn Send>)
    }
    async fn settle(&self, session: &str, turn: u64) {
        self.0.settle(&SavedLoginTurn { session: session.to_owned(), turn }).await;
    }
}

/// The turn source of a session's saved-login fills: the runtime's own turn while the bridge runs a fill of the session, else the core's count.
pub struct BridgeFillTurns {
    pub fills: Arc<FillTurns>,
    pub clock: Arc<dyn SavedLoginTurns>,
}

impl SavedLoginTurns for BridgeFillTurns {
    fn turn(&self, thread: &ThreadId) -> Option<u64> {
        self.fills.current(thread.as_str()).or_else(|| self.clock.turn(thread))
    }
}
