//! The session-side ports of the domain services (`ai_admin` route actions, the quota card and
//! attachments): the domains own the callers, the session layer implements them.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

pub type Obj = Map<String, Value>;

/// `publishAgentRouteChange(agentId, route)`: settles once every host took the route; one
/// failing host never fails the save.
#[async_trait]
pub trait AgentRoutePublisher: Send + Sync {
    async fn publish(&self, agent_id: &str, route: &Value);
}

/// The failed turn that ended a transcript on exhausted provider quota
/// (`latestQuotaFailure(items)`).
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaFailure {
    pub turn_key: String,
    pub provider: String,
    pub model: String,
    /// `None` when the provider gave no reset time.
    pub reset_at: Option<Number>,
}

/// What `scheduleQuotaResume` reads of the addressed session.
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaFacts {
    /// `latestQuotaFailure(getState().items)`.
    pub failure: Option<QuotaFailure>,
    /// `hasResumeInput(failure.turnKey)`; false when there is no failure.
    pub resumable: bool,
    /// The session's own route (`sessionRoute()`): `routeProvider`, `routeModel`.
    pub route_provider: String,
    pub route_model: String,
}

/// The session side of the quota card (WP-SESSION): its transcript and the cancel epoch of its
/// resume lane.
#[async_trait]
pub trait QuotaResumeSessions: Send + Sync {
    async fn facts(&self, thread: &ThreadId) -> Result<QuotaFacts, CoreError>;
    /// `cancelEpoch += 1`: a cancel landing inside a failed turn's settlement also keeps the
    /// settlement from recording the Goal it suspended.
    async fn cancelled(&self, thread: &ThreadId) -> Result<(), CoreError>;
}

/// What a setup action reads of one session held here.
#[derive(Clone, Debug)]
pub struct SessionFacts {
    pub id: String,
    /// `resolveSessionMode({ session }).agentId || session.agent`: whose settings it runs on.
    pub acting_agent: String,
    /// The route it is on now (`provider`, `model`).
    pub current: Obj,
    /// `routeFallbackHopped(session)`.
    pub hopped: bool,
    /// The route a reset returns it to (`primaryRoute`): the one it left at its first hop, else
    /// its settings' route when that is still its primary.
    pub primary: Obj,
}

/// A calling conversation's fallback position, for the receipt of a chain edit.
#[derive(Clone, Debug)]
pub struct CallerChain {
    /// `routeFallbackPosition(caller, config)`.
    pub position: Value,
    /// `sameRouteModel(sessionChainSource(caller, config), sessionRoutePrimary(caller))`.
    pub source_is_primary: bool,
}

/// The live sessions of this process and the lane that reaches another one.
#[async_trait]
pub trait RouteSetupSessions: Send + Sync {
    /// `None` when the caller has no agent (it follows no chain).
    async fn caller_chain(&self, thread: &ThreadId, config: &Obj) -> Option<CallerChain>;
    /// An open session by id, held here or stored (`mgr.getSession`); `None` when it is absent or
    /// closed.
    async fn session(&self, id: &str, config: &Obj) -> Option<SessionFacts>;
    /// The open sessions of `agent`: those held here, then its home thread, from disk when it is
    /// not loaded.
    async fn agent_sessions(&self, agent: &str, config: &Obj) -> Vec<SessionFacts>;
    /// The daemon's configure lane (`executeSessionControl`, action `route`) on another session.
    async fn control(&self, caller: &ThreadId, session: &str, method: &str, input: Option<&Obj>) -> Result<Value, PortError>;
}

/// What a session's rows say about one attachment (`sessionAttachments`,
/// `transcript-file-links.ts`), as written on the row: the defaults and limits are applied here.
pub struct NamedAttachment {
    pub name: Option<String>,
    pub mime_type: Option<String>,
}

/// Whether the conversation of `session_id` names attachment `id`: the transcript window
/// first, then the session's whole stored history (`namedAttachment`).
#[async_trait]
pub trait SessionAttachments: Send + Sync {
    async fn named(&self, session_id: &str, id: &str) -> Option<NamedAttachment>;
}
