// Transparent callback/state names; existing ownership and call signatures are unchanged.
type HiddenAgentLookup = dyn Fn(Option<&str>) -> bool + Send + Sync;

use std::sync::Arc;

use mixdog_agent::env::Clock;
use mixdog_ai::catalog::CatalogService;
use mixdog_core_session::session::thread_settings::tool_spec_for_mode;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_store::schema::record::{Header, HeaderChange};
use serde_json::{Map, Value};

use mixdog_core_ports::ports::route::Route;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;

use super::deferred_manifest::apply_initial_manifest;
use super::route_change::{RouteFacts, SurfaceLookup};
use super::session_cache_opts::route_cache_opts;
use super::session_tools::header_scope;
use super::surface_host::thread_mode;
use super::tool_exposure::{
    LoadToolDef, TOOL_EXPOSURE_BRIDGE, TOOL_EXPOSURE_NATIVE, bridge_surface_outdated, session_tool_exposure, tool_exposure_mode_for_provider,
};
use super::tool_migration::mark_tool_surface_migrated;
use super::tool_surface::{ApplyOptions, SurfaceHost, ToolSurface, clean, filter_model_edit_tool_names, filter_model_edit_tools};
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use mixdog_core_run::run_host::session_context_meta::session_context_meta;

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
    host.bridge_tools()
        .iter()
        .find(|t| t.get("name").and_then(Value::as_str) == Some("load_tool"))
        .map_or_else(|| LoadToolDef { description: String::new(), input_schema: Value::Null }, LoadToolDef::from_def)
}

/// `applyAgentToolExposure(session, { existing: true })`: whether the exposure changed.
/// `hidden_agent` is `getHiddenAgent(session.agent)`: a hidden agent honors a schema allowlist.
fn apply_agent_tool_exposure(surface: &ToolSurface, session: &mut Value, hidden_agent: bool, blocks: &SystemBlocks) -> bool {
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
    let options =
        |session: &Value| ApplyOptions { provider: Some(clean(session.get("provider"))), model: Some(clean(session.get("model"))), disallowed: Vec::new() };
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
    let bridged = before.as_deref() == Some(TOOL_EXPOSURE_BRIDGE);
    if bridge {
        // A surface that leaves another exposure for the bridge is written with its prompt: the surface rewrites the
        // roster and the bridge guidance in the session's system messages, which a header holds as its blocks.
        let entering = before.is_some() && !bridged;
        if entering {
            session["messages"] = Value::Array(blocks.node_messages());
        }
        let opts = options(session);
        surface.apply(session, "full", &[], &opts);
        if entering {
            land_bridge_prompt(session, blocks);
        }
    } else {
        for field in AGENT_BRIDGE_FIELDS {
            map.shift_remove(field);
        }
        let kept = map.shift_remove(PROMPT_BEFORE_BRIDGE);
        if bridged && !kept.is_some_and(|kept| restore_prompt(map, &kept)) {
            // No text of an earlier exposure to return to: the bridge's roster and guidance leave the prompt.
            session["messages"] = Value::Array(blocks.node_messages());
            apply_initial_manifest(session, &[], true, surface.clock);
            land_prompt_blocks(session, blocks);
        }
        session.as_object_mut().expect("session object").shift_remove("deferredToolBp2Applied");
    }
    before != session_tool_exposure(session) || outdated
}

/// The prompt blocks a move to the bridge rewrote, as they were (`before`) and as it left them (`after`), by header key;
/// `null` is a block that is not there. A return to an exposure without the bridge puts `before` back while the prompt
/// is still `after`, so the route the session came from is sent the text it was sent before.
const PROMPT_BEFORE_BRIDGE: &str = "promptBeforeBridge";

fn prompt_keys() -> [&'static str; 5] {
    use mixdog_core_prompt::prompt::blocks::{BASE_KEY, CORE_KEY, ENV_KEY, STABLE_KEY, TIER3_KEY};
    [BASE_KEY, STABLE_KEY, CORE_KEY, TIER3_KEY, ENV_KEY]
}

