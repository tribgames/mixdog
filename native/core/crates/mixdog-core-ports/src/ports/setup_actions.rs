//! The setup dispatcher's ports: who the caller is and the owners' actions.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use mixdog_tools::orch::util::PortError;

/// `scheduleCallerScope`: who the calling session is. `agent_id` is the scope's `agentId`:
/// the agent the session is bound to (its provenance), or for an unattended run the agent
/// that run belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerScope {
    Human,
    Agent { agent_id: String, unattended: bool },
    RoomMember,
    Headless,
}

/// What the session layer knows about the caller of a setup call.
#[async_trait]
pub trait SetupCallers: Send + Sync {
    async fn scope(&self, thread: &ThreadId) -> CallerScope;
    /// Mixy's heartbeat session.
    async fn is_heartbeat(&self, thread: &ThreadId) -> bool;
    /// The agent a human's session acts as (`caller.agent`; the agent-id half of
    /// `resolveSessionMode`), empty when it acts as none. Added as a method rather than a
    /// `CallerScope` field because `CallerScope` is built in other owners' code; WP-SESSION's
    /// composition fills it. A thread that fails to open is Node's missing caller record: the
    /// call is refused as a background run.
    async fn acting_agent(&self, _thread: &ThreadId) -> Result<String, CoreError> {
        Ok(String::new())
    }
    /// Whether the session runs in agent mode (`resolveSessionMode(..).mode`): Mixy's or a
    /// contact's chat, not a coding task. A bot created from Mixy's agent-mode chat is a bot.
    async fn agent_mode(&self, _thread: &ThreadId) -> bool {
        false
    }
    /// `mixyDisplayName()`: the representative agent's name in messages.
    async fn mixy_name(&self) -> String {
        "Mixy".into()
    }
    /// `settingsReachCurrentSession()`: an empty session takes a changed global setting at its
    /// next turn start, a conversation keeps its own until a cold point.
    async fn settings_reach_session(&self, _thread: &ThreadId) -> bool {
        false
    }
}

/// The actions of one owner.
#[async_trait]
pub trait SetupActions: Send + Sync {
    fn actions(&self) -> &'static [&'static str];
    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError>;
}

pub struct SetupCall<'a> {
    pub action: &'a str,
    pub args: &'a Value,
    pub thread: &'a ThreadId,
}
