//! The `agent/` methods of Mixy's identity: the persona and way-of-working files, the status
//! (`created`, name, face, home chat, route), the home route and the shared Lead appearance.
//! [`AgentService`](super::AgentService) claims the definition methods; these ten are this
//! service's. A mutation is one op (`opId`); a read answers at once.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::AgentGetLeadAgentBodyParams;
use mixdog_app_protocol::v2::params::AgentGetLeadAppearanceParams;
use mixdog_app_protocol::v2::params::AgentGetLeadHomeRouteParams;
use mixdog_app_protocol::v2::params::AgentGetLeadPersonaParams;
use mixdog_app_protocol::v2::params::AgentGetLeadStatusParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use serde_json::Value;

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;

use super::AgentDefinitions;
use super::AgentHomeSessions;
use super::AgentsError;
use super::lead::AGENT_FILE;
use super::lead::LeadAppearance;
use super::lead::PERSONA_FILE;

const DOMAIN: &str = "agent";

pub const LEAD_METHODS: &[&str] = &[
    "agent/getLeadPersona",
    "agent/getLeadAgentBody",
    "agent/getLeadStatus",
    "agent/getLeadHomeRoute",
    "agent/getLeadAppearance",
    "agent/saveLeadPersona",
    "agent/saveLeadAgentBody",
    "agent/setLeadCreated",
    "agent/saveLeadIdentity",
    "agent/setLeadAppearance",
];

pub struct LeadService {
    agents: Arc<AgentDefinitions>,
    appearance: LeadAppearance,
    ops: OpScopes,
}

/// The argument `key` as sent; an absent one is JavaScript's `undefined`, which every Node
/// function reads like `null`.
fn arg<'a>(req: &'a CoreRequest, key: &str) -> &'a Value {
    static ABSENT: Value = Value::Null;
    req.params.get(key).unwrap_or(&ABSENT)
}

fn refused(error: AgentsError) -> CoreError {
    match error {
        AgentsError::Lane(error) => error,
        other => failed(DOMAIN, other.to_string()),
    }
}

impl LeadService {
    pub fn new(agents: Arc<AgentDefinitions>, appearance: LeadAppearance, ops: OpScopes) -> Self {
        Self { agents, appearance, ops }
    }

    async fn file(&self, file: &'static str) -> Result<Value, CoreError> {
        self.agents.lead_file(file).await.map(Value::String).map_err(refused)
    }

    pub(super) async fn status(&self) -> Result<Value, CoreError> {
        Ok(self.agents.lead_status().await.map_err(refused)?.to_json())
    }

    /// `withMixyExists` (`tui/session/session-api/routes-agent-definitions.mjs`): the read of
    /// `getLeadStatus` adds `exists`, the one rule; `null` when her routines cannot be read. The
    /// mutations answer the bare status.
    async fn status_with_exists(&self) -> Result<Value, CoreError> {
        let mut status = self.status().await?;
        status["exists"] = self.agents.mixy_exists().await.map_or(Value::Null, Value::Bool);
        Ok(status)
    }

