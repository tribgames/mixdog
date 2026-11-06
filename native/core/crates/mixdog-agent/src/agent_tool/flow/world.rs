//! What the spawn and send flows borrow from the rest of the runtime beyond a worker's turn
//! (see [`super::seams`]): the config and agent definitions, the session surface that creates a
//! worker, the worker row and the session manager's queues. WP-SESSION implements these. Each
//! method is one Node collaborator of `createSpawnPreparer`, `createDeferredSpawn` or
//! `createSendFlow`; the decisions around them are the port.

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_ai::service::admin_route::Obj;
use serde_json::Value;

use crate::agent_tool::scope::Caller;
use crate::agent_tool::scope::Scope;
use crate::agent_tool::scope::clean_str;

/// The caller of a spawn, as the tool's context object carries it.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct SpawnContext {
    pub caller_session_id: Option<String>,
    pub session_id: Option<String>,
    pub owner_session_id: Option<String>,
    pub client_host_pid: Option<u64>,
}

fn first_set(values: &[&Option<String>]) -> String {
    values.iter().filter_map(|v| v.as_deref()).find(|v| !v.is_empty()).map(clean_str).unwrap_or_default()
}

impl SpawnContext {
    /// `clean(context.callerSessionId || context.sessionId)`.
    pub fn caller_id(&self) -> String {
        first_set(&[&self.caller_session_id, &self.session_id])
    }

    /// `clean(context.ownerSessionId)`, else the caller.
    pub fn owner_id(&self) -> String {
        let own = first_set(&[&self.owner_session_id]);
        if own.is_empty() { self.caller_id() } else { own }
    }

    /// The scope tag lookups run in.
    pub fn scope(&self) -> Scope {
        let caller = self.caller_id();
        Scope { caller_session_id: (!caller.is_empty()).then_some(caller), host_pid: self.client_host_pid }
    }
}

impl From<&Caller> for SpawnContext {
    fn from(caller: &Caller) -> Self {
        // A tool call's context (call-prep.mjs) carries the calling session as both its
        // callerSessionId and its sessionId and no ownerSessionId: an owner is named only by the
        // wake and restart paths, which build their SpawnContext themselves.
        Self {
            caller_session_id: caller.scope.caller_session_id.clone(),
            session_id: caller.scope.caller_session_id.clone(),
            owner_session_id: None,
            client_host_pid: caller.scope.host_pid,
        }
    }
}

/// A session a surface created for a spawn: the session as the runtime holds it, and the
/// directory it ended up working in when that is not the one asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Created {
    pub session: Value,
    pub effective_cwd: Option<String>,
}

/// The agents a delegation passed through and the one acting now.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Delegation {
    pub chain: Vec<String>,
    pub acting: String,
}