/// The system messages the surface worked on, taken out of `session` and written back as its blocks where they changed.
fn land_prompt_blocks(session: &mut Value, blocks: &SystemBlocks) {
    let map = session.as_object_mut().expect("session object");
    let Some(Value::Array(messages)) = map.shift_remove("messages") else { return };
    let Ok(mut rebuilt) = SystemBlocks::from_node_messages(&messages) else { return };
    rebuilt.combined = blocks.combined;
    if rebuilt != *blocks {
        rebuilt.write(map);
    }
}

/// [`land_prompt_blocks`] for a move to the bridge, which also keeps what it rewrote ([`PROMPT_BEFORE_BRIDGE`]).
fn land_bridge_prompt(session: &mut Value, blocks: &SystemBlocks) {
    let slot = |session: &Value, key: &str| session.get(key).cloned().unwrap_or(Value::Null);
    let was = prompt_keys().map(|key| slot(session, key));
    land_prompt_blocks(session, blocks);
    let (mut before, mut after) = (Map::new(), Map::new());
    for (key, was) in prompt_keys().into_iter().zip(was) {
        let now = slot(session, key);
        if now != was {
            before.insert(key.to_owned(), was);
            after.insert(key.to_owned(), now);
        }
    }
    if !after.is_empty() {
        session[PROMPT_BEFORE_BRIDGE] = serde_json::json!({ "before": before, "after": after });
    }
}

/// Puts back the blocks `kept` holds, when the prompt is still what the move to the bridge left; whether it did.
fn restore_prompt(map: &mut Map<String, Value>, kept: &Value) -> bool {
    let (Some(before), Some(after)) = (kept.get("before").and_then(Value::as_object), kept.get("after").and_then(Value::as_object)) else { return false };
    if after.is_empty() || !after.iter().all(|(key, text)| map.get(key).unwrap_or(&Value::Null) == text) {
        return false;
    }
    for (key, text) in before {
        if text.is_null() {
            map.shift_remove(key);
        } else {
            map.insert(key.clone(), text.clone());
        }
    }
    true
}

/// What turns `header` into `after`, the messages aside.
pub(super) fn header_diff(header: &Header, after: &Map<String, Value>) -> HeaderChange {
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
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

pub fn route_surface_change(
    surface: &ToolSurface,
    clock: &dyn Clock,
    header: &Header,
    previous: &Route,
    prepared: Option<PreparedTools>,
    hidden_agent: bool,
) -> HeaderChange {
    if is_first_route(previous) {
        return HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
    }
    let mut session = Value::Object(header.clone());
    if let Some(prepared) = prepared {
        session["tools"] = prepared.tools;
        session["toolSpec"] = prepared.tool_spec;
    }
    filter_model_edit_surface(&mut session, &clean(header.get("model")));
    if is_agent_owner(&session) {
        return exposure_change(surface, clock, header, session, hidden_agent);
    }
    lead_surface_change(surface, clock, header, session)
}

fn filter_model_edit_surface(session: &mut Value, model: &str) {
    for key in ["deferredToolCatalog", "deferredLateToolCatalog"] {
        if let Some(items) = session.get(key).and_then(Value::as_array) {
            session[key] = Value::Array(filter_model_edit_tools(items, model));
        }
    }
    for key in ["deferredSelectedTools", "deferredCallableTools", "deferredDefaultTools", "deferredDiscoveredTools"] {
        if let Some(items) = session.get(key).and_then(Value::as_array) {
            let names: Vec<String> = items.iter().map(|v| clean(Some(v))).collect();
            session[key] = Value::Array(filter_model_edit_tool_names(&names, model).into_iter().map(Value::String).collect());
        }
    }
}

fn lead_surface_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, mut session: Value) -> HeaderChange {
    let blocks = SystemBlocks::from_header(header);
    session["messages"] = Value::Array(blocks.node_messages());
    let provider = clean(session.get("provider"));
    let migrating = super::tool_exposure::tool_exposure_migration_needed(&session, Some(&provider), &load_tool_def(surface.host))
        || !surface.retired_names(&session).is_empty();
    surface.rebuild_for_provider(&mut session, &provider);
    let messages = session.as_object_mut().expect("session object").shift_remove("messages").expect("system messages");
    let mut after = session.as_object().expect("session object").clone();
    let mut rebuilt = SystemBlocks::from_node_messages(messages.as_array().expect("system messages")).expect("surface preserves system blocks");
    rebuilt.combined = blocks.combined;
    if rebuilt != blocks {
        rebuilt.write(&mut after);
    }
    if migrating {
        let marked = mark_tool_surface_migrated(clock, None, None).change;
        for key in marked.unset {
            after.shift_remove(&key);
        }
        after.extend(marked.set);
    }
    header_diff(header, &after)
}

pub fn resumed_surface_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, prepared: PreparedTools, hidden_agent: bool) -> HeaderChange {
    resumed_surface_change_with_skills_gate(surface, clock, header, prepared, hidden_agent, mixdog_mcp::skill_catalog::skills_disabled_by_env())
}

fn resumed_surface_change_with_skills_gate(
    surface: &ToolSurface,
    clock: &dyn Clock,
    header: &Header,
    prepared: PreparedTools,
    hidden_agent: bool,
    skills_off: bool,
) -> HeaderChange {
    let old: Vec<String> = header.get("tools").and_then(Value::as_array).map(|tools| tools.iter().map(|t| clean(t.get("name"))).collect()).unwrap_or_default();
    let mut session = Value::Object(header.clone());
    // The manager's freshly resolved list omits retired tools. On a same-route resume keep the
    // stored surface instead; the cold fold is responsible for removing those definitions.
    // An explicit skills-off gate is not a cold-fold retirement.
    if !surface.retired_names(&session).is_empty() {
        if skills_off {
            remove_disabled_skill_loader(&mut session);
        }
        return header_diff(header, session.as_object().expect("session object"));
    }
    session["toolSpec"] = prepared.tool_spec;
    session["tools"] = prepared.tools;
    if skills_off {
        remove_disabled_skill_loader(&mut session);
    }
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
        mixdog_rt::node_stderr!("[session] Warning: {} tools no longer available: {}", missing.len(), names.join(", "));
    }
    change
}

fn remove_disabled_skill_loader(session: &mut Value) {
    *session = super::tool_surface::surviving_entries(session, &|tool| clean(tool.get("name")).eq_ignore_ascii_case("Skill"));
    for key in [
        "deferredDefaultTools",
        "deferredSelectedTools",
        "deferredDiscoveredTools",
        "deferredCallableTools",
        "deferredAnnouncedTools",
        "nativeDeferredDiscovery",
    ] {
        if let Some(Value::Array(names)) = session.get_mut(key) {
            names.retain(|name| !clean(Some(name)).eq_ignore_ascii_case("Skill"));
        }
    }
}

pub fn resume_header(scoped: &Header) -> Header {
    let mut resuming = scoped.clone();
    resuming.insert("preset".to_owned(), tool_spec_for_mode(thread_mode(scoped)));
    resuming
}

/// `applyAgentToolExposure(session, { existing: true })` over `session` (the header with its new
/// tools), as the header change from `header`; a changed exposure is marked migrated.
fn exposure_change(surface: &ToolSurface, clock: &dyn Clock, header: &Header, mut session: Value, hidden_agent: bool) -> HeaderChange {
    let blocks = SystemBlocks::from_header(header);
    let changed = apply_agent_tool_exposure(surface, &mut session, hidden_agent, &blocks);
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

    /// The skill listing of `cwd`: the one outside read of the preparation, awaited by a route change on the session's actor.
    async fn skills_listed(&self, cwd: &std::path::Path) -> Result<bool, String>;

    /// [`PrepareTools::prepare`] over a listing already collected: synchronous and pure.
    fn prepare_with(&self, header: &Header, skills_listed: bool) -> Option<PreparedTools>;
}

/// `restoreResumedToolSurface(target, targetRoute)` (`session-switch/resume.mjs:66-75`), which follows the manager
/// step of every resume: the thread's deferred surface applied again over the tools that step left it.
#[async_trait::async_trait]
pub trait ResumedSurface: Send + Sync {
    /// `session` (the stored header after `_refreshResumedTools`) with its surface restored, as the header it becomes.
    async fn restored(&self, session: &Header) -> Result<Header, String>;
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
    pub hidden_agent: Arc<HiddenAgentLookup>,
    /// The MCP scope a resumed thread takes (`resumeSession`'s `mcpScopeId` option).
    pub scopes: Arc<dyn McpScopes>,
    /// `restoreResumedToolSurface` after a resumed thread's manager step.
    pub resumed_surface: Arc<dyn ResumedSurface>,
}

impl AiRouteFacts {
    /// The header a resumed thread is prepared from, with its MCP scope open: the scope it names, else
    /// a new one (`resumeSession` gives the session the runtime's scope, `session-lifecycle.mjs:646`),
    /// which is also returned so that the change writes it. A closed session holds no scope: Node does
    /// not resume it (`session-lifecycle.mjs:640`).
    async fn scoped_header(&self, thread: &mixdog_core_api::ids::ThreadId, header: &Header) -> (Header, Option<String>) {
        if header.get("closed") == Some(&Value::Bool(true)) {
            return (header.clone(), None);
        }
        let cwd = header.get("cwd").and_then(Value::as_str).map(std::path::PathBuf::from).unwrap_or_default();
        let fresh = || uuid::Uuid::new_v4().to_string();
        // A scope that was released (its owner closed, a worker's Lead among them) is not the thread's
        // any more: it takes a new one, as a resume takes the runtime's current scope.
        let (scope, minted) = match header_scope(header) {
            Some(scope) if self.scopes.open(scope, thread.as_str(), &cwd).await.is_ok() => (scope.to_owned(), false),
            _ => {
                let scope = fresh();
                if self.scopes.open(&scope, thread.as_str(), &cwd).await.is_err() {
                    // The thread itself was released: it holds no scope.
                    return (header.clone(), None);
                }
                (scope, true)
            }
        };
        let mut scoped = header.clone();
        scoped.insert("mcpScopeId".to_owned(), Value::String(scope.clone()));
        (scoped, minted.then_some(scope))
    }

    async fn restored_change(&self, header: &Header, scoped: &Header, change: HeaderChange) -> Option<HeaderChange> {
        let mut session = scoped.clone();
        for key in &change.unset {
            session.shift_remove(key);
        }
        session.extend(change.set);
        match self.resumed_surface.restored(&session).await {
            Ok(restored) => Some(header_diff(header, &restored)),
            Err(error) => {
                tracing::warn!(%error, "[session] the resumed thread keeps its stored tool surface");
                None
            }
        }
    }
}

#[async_trait::async_trait]
impl RouteFacts for AiRouteFacts {
    fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta> {
        session_context_meta(&self.catalog, provider, model, seed)
    }

    fn cache_opts(&self, _provider: &str, _session_id: &str, agent: Option<&str>, header: &Header) -> Option<Value> {
        route_cache_opts(header, agent, &(self.auto_clear)())
    }

    async fn surface_lookup(&self, header: &Header, previous: &Route) -> SurfaceLookup {
        if is_first_route(previous) {
            return None;
        }
        let cwd = super::resume_tools::header_cwd(header);
        let listed = self.prepare_tools.skills_listed(&cwd).await;
        Some((cwd, listed))
    }

    fn surface_change(&self, header: &Header, previous: &Route, lookup: &SurfaceLookup) -> HeaderChange {
        let prepared = match lookup {
            Some((_, Ok(listed))) if !is_first_route(previous) => self.prepare_tools.prepare_with(header, *listed),
            _ => None,
        };
        let surface = ToolSurface { host: self.surface_host.as_ref(), clock: self.clock.as_ref() };
        let agent = header.get("agent").and_then(Value::as_str);
        route_surface_change(&surface, self.clock.as_ref(), header, previous, prepared, (self.hidden_agent)(agent))
    }
}

