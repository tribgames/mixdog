//! The session side of Mixy's heartbeat wake (`mixy-heartbeat.mjs` `wakeMixy`): her hidden
//! session is created and closed here, the Lead route read, and her reply handed to the
//! home-chat delivery queue. A close that did not land is the runner's to keep and retry
//! (`keepUnreleased`, `retryReleases` over this close).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::clean;
use mixdog_ai::service::admin_route::truthy;
use mixdog_app_protocol::v2::thread::ThreadSessionOptions;
use mixdog_core_domains::domains::ai_admin::chain::RouteContext;
use mixdog_services::bots::WakeHost;
use mixdog_services::bots::delivery::home::AgentHomeDelivery;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::close::SessionClose;

/// `closeHiddenSession`'s close reason.
const CLOSE_REASON: &str = "heartbeat-finished";

/// `modelRouteFields(route)` (`schedule-model-ref.mjs`).
pub fn model_route_fields(route: &Map<String, Value>) -> Value {
    let mut fields = Map::new();
    fields.insert("provider".into(), route.get("provider").cloned().unwrap_or(Value::Null));
    fields.insert("model".into(), route.get("model").cloned().unwrap_or(Value::Null));
    if truthy(route.get("effort")) {
        fields.insert("effort".into(), route["effort"].clone());
    }
    if route.get("fast") == Some(&Value::Bool(true)) {
        fields.insert("fast".into(), json!(true));
    }
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        fields.insert("autoEffort".into(), json!(false));
    }
    if truthy(route.get("modelParameters")) {
        fields.insert("modelParameters".into(), route["modelParameters"].clone());
    }
    Value::Object(fields)
}

/// The header `createSession({ ...route, sessionProfile })` records for a session whose profile
/// is not agent-owned (`session-options.mjs` `sessionOptions`, the fields the session runtime
/// reads), in `thread/start`'s form.
pub fn hidden_session_header(route: &Value, profile: &Value, now_ms: i64) -> Header {
    let mut header = Header::new();
    header.insert("createdAt".into(), json!(now_ms));
    header.insert("updatedAt".into(), json!(now_ms));
    super::session_options::write_header(&ThreadSessionOptions::default(), &mut header);
    header.insert("provider".into(), route.get("provider").cloned().unwrap_or(Value::Null));
    header.insert("model".into(), route.get("model").cloned().unwrap_or(Value::Null));
    header.insert("owner".into(), json!("cli"));
    header.insert("agent".into(), json!("lead"));
    header.insert("lane".into(), json!("cli"));
    let exec = profile.get("sourceType").and_then(Value::as_str) == Some("exec");
    header.insert("sourceType".into(), json!(if exec { "exec" } else { "lead" }));
    let name = clean(profile.get("sourceName"));
    header.insert("sourceName".into(), json!(if name.is_empty() { "main".to_owned() } else { name }));
    let owner_agent = clean(profile.get("ownerAgentId"));
    if !owner_agent.is_empty() {
        header.insert("ownerAgentId".into(), json!(owner_agent));
    }
    let pid = profile.get("clientHostPid").filter(|pid| truthy(Some(pid))).cloned();
    header.insert("clientHostPid".into(), pid.unwrap_or_else(|| json!(std::process::id())));
    header.insert("fast".into(), json!(route.get("fast") == Some(&Value::Bool(true))));
    header.insert("autoEffort".into(), json!(route.get("autoEffort") != Some(&Value::Bool(false))));
    let params = route.get("modelParameters").filter(|p| truthy(Some(p))).cloned();
    header.insert("modelParameters".into(), params.unwrap_or_else(|| json!({})));
    header.insert("contextTokens".into(), Value::Null);
    header.insert("selectedContextWindow".into(), Value::Null);
    if let Some(effort) = route.get("effort") {
        header.insert("effort".into(), if truthy(Some(effort)) { effort.clone() } else { Value::Null });
    }
    let mode = mixdog_store::agent_mode::session_mode_of(&header);
    header.insert("sessionMode".into(), json!(mode));
    header
}

/// [`WakeHost`] over the session directory.
pub struct SessionWakeHost {
    directory: Arc<SessionDirectory>,
    close: Arc<SessionClose>,
    routes: Arc<dyn RouteContext>,
    messages: Arc<AgentHomeDelivery>,
}

impl SessionWakeHost {
    /// `routes`: the runtime's route context (`resolveRoute(config, {})`); `messages`: the home
    /// chats' delivery (`deliverAgentMessage`); `close`: the tombstoning close.
    pub fn new(
        directory: Arc<SessionDirectory>,
        close: Arc<SessionClose>,
        routes: Arc<dyn RouteContext>,
        messages: Arc<AgentHomeDelivery>,
    ) -> Self {
        Self { close, directory, routes, messages }
    }
}

#[async_trait]
impl WakeHost for SessionWakeHost {
    /// The session service is the directory, which lives as long as the core.
    fn session_service_running(&self) -> bool {
        true
    }

    /// `configLeadRoute()`: the Main route's fields, `None` while it names no provider and model.
    async fn lead_route(&self) -> Result<Option<Value>, String> {
        let route = self.routes.resolve_main()?;
        let chosen = !clean(route.get("provider")).is_empty() && !clean(route.get("model")).is_empty();
        Ok(chosen.then(|| model_route_fields(&route)))
    }

    async fn create_hidden_session(&self, lead: &Value, profile: &Value) -> Result<String, String> {
        let header = hidden_session_header(lead, profile, self.directory.deps().clock.now_ms());
        let mut params = lead.as_object().cloned().unwrap_or_default();
        params.insert("sessionProfile".into(), profile.clone());
        let id = self.directory.create_session(header, Value::Object(params)).await.map_err(|e| format!("{e:?}"))?;
        Ok(id.as_str().to_owned())
    }

    /// `closeSession(id, 'heartbeat-finished')`.
    async fn close_hidden_session(&self, session_id: &str) -> Result<bool, String> {
        Ok(self.close.close(session_id, CLOSE_REASON).await)
    }

    async fn deliver(&self, agent_id: &str, run_id: &str, text: &str) -> Result<(), String> {
        self.messages.enqueue_message(agent_id, run_id, text).await.map(drop)
    }
}

#[cfg(test)]
#[path = "heartbeat_host_tests.rs"]
mod tests;
