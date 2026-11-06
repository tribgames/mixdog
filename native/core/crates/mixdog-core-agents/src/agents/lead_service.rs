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

use super::AgentDefinitions;
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

    async fn status(&self) -> Result<Value, CoreError> {
        Ok(self.agents.lead_status().await.map_err(refused)?.to_json())
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
                self.status().await
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
