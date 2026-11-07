//! The tool surface a route change rebuilds (Node `resetSessionForRouteChange`, after the
//! provider reset: the prepared tools, the model's edit dialect in the deferred catalogs and name
//! lists, then `applyAgentToolExposure(session, { existing: true })`).
//!
//! The session is its header with the freshly prepared tools; the result is the header diff.
//! Rewriting the prompt's own messages (manifest block, rules variant) stays with the adapter.

use std::sync::Arc;

use mixdog_agent::env::Clock;
use mixdog_ai::catalog::CatalogService;
use mixdog_store::schema::record::{Header, HeaderChange};
use serde_json::{Map, Value};

use mixdog_core_ports::ports::route::Route;

use super::deferred_manifest::apply_initial_manifest;
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use super::route_change::RouteFacts;
use super::session_cache_opts::session_provider_cache_opts;
use mixdog_core_run::run_host::session_context_meta::session_context_meta;
use super::tool_exposure::{
    bridge_surface_outdated, session_tool_exposure, tool_exposure_mode_for_provider, LoadToolDef, TOOL_EXPOSURE_BRIDGE, TOOL_EXPOSURE_NATIVE,
};
use super::tool_migration::mark_tool_surface_migrated;
use super::tool_surface::{clean, filter_model_edit_tool_names, filter_model_edit_tools, ApplyOptions, SurfaceHost, ToolSurface};

/// `AGENT_BRIDGE_FIELDS`: what a bridge surface adds, gone when an agent leaves it.
const AGENT_BRIDGE_FIELDS: [&str; 14] = [
    "toolExposureMode",
    "deferredProviderMode",
    "deferredNativeTools",
    "deferredSurfaceMode",
    "deferredToolUsage",
    "deferredDefaultTools",
    "deferredSelectedTools",
    "deferredDiscoveredTools",
    "deferredCallableTools",
    "deferredAnnouncedTools",
    "deferredToolDeltaRevision",
    "nativeDeferredDiscovery",
    "mcpServerInstructions",
    "mcpInstructionsAnnounced",
];

/// `_prepareResumeTools`' output: the resolved tool list and its spec.
pub struct PreparedTools {
    pub tools: Value,
    pub tool_spec: Value,
}

pub(super) fn is_agent_owner(session: &Value) -> bool {
    session.get("owner").map(|o| clean(Some(o)).to_lowercase()).as_deref() == Some("agent")
}

pub(super) fn load_tool_def(host: &dyn SurfaceHost) -> LoadToolDef {
    host.bridge_tools().iter().find(|t| t.get("name").and_then(Value::as_str) == Some("load_tool")).map_or_else(
        || LoadToolDef { description: String::new(), input_schema: Value::Null },
        LoadToolDef::from_def,
    )
}

/// `applyAgentToolExposure(session, { existing: true })`: whether the exposure changed.
/// `hidden_agent` is `getHiddenAgent(session.agent)`: a hidden agent honors a schema allowlist.
fn apply_agent_tool_exposure(surface: &ToolSurface, session: &mut Value, hidden_agent: bool) -> bool {
    if !session.get("tools").is_some_and(Value::is_array) || !is_agent_owner(session) {
        return false;
    }
    let before = session_tool_exposure(session);
    let allowlisted = session.get("schemaAllowedTools").is_some_and(Value::is_array) && hidden_agent;
    let route = session.get("wireRoute").cloned();
    let bridge = !allowlisted && tool_exposure_mode_for_provider(&clean(session.get("provider")), route.as_ref()) == TOOL_EXPOSURE_BRIDGE;
    if !bridge && before.is_none() {
        return false;
    }
    let options = |session: &Value| ApplyOptions { provider: Some(clean(session.get("provider"))), model: Some(clean(session.get("model"))), disallowed: Vec::new() };
    if !bridge && before.as_deref() == Some(TOOL_EXPOSURE_NATIVE) {
        let mode = session.get("deferredSurfaceMode").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("full").to_owned();
        let opts = options(session);
        surface.apply(session, &mode, &[], &opts);
        return false;
    }
    let outdated = bridge_surface_outdated(session, &load_tool_def(surface.host));
    let map = session.as_object_mut().expect("session object");
    for key in ["deferredToolCatalog", "deferredLateToolCatalog", "deferredMcpToolNames", "pendingDeferredToolDelta"] {
        map.shift_remove(key);
    }
    if bridge {
        let opts = options(session);
        surface.apply(session, "full", &[], &opts);
    } else {
        for field in AGENT_BRIDGE_FIELDS {
            map.shift_remove(field);
        }
        if session.get("messages").is_some_and(Value::is_array) {
            apply_initial_manifest(session, &[], true, surface.clock);
        }
        session.as_object_mut().expect("session object").shift_remove("deferredToolBp2Applied");
    }
    before != session_tool_exposure(session) || outdated
}