#[async_trait]
pub trait SpawnWorld: Send + Sync {
    /// The saved configuration, after the settings a runtime adopted a moment ago are written.
    async fn load_config(&self) -> Result<Obj, String>;
    /// `cfgMod.loadConfig()` as it stands now, with no flush (a pending card's best effort).
    fn loaded_config(&self) -> Option<Obj>;
    /// `configuredAgentRouteCandidates(config, agent)`.
    fn route_candidates(&self, config: &Obj, agent: &str) -> Vec<Value>;
    /// An agent has a definition (not deleted).
    fn agent_defined(&self, agent: &str) -> bool;
    /// `isAgentDisabled(config, agent)`.
    fn agent_disabled(&self, config: &Obj, agent: &str) -> bool;
    /// The definition's `kind`.
    fn agent_kind(&self, agent: &str) -> Option<String>;
    /// `isContactAgentId(agent, kind)`.
    fn is_contact_agent(&self, agent: &str, kind: Option<&str>) -> bool;
    /// The delegation chain `caller_id` acts in and the agent it acts as.
    fn delegation(&self, caller_id: &str) -> Delegation;
    /// The definition's permission, normalized; `None` when it sets none.
    fn agent_permission(&self, agent: &str) -> Option<Value>;
    /// The execution root a Lead in a worktree locks its workers to.
    fn workspace_cwd_lock(&self, owner_ids: &[String]) -> Option<String>;
    /// Held while a worker is prepared: no Lead workspace transition runs in the meantime.
    fn enter_worker_spawn(&self, owner_ids: &[String]) -> Box<dyn Send>;
    fn next_tag(&self, agent: &str, context: &SpawnContext) -> String;
    /// `cfgMod.resolveRuntimeSpec(preset, { lane: 'agent', agentId: tag })`.
    fn resolve_runtime_spec(&self, preset: &Value, tag: &str) -> Value;
    /// The cached provider row of a model: `contextWindow` / `maxContextWindow`.
    fn route_window_meta(&self, provider: &str, model: &str) -> Option<Value>;
    /// The session surface is the canonical runtime.
    fn canonical_surface(&self) -> bool;
    /// The surface creates a worker session itself (`createChild`).
    fn can_create_child(&self) -> bool;
    /// Starts the git startup probes of `cwd`; the future settles when they have answered.
    fn prewarm_git_probes(&self, cwd: &str) -> BoxFuture<'static, ()>;
    async fn create_child(&self, spec: &Obj, prompt: &str, tag: &str) -> Result<Created, String>;
    async fn ensure_provider(&self, config: &Obj, provider: &str) -> Result<(), String>;
    /// `prepareAgentSession(spec)`: the session built in this process.
    async fn prepare_session(&self, spec: &Obj) -> Result<Created, String>;
    fn write_statusline_route(&self, session_id: &str, preset: &Value);
    fn bind_tag(&self, tag: &str, session: &Value, descriptor: &Obj);
    /// Opens the session's pooled transport ahead of its first turn (best effort).
    fn prewarm_transport(&self, provider: &str, session: &Value);
    /// `upsertWorkerSessionDeferred(session, tag, row)`.
    fn upsert_worker_row(&self, session: &Value, tag: &str, row: &Obj);
}

/// A worker session reused by a `send`, and the manager and surface that hold it.
#[async_trait]
pub trait SendWorld: Send + Sync {
    /// `mgr.getSession(id)`: the session as the runtime holds it.
    fn session(&self, session_id: &str) -> Option<Value>;
    /// `canUseSessionSurface(session)`: the surface runs this session.
    fn surface_runs(&self, session: &Value) -> bool;
    /// `sessionSurface.canonical === true`.
    fn canonical_surface(&self) -> bool;
    /// `views.isSessionBusy(id)`.
    fn is_busy(&self, session_id: &str) -> bool;
    /// `cfgMod.loadConfig()` after the pending writes are flushed; `None` without a config module.
    async fn load_config(&self) -> Result<Option<Obj>, String>;
    fn route_candidates(&self, config: &Obj, agent: &str) -> Vec<Value>;
    /// The surface can change a reused session's model (`setRoute`).
    fn can_set_route(&self) -> bool;
    async fn set_route(&self, session: &Value, route: &Value) -> Result<(), String>;
    /// `mgr.updateSessionRoute`: an in-process session takes the route in place, between turns.
    fn update_session_route(&self, session_id: &str, route: &Value, session: &Value, cross_provider: bool);
    /// `mgr.holdSessionRoute(id, route)`: `None` drops the hold.
    fn hold_session_route(&self, session_id: &str, route: Option<&Value>);
    /// The surface queues a prompt behind the running turn; the queue's own fields on success.
    async fn enqueue_turn(&self, session: &Value, prompt: &str, attachments: &[Value], context: Option<&Value>) -> Option<Value>;
    /// `mgr.enqueuePendingMessage`: the queue depth; `None` when the manager has no such queue.
    fn enqueue_pending(&self, session_id: &str, prompt: &str, attachments: &[Value]) -> Option<u64>;
    /// The calling session hands the worker new work: from now on it acts as the caller does.
    fn rebind_delegation(&self, session_id: &str, caller_session_id: Option<&str>);
}
