//! `GateSession` over the session runtime: what the policy gate reads from the owning session
//! on every call. The facts are Node's `actingBotId` / `actingContactBotId` / `agentIdForSession`
//! (`human-gate/gate.mjs`), `connectorPolicyAgentOf` (`mcp/agent-connectors.mjs`) and
//! `sessionLifeMark` (`human-gate/session-life.mjs`); the account is the binding
//! `tool-exec.mjs` makes before a connector call reaches a hook or a card.
//!
//! The session's state is read live: the header through [`LiveHeader`] (the actor's latest
//! acked header), the tool surface through the actor's `watch` of [`SessionSurface`], the rest
//! through [`GateEnv`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::BoundAccount;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateSession;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::RunKind;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;
use tokio::sync::watch;

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;

/// The unattended run that owns a session (`unattendedApprovalPort().runOf`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateRun {
    pub kind: RunKind,
    /// The run's owner; may be empty.
    pub agent_id: String,
}

/// The session's latest acked header, readable without waiting (the actor publishes it).
pub trait LiveHeader: Send + Sync {
    fn header(&self) -> Arc<Header>;
}

/// The state outside the session the gate reads.
#[async_trait]
pub trait GateEnv: Send + Sync {
    /// The unattended run that owns `thread`, if one does.
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun>;
    /// `isContactAgentId(id, readAgentDefinitionKind(id))`: the agent is a contact bot.
    async fn is_contact_bot(&self, agent_id: &str) -> bool;
    /// `developerOptionEnabledStrict('allowAllActions')`: unreadable or malformed is `false`.
    fn allow_all_actions(&self) -> bool;
    /// `resolveMcpToolAccount(name, args, { scopeId, conversation })`: the account a connector call
    /// is bound to, `Ok(None)` when its server holds none; `Err` is the refusal the model sees.
    async fn connector_account(&self, thread: &ThreadId, header: &Header, call: &GateCall) -> Result<Option<BoundAccount>, String>;
}

pub struct SessionGate {
    thread: ThreadId,
    header: Arc<dyn LiveHeader>,
    surface: watch::Receiver<Arc<SessionSurface>>,
    env: Arc<dyn GateEnv>,
}

impl SessionGate {
    pub fn new(
        thread: ThreadId,
        header: Arc<dyn LiveHeader>,
        surface: watch::Receiver<Arc<SessionSurface>>,
        env: Arc<dyn GateEnv>,
    ) -> Self {
        Self { thread, header, surface, env }
    }

    /// `ownBoundAgentId`: the unattended run's owner, a room member, a home thread's agent.
    async fn own_bound_agent(&self) -> String {
        if let Some(run) = self.env.run_of(&self.thread).await.filter(|run| !run.agent_id.is_empty()) {
            return run.agent_id;
        }
        let id = self.thread.as_str();
        room_member_of_session(id)
            .map(|member| member.agent_id)
            .or_else(|| agent_id_of_home_session(id))
            .unwrap_or_default()
    }

    /// `actingBotId`.
    async fn acting_bot(&self, bound: &str) -> Option<String> {
        if bound.is_empty() {
            return None;
        }
        (bound == MIXY_AGENT_ID || self.env.is_contact_bot(bound).await).then(|| bound.to_owned())
    }
}