/// What turns `header` into `after`, the messages aside.
pub(super) fn header_diff(header: &Header, after: &Map<String, Value>) -> HeaderChange {
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new() };
    for (key, value) in after {
        if key != "messages" && header.get(key) != Some(value) {
            change.set.insert(key.clone(), value.clone());
        }
    }
    change.unset = header.keys().filter(|k| *k != "messages" && !after.contains_key(*k)).cloned().collect();
    change
}

/// Whether `previous` is no route at all: the thread is being seated on its first one.
pub fn is_first_route(previous: &Route) -> bool {
    ["provider", "model"].iter().all(|key| clean(previous.get(*key)).is_empty())
}

/// The header change of a route change's tool surface: `header` already names the new route. A thread seated on its
/// first route (`previous` names none) has no surface to rebuild: `thread/start` seeded it for that route, as
/// `createSession` resolves it with the route already on the session. Preparing the tools again would store the whole
/// resolved list over the deferred surface (a Lead is no agent, so `applyAgentToolExposure` does not select again),
/// and nothing rebuilds it before the first request.
pub fn route_surface_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, previous: &Route, prepared: Option<PreparedTools>, hidden_agent: bool) -> HeaderChange {
    if is_first_route(previous) {
        return HeaderChange { set: Map::new(), unset: Vec::new() };
    }
    let mut session = Value::Object(header.clone());
    let model = clean(header.get("model"));
    if let Some(prepared) = prepared {
        session["tools"] = prepared.tools;
        session["toolSpec"] = prepared.tool_spec;
    }
    for key in ["deferredToolCatalog", "deferredLateToolCatalog"] {
        if let Some(items) = session.get(key).and_then(Value::as_array) {
            session[key] = Value::Array(filter_model_edit_tools(items, &model));
        }
    }
    for key in ["deferredSelectedTools", "deferredCallableTools", "deferredDefaultTools", "deferredDiscoveredTools"] {
        if let Some(items) = session.get(key).and_then(Value::as_array) {
            let names: Vec<String> = items.iter().map(|v| clean(Some(v))).collect();
            session[key] = Value::Array(filter_model_edit_tool_names(&names, &model).into_iter().map(Value::String).collect());
        }
    }
    exposure_change(surface, clock, header, session, hidden_agent)
}

