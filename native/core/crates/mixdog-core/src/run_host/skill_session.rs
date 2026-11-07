//! The two session inputs of `CatalogSkillPort`: the re-arming of a loaded skill's deferred tools
//! for its thread ([`HeaderSkillArm`], Node `loadSkillToolDependencies`) and the thread's live
//! transcript ([`ThreadTranscript`], Node `currentSkillContext`).
//!
//! Node holds both on the live session object; here the session is the thread's header (a
//! `Value`, changed in place as `tool_surface` does) and its messages. The arm changes the session
//! the way Node does and writes back the keys that moved, through the session actor's conditional
//! header patch, as `SessionCatalog::announce` does.
//!
//! Node's `loadSkillToolDependencies` also words the outcome ("Required tools loaded: ...",
//! "Required tools unavailable: ...", the native tool-search payload) and appends it to the
//! Skill result. `DeferredToolArm::arm` returns nothing, so that text is not produced here.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::gate::connector_policy_agent;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::HeaderToolSurfaces;
use mixdog_core_session::session::RouteExclusions;
use mixdog_core_session::session::ToolSurfaceSource;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skill_state::message_text;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use serde_json::Map;
use serde_json::Value;

use super::route_schema::Verdict;
use super::route_schema::schema_verdict;
use super::session_catalog::deferred_available;
use super::session_catalog::server_of;
use super::session_catalog::strings;
use super::tool_exposure::is_tool_bridge_enabled;
use super::tool_surface::SurfaceHost;
use super::tool_surface::ToolSurface;
use super::tool_surface::filter_disallowed_tools;
use super::tool_surface::parse_tool_selection;
use super::tool_surface::permitted_by_session_policy;
use super::tool_surface::readonly_selectable;
use super::tool_surface::sorted_names_by_measured_usage;
use super::tool_surface::tool_name;
use super::tool_surface::truthy;

/// The header keys a skill load can change: `selectDeferredTools` (`session.tools`,
/// `deferredCallableTools`, `deferredDiscoveredTools`, `deferredSelectedTools`) and
/// `loadSkillToolDependencies` (`skillLoadedTools`).
const ARMED_KEYS: [&str; 5] = ["tools", "deferredCallableTools", "deferredDiscoveredTools", "deferredSelectedTools", "skillLoadedTools"];

/// The `DeferredToolArm` of the running product: a skill's tool dependencies are loaded into the
/// thread's session under the session's own tool policy (a skill never relaxes it).
pub struct HeaderSkillArm {
    threads: Arc<dyn ThreadState>,
    surfaces: HeaderToolSurfaces,
    permissions: Arc<dyn ConnectorPermissions>,
    host: Arc<dyn SurfaceHost>,
    clock: Arc<dyn Clock>,
}

impl HeaderSkillArm {
    /// `exclusions`, `host` and `clock` are the ones `SessionCatalog::new` is given, so a tool is
    /// judged the same way here, in `load_tool` and at dispatch; `permissions` is the gate's.
    pub fn new(
        threads: Arc<dyn ThreadState>,
        exclusions: Arc<dyn RouteExclusions>,
        permissions: Arc<dyn ConnectorPermissions>,
        host: Arc<dyn SurfaceHost>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { threads, surfaces: HeaderToolSurfaces::new(exclusions), permissions, host, clock }
    }

    fn surface(&self) -> ToolSurface<'_> {
        ToolSurface { host: self.host.as_ref(), clock: self.clock.as_ref() }
    }

    /// `new Map([...session.tools, ...deferredCatalogUnion(session)].map(tool => [tool.name, tool]))`:
    /// by the name as written, a later definition replacing an earlier one in place.
    fn named_catalog(&self, session: &Value) -> Vec<(String, Value)> {
        let eager = session.get("tools").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let mut named: Vec<(String, Value)> = Vec::new();
        for tool in eager.iter().cloned().chain(self.surface().catalog_union(session)) {
            let Some(name) = tool.get("name").and_then(Value::as_str).map(str::to_owned) else { continue };
            match named.iter_mut().find(|slot| slot.0 == name) {
                Some(slot) => slot.1 = tool,
                None => named.push((name, tool)),
            }
        }
        named
    }

    /// `resolvableCatalog(session)`: the deferred catalog union, or the session's own tools when
    /// nothing is deferred, within what the session's policy lets it run.
    fn resolvable(&self, session: &Value) -> Vec<Value> {
        let mut tools = self.surface().catalog_union(session);
        if tools.is_empty() {
            tools = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        }
        filter_disallowed_tools(&tools, &strings(session, "disallowedTools")).into_iter().filter(|tool| permitted_by_session_policy(session, &tool_name(tool))).collect()
    }

    /// `selectDeferredTools(session, names, mode, { exact: true })`, `readonly` being
    /// `mode === 'readonly'`: the names it loaded (`added`, then `already`).
    fn select(&self, session: &mut Value, header: &Header, route_excluded: &[(String, String)], names: &[String], readonly: bool) -> Vec<String> {
        let catalog = self.resolvable(session);
        let mut active: Vec<String> = Vec::new();
        let eager = session.get("tools").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        for name in eager.iter().map(tool_name).filter(|name| !name.is_empty()).chain(parse_tool_selection(session.get("deferredCallableTools"))) {
            insert(&mut active, name);
        }
        let native = session.get("deferredProviderMode").and_then(Value::as_str) == Some("native") || session.get("deferredNativeTools") == Some(&Value::Bool(true));
        let mut discovered: Vec<String> = Vec::new();
        for name in session.get("deferredDiscoveredTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            insert(&mut discovered, name.to_owned());
        }
        // Bridge sessions keep a fixed surface: deferred tools are described and run through the
        // bridge, never appended to `session.tools`.
        let bridge = is_tool_bridge_enabled(session);
        let mut by_name: HashMap<String, usize> = HashMap::new();
        for (index, tool) in catalog.iter().enumerate() {
            let name = tool_name(tool);
            if !name.is_empty() {
                by_name.insert(name.clone(), index);
                by_name.insert(name.to_lowercase(), index);
            }
        }
        let (mut added, mut already) = (Vec::new(), Vec::new());
        for raw in names {
            let requested = mixdog_js::js_trim(raw);
            let Some(&index) = by_name.get(requested).or_else(|| by_name.get(&requested.to_lowercase())) else { continue };
            let tool = &catalog[index];
            let name = tool_name(tool);
            if !deferred_available(session, &name) {
                continue;
            }
            // A tool this route never sends is not loaded.
            if !bridge && route_excludes(header, route_excluded, tool) {
                continue;
            }
            if readonly && !readonly_selectable(tool) {
                continue;
            }
            if bridge || active.contains(&name) || (native && discovered.contains(&name)) {
                already.push(name);
                continue;
            }
            if native {
                insert(&mut discovered, name.clone());
            } else {
                if let Some(Value::Array(tools)) = session.get_mut("tools") {
                    tools.push(tool.clone());
                }
                discovered.retain(|known| *known != name);
            }
            insert(&mut active, name.clone());
            added.push(name);
        }
        if !bridge && let Some(map) = session.as_object_mut() {
            let selected = names_value(&sorted_names_by_measured_usage(active));
            if native {
                map.insert("deferredCallableTools".to_owned(), selected.clone());
                map.insert("deferredDiscoveredTools".to_owned(), names_value(&sorted_names_by_measured_usage(discovered)));
            } else {
                map.insert("deferredDiscoveredTools".to_owned(), selected.clone());
            }
            map.insert("deferredSelectedTools".to_owned(), selected);
        }
        added.extend(already);
        added
    }

    /// `loadSkillToolDependencies(envelope, session)`'s change to the session of `header`.
    fn load(&self, thread: &ThreadId, header: &Header, dependencies: &[Value]) -> Value {
        let mut session = Value::Object(header.clone());
        let catalog = self.named_catalog(&session);
        let wanted = wanted_names(&catalog, dependencies);
        let has_tools = session.get("tools").is_some_and(Value::is_array);
        // `preDispatchDenyForSession(session, { name, arguments: {} })`.
        let surface = self.surfaces.surface(thread, header);
        let agent = connector_policy_agent(header);
        let allowed: Vec<String> = wanted
            .into_iter()
            .filter(|name| {
                if !has_tools || !catalog.iter().any(|(known, _)| known == name) {
                    return false;
                }
                let mut call = surface.clone();
                call.connector_disabled = self.permissions.disabled(&agent, name);
                call.project_disabled = self.permissions.project_disabled(thread, name);
                call.refusal(name, None).is_none()
            })
            .collect();
        if allowed.is_empty() {
            return session;
        }
        let readonly = readonly_selection(&session);
        let loaded = self.select(&mut session, header, &surface.route_excluded, &allowed, readonly);
        if !loaded.is_empty()
            && let Some(map) = session.as_object_mut()
        {
            let mut kept: Vec<String> = Vec::new();
            for name in map.get("skillLoadedTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).chain(loaded) {
                insert(&mut kept, name);
            }
            map.insert("skillLoadedTools".to_owned(), names_value(&kept));
        }
        session
    }
}

/// An ordered set: `name` joins unless it is in already.
fn insert(set: &mut Vec<String>, name: String) {
    if !set.contains(&name) {
        set.push(name);
    }
}

fn names_value(names: &[String]) -> Value {
    Value::Array(names.iter().cloned().map(Value::String).collect())
}

/// The names the dependencies ask for, once each, in order: a `tool` by its value, an `mcp` by the
/// names of the catalog's tools of that server. Other kinds ask for nothing.
fn wanted_names(catalog: &[(String, Value)], dependencies: &[Value]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for dependency in dependencies {
        let (Some(kind), Some(value)) = (dependency.get("type").and_then(Value::as_str), dependency.get("value").and_then(Value::as_str)) else { continue };
        match kind {
            "tool" => insert(&mut names, value.to_owned()),
            "mcp" => {
                for (name, _) in catalog.iter().filter(|(_, tool)| server_of(tool) == value) {
                    insert(&mut names, name.clone());
                }
            }
            _ => {}
        }
    }
    names
}

/// `routeToolExclusionReason(session, tool)` is set: the provider dropped the tool for the
/// route, or the wire's schema rule leaves it out.
fn route_excludes(header: &Header, excluded: &[(String, String)], tool: &Value) -> bool {
    let raw = tool.get("name").and_then(Value::as_str).unwrap_or_default();
    excluded.iter().any(|(name, _)| name == raw) || matches!(schema_verdict(header, tool), Verdict::Excluded(_))
}

/// The `selectedMode === 'readonly'` of `loadSkillToolDependencies` for a Skill tool call (no mode
/// given): a read-only tool spec, else the session's surface mode, else the tool spec's own.
fn readonly_selection(session: &Value) -> bool {
    let spec = session.get("toolSpec");
    let readonly_spec = match spec {
        Some(Value::String(spec)) => spec == "readonly" || spec.contains("tools:readonly"),
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some("tools:readonly")),
        _ => false,
    };
    if readonly_spec {
        return true;
    }
    match session.get("deferredSurfaceMode") {
        Some(mode) if truthy(Some(mode)) => mode.as_str() == Some("readonly"),
        _ => !matches!(spec.and_then(Value::as_str), Some("full" | "mcp")),
    }
}

/// The keys of `ARMED_KEYS` that `session` holds differently from `header`, with the values the
/// header holds now (`null` for absent) for the conditional patch.
fn armed_patch(header: &Header, session: &Value) -> (Map<String, Value>, Map<String, Value>) {
    let (mut expect, mut set) = (Map::new(), Map::new());
    for key in ARMED_KEYS {
        if let Some(value) = session.get(key)
            && header.get(key) != Some(value)
        {
            set.insert(key.to_owned(), value.clone());
            expect.insert(key.to_owned(), header.get(key).cloned().unwrap_or(Value::Null));
        }
    }
    (expect, set)
}

#[async_trait]
impl DeferredToolArm for HeaderSkillArm {
    /// A thread that cannot be read, or whose header could not be written, has nothing armed; Node's
    /// in-memory session cannot fail here.
    async fn arm(&self, thread: &ThreadId, dependencies: &SkillToolDependencies) {
        if dependencies.tool_dependencies.is_empty() && dependencies.issues.is_empty() {
            return;
        }
        loop {
            let header = match self.threads.header(thread).await {
                Ok(header) => header,
                Err(error) => {
                    tracing::warn!(thread = %thread, "[skill] tool dependencies not armed, header unreadable: {error:?}");
                    return;
                }
            };
            let session = self.load(thread, &header, &dependencies.tool_dependencies);
            let (expect, set) = armed_patch(&header, &session);
            if set.is_empty() {
                return;
            }
            match self.threads.patch_header_if(thread, expect, set, Vec::new()).await {
                Ok(None) => return,
                // Another write moved the header meanwhile: computed again from what it holds now.
                Ok(Some(_)) => continue,
                Err(error) => {
                    tracing::warn!(thread = %thread, "[skill] tool dependencies not armed, header not written: {error:?}");
                    return;
                }
            }
        }
    }
}

/// The `TranscriptTexts` of the running product: the running turn's working messages when there
/// are any, else the thread's saved messages (`currentSkillContext`).
pub struct ThreadTranscript {
    session: Arc<dyn RouteSession>,
    messages: Arc<dyn ThreadMessages>,
}

impl ThreadTranscript {
    /// `session` is the one the route changes use (its `live_turn_messages` is
    /// `session.liveTurnMessages`); `messages` reads `session.messages`.
    pub fn new(session: Arc<dyn RouteSession>, messages: Arc<dyn ThreadMessages>) -> Self {
        Self { session, messages }
    }

    async fn rows(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        let live = self.session.live_turn_messages(thread).await?;
        if live.is_empty() { self.messages.messages(thread).await } else { Ok(live) }
    }
}

#[async_trait]
impl TranscriptTexts for ThreadTranscript {
    /// An unreadable transcript holds no skill body, so the skill is delivered again; Node's
    /// in-memory transcript cannot fail here.
    async fn user_texts(&self, thread: &ThreadId) -> Vec<String> {
        let rows = match self.rows(thread).await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(thread = %thread, "[skill] transcript unreadable: {error:?}");
                return Vec::new();
            }
        };
        rows.iter().filter(|row| row.get("role").and_then(Value::as_str) == Some("user")).map(|row| row.get("content").map_or_else(String::new, message_text)).collect()
    }
}

#[cfg(test)]
mod tests;