    async fn read(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        match req.method.as_str() {
            "agent/getLeadPersona" => {
                decode::<AgentGetLeadPersonaParams>(req)?;
                self.file(PERSONA_FILE).await
            }
            "agent/getLeadAgentBody" => {
                decode::<AgentGetLeadAgentBodyParams>(req)?;
                self.file(AGENT_FILE).await
            }
            "agent/getLeadStatus" => {
                decode::<AgentGetLeadStatusParams>(req)?;
                self.status_with_exists().await
            }
            "agent/getLeadHomeRoute" => {
                decode::<AgentGetLeadHomeRouteParams>(req)?;
                self.agents.mixy_home_route().await.map_err(refused)
            }
            "agent/getLeadAppearance" => {
                decode::<AgentGetLeadAppearanceParams>(req)?;
                Ok(self.appearance.get())
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    /// The mutation `req` carries, with what re-reads its answer for a duplicate whose stored
    /// result was too large.
    async fn mutate(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        match req.method.as_str() {
            // The arguments go to Node's functions as the caller sent them: `String(text ?? '')`,
            // `typeof created !== 'boolean'` and `oneLine(description)` judge them, not a typed
            // decode (a number is a persona text, a string is not a `created`).
            "agent/saveLeadPersona" => self.agents.save_lead_file(PERSONA_FILE, arg(req, "text")).await.map(Value::String).map_err(refused),
            "agent/saveLeadAgentBody" => self.agents.save_lead_file(AGENT_FILE, arg(req, "text")).await.map(Value::String).map_err(refused),
            "agent/setLeadCreated" => self.agents.set_lead_created(arg(req, "created"), arg(req, "description")).await.map_err(refused),
            "agent/saveLeadIdentity" => {
                // `saveLeadIdentity(payload = {})`: only an absent payload defaults.
                let payload = req.params.get("payload").cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                self.agents.save_lead_identity(&payload).await.map_err(refused)
            }
            "agent/setLeadAppearance" => self.appearance.set(arg(req, "avatar")).await.map_err(refused),
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    async fn reproduce(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        match req.method.as_str() {
            "agent/saveLeadPersona" => self.file(PERSONA_FILE).await,
            "agent/saveLeadAgentBody" => self.file(AGENT_FILE).await,
            "agent/setLeadAppearance" => Ok(self.appearance.get()),
            _ => self.status().await,
        }
    }
}

/// The lead methods as the desktop window asks them: `getLeadStatus` carries whether Mixy exists (`withMixyExists`
/// of the runtime's route) and the once-per-profile `created` decision (`leadStatus` of `session-host-lifecycle.ts`,
/// `resolveMixyCreated` of `mixy-first.ts`); every other method is [`LeadService`]'s own.
pub struct DesktopLeadStatus {
    inner: LeadService,
    agents: Arc<AgentDefinitions>,
    homes: AgentHomeSessions,
}

/// `resolveMixyCreated`: whether Mixy exists, and the `created` flag to persist when the profile has none yet (her home
/// thread or evidence of her marks it created, so the answer is unchanged by the decision). Refused when `exists` could
/// not be read: no answer, and nothing decided.
fn mixy_decision(exists: Option<bool>, created: Option<bool>, existing: bool) -> Result<(bool, Option<bool>), CoreError> {
    let Some(exists) = exists else { return Err(failed(DOMAIN, "Mixy's status could not be read.")) };
    Ok((exists, created.is_none().then_some(existing || exists)))
}

impl DesktopLeadStatus {
    pub fn new(inner: LeadService, agents: Arc<AgentDefinitions>, homes: AgentHomeSessions) -> Self {
        Self { inner, agents, homes }
    }

    /// The raw status with `exists`, and `created` as the window shows it (the same fact).
    async fn resolved(&self) -> Result<Value, CoreError> {
        let mut status = self.inner.status().await?;
        let created = status.get("created").and_then(Value::as_bool);
        let name = status.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let chatted = status.get("homeChatted") == Some(&Value::Bool(true));
        // `withMixyExists`: the one rule, unknown when it could not be read.
        let exists = self.agents.mixy_exists_of(created, &name, chatted).await.ok();
        let existing = if exists.is_some() && created.is_none() { self.homes.has_home(MIXY_AGENT_ID).await? } else { false };
        let (exists, persist) = mixy_decision(exists, created, existing)?;
        if let Some(created) = persist {
            self.agents.set_lead_created(&Value::Bool(created), &Value::Null).await.map_err(refused)?;
        }
        if let Some(fields) = status.as_object_mut() {
            fields.insert("exists".to_owned(), Value::Bool(exists));
            fields.insert("created".to_owned(), Value::Bool(exists));
        }
        Ok(status)
    }
}

#[async_trait]
impl DomainService for DesktopLeadStatus {
    fn methods(&self) -> &'static [&'static str] {
        self.inner.methods()
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != "agent/getLeadStatus" {
            return self.inner.call(req).await;
        }
        decode::<AgentGetLeadStatusParams>(&req)?;
        self.resolved().await.map(Reply::Value)
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        self.inner.notify(method, params, from)
    }
}

#[async_trait]
impl DomainService for LeadService {
    fn methods(&self) -> &'static [&'static str] {
        LEAD_METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str().starts_with("agent/get") {
            return self.read(&req).await.map(Reply::Value);
        }
        self.ops.run(&req, None, || self.mutate(&req), || self.reproduce(&req)).await
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The decisions Node's `resolveMixyCreated` made (`agent-lifecycle-twin.json` `statusRuns`).
    #[test]
    fn the_created_decision_is_what_node_decided() {
        let twin: Value = serde_json::from_str(include_str!("../../../../fixtures/desktop/settings/agent-lifecycle-twin.json")).unwrap();
        let runs = twin["statusRuns"].as_array().unwrap();
        assert!(runs.len() > 30);
        for run in runs {
            let (exists, created) = (run["status"]["exists"].as_bool(), run["status"]["created"].as_bool());
            let existing = run["sessions"].as_array().unwrap().iter().any(|id| id == "sess_home_lead");
            let asked = run["setCreated"].as_array().unwrap().clone();
            match (mixy_decision(exists, created, existing), run.get("error")) {
                (Ok((got, persist)), None) => {
                    assert_eq!(Value::Bool(got), run["result"], "{run}");
                    assert_eq!(persist.into_iter().map(Value::Bool).collect::<Vec<_>>(), asked, "{run}");
                }
                (Err(CoreError::DomainError { message: Some(got), .. }), Some(want)) => {
                    assert_eq!(Value::String(got.to_string()), *want, "{run}");
                    assert!(asked.is_empty(), "nothing is decided when it could not be read: {run}");
                }
                (got, want) => panic!("{run}: got {got:?}, Node {want:?}"),
            }
        }
    }
}