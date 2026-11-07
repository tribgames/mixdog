//! The production [`SpawnWorld`] of the agent tool: what `createSpawnPreparer`
//! (`agent-tool/spawn-flow/spawn-prep.mjs`), `createSpawnPlanner` (`spawn-plan.mjs`) and
//! `createDeferredSpawn` (`deferred-spawn.mjs`) borrow from the rest of the runtime, over the
//! daemon's canonical session surface (`standalone/session-service/agent-tree.mjs`). The daemon's
//! surface is canonical and creates children itself, so the in-process builder methods
//! (`ensure_provider`, `prepare_session`, `prewarm_transport`) are never reached and refuse.
//!
//! Spawn admission (`workspaceCwdLock`, `enterWorkerSpawn`) is `SpawnAdmission`
//! (`SessionWorkspaces`, wp-session-39), not this world.

use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::flow::world::{Created, Delegation, SpawnContext, SpawnWorld};
use mixdog_agent::agent_tool::host::{CloseOptions, Sessions};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_agents::agents::{AgentDefinitions, is_contact};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::hidden_agents::hidden_agent;
use mixdog_core_config::config::{Config, agent_disabled};
use mixdog_core_run::run_host::route_chain::{BotRoutes, route_candidates};
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::delegation::{acting_agent_of, delegation_chain, delegation_for_new_session};
use mixdog_core_session::session::route_session::RouteStatusline;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::run_policy::RunKind;
use serde_json::{Map, Value, json};

use super::agent_dispatch::PrepareSpec;
use super::agent_world::{RouteWindows, resolve_runtime_spec};
use super::dispatch_sessions::stamped_header;
use super::unattended::UnattendedRunRegistry;

/// `runOfSession(creator)` (`human-gate/delegation.mjs:96`): the schedule or webhook run a
/// session is, as `{ kind, agentId, name }`; a room member's own session is no run here.
#[async_trait]
pub trait SessionRuns: Send + Sync {
    async fn run_of(&self, session: &str) -> Option<Value>;
}

#[async_trait]
impl SessionRuns for UnattendedRunRegistry {
    async fn run_of(&self, session: &str) -> Option<Value> {
        let (run, name) = self.named_run_of(&ThreadId::from(session)).await?;
        let kind = match run.kind {
            RunKind::Schedule => "schedule",
            RunKind::Webhook => "webhook",
            RunKind::Room => return None,
        };
        Some(json!({ "kind": kind, "agentId": run.agent_id, "name": name }))
    }
}

/// The refusal of the in-process builder path: the daemon only creates workers through its
/// canonical surface.
const NO_IN_PROCESS_BUILDER: &str = "agent spawn: this daemon creates workers through its canonical session surface only";

