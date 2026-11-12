//! The two session inputs of `CatalogSkillPort`: the re-arming of a loaded skill's deferred tools
//! for its thread ([`HeaderSkillArm`], Node `loadSkillToolDependencies`) and the thread's live
//! transcript ([`ThreadTranscript`], Node `currentSkillContext`).
//!
//! Node holds both on the live session object; here the session is the thread's header (a
//! `Value`, changed in place as `tool_surface` does) and its messages. The arm is one header
//! update run where the header has its only writer (`HeaderUpdates`): it changes the session the
//! way Node does, synchronously, and the keys that moved are the next record. Nothing is retried.
//! The update runs on the session actor, so it is pure: whatever the load asks of the world (the
//! connector and project switches, the route's exclusions) is looked up before the update and
//! captured (`Lookups`), and the update takes no lock, does no I/O and awaits nothing.
//!
//! `loadSkillToolDependencies` also words the outcome ("Required tools loaded: ...", "Required
//! tools unavailable: ...", the native tool-search payload `toolSearchNativePayload`): the arm
//! returns it as an [`ArmNotice`] and the Skill tool appends it to its result. A header or
//! transcript that cannot be read or written is the port's error, not an empty answer.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::gate::connector_policy_agent;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::RouteExclusions;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skill_state::message_text;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::skill::ArmNotice;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::SessionSurface;
use serde_json::Map;
use serde_json::Value;

use super::deferred_select::insert;
use super::deferred_select::names_value;
use super::deferred_select::select;
use super::deferred_select::tool_search_native_payload;
use super::session_catalog::server_of;
use super::tool_exposure::is_tool_bridge_enabled;
use super::tool_surface::SurfaceHost;
use super::tool_surface::ToolSurface;
use super::tool_surface::clean;
use super::tool_surface::truthy;

/// The header keys a skill load can change: `selectDeferredTools` (`session.tools`,
/// `deferredCallableTools`, `deferredDiscoveredTools`, `deferredSelectedTools`) and
/// `loadSkillToolDependencies` (`skillLoadedTools`).
const ARMED_KEYS: [&str; 5] = ["tools", "deferredCallableTools", "deferredDiscoveredTools", "deferredSelectedTools", "skillLoadedTools"];

/// The `DeferredToolArm` of the running product: a skill's tool dependencies are loaded into the
/// thread's session under the session's own tool policy (a skill never relaxes it).
pub struct HeaderSkillArm {
    threads: Arc<dyn ThreadState>,
    updates: Arc<dyn HeaderUpdates>,
    exclusions: Arc<dyn RouteExclusions>,
    permissions: Arc<dyn ConnectorPermissions>,
    parts: Arc<Parts>,
}

/// What the load needs besides the header and the lookups; it moves into the update that runs on
/// the session actor, and only reads memory.
struct Parts {
    host: Arc<dyn SurfaceHost>,
    clock: Arc<dyn Clock>,
}

/// What the load asks of the world, looked up before the update: the route's exclusions and the
/// agent's connector and project switches, for every name the load can ask about. `asked` is that
/// set; a name outside it (the catalog moved since) fails the load.
struct Lookups {
    route_excluded: Vec<(String, String)>,
    connector_disabled: HashSet<String>,
    project_disabled: HashSet<String>,
    asked: HashSet<String>,
}

impl HeaderSkillArm {
    /// `threads` reads the header the lookups are made from and `updates` writes it (one object,
    /// `LateThreads` or `SessionThreads`, is both). `exclusions`, `host` and `clock` are the ones
    /// `SessionCatalog::new` is given, so a tool is judged the same way here, in `load_tool` and at
    /// dispatch; `permissions` is the gate's.
    pub fn new(
        threads: Arc<dyn ThreadState>,
        updates: Arc<dyn HeaderUpdates>,
        exclusions: Arc<dyn RouteExclusions>,
        permissions: Arc<dyn ConnectorPermissions>,
        host: Arc<dyn SurfaceHost>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { threads, updates, exclusions, permissions, parts: Arc::new(Parts { host, clock }) }
    }

    /// The lookups of `header`: every name the load can ask about is a dependency value or a tool
    /// of the header's catalogs.
    fn lookups(&self, thread: &ThreadId, header: &Header, dependencies: &SkillToolDependencies) -> Lookups {
        let mut asked: HashSet<String> = dependencies
            .tool_dependencies
            .iter()
            .filter(|dependency| dependency.get("type").and_then(Value::as_str) == Some("tool"))
            .filter_map(|dependency| dependency.get("value").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        for key in ["tools", "deferredToolCatalog", "deferredLateToolCatalog"] {
            asked.extend(header.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(|tool| tool.get("name").and_then(Value::as_str)).map(str::to_owned));
        }
        let agent = connector_policy_agent(header);
        let connector_disabled = asked.iter().filter(|name| self.permissions.disabled(&agent, name)).cloned().collect();
        let project_disabled = asked.iter().filter(|name| self.permissions.project_disabled(thread, name)).cloned().collect();
        Lookups { route_excluded: self.exclusions.excluded(thread, header), connector_disabled, project_disabled, asked }
    }
}

impl Parts {
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

    /// `loadSkillToolDependencies(envelope, session)`: the session of `header` after the load, and
    /// what the model is told of it; pure over `header` and `lookups`. `Err(name)`: `name` was not
    /// looked up (the catalog gained it after the lookups were made).
    fn load(&self, header: &Header, dependencies: &SkillToolDependencies, lookups: &Lookups) -> Result<(Value, ArmNotice), String> {
        let mut session = Value::Object(header.clone());
        let catalog = self.named_catalog(&session);
        // `unavailable`: the skill's own issues, then what the dependencies cannot name, then what
        // the session refuses or lacks.
        let mut unavailable = dependencies.issues.clone();
        let wanted = wanted_names(&catalog, &dependencies.tool_dependencies, &mut unavailable);
        let has_tools = session.get("tools").is_some_and(Value::is_array);
        // `preDispatchDenyForSession(session, { name, arguments: {} })`.
        let surface = SessionSurface::from_header(header, lookups.route_excluded.clone());
        let mut allowed: Vec<String> = Vec::new();
        for name in wanted {
            if !has_tools || !catalog.iter().any(|(known, _)| *known == name) {
                unavailable.push(format!("{name} (not available in this session)"));
                continue;
            }
            if !lookups.asked.contains(&name) {
                return Err(name);
            }
            let mut call = surface.clone();
            call.connector_disabled = lookups.connector_disabled.contains(&name);
            call.project_disabled = lookups.project_disabled.contains(&name);
            match call.refusal(&name, None) {
                Some(denial) => unavailable.push(format!("{name} ({})", denial.message_for_model)),
                None => allowed.push(name),
            }
        }
        let readonly = readonly_selection(&session);
        let selection = (!allowed.is_empty()).then(|| select(&self.surface(), &mut session, &surface.route_excluded, &allowed, readonly, true));
        let loaded: Vec<String> = selection.as_ref().map_or_else(Vec::new, |selection| selection.added.iter().chain(&selection.already).cloned().collect());
        for (name, reason) in selection.iter().flat_map(|selection| &selection.blocked) {
            unavailable.push(format!("{name} ({reason})"));
        }
        for name in selection.iter().flat_map(|selection| &selection.missing) {
            unavailable.push(format!("{name} (not available in this session)"));
        }
        if !loaded.is_empty()
            && let Some(map) = session.as_object_mut()
        {
            let mut kept: Vec<String> = Vec::new();
            for name in map.get("skillLoadedTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).chain(loaded.iter().cloned()) {
                insert(&mut kept, name);
            }
            map.insert("skillLoadedTools".to_owned(), names_value(&kept));
        }
        let native = selection.as_ref().is_some_and(|selection| selection.native);
        let notice = notice_of(&session, &catalog, &loaded, &unavailable, native);
        Ok((session, notice))
    }
}

/// The text `loadSkillToolDependencies` appends to the Skill result, and the native tool-search
/// payload it replaces the result with: `loaded` after the load, `unavailable` what it could not
/// load, `catalog` the one the dependencies were named in, `native` whether the provider's own
/// tool search is on.
fn notice_of(session: &Value, catalog: &[(String, Value)], loaded: &[String], unavailable: &[String], native: bool) -> ArmNotice {
    let eager: HashSet<&str> = session.get("tools").and_then(Value::as_array).into_iter().flatten().filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
    // Bridge exposure never promotes a schema: deferred dependencies stay reachable through call_tool
    // while the eager surface keeps its bytes.
    let bridge = is_tool_bridge_enabled(session);
    let bridged: Vec<&String> = if bridge { loaded.iter().filter(|name| !eager.contains(name.as_str())).collect() } else { Vec::new() };
    let direct: Vec<&String> = loaded.iter().filter(|name| !bridged.contains(name)).collect();
    let join = |names: &[&String]| names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ");
    let mut lines: Vec<String> = Vec::new();
    if !direct.is_empty() && !bridge {
        lines.push(format!("Required tools loaded: {}. Their full definitions are available on your next request; use them directly without load_tool.", join(&direct)));
    }
    if !direct.is_empty() && bridge {
        lines.push(format!("Required tools available directly: {}.", join(&direct)));
    }
    if !bridged.is_empty() {
        lines.push(format!("Required tools available through call_tool: {}. Read a definition with load_tool, then run it with call_tool {{name, arguments}}.", join(&bridged)));
    }
    if !unavailable.is_empty() {
        lines.push(format!("Required tools unavailable: {}", unavailable.join("; ")));
        lines.push("No tools were installed or enabled and no permissions were changed.".to_owned());
    }
    let provider = clean(session.get("provider"));
    let promoted: Vec<String> = loaded.iter().filter(|name| !eager.contains(name.as_str())).cloned().collect();
    // `toolSearchNativePayload` without its summary: the result's own stands in.
    let payload = native.then(|| tool_search_native_payload(catalog.iter().map(|(_, tool)| tool), &promoted, &provider)).flatten().map(|mut payload| {
        if let Some(map) = payload.as_object_mut() {
            map.shift_remove("summary");
        }
        payload
    });
    ArmNotice { lines, native: payload }
}

/// The names the dependencies ask for, once each, in order: a `tool` by its value, an `mcp` by the
/// names of the catalog's tools of that server. A server with no tools, and any other kind, are
/// pushed to `unavailable`.
fn wanted_names(catalog: &[(String, Value)], dependencies: &[Value], unavailable: &mut Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for dependency in dependencies {
        let (Some(kind), Some(value)) = (dependency.get("type").and_then(Value::as_str), dependency.get("value").and_then(Value::as_str)) else { continue };
        match kind {
            "tool" => insert(&mut names, value.to_owned()),
            "mcp" => {
                let matches: Vec<&String> = catalog.iter().filter(|(_, tool)| server_of(tool) == value).map(|(name, _)| name).collect();
                if matches.is_empty() {
                    unavailable.push(format!("mcp:{value} (no available connected tools)"));
                }
                for name in matches {
                    insert(&mut names, name.clone());
                }
            }
            _ => unavailable.push(format!("{kind}:{value} (unsupported dependency type)")),
        }
    }
    names
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

/// The keys of `ARMED_KEYS` that `session` holds differently from `header`.
fn armed_change(header: &Header, session: &Value) -> HeaderChange {
    let mut set = Map::new();
    for key in ARMED_KEYS {
        if let Some(value) = session.get(key)
            && header.get(key) != Some(value)
        {
            set.insert(key.to_owned(), value.clone());
        }
    }
    HeaderChange { set, unset: Vec::new() }
}

#[async_trait]
impl DeferredToolArm for HeaderSkillArm {
    /// The load is one header update on the session actor, so it reads the header it writes to and
    /// no write can land in between; a header that cannot be read or updated is the port's error,
    /// and the Skill tool fails with it. The world is asked first (`lookups`), the update is pure.
    async fn arm(&self, thread: &ThreadId, dependencies: &SkillToolDependencies) -> Result<ArmNotice, PortError> {
        if dependencies.tool_dependencies.is_empty() && dependencies.issues.is_empty() {
            return Ok(ArmNotice::default());
        }
        let header = self.threads.header(thread).await?;
        let lookups = self.lookups(thread, &header, dependencies);
        // The update only sends its result: `send` neither blocks nor awaits.
        let (told, heard) = tokio::sync::oneshot::channel::<Result<ArmNotice, String>>();
        let (parts, skill) = (self.parts.clone(), dependencies.clone());
        let update: HeaderUpdate = Box::new(move |header| match parts.load(header, &skill, &lookups) {
            Ok((session, notice)) => {
                let _ = told.send(Ok(notice));
                armed_change(header, &session)
            }
            Err(name) => {
                let _ = told.send(Err(name));
                HeaderChange { set: Map::new(), unset: Vec::new() }
            }
        });
        self.updates.update_header(thread, update).await?;
        match heard.await {
            Ok(Ok(notice)) => Ok(notice),
            Ok(Err(name)) => Err(PortError::Failed {
                capability: "session".to_owned(),
                message: format!("the tool catalog gained {name} while the skill loaded; load the skill again"),
            }),
            Err(_) => Err(PortError::Failed { capability: "session".to_owned(), message: "the header update did not run".to_owned() }),
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
    /// A transcript that cannot be read is the port's error; the Skill tool fails with it.
    async fn user_texts(&self, thread: &ThreadId) -> Result<Vec<String>, PortError> {
        let rows = self.rows(thread).await?;
        Ok(rows.iter().filter(|row| row.get("role").and_then(Value::as_str) == Some("user")).map(|row| row.get("content").map_or_else(String::new, message_text)).collect())
    }
}