fn clean(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

/// `connectorPolicyAgentOf`: a coding Lead shares Mixy's runtime id but is not her, so it has
/// no connector policy of its own.
fn connector_policy_agent(header: &Header) -> String {
    let agent = clean(header.get("agent"));
    if agent == MIXY_AGENT_ID && session_mode_of(header) != "agent" { String::new() } else { agent.to_owned() }
}

fn number_text(value: Option<&Value>) -> String {
    match value {
        Some(number @ Value::Number(_)) => mixdog_js::value_to_string(number),
        _ => "0".into(),
    }
}

/// `sessionLifeMark`: `createdAt:lastClearAt`, `None` once the session is closed.
fn life_mark(header: &Header) -> Option<String> {
    if header.get("closed") == Some(&Value::Bool(true)) {
        return None;
    }
    Some(format!(
        "{}:{}",
        number_text(header.get("createdAt")),
        number_text(header.get("compaction").and_then(|c| c.get("lastClearAt"))),
    ))
}

#[async_trait]
impl GateSession for SessionGate {
    fn connector_agent_id(&self) -> String {
        connector_policy_agent(&self.header.header())
    }

    async fn facts(&self) -> SessionFacts {
        let header = self.header.header();
        let bound = self.own_bound_agent().await;
        let acting_bot = self.acting_bot(&bound).await;
        SessionFacts {
            agent_id: if bound.is_empty() { MIXY_AGENT_ID.to_owned() } else { bound },
            contact_bot: acting_bot.clone().filter(|id| id != MIXY_AGENT_ID),
            acting_bot,
            connector_agent_id: connector_policy_agent(&header),
            run: self.env.run_of(&self.thread).await.map(|run| run.kind),
            life: life_mark(&header),
        }
    }

    fn surface(&self) -> SessionSurface {
        self.surface.borrow().as_ref().clone()
    }

    fn settings(&self) -> PolicySettings {
        PolicySettings { allow_all_actions: self.env.allow_all_actions() }
    }

    async fn account(&self, call: &GateCall) -> Result<Option<BoundAccount>, String> {
        if !call.name.starts_with("mcp__") {
            return Ok(None);
        }
        self.env.connector_account(&self.thread, &self.header.header(), call).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fixed(Arc<Header>);
    impl LiveHeader for Fixed {
        fn header(&self) -> Arc<Header> {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Env {
        run: Option<GateRun>,
        contacts: Vec<&'static str>,
        allow_all: bool,
    }
    #[async_trait]
    impl GateEnv for Env {
        async fn run_of(&self, _: &ThreadId) -> Option<GateRun> {
            self.run.clone()
        }
        async fn is_contact_bot(&self, id: &str) -> bool {
            self.contacts.contains(&id)
        }
        fn allow_all_actions(&self) -> bool {
            self.allow_all
        }
        async fn connector_account(&self, _: &ThreadId, _: &Header, call: &GateCall) -> Result<Option<BoundAccount>, String> {
            Ok(Some(BoundAccount { name: format!("name-of-{}", call.name), label: format!("acct-of-{}", call.name) }))
        }
    }

    fn gate(thread: &str, header: Value, env: Env) -> (SessionGate, watch::Sender<Arc<SessionSurface>>) {
        let (tx, rx) = watch::channel(Arc::new(SessionSurface::default()));
        let header = Arc::new(header.as_object().unwrap().clone());
        (SessionGate::new(ThreadId::from(thread), Arc::new(Fixed(header)), rx, Arc::new(env)), tx)
    }

    #[tokio::test]
    async fn a_coding_lead_is_no_bot_and_has_no_connector_policy() {
        let (g, _tx) = gate("sess_abc", json!({"agent": "lead", "createdAt": 5, "compaction": {"lastClearAt": 9}}), Env::default());
        let facts = g.facts().await;
        assert_eq!(facts.agent_id, "lead");
        assert_eq!(facts.acting_bot, None);
        assert_eq!(facts.connector_agent_id, "");
        assert_eq!(facts.life.as_deref(), Some("5:9"));
        assert!(facts.run.is_none());
    }

    #[tokio::test]
    async fn mixy_in_her_agent_mode_home_thread_is_the_acting_bot_with_her_own_policy() {
        let (g, _tx) = gate("sess_home_lead", json!({"agent": "lead", "sessionMode": "agent"}), Env::default());
        let facts = g.facts().await;
        assert_eq!(facts.acting_bot.as_deref(), Some("lead"));
        assert_eq!(facts.contact_bot, None);
        assert_eq!(facts.connector_agent_id, "lead");
        assert_eq!(facts.life.as_deref(), Some("0:0"));
    }

    #[tokio::test]
    async fn a_contact_bot_home_thread_and_a_room_seat_resolve_the_bot() {
        let env = || Env { contacts: vec!["ann"], ..Env::default() };
        let (home, _a) = gate("sess_home_ann", json!({"agent": "ann"}), env());
        assert_eq!(home.facts().await.contact_bot.as_deref(), Some("ann"));
        let (seat, _b) = gate("sess_rmem_abcdef_ann", json!({"agent": "ann"}), env());
        assert_eq!(seat.facts().await.acting_bot.as_deref(), Some("ann"));
        let (other, _c) = gate("sess_home_bob", json!({"agent": "bob"}), env());
        let facts = other.facts().await;
        assert_eq!((facts.agent_id.as_str(), facts.acting_bot), ("bob", None));
    }

    #[tokio::test]
    async fn an_unattended_run_owns_the_session_and_its_agent() {
        let env = Env { run: Some(GateRun { kind: RunKind::Schedule, agent_id: "ann".into() }), contacts: vec!["ann"], ..Env::default() };
        let (g, _tx) = gate("sess_task", json!({"agent": "worker"}), env);
        let facts = g.facts().await;
        assert_eq!(facts.run, Some(RunKind::Schedule));
        assert_eq!(facts.agent_id, "ann");
        assert_eq!(facts.contact_bot.as_deref(), Some("ann"));
        assert!(!facts.attended());
    }

    #[tokio::test]
    async fn a_closed_session_has_no_life_and_the_surface_and_settings_are_live() {
        let (g, tx) = gate("sess_x", json!({"closed": true}), Env { allow_all: true, ..Env::default() });
        assert_eq!(g.facts().await.life, None);
        assert!(g.settings().allow_all_actions);
        tx.send_replace(Arc::new(SessionSurface { readonly: true, ..SessionSurface::default() }));
        assert!(g.surface().readonly);
    }

    #[tokio::test]
    async fn only_connector_calls_have_an_account() {
        let (g, _tx) = gate("sess_x", json!({}), Env::default());
        assert_eq!(g.account(&GateCall::new("read", json!({}))).await, Ok(None));
        let bound = g.account(&GateCall::new("mcp__notion__search", json!({}))).await.unwrap().unwrap();
        assert_eq!((bound.name.as_str(), bound.label.as_str()), ("name-of-mcp__notion__search", "acct-of-mcp__notion__search"));
    }
}