/// `_refreshResumedTools(session, sessionId, preset)` (`session-lifecycle.mjs:598-620`): the
/// prepared tools and spec, then `applyAgentToolExposure(session, { existing: true })`, as the
/// header change of a resumed session. The tools the stored list had that the new surface does not
/// offer (its catalog included) are logged, as Node warns.
pub fn resumed_surface_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, prepared: PreparedTools, hidden_agent: bool) -> HeaderChange {
    let old: Vec<String> = header.get("tools").and_then(Value::as_array).map(|tools| tools.iter().map(|t| clean(t.get("name"))).collect()).unwrap_or_default();
    let mut session = Value::Object(header.clone());
    session["toolSpec"] = prepared.tool_spec;
    session["tools"] = prepared.tools;
    let change = exposure_change(surface, clock, header, session.clone(), hidden_agent);
    let mut after = session;
    for key in &change.unset {
        after.as_object_mut().expect("session object").shift_remove(key);
    }
    for (key, value) in &change.set {
        after[key] = value.clone();
    }
    let available: Vec<String> = ["tools", "deferredToolCatalog"]
        .iter()
        .flat_map(|key| after.get(*key).and_then(Value::as_array).cloned().unwrap_or_default())
        .map(|tool| clean(tool.get("name")))
        .filter(|name| !name.is_empty())
        .collect();
    let missing: Vec<&String> = old.iter().filter(|name| !available.contains(name)).collect();
    if !missing.is_empty() {
        let names: Vec<&str> = missing.iter().map(|name| name.as_str()).collect();
        tracing::warn!("[session] Warning: {} tools no longer available: {}", missing.len(), names.join(", "));
    }
    change
}

/// `applyAgentToolExposure(session, { existing: true })` over `session` (the header with its new
/// tools), as the header change from `header`; a changed exposure is marked migrated.
fn exposure_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, mut session: Value, hidden_agent: bool) -> HeaderChange {
    let changed = apply_agent_tool_exposure(surface, &mut session, hidden_agent);
    let mut change = header_diff(header, session.as_object().expect("session object"));
    if changed {
        let migrated = mark_tool_surface_migrated(clock, None, None).change;
        for key in migrated.unset {
            change.set.shift_remove(&key);
            if !change.unset.contains(&key) {
                change.unset.push(key);
            }
        }
        for (key, value) in migrated.set {
            change.unset.retain(|k| *k != key);
            change.set.insert(key, value);
        }
    }
    change
}

/// `_prepareResumeTools(session, preset)`: the tool list the session resolves to on its new route,
/// read from a skill list collected now (Node collects inside the call). `None`: the tools could
/// not be resolved; the stored ones stay.
#[async_trait::async_trait]
pub trait PrepareTools: Send + Sync {
    async fn prepare(&self, header: &Header) -> Option<PreparedTools>;
}

/// The route facts of the running host: the catalog's context windows, the configured cache
/// policy and the tool surface a route change rebuilds.
pub struct AiRouteFacts {
    pub catalog: Arc<CatalogService>,
    /// The config's `autoClear` section, read at each call: Node loads it per `buildSessionProviderCacheOpts`, so a settings change reaches the next route change.
    pub auto_clear: Arc<dyn Fn() -> Value + Send + Sync>,
    pub surface_host: Arc<dyn SurfaceHost>,
    pub clock: Arc<dyn Clock>,
    /// `_prepareResumeTools` for the header's new route (`resume_tools::ResumeTools`).
    pub prepare_tools: Arc<dyn PrepareTools>,
    /// `getHiddenAgent(agent)`.
    pub hidden_agent: Arc<dyn Fn(Option<&str>) -> bool + Send + Sync>,
}

#[async_trait::async_trait]
impl RouteFacts for AiRouteFacts {
    fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta> {
        session_context_meta(&self.catalog, provider, model, seed)
    }

    fn cache_opts(&self, provider: &str, session_id: &str, agent: Option<&str>, header: &Header) -> Option<Value> {
        session_provider_cache_opts(provider, session_id, agent, header, &(self.auto_clear)())
    }

    async fn surface_change(&self, header: &Header, previous: &Route) -> HeaderChange {
        let prepared = if is_first_route(previous) { None } else { self.prepare_tools.prepare(header).await };
        let surface = ToolSurface { host: self.surface_host.as_ref(), clock: self.clock.as_ref() };
        let agent = header.get("agent").and_then(Value::as_str);
        route_surface_change(&surface, self.clock.as_ref(), header, previous, prepared, (self.hidden_agent)(agent))
    }
}

