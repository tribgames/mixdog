//! The inputs of the agent registry and the worker-turn observer that the purge hooks hold
//! (`PurgeOwners.agents`, `PurgeOwners.worker_turns`) and that exist before the session directory:
//!
//! - [`ConfigReap`]: `ReapWindow`, Node's `resolveAgentTerminalReapMs(config, provider)` over the live
//!   config's `autoClear` section (`agent_terminal_reap_ms`).
//! - [`LateLiveSessions`] and [`LateTurnSource`]: the directory's own `LiveSessions` and `TurnSource`
//!   through the late directory. The purge hooks are part of what the directory is built from, so
//!   the registry cannot hold the built directory. Unbound nothing is loaded and no session
//!   reports turns, which is what Node's registry sees before any session runtime exists; the
//!   composition verifies the directory before the listener accepts.

use std::sync::Arc;

use mixdog_agent::agent_tool::flow::seams::{TurnListener, TurnSource, Unobserve};
use mixdog_agent::compact::settings::agent_terminal_reap_ms;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::agent_registry::{LiveSessions, ReapWindow, Row};

use super::compose_parts::LateDirectory;

/// `resolveAgentTerminalReapMs(config, provider)`.
pub struct ConfigReap {
    config: Config,
}

impl ConfigReap {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

impl ReapWindow for ConfigReap {
    fn terminal_reap_ms(&self, provider: &str) -> f64 {
        agent_terminal_reap_ms(self.config.agent().get("autoClear"), provider)
    }
}

/// The registry's view of the loaded sessions.
pub struct LateLiveSessions(pub Arc<LateDirectory>);

impl LiveSessions for LateLiveSessions {
    fn loaded(&self) -> Vec<String> {
        self.0.directory().map(|directory| LiveSessions::loaded(&*directory)).unwrap_or_default()
    }

    fn header(&self, session: &str) -> Option<Row> {
        LiveSessions::header(&*self.0.directory()?, session)
    }

    fn running(&self, session: &str) -> bool {
        self.0.directory().is_some_and(|directory| LiveSessions::running(&*directory, session))
    }

    fn has_live_work(&self, session: &str) -> bool {
        self.0.directory().is_some_and(|directory| LiveSessions::has_live_work(&*directory, session))
    }

    fn runtime_stage(&self, session: &str) -> Option<String> {
        LiveSessions::runtime_stage(&*self.0.directory()?, session)
    }
}

/// `observeSessionTurns` through the late directory.
pub struct LateTurnSource(pub Arc<LateDirectory>);

impl TurnSource for LateTurnSource {
    fn observe_session_turns(&self, session_id: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve> {
        self.0.directory()?.observe_session_turns(session_id, listener)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_unbound_directory_has_no_sessions_and_no_turns() {
        let late = Arc::new(LateDirectory::default());
        let live = LateLiveSessions(late.clone());
        assert!(live.loaded().is_empty() && live.header("s").is_none() && !live.running("s") && !live.has_live_work("s"));
        assert!(live.runtime_stage("s").is_none());
        struct Quiet;
        impl TurnListener for Quiet {
            fn turn_started(&self, _: mixdog_agent::agent_tool::flow::seams::TurnStart) {}
            fn turn_settled(&self, _: mixdog_agent::agent_tool::flow::seams::TurnOutcome) {}
        }
        assert!(LateTurnSource(late).observe_session_turns("s", Arc::new(Quiet)).is_none());
    }

    /// `resolveAgentTerminalReapMs`: openai-oauth keeps the finite hour its unlimited cache needs, a
    /// provider with an override uses it, an unknown provider the `default` row.
    #[test]
    fn the_reap_window_is_the_agent_terminal_retention() {
        let hour = 3_600_000.0;
        assert_eq!(agent_terminal_reap_ms(None, "openai-oauth"), hour);
        let section = json!({ "providerIdleMs": { "openai": 120_000, "default": 180_000 } });
        assert_eq!(agent_terminal_reap_ms(Some(&section), "openai"), 120_000.0);
        assert_eq!(agent_terminal_reap_ms(Some(&section), "nowhere"), 180_000.0);
    }
}