pub struct DirectorySpawnWorld {
    pub config: Config,
    pub bots: Arc<dyn BotRoutes>,
    pub definitions: Arc<AgentDefinitions>,
    pub registry: Arc<AgentRegistry>,
    /// Closes a child whose parent was cancelled while it was created (`AgentSessions`).
    pub sessions: Arc<dyn Sessions>,
    pub directory: Arc<SessionDirectory>,
    pub providers: Arc<ProviderRegistry>,
    pub windows: Arc<dyn RouteWindows>,
    pub statusline: Arc<dyn RouteStatusline>,
    pub runs: Arc<dyn SessionRuns>,
    /// `mcpScopeId` of the spawn flow.
    pub mcp_scope_id: Option<String>,
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

/// `resolveAgentSessionPermission(agent, callerPermission)` (`internal-agents.mjs:164`): a hidden
/// agent declared `permission: read` is read-locked, whatever the caller asks; otherwise the
/// caller's permission, else the hidden agent's own, else none.
pub fn resolve_agent_session_permission(agent: &str, caller: Option<&str>) -> Option<String> {
    let own = hidden_agent(agent).and_then(|hidden| hidden.get("permission").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned));
    if own.as_deref() == Some("read") {
        return own;
    }
    caller.filter(|permission| !permission.is_empty()).map(str::to_owned).or(own)
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn row(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `bridgeRouteForStatusline(preset)` (`helpers.mjs:139`) in the shape the gateway store's
/// `statusline_section` reads: provider and model, the preset's id, name and display, its effort
/// and its fast flag. Nothing without a provider and a model.
pub fn statusline_route(preset: &Value) -> Option<Map<String, Value>> {
    let (provider, model) = (text(preset.get("provider")), text(preset.get("model")));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let mut route = Map::new();
    route.insert("provider".into(), json!(provider));
    route.insert("model".into(), json!(model));
    let effort = text(preset.get("effort"));
    if !effort.is_empty() {
        route.insert("effectiveEffort".into(), json!(effort));
    }
    let display = [preset.get("modelDisplay"), preset.get("display"), preset.get("displayName")]
        .into_iter()
        .map(text)
        .find(|shown| !shown.is_empty())
        .unwrap_or_default();
    let mut shown = Map::new();
    for (key, value) in [("id", text(preset.get("id"))), ("name", text(preset.get("name"))), ("modelDisplay", display)] {
        if !value.is_empty() {
            shown.insert(key.into(), json!(value));
        }
    }
    route.insert("preset".into(), Value::Object(shown));
    if let Some(fast) = preset.get("fast").and_then(Value::as_bool) {
        route.insert("fast".into(), json!(fast));
    }
    Some(route)
}

impl DirectorySpawnWorld {
    /// The header `createAgentChild` (`agent-child.mjs`) creates the child with: the record
    /// `prepareAgentSession` stamps (`stamped_header`), with the session profile the child adds
    /// (`agentTag`, `agent-only` visibility, the host pid, route fallbacks) and the delegation and
    /// run its creator gives it (`session-record.mjs:112-118`).
    async fn child_header(&self, spec: &Obj, parent: &str, owner: &str, tag: &str) -> Result<Header, String> {
        let preset = spec.get("preset").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        let (provider, model) = (text(preset.get("provider")).to_owned(), text(preset.get("model")));
        let provider = if provider.is_empty() { text(spec.get("provider")) } else { provider };
        let model = if model.is_empty() { text(spec.get("model")) } else { model };
        if provider.is_empty() || model.is_empty() {
            return Err("agent child route is incomplete".into());
        }
        let mut routed = preset.clone();
        routed["provider"] = json!(provider);
        routed["model"] = json!(model);
        let context: Map<String, Value> =
            ["contextPercent", "contextTokens", "selectedContextWindow"].iter().filter_map(|key| spec.get(*key).map(|v| ((*key).to_owned(), v.clone()))).collect();
        let agent = nonempty(text(spec.get("agent"))).unwrap_or_else(|| "worker".into());
        let prepare = PrepareSpec {
            agent: agent.clone(),
            preset_name: text(spec.get("presetName")),
            preset: routed,
            runtime_spec: spec.get("runtimeSpec").cloned().unwrap_or_else(|| json!({})),
            context,
            // `prepareAgentSession`: `resolveAgentSessionPermission(agent, permission)`
            // (`session-builder.mjs:93`).
            permission: resolve_agent_session_permission(&agent, spec.get("permission").and_then(Value::as_str)),
            cwd: nonempty(text(spec.get("cwd"))),
            source_type: Some(nonempty(text(spec.get("sourceType"))).unwrap_or_else(|| "agent".into())),
            source_name: Some(nonempty(text(spec.get("sourceName"))).unwrap_or_else(|| agent.clone())),
            task_type: nonempty(text(spec.get("taskType"))),
            parent_session_id: Some(parent.to_owned()),
            owner_session_id: Some(owner.to_owned()),
            skip_role_reminder: false,
            schema_allowed_tools: spec.get("schemaAllowedTools").and_then(Value::as_array).map(|tools| tools.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
        };
        let mut header = stamped_header(&prepare, |name| self.providers.registered(name).is_some())?;
        header.insert("visibility".into(), json!("agent-only"));
        let tag = nonempty(text(spec.get("agentTag"))).or_else(|| nonempty(tag.to_owned()));
        header.insert("agentTag".into(), tag.map_or(Value::Null, Value::String));
        header.insert("clientHostPid".into(), spec.get("clientHostPid").filter(|pid| pid.as_u64().is_some_and(|p| p > 0)).cloned().unwrap_or(Value::Null));
        header.insert("mcpScopeId".into(), self.mcp_scope_id.clone().map_or(Value::Null, Value::String));
        if let Some(mode) = nonempty(text(spec.get("permissionMode"))) {
            header.insert("permissionMode".into(), json!(mode));
        }
        if let Some(fallbacks) = preset.get("fallbacks") {
            header.insert("routeFallbacks".into(), fallbacks.clone());
        }
        if let Some(source) = preset.get("fallbackSource").filter(|s| mixdog_ai::service::admin_route::truthy(Some(s))) {
            header.insert("routeFallbackSource".into(), source.clone());
        }
        if let Some(delegation) = delegation_for_new_session(&header, "", &*self.directory).await {
            header.insert("delegation".into(), delegation);
        }
        if let Some(run) = self.runs.run_of(parent).await {
            header.insert("run".into(), run);
        }
        Ok(header)
    }
}

#[async_trait]
impl SpawnWorld for DirectorySpawnWorld {
    /// `flushPendingSessionConfigWrites()` then `cfgMod.loadConfig()` (`spawn-plan.mjs:46-48`):
    /// every config write is awaited by its writer here, so nothing is pending to flush.
    async fn load_config(&self) -> Result<Obj, String> {
        Ok(self.config.agent())
    }

    fn loaded_config(&self) -> Option<Obj> {
        Some(self.config.agent())
    }

    /// `configuredAgentRouteCandidates` (`agent-route-config.mjs:150`).
    async fn route_candidates(&self, config: &Obj, agent: &str) -> Result<Vec<Value>, String> {
        route_candidates(config, agent, &*self.bots).await.map_err(|error| error.to_string())
    }

    /// `agentDefinitionExists` (`helpers.mjs:409`).
    async fn agent_defined(&self, agent: &str) -> Result<bool, String> {
        let id = mixdog_js::js_trim(agent);
        if id.is_empty() {
            return Ok(false);
        }
        self.definitions.load(id).await.map(|definition| definition.is_some()).map_err(|error| error.to_string())
    }

    /// `isAgentDisabled` (`agent-route-config.mjs:119`).
    fn agent_disabled(&self, config: &Obj, agent: &str) -> bool {
        agent_disabled(config, agent)
    }

    /// `readAgentFrontmatterKind` (`helpers.mjs:378`).
    async fn agent_kind(&self, agent: &str) -> Result<Option<String>, String> {
        let id = mixdog_js::js_trim(agent);
        if id.is_empty() {
            return Ok(None);
        }
        self.definitions.definition_kind(id).await.map_err(|error| error.to_string())
    }

    /// `isContactAgentId` (`agent-route-config.mjs:40`).
    fn is_contact_agent(&self, agent: &str, kind: Option<&str>) -> bool {
        is_contact(agent, kind)
    }

    /// `delegationChainOf(callerId, getSession)` and `actingAgentOf(getSession(callerId), callerId)`
    /// (`spawn-plan.mjs:60-63`, `bot-chain.mjs`).
    fn delegation(&self, caller_id: &str) -> Delegation {
        let get = |id: &str| self.registry.session_row(id).map(Value::Object);
        let turn_bots = |id: &str| self.directory.turn_bot_chain(&ThreadId::from(id));
        let chain = delegation_chain(caller_id, &get, &turn_bots);
        let acting = acting_agent_of(get(caller_id).as_ref(), caller_id);
        Delegation { chain, acting }
    }

    /// `normalizeAgentPermission(readAgentFrontmatterPermission(agent))` (`spawn-plan.mjs:64`).
    async fn agent_permission(&self, agent: &str) -> Result<Option<Value>, String> {
        let id = mixdog_js::js_trim(agent);
        if id.is_empty() {
            return Ok(None);
        }
        let definition = self.definitions.load(id).await.map_err(|error| error.to_string())?;
        Ok(definition.and_then(|definition| definition.permission).map(Value::String))
    }

    /// `nextTag(agent, context)` (`tag-lookup.mjs:101`).
    fn next_tag(&self, agent: &str, context: &SpawnContext) -> String {
        self.registry.next_tag(agent, &context.scope())
    }

    fn resolve_runtime_spec(&self, preset: &Value, tag: &str) -> Value {
        resolve_runtime_spec(preset, tag)
    }

    fn route_window_meta(&self, provider: &str, model: &str) -> Option<Value> {
        self.windows.window_meta(provider, model)
    }

    fn canonical_surface(&self) -> bool {
        true
    }

    fn can_create_child(&self) -> bool {
        true
    }

    /// `prewarmGitStartupProbes([cwd])`: the Rust session composes its git startup line on a lane,
    /// never on the runtime thread, so there is no synchronous composition to warm for.
    fn prewarm_git_probes(&self, _cwd: &str) -> BoxFuture<'static, ()> {
        futures::future::ready(()).boxed()
    }

    /// `createAgentChild({ spec, tag })` (`agent-child.mjs`).
    async fn create_child(&self, spec: &Obj, _prompt: &str, tag: &str) -> Result<Created, String> {
        let parent = text(spec.get("parentSessionId"));
        if parent.is_empty() {
            return Err("agent child parentSessionId is required".into());
        }
        // `registry.assertAdmission(parentSessionId)` (`agent-child.mjs:11`): a parent being
        // cancelled gets no new child.
        let parent_epoch = self.registry.assert_admission(&parent, None)?;
        let owner = nonempty(text(spec.get("ownerSessionId")))
            .or_else(|| self.registry.session_row(&parent).and_then(|session| nonempty(text(session.get("ownerSessionId")))))
            .unwrap_or_else(|| parent.clone());
        let mut header = self.child_header(spec, &parent, &owner, tag).await?;
        let now = json!(self.directory.deps().clock.now_ms());
        for key in ["createdAt", "updatedAt", "lastUsedAt"] {
            header.insert(key.into(), now.clone());
        }
        let id = self.directory.create_session(header.clone(), json!({})).await.map_err(|error| format!("{error:?}"))?;
        // The parent was cancelled while the session was being created (`agent-child.mjs:51-69`):
        // close the child like any cancelled child instead of leaving it unlinked and open.
        if let Err(cancelled) = self.registry.assert_admission(&parent, Some(parent_epoch)) {
            self.sessions
                .close_session(id.as_str(), "parent cancelled during agent creation", CloseOptions { tombstone: false, owner_close: false })
                .await;
            return Err(cancelled);
        }
        let cwd = nonempty(text(spec.get("cwd")));
        let mut session = header;
        session.insert("id".into(), json!(id.as_str()));
        session.insert("status".into(), json!("idle"));
        session.insert("stage".into(), json!("idle"));
        Ok(Created { session: Value::Object(session), effective_cwd: cwd })
    }

    async fn ensure_provider(&self, _config: &Obj, _provider: &str) -> Result<(), String> {
        Err(NO_IN_PROCESS_BUILDER.into())
    }

    async fn prepare_session(&self, _spec: &Obj) -> Result<Created, String> {
        Err(NO_IN_PROCESS_BUILDER.into())
    }

    /// `writeAgentStatuslineRoute(sessionId, preset)` (`helpers.mjs:184`).
    fn write_statusline_route(&self, session_id: &str, preset: &Value) {
        if session_id.is_empty() {
            return;
        }
        if let Some(route) = statusline_route(preset) {
            self.statusline.write(session_id, &route, None);
        }
    }

    /// `bindTag(tag, session, descriptor)` (`tag-registry.mjs:98`).
    fn bind_tag(&self, tag: &str, session: &Value, descriptor: &Obj) {
        self.registry.bind_tag_row(tag, &row(session), descriptor);
    }

    /// Only the in-process path prewarms (`spawn-prep.mjs:121`); the canonical surface never does.
    fn prewarm_transport(&self, _provider: &str, _session: &Value) {}

    /// `upsertWorkerSessionDeferred(session, tag, row)`.
    fn upsert_worker_row(&self, session: &Value, tag: &str, worker: &Obj) {
        self.registry.upsert_worker_row(&row(session), tag, worker);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `bridgeRouteForStatusline` through the gateway store's section: provider/model required,
    /// the display falls back through `display` and `displayName`, fast only when boolean.
    /// `internal-agents.mjs:164`: a read-locked internal agent keeps `read`; a user agent takes the
    /// caller's permission or none.
    #[test]
    fn a_session_takes_the_callers_permission_unless_its_internal_agent_is_read_locked() {
        assert_eq!(resolve_agent_session_permission("my-agent", Some("full")), Some("full".into()));
        assert_eq!(resolve_agent_session_permission("my-agent", Some("")), None);
        assert_eq!(resolve_agent_session_permission("my-agent", None), None);
        let locked = ["cycle1-agent", "title-agent"].into_iter().find(|name| hidden_agent(name).and_then(|h| h.get("permission").cloned()) == Some(json!("read")));
        if let Some(name) = locked {
            assert_eq!(resolve_agent_session_permission(name, Some("full")), Some("read".into()));
        }
    }

    #[test]
    fn the_statusline_route_is_the_presets_provider_model_and_display() {
        let route = statusline_route(&json!({ "provider": " p ", "model": "m", "id": "i", "name": "N", "displayName": "Shown", "effort": "high", "fast": false })).unwrap();
        let section = mixdog_core_session::session::gateway_routes::statusline_section(&route).unwrap();
        assert_eq!(
            Value::Object(section),
            json!({ "mode": "fixed", "defaultProvider": "p", "defaultModel": "m", "presetId": "i", "presetName": "N", "effort": "high", "displayEffort": "high", "modelDisplay": "Shown", "fast": false })
        );
        assert!(statusline_route(&json!({ "provider": "p" })).is_none());
        assert!(!statusline_route(&json!({ "provider": "p", "model": "m", "fast": "yes" })).unwrap().contains_key("fast"));
    }
}