/// `SessionDeps.resumed_tools`: `_refreshResumedTools(session, sessionId, session.preset || 'full')`
/// with the same producer a route change uses.
#[async_trait::async_trait]
impl mixdog_core_session::session::ResumedTools for AiRouteFacts {
    async fn refreshed(&self, _thread: &mixdog_core_api::ids::ThreadId, header: &Header) -> Option<HeaderChange> {
        let prepared = self.prepare_tools.prepare(header).await?;
        let surface = ToolSurface { host: self.surface_host.as_ref(), clock: self.clock.as_ref() };
        let agent = header.get("agent").and_then(Value::as_str);
        Some(resumed_surface_change(&surface, self.clock.as_ref(), header, prepared, (self.hidden_agent)(agent)))
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::run_host::rules::{build_base_rules, refresh_rule_variants, RulesPolicy};

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct Host(Vec<Value>);
    impl SurfaceHost for Host {
        fn bridge_tools(&self) -> Vec<Value> {
            self.0.clone()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            json!({})
        }
    }

    struct Policy;
    impl RulesPolicy for Policy {
        fn hidden_agent(&self, _: Option<&str>) -> bool {
            false
        }
        fn delegation_disabled(&self, _: &Value, _: bool) -> bool {
            false
        }
    }

    fn without_messages(value: &Value) -> Map<String, Value> {
        value.as_object().unwrap().iter().filter(|(k, _)| *k != "messages").map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Node's `applyAgentToolExposure(session, { existing: true })` over the deferred-surface
    /// sessions, owned by an agent and by a lead, with and without a schema allowlist.
    #[test]
    fn the_route_surface_follows_node() {
        let surface_golden: Value = serde_json::from_str(include_str!("golden/tool_surface.json")).expect("fixture");
        let golden: Value = serde_json::from_str(include_str!("golden/route_surface_variant.json")).expect("fixture");
        let host = Host(surface_golden["bridgeTools"].as_array().unwrap().clone());
        let surface = ToolSurface { host: &host, clock: &Fixed };
        for row in golden["surface"].as_array().unwrap() {
            if row["changed"].is_string() {
                continue;
            }
            let header = row["before"].as_object().unwrap().clone();
            let previous = Route::from_iter([("provider".to_owned(), json!("previous")), ("model".to_owned(), json!("previous"))]);
            let change = route_surface_change(&surface, &Fixed, &header, &previous, None, false);
            let mut got = header.clone();
            for key in &change.unset {
                got.shift_remove(key);
            }
            for (key, value) in change.set {
                got.insert(key, value);
            }
            assert_eq!(without_messages(&Value::Object(got)), without_messages(&row["after"]), "{} {}", row["name"], row["before"]["owner"]);
        }
    }

    /// Node's `_refreshSessionRuleVariantsForModel` over every route pair, with the block untagged
    /// (replaced) and tagged (left alone), and a denied tool.
    #[test]
    fn the_rules_variant_follows_node() {
        let rules: Value = serde_json::from_str(include_str!("golden/rules_builder.json")).expect("fixture");
        let golden: Value = serde_json::from_str(include_str!("golden/route_surface_variant.json")).expect("fixture");
        let root = std::path::PathBuf::from(std::env::var("TEMP").unwrap_or_else(|_| ".".into())).join(format!("variant-golden-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, body) in rules["files"].as_object().unwrap() {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body.as_str().unwrap()).unwrap();
        }
        let _ = build_base_rules;
        for row in golden["variant"].as_array().unwrap() {
            let mut session = row["before"].clone();
            let changed = refresh_rule_variants(&mut session, &root, row["previousModel"].as_str().unwrap(), row["previousProvider"].as_str(), &Policy);
            assert_eq!(Value::Bool(changed), row["changed"], "{}", row["before"]);
            assert_eq!(session, row["after"], "{}", row["before"]);
        }
    }
}