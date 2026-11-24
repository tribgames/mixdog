use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::skills::{CurrentSkill, CurrentSkillResult, CurrentSkills};
use mixdog_agent::env::Clock;
use mixdog_agent::native_search::parse_native_tool_search;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::gate::connector_policy_agent;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::RouteExclusions;
use mixdog_mcp::skill_catalog::{SkillCatalog, SkillLoad};
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skill_state::message_text;
use mixdog_mcp::skills::SkillSource;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::skill::{ArmNotice, result_envelope, stub};
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

pub(super) struct CompactionSkills {
    pub catalog: Arc<SkillCatalog>,
    pub arm: Arc<HeaderSkillArm>,
    pub thread: ThreadId,
    pub cwd: std::path::PathBuf,
}

#[async_trait]
impl CurrentSkills for CompactionSkills {
    async fn resolve(&self, name: &str, preview: bool) -> Result<Option<CurrentSkill>, String> {
        let SkillLoad::Loaded(resource) = self.catalog.load(name, &self.cwd).await.map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        let dependencies = &resource.skill.tool_dependencies;
        let body = result_envelope(name, &resource.body, Some(&resource.dir));
        let tools = dependencies.manifest_names();
        let result = if preview {
            None
        } else {
            let notice = if dependencies.tool_dependencies.is_empty() && dependencies.issues.is_empty() {
                ArmNotice::default()
            } else {
                let header = self.arm.threads.header(&self.thread).await.map_err(|error| format!("{error:?}"))?;
                let lookups = self.arm.lookups(&self.thread, &header, dependencies);
                self.arm.parts.load(&header, dependencies, &lookups).map_err(|name| format!("could not resolve skill-linked tool {name}"))?.1
            };
            let source = if resource.skill.source == SkillSource::Builtin { "builtin" } else { "" };
            let text = notice.result(&stub(name, source));
            let native = parse_native_tool_search("Skill", &text);
            let summary = native.as_ref().and_then(|value| value.get("summary")).and_then(Value::as_str).map_or(text, str::to_owned);
            Some(CurrentSkillResult { summary, native })
        };
        Ok(Some(CurrentSkill { body, tools, result }))
    }

    async fn activate(&self, name: &str, body: &str) -> Result<(), String> {
        if let SkillLoad::Loaded(resource) = self.catalog.load(name, &self.cwd).await.map_err(|error| error.to_string())?
            && result_envelope(name, &resource.body, Some(&resource.dir)) == body
        {
            self.arm.arm(&self.thread, &resource.skill.tool_dependencies).await.map_err(|error| format!("{error:?}"))?;
        }
        Ok(())
    }
}

impl HeaderSkillArm {
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
            asked.extend(
                header.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(|tool| tool.get("name").and_then(Value::as_str)).map(str::to_owned),
            );
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
        let mut unavailable = dependencies.issues.clone();
        let wanted = wanted_names(&catalog, &dependencies.tool_dependencies, &mut unavailable);
        let has_tools = session.get("tools").is_some_and(Value::is_array);
        let surface = SessionSurface::from_header(header, lookups.route_excluded.clone());
        let allowed = allowed_names(wanted, &catalog, has_tools, &surface, lookups, &mut unavailable)?;
        let readonly = readonly_selection(&session);
        let selection = (!allowed.is_empty()).then(|| select(&self.surface(), &mut session, &surface.route_excluded, &allowed, readonly, true));
        let loaded: Vec<String> = selection.as_ref().map_or_else(Vec::new, |selection| selection.added.iter().chain(&selection.already).cloned().collect());
        for (name, reason) in selection.iter().flat_map(|selection| &selection.blocked) {
            unavailable.push(format!("{name} ({reason})"));
        }
        for (name, reason) in selection.iter().flat_map(|selection| &selection.unavailable) {
            unavailable.push(format!("{name} ({reason})"));
        }
        for name in selection.iter().flat_map(|selection| &selection.missing) {
            unavailable.push(format!("{name} (not available in this session)"));
        }
        record_loaded_tools(&mut session, &loaded);
        let native = selection.as_ref().filter(|s| s.native).map(|_| loaded.as_slice());
        let notice = notice_of(&session, &catalog, &loaded, &unavailable, native);
        Ok((session, notice))
    }
}

fn allowed_names(
    wanted: Vec<String>,
    catalog: &[(String, Value)],
    has_tools: bool,
    surface: &SessionSurface,
    lookups: &Lookups,
    unavailable: &mut Vec<String>,
) -> Result<Vec<String>, String> {
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
    Ok(allowed)
}

fn record_loaded_tools(session: &mut Value, loaded: &[String]) {
    if loaded.is_empty() {
        return;
    }
    let Some(map) = session.as_object_mut() else { return };
    let mut kept: Vec<String> = Vec::new();
    for name in
        map.get("skillLoadedTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).chain(loaded.iter().cloned())
    {
        insert(&mut kept, name);
    }
    map.insert("skillLoadedTools".to_owned(), names_value(&kept));
}

fn notice_of(session: &Value, catalog: &[(String, Value)], loaded: &[String], unavailable: &[String], native: Option<&[String]>) -> ArmNotice {
    let eager: HashSet<&str> =
        session.get("tools").and_then(Value::as_array).into_iter().flatten().filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
    // Bridge exposure never promotes a schema: deferred dependencies stay reachable through call_tool
    // while the eager surface keeps its bytes.
    let bridge = is_tool_bridge_enabled(session);
    let bridged: Vec<&String> = if bridge { loaded.iter().filter(|name| !eager.contains(name.as_str())).collect() } else { Vec::new() };
    let direct: Vec<&String> = loaded.iter().filter(|name| !bridged.contains(name)).collect();
    let join = |names: &[&String]| names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ");
    let mut lines: Vec<String> = Vec::new();
    if !direct.is_empty() && !bridge {
        lines.push(format!(
            "Required tools loaded: {}. Their full definitions are available on your next request; use them directly without load_tool.",
            join(&direct)
        ));
    }
    if !direct.is_empty() && bridge {
        lines.push(format!("Required tools available directly: {}.", join(&direct)));
    }
    if !bridged.is_empty() {
        lines.push(format!(
            "Required tools available through call_tool: {}. Read a definition with load_tool, then run it with call_tool {{name, arguments}}.",
            join(&bridged)
        ));
    }
    if !unavailable.is_empty() {
        lines.push(format!("Required tools unavailable: {}", unavailable.join("; ")));
        lines.push("No tools were installed or enabled and no permissions were changed.".to_owned());
    }
    let provider = clean(session.get("provider"));
    // `toolSearchNativePayload` without its summary: the result's own stands in.
    let payload = native
        .and_then(|names| {
            let promoted: Vec<String> = names.iter().filter(|name| !eager.contains(name.as_str())).cloned().collect();
            tool_search_native_payload(catalog.iter().map(|(_, tool)| tool), &promoted, &provider)
        })
        .map(|mut payload| {
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
    HeaderChange { set, unset: Vec::new(), patch: Default::default() }
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
                HeaderChange::default()
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

pub struct ThreadTranscript {
    messages: Arc<dyn ThreadMessages>,
}

impl ThreadTranscript {
    /// `messages` reads the thread's model conversation (`thread/messages/read`).
    pub fn new(messages: Arc<dyn ThreadMessages>) -> Self {
        Self { messages }
    }
}

#[async_trait]
impl TranscriptTexts for ThreadTranscript {
    /// A transcript that cannot be read is the port's error; the Skill tool fails with it.
    async fn user_texts(&self, thread: &ThreadId) -> Result<Vec<String>, PortError> {
        let rows = self.messages.messages(thread).await?;
        Ok(rows
            .iter()
            .filter(|row| row.get("role").and_then(Value::as_str) == Some("user"))
            .map(|row| row.get("content").map_or_else(String::new, message_text))
            .collect())
    }
}