/// `SessionDeps.resumed_tools`: `_refreshResumedTools(session, sessionId, toolSpecForMode(getMode()))`
/// ([`resume_header`]) with the same producer a route change uses, then `restoreResumedToolSurface`.
#[async_trait::async_trait]
impl mixdog_core_session::session::ResumedTools for AiRouteFacts {
    async fn refreshed(&self, thread: &mixdog_core_api::ids::ThreadId, header: &Header) -> Option<HeaderChange> {
        let (scoped, minted) = self.scoped_header(thread, header).await;
        let surface = ToolSurface { host: self.surface_host.as_ref(), clock: self.clock.as_ref() };
        let agent = header.get("agent").and_then(Value::as_str);
        let restored = match self.prepare_tools.prepare(&resume_header(&scoped)).await {
            Some(prepared) => {
                let change = resumed_surface_change(&surface, self.clock.as_ref(), header, prepared, (self.hidden_agent)(agent));
                self.restored_change(header, &scoped, change).await
            }
            None => None,
        };
        let mut change = match restored {
            Some(change) => change,
            None => {
                // The global gate still applies if preparation or restore kept the stored surface.
                let mut session = Value::Object(header.clone());
                if mixdog_mcp::skill_catalog::skills_disabled_by_env() {
                    remove_disabled_skill_loader(&mut session);
                }
                let fallback = header_diff(header, session.as_object().expect("session object"));
                if minted.is_none() && fallback.set.is_empty() && fallback.unset.is_empty() {
                    return None;
                }
                fallback
            }
        };
        if let Some(scope) = minted {
            change.set.insert("mcpScopeId".to_owned(), Value::String(scope));
        }
        Some(change)
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct Host(Vec<Value>);
    impl SurfaceHost for Host {
        fn defined(&self, _: &str) -> bool {
            true
        }
        fn bridge_tools(&self) -> Vec<Value> {
            self.0.clone()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            json!({})
        }
    }

    #[test]
    fn same_route_resume_hides_disabled_skill_without_removing_other_retired_definitions() {
        struct CurrentHost;
        impl SurfaceHost for CurrentHost {
            fn defined(&self, name: &str) -> bool {
                name == "read"
            }
            fn bridge_tools(&self) -> Vec<Value> {
                Vec::new()
            }
            fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
                json!({})
            }
        }
        let surface = ToolSurface { host: &CurrentHost, clock: &Fixed };
        let saved = json!({
            "owner": "agent", "provider": "openai-oauth", "model": "gpt-5",
            "tools": [{"name": "Skill"}, {"name": "read"}, {"name": "retired"}],
            "deferredLateToolCatalog": [{"name": "Skill"}],
            "deferredCallableTools": ["Skill", "read"]
        });
        let mut header = saved.as_object().unwrap().clone();
        let prepared = PreparedTools { tools: json!([{"name": "read"}]), tool_spec: json!("full") };
        let change = resumed_surface_change_with_skills_gate(&surface, &Fixed, &header, prepared, false, true);
        for key in change.unset {
            header.shift_remove(&key);
        }
        header.extend(change.set);
        assert_eq!(header["tools"], json!([{"name": "read"}, {"name": "retired"}]));
        assert_eq!(header["deferredLateToolCatalog"], json!([]));
        assert_eq!(header["deferredCallableTools"], json!(["read"]));
    }

    #[test]
    fn a_lead_route_change_reselects_the_catalog_without_exposing_the_pool() {
        let host = Host(Vec::new());
        let surface = ToolSurface { host: &host, clock: &Fixed };
        let tool = |name: &str| json!({"name": name, "description": name, "inputSchema": {"type": "object"}});
        let catalog = vec![tool("read"), tool("load_tool"), tool("computer"), tool("mcp__gmail__search_emails")];
        let mut session = json!({"provider": "anthropic-oauth", "model": "claude", "tools": catalog});
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        session["deferredDiscoveredTools"] = json!(["computer"]);
        session["provider"] = json!("openai-oauth");
        session["model"] = json!("gpt-5");
        let header = session.as_object().unwrap().clone();
        let previous = Route::from_iter([("provider".into(), json!("anthropic-oauth")), ("model".into(), json!("claude"))]);
        let change = route_surface_change(&surface, &Fixed, &header, &previous, Some(PreparedTools { tools: json!(catalog), tool_spec: json!("full") }), false);
        let mut after = header;
        for key in change.unset {
            after.shift_remove(&key);
        }
        after.extend(change.set);
        let after = Value::Object(after);
        let eager: Vec<_> = after["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(eager, ["read", "load_tool"]);
        assert_eq!(after["deferredDiscoveredTools"], json!(["computer"]));
        assert_eq!(surface.pool_tool_names(&after), vec!["mcp__gmail__search_emails".to_owned()]);
    }

    /// An agent's session that leaves a native route for a bridge one (a fallback, a model switch) is told the surface it
    /// now has, on every such route: what it calls directly is defined with its schema, the bridge's two tools are
    /// defined, and the prompt names what is reached through them and how. The way back takes that text out again.
    #[test]
    fn an_agents_move_to_a_bridge_route_rewrites_the_prompts_roster_and_guidance() {
        use super::super::tool_exposure::TOOL_BRIDGE_GUIDANCE;

        let tool =
            |name: &str| json!({"name": name, "description": format!("{name}."), "inputSchema": {"type": "object", "properties": {name: {"type": "string"}}}});
        let call_tool = json!({"name": "call_tool", "description": "Run a deferred tool.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "arguments": {"type": "object"}}}});
        let host = Host(vec![tool("load_tool"), call_tool]);
        let surface = ToolSurface { host: &host, clock: &Fixed };
        let catalog = vec![tool("read"), tool("git"), tool("shell"), tool("load_tool"), tool("computer")];
        let applied = |mut header: Header, change: HeaderChange| {
            for key in change.unset {
                header.shift_remove(&key);
            }
            header.extend(change.set);
            header
        };
        let route = |provider: &str| Route::from_iter([("provider".into(), json!(provider)), ("model".into(), json!("m"))]);
        let prepared = || Some(PreparedTools { tools: json!(catalog), tool_spec: json!("full") });
        for provider in ["cursor-oauth", "gemini", "grok-oauth", "opencode-go-oauth"] {
            // The session as its native route left it: `git` and `shell` defined, `computer` in the prompt's roster.
            let mut session = json!({
                "owner": "agent", "provider": "openai-oauth", "model": "m", "tools": catalog, "bp3EnvSplit": true,
                "messages": [{"role": "system", "content": "rules"}, {"role": "system", "content": "skills"}],
            });
            surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
            let mut header = session.as_object().unwrap().clone();
            let messages = header.shift_remove("messages").unwrap();
            header.insert("promptBase".into(), messages[0]["content"].clone());
            header.insert("promptStable".into(), messages[1]["content"].clone());
            let native = header["promptStable"].as_str().unwrap().to_owned();
            assert!(native.contains("\n- computer") && !native.contains("\n- git"), "{provider}: the native roster: {native}");

            header.insert("provider".into(), json!(provider));
            let change = route_surface_change(&surface, &Fixed, &header, &route("openai-oauth"), prepared(), false);
            let bridged = applied(header, change);
            let defined: Vec<(&str, bool)> =
                bridged["tools"].as_array().unwrap().iter().map(|t| (t["name"].as_str().unwrap(), t["inputSchema"].is_object())).collect();
            assert_eq!(defined, [("read", true), ("load_tool", true), ("call_tool", true)], "{provider}: defined on the wire, each with its schema");
            let stable = bridged["promptStable"].as_str().unwrap();
            assert!(stable.starts_with("skills\n\n---\n\n<available-deferred-tools>\n"), "{provider}: {stable}");
            for name in ["git", "shell", "computer"] {
                assert!(stable.contains(&format!("\n- {name}")), "{provider}: {name} is reached through the bridge and listed: {stable}");
            }
            assert!(stable.ends_with(TOOL_BRIDGE_GUIDANCE), "{provider}: {stable}");
            assert_eq!(bridged["promptBase"], "rules");

            // A second bridge route is the same exposure: the prompt it was given stays.
            let mut other = bridged.clone();
            other.insert("provider".into(), json!("groq"));
            let change = route_surface_change(&surface, &Fixed, &other, &route(provider), prepared(), false);
            assert!(!change.set.contains_key("promptStable") && !change.unset.iter().any(|key| key == "promptStable"), "{provider}: {:?}", change.set.keys());

            // Back on the route it came from, the prompt is the text that route was sent before, byte for byte.
            let mut back = bridged.clone();
            back.insert("provider".into(), json!("openai-oauth"));
            let change = route_surface_change(&surface, &Fixed, &back, &route(provider), prepared(), false);
            let returned = applied(back, change);
            assert_eq!(returned["promptStable"].as_str(), Some(native.as_str()), "{provider}: back on the native route");
            assert!(!returned.contains_key(PROMPT_BEFORE_BRIDGE));

            // A prompt rebuilt while on the bridge is no longer the text the move left: the bridge's blocks leave it.
            let mut refolded = bridged;
            refolded.insert("promptStable".into(), json!(format!("new skills\n\n---\n\n{TOOL_BRIDGE_GUIDANCE}")));
            refolded.insert("provider".into(), json!("openai-oauth"));
            let change = route_surface_change(&surface, &Fixed, &refolded, &route(provider), prepared(), false);
            assert_eq!(applied(refolded, change)["promptStable"], "new skills", "{provider}: a rebuilt prompt loses the bridge text");
        }
    }

    /// A resumed agent on a direct route keeps its prompt as stored, also when the surface drops a name its build no longer
    /// defines from the session's lists: nothing but a move between exposures writes the prompt.
    #[test]
    fn a_resume_on_a_direct_route_leaves_the_prompt_as_stored() {
        struct WithoutGone;
        impl SurfaceHost for WithoutGone {
            fn defined(&self, name: &str) -> bool {
                name != "gone"
            }
            fn bridge_tools(&self) -> Vec<Value> {
                Vec::new()
            }
            fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
                json!({})
            }
        }
        let tool = |name: &str| json!({"name": name, "description": format!("{name}."), "inputSchema": {"type": "object"}});
        let catalog = vec![tool("read"), tool("load_tool"), tool("computer")];
        let surface = ToolSurface { host: &WithoutGone, clock: &Fixed };
        let mut session = json!({"owner": "agent", "provider": "openai-oauth", "model": "m", "tools": catalog});
        surface.apply(&mut session, "lead", &[], &ApplyOptions::default());
        let mut header = session.as_object().unwrap().clone();
        header
            .extend(json!({"bp3EnvSplit": true, "promptBase": "rules", "promptStable": "skills", "deferredToolBp2Applied": true}).as_object().unwrap().clone());
        header.insert("deferredSelectedTools".into(), json!(["read", "load_tool", "gone"]));
        assert!(surface.retired_names(&Value::Object(header.clone())).is_empty(), "no stored definition is retired");
        let prepared = PreparedTools { tools: json!(catalog), tool_spec: json!("full") };
        let change = resumed_surface_change_with_skills_gate(&surface, &Fixed, &header, prepared, false, false);
        let prompt = |key: &String| key.starts_with("prompt") || key == "bp3CoreContext";
        assert!(!change.set.keys().any(prompt) && !change.unset.iter().any(prompt), "{:?} {:?}", change.set.keys(), change.unset);
        assert_eq!(change.set.get("deferredSelectedTools"), Some(&json!(["read", "load_tool"])), "the list is still pruned");
    }
}
