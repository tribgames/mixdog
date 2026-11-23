use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::HeaderToolSurfaces;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::ToolSurfaceSource;
use mixdog_mcp::permissions::parse_mcp_tool_name;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::bridge::CallResolution;
use mixdog_tools::orch::bridge::CatalogView;
use mixdog_tools::orch::bridge::ToolDoc;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::deferred_manifest::server_label;
use super::deferred_select::render_tool_search;
use super::deferred_select::scope_mode;
use super::route_schema::Verdict;
use super::route_schema::schema_verdict;
use super::surface_host::thread_mode;
use super::tool_exposure::is_tool_bridge_enabled;
use super::tool_surface::SELECT_ALIASES;
use super::tool_surface::SurfaceHost;
use super::tool_surface::ToolSurface;
use super::tool_surface::bridge_readonly_session;
use super::tool_surface::clean;
use super::tool_surface::filter_disallowed_tools;
use super::tool_surface::permitted_by_session_policy;
use super::tool_surface::readonly_selectable;
use super::tool_surface::sorted_catalog_by_measured_usage;
use super::tool_surface::tool_name;
use super::turn_settings::TurnSettings;

/// `MCP_INSTRUCTION_MAX_CHARS` of `context/deferred-tools.mjs`.
const MCP_INSTRUCTION_MAX_CHARS: usize = 600;

/// The latest header of a running thread, readable without waiting.
pub trait RunningHeaders: Send + Sync {
    fn header(&self, thread: &ThreadId) -> Option<Arc<Header>>;
}

impl RunningHeaders for SessionDirectory {
    fn header(&self, thread: &ThreadId) -> Option<Arc<Header>> {
        self.handle(thread).map(|handle| handle.live_header().header())
    }
}

/// `mcpStatus()` for a thread's MCP scope: `{servers: [{name, status}, ..]}`. A status that cannot be
/// read is `Value::Null` (Node's `pendingAndFailedMcpServers` reads a throwing getter as none).
#[async_trait]
pub trait McpServerStatus: Send + Sync {
    async fn status(&self, thread: &ThreadId) -> Value;
}

pub struct SessionCatalog {
    sessions: Arc<dyn RunningHeaders>,
    threads: Arc<dyn ThreadState>,
    updates: Arc<dyn HeaderUpdates>,
    surfaces: HeaderToolSurfaces,
    host: Arc<dyn SurfaceHost>,
    clock: Arc<dyn Clock>,
    /// The turn settings that refresh a thread's MCP catalog before `load_tool` reads it.
    mcp: Option<Arc<dyn TurnSettings>>,
    /// The servers' status a native `load_tool` names pending and failed servers from.
    status: Option<Arc<dyn McpServerStatus>>,
}

impl SessionCatalog {
    /// `load_tool` refreshes the thread's MCP catalog through `settings` first (`toolSearch` of
    /// `internal-tool-executor/knowledge-tools.mjs`).
    #[must_use]
    pub fn with_refresh(mut self, settings: Arc<dyn TurnSettings>) -> Self {
        self.mcp = Some(settings);
        self
    }

    /// A native `load_tool` reads the MCP servers' status through `status` (`{ mcpStatus }`).
    #[must_use]
    pub fn with_status(mut self, status: Arc<dyn McpServerStatus>) -> Self {
        self.status = Some(status);
        self
    }

    /// `exclusions` is the one `RouteExclusions` the session surfaces are built from; `threads`
    /// reads a header and `updates` writes it where it has one writer (one object is both).
    pub fn new(
        sessions: Arc<dyn RunningHeaders>,
        threads: Arc<dyn ThreadState>,
        updates: Arc<dyn HeaderUpdates>,
        exclusions: Arc<dyn mixdog_core_session::session::RouteExclusions>,
        host: Arc<dyn SurfaceHost>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { sessions, threads, updates, surfaces: HeaderToolSurfaces::new(exclusions), host, clock, mcp: None, status: None }
    }

    fn running(&self, thread: &ThreadId) -> Option<(Arc<Header>, Value)> {
        let header = self.sessions.header(thread)?;
        let session = Value::Object((*header).clone());
        Some((header, session))
    }

    fn union(&self, session: &Value) -> Vec<Value> {
        ToolSurface { host: self.host.as_ref(), clock: self.clock.as_ref() }.catalog_union(session)
    }

    /// Whether the core registered a runner for `name`: the set a call is resolved from.
    fn runs(&self, name: &str) -> bool {
        ToolSurface { host: self.host.as_ref(), clock: self.clock.as_ref() }.runs(name)
    }

    /// `filterSessionToolPolicy(tools, session)`: what the session's own policy lets it run.
    fn within_policy(&self, tools: &[Value], session: &Value) -> Vec<Value> {
        let denied = strings(session, "disallowedTools");
        filter_disallowed_tools(tools, &denied).into_iter().filter(|tool| permitted_by_session_policy(session, &tool_name(tool))).collect()
    }

    /// `availableBridgeTools`: eager first, then the deferred catalog, within the session's policy
    /// and the current MCP snapshot.
    fn available_tools(&self, session: &Value) -> Vec<Value> {
        let eager = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let all: Vec<Value> = eager.into_iter().chain(self.union(session)).collect();
        let mut seen = HashSet::new();
        let out: Vec<Value> = self
            .within_policy(&all, session)
            .into_iter()
            .filter(|tool| {
                let name = tool_name(tool);
                !name.is_empty() && deferred_available(session, &name) && seen.insert(name)
            })
            .collect();
        sorted_catalog_by_measured_usage(out)
    }
}

/// An array of strings, `clean`ed (`[]` for anything else).
pub(super) fn strings(session: &Value, key: &str) -> Vec<String> {
    session.get(key).and_then(Value::as_array).map_or_else(Vec::new, |items| items.iter().map(|v| clean(Some(v))).collect())
}

fn eager_names(session: &Value) -> HashSet<String> {
    session.get("tools").and_then(Value::as_array).into_iter().flatten().map(tool_name).filter(|n| !n.is_empty()).collect()
}

/// `isDeferredToolAvailable`: only the latest scoped MCP snapshot grants availability, and an
/// absent snapshot preserves pre-initialization behaviour.
pub(super) fn deferred_available(session: &Value, name: &str) -> bool {
    !name.starts_with("mcp__")
        || session.get("deferredMcpToolNames").and_then(Value::as_array).is_none_or(|names| names.iter().any(|n| n.as_str() == Some(name)))
}

/// `lookupByName`: the exact name, else the same name in any case.
fn lookup<'a>(tools: &'a [Value], name: &str) -> Option<&'a Value> {
    let key = mixdog_js::js_trim(name);
    if key.is_empty() {
        return None;
    }
    let lower = key.to_lowercase();
    tools.iter().find(|t| tool_name(t) == key).or_else(|| tools.iter().find(|t| tool_name(t).to_lowercase() == lower))
}

/// `parseMcpToolName(tool)?.server`: a definition's own `mcpServerName` wins over its name.
pub(super) fn server_of(tool: &Value) -> String {
    let own = clean(tool.get("mcpServerName"));
    if !own.is_empty() {
        return own;
    }
    parse_mcp_tool_name(&tool_name(tool)).map(|(server, _)| server).unwrap_or_default()
}

fn doc(tool: &Value) -> ToolDoc {
    ToolDoc {
        name: tool_name(tool),
        description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
        input_schema: tool.get("inputSchema").cloned().unwrap_or(Value::Null),
        annotations: tool.get("annotations").cloned().unwrap_or(Value::Null),
    }
}

/// `sanitizeMcpInstructionText`: no angle brackets, trimmed, capped at 600 UTF-16 units.
fn sanitize_instructions(text: &str) -> String {
    let stripped = mixdog_js::js_trim(&text.replace(['<', '>'], "")).to_owned();
    if mixdog_js::utf16_len(&stripped) > MCP_INSTRUCTION_MAX_CHARS {
        return format!("{}...", mixdog_js::slice_utf16(&stripped, MCP_INSTRUCTION_MAX_CHARS - 3));
    }
    stripped
}

fn instruction_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes())).chars().take(16).collect()
}

/// `/^Error:\s*/` removed.
fn without_error_prefix(text: &str) -> &str {
    match text.strip_prefix("Error:") {
        Some(rest) => rest.trim_start_matches(mixdog_js::is_js_space),
        None => text,
    }
}

/// A server whose instruction text the session has not been told yet.
pub(super) struct Pending {
    pub(super) server: String,
    pub(super) hash: String,
    pub(super) block: String,
}

/// `mcpServerSelection(tools, requested)`: the names of the tools `mcp__<server>` stands for; none
/// for any other name.
pub(super) fn mcp_server_selection(tools: &[Value], requested: &str) -> Vec<String> {
    let key = mixdog_js::js_trim(requested);
    let has_prefix = key.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("mcp__"));
    let server = &key[if has_prefix { 5 } else { 0 }..];
    // `/^mcp__(.+)$/i`: `.` matches no line terminator.
    if !has_prefix || server.is_empty() || server.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return Vec::new();
    }
    let server = server.to_lowercase();
    tools.iter().filter(|t| server_of(t).to_lowercase() == server).map(tool_name).collect()
}

/// `announceMcpServers(session, pending)`: the servers told, each with the hash of the text told.
pub(super) fn announce_mcp_servers(session: &mut Value, pending: &[Pending]) {
    if pending.is_empty() {
        return;
    }
    let Some(map) = session.as_object_mut() else { return };
    let mut announced = map.get("mcpInstructionsAnnounced").and_then(Value::as_array).cloned().unwrap_or_default();
    for entry in pending {
        let server = Value::String(entry.server.clone());
        if !announced.contains(&server) {
            announced.push(server);
        }
    }
    let mut hashes = map.get("mcpInstructionHashes").and_then(Value::as_object).cloned().unwrap_or_default();
    for entry in pending {
        hashes.insert(entry.server.clone(), Value::String(entry.hash.clone()));
    }
    map.insert("mcpInstructionsAnnounced".to_owned(), Value::Array(announced));
    map.insert("mcpInstructionHashes".to_owned(), Value::Object(hashes));
}

impl SessionCatalog {
    /// `pendingMcpInstructions(session, resolvableCatalog(session), names)`.
    fn pending_instructions(&self, session: &Value, names: &[String]) -> Vec<Pending> {
        // The deferred catalog, or the session's own tools when nothing is deferred.
        let mut catalog = self.union(session);
        if catalog.is_empty() {
            catalog = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        }
        pending_mcp_instructions(session, &self.within_policy(&catalog, session), names)
    }
}

/// `pendingMcpInstructions(session, catalog, names)`.
pub(super) fn pending_mcp_instructions(session: &Value, catalog: &[Value], names: &[String]) -> Vec<Pending> {
    let Some(texts) = session.get("mcpServerInstructions").and_then(Value::as_object) else { return Vec::new() };
    if names.is_empty() {
        return Vec::new();
    }
    let announced = strings(session, "mcpInstructionsAnnounced");
    let hashes = session.get("mcpInstructionHashes").and_then(Value::as_object);
    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    for name in names {
        let by_name = catalog.iter().find(|t| tool_name(t) == *name);
        let server = by_name.map_or_else(|| parse_mcp_tool_name(name).map(|(s, _)| s).unwrap_or_default(), server_of);
        if server.is_empty() || seen.contains(&server) || server_label(&server).is_empty() {
            continue;
        }
        let text = sanitize_instructions(texts.get(&server).and_then(Value::as_str).unwrap_or_default());
        if text.is_empty() {
            continue;
        }
        let hash = instruction_hash(&text);
        // Told already, and the text is the one told.
        if announced.contains(&server) && hashes.and_then(|h| h.get(&server)).and_then(Value::as_str) == Some(hash.as_str()) {
            continue;
        }
        pending.push(Pending { block: format!("## {server}\n{text}"), hash, server: server.clone() });
        seen.insert(server);
    }
    pending
}

#[async_trait]
impl CatalogView for SessionCatalog {
    fn available(&self, thread: &ThreadId) -> Vec<ToolDoc> {
        let Some((_, session)) = self.running(thread) else { return Vec::new() };
        self.available_tools(&session).iter().map(doc).collect()
    }

    fn is_eager(&self, thread: &ThreadId, name: &str) -> bool {
        self.running(thread).is_some_and(|(_, session)| eager_names(&session).contains(mixdog_js::js_trim(name)))
    }

    /// `bridgeBlockReason`: the surface's refusal, then (for a deferred tool) the read-only rule.
    fn block_reason(&self, thread: &ThreadId, name: &str) -> Option<String> {
        let (header, session) = self.running(thread)?;
        let available = self.available_tools(&session);
        let tool = lookup(&available, name)?;
        let name = tool_name(tool);
        if !self.runs(&name) {
            return Some(ToolSurface::unavailable_reason(&name));
        }
        if let Some(refusal) = self.surfaces.surface(thread, &header).refusal(&name, None) {
            return Some(without_error_prefix(&refusal.message_for_model).to_owned());
        }
        let eager = eager_names(&session).contains(&name);
        // An eager tool the route never sends is not "directly available".
        if eager && let Verdict::Excluded(reason) = schema_verdict(&header, tool) {
            return Some(reason);
        }
        (!eager && bridge_readonly_session(&session) && !readonly_selectable(tool)).then(|| "readonly mode".to_owned())
    }

    fn alias_members(&self, key: &str) -> Vec<String> {
        SELECT_ALIASES.iter().find(|(alias, _)| *alias == key).map_or_else(Vec::new, |(_, members)| members.iter().map(|m| (*m).to_owned()).collect())
    }

    /// `mcpServerSelection(available, requested)`: the tools `mcp__<server>` stands for.
    fn mcp_server_members(&self, thread: &ThreadId, requested: &str) -> Vec<String> {
        let Some((_, session)) = self.running(thread) else { return Vec::new() };
        mcp_server_selection(&self.available_tools(&session), requested)
    }

    /// `pendingMcpInstructions(session, resolvableCatalog(session), names)` as text.
    fn instructions_for(&self, thread: &ThreadId, names: &[String]) -> String {
        let Some((_, session)) = self.running(thread) else { return String::new() };
        self.pending_instructions(&session, names).into_iter().map(|p| p.block).collect::<Vec<_>>().join("\n")
    }

    /// `announceMcpServers`: the servers whose text a page carried are recorded with the hash of
    /// that text, through the session actor's header patch (a patch that lost the race is
    /// computed again from the header that won). A thread that is gone has nothing to record.
    async fn announce(&self, thread: &ThreadId, names: &[String]) {
        loop {
            let Ok(header) = self.threads.header(thread).await else { return };
            let session = Value::Object(header);
            let pending = self.pending_instructions(&session, names);
            if pending.is_empty() {
                return;
            }
            let current = |key: &str| session.get(key).cloned().unwrap_or(Value::Null);
            let mut announced = session.get("mcpInstructionsAnnounced").and_then(Value::as_array).cloned().unwrap_or_default();
            for entry in &pending {
                let server = Value::String(entry.server.clone());
                if !announced.contains(&server) {
                    announced.push(server);
                }
            }
            let mut hashes = session.get("mcpInstructionHashes").and_then(Value::as_object).cloned().unwrap_or_default();
            for entry in &pending {
                hashes.insert(entry.server.clone(), Value::String(entry.hash.clone()));
            }
            let expect = Map::from_iter([
                ("mcpInstructionsAnnounced".to_owned(), current("mcpInstructionsAnnounced")),
                ("mcpInstructionHashes".to_owned(), current("mcpInstructionHashes")),
            ]);
            let set =
                Map::from_iter([("mcpInstructionsAnnounced".to_owned(), Value::Array(announced)), ("mcpInstructionHashes".to_owned(), Value::Object(hashes))]);
            match self.threads.patch_header_if(thread, expect, set, Vec::new()).await {
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => return,
            }
        }
    }
    async fn refresh(&self, thread: &ThreadId) {
        if let Some(settings) = &self.mcp
            && let Err(error) = settings.refresh_mcp(thread).await
        {
            tracing::warn!("[mcp] catalog refresh failed: {error}");
        }
    }

    /// `renderToolSearch(args, session, scopeMode(session), { mcpStatus })` off the bridge: one
    /// header update on the session actor, so the load reads the header it writes and nothing
    /// lands in between. The route's exclusions and the servers' status are read before it.
    async fn load_native(&self, thread: &ThreadId, args: &Value) -> Option<Result<String, String>> {
        let (header, session) = self.running(thread)?;
        if is_tool_bridge_enabled(&session) {
            return None;
        }
        let excluded = self.surfaces.surface(thread, &header).route_excluded.clone();
        let status = match &self.status {
            Some(status) => status.status(thread).await,
            None => Value::Null,
        };
        let (host, clock, args) = (self.host.clone(), self.clock.clone(), args.clone());
        let (told, heard) = tokio::sync::oneshot::channel::<String>();
        let update: HeaderUpdate = Box::new(move |header| {
            let mut session = Value::Object(header.clone());
            let surface = ToolSurface { host: host.as_ref(), clock: clock.as_ref() };
            let mode = scope_mode(&session, thread_mode(header));
            let text = render_tool_search(&surface, &mut session, &args, &mode, &excluded, &status);
            let _ = told.send(text);
            let Value::Object(after) = session else { return HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() } };
            let set = after.into_iter().filter(|(key, value)| header.get(key) != Some(value)).collect();
            HeaderChange { set, unset: Vec::new(), patch: Default::default() }
        });
        if let Err(error) = self.updates.update_header(thread, update).await {
            return Some(Err(format!("load_tool could not update the session: {error:?}")));
        }
        Some(heard.await.map_err(|_| "load_tool: the header update did not run".to_owned()))
    }

    /// `catalogLacks`: a requested name the deferred catalog does not hold (case-insensitive).
    fn lacks(&self, thread: &ThreadId, names: &[String]) -> bool {
        let Some((_, session)) = self.running(thread) else { return false };
        let known: HashSet<String> = self.union(&session).iter().map(|tool| tool_name(tool).to_lowercase()).collect();
        names.iter().any(|name| !known.contains(&name.to_lowercase()))
    }

    async fn await_connect(&self, thread: &ThreadId) {
        if let Some(settings) = &self.mcp {
            settings.await_initial_mcp(thread).await;
        }
    }

    /// One reading of the header: what [`Self::resolve_call`] answers as deferred and [`Self::block_reason`] does not
    /// block, which is what a bridge roster lists of the catalog.
    fn callable(&self, thread: &ThreadId) -> Vec<String> {
        let Some((header, session)) = self.running(thread) else { return Vec::new() };
        let eager = eager_names(&session);
        let surface = self.surfaces.surface(thread, &header);
        let readonly = bridge_readonly_session(&session);
        let runs = |tool: &Value| {
            let name = tool_name(tool);
            !eager.contains(&name) && self.runs(&name) && surface.refusal(&name, None).is_none() && !(readonly && !readonly_selectable(tool))
        };
        self.available_tools(&session).iter().filter(|tool| runs(tool)).map(tool_name).collect()
    }

    /// `resolveBridgeTarget` after the argument checks.
    fn resolve_call(&self, thread: &ThreadId, name: &str) -> CallResolution {
        let Some((header, session)) = self.running(thread) else { return CallResolution::NotFound };
        let eager = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(tool) = lookup(&eager, name) {
            let direct = tool_name(tool);
            if !self.runs(&direct) {
                return CallResolution::Unrunnable { reason: ToolSurface::unavailable_reason(&direct), name: direct };
            }
            let surface = self.surfaces.surface(thread, &header);
            if let Some((_, reason)) = surface.route_excluded.iter().find(|(excluded, _)| *excluded == direct) {
                return CallResolution::Excluded(reason.clone());
            }
            if let Verdict::Excluded(reason) = schema_verdict(&header, tool) {
                return CallResolution::Excluded(reason);
            }
            return CallResolution::Direct(direct);
        }
        let union = self.union(&session);
        let Some(tool) = lookup(&union, name) else { return CallResolution::NotFound };
        let canonical = tool_name(tool);
        if !deferred_available(&session, &canonical) {
            CallResolution::Unavailable(canonical)
        } else if !self.runs(&canonical) {
            CallResolution::Unrunnable { reason: ToolSurface::unavailable_reason(&canonical), name: canonical }
        } else {
            CallResolution::Deferred(canonical)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_ports::ports::threads::Section;
    use mixdog_core_session::session::NoRouteExclusions;
    use mixdog_tools::orch::util::PortError;
    use serde_json::json;

    use super::*;

    /// The header of thread `t1`, readable as a running thread's and patchable as the actor's.
    struct Store(Mutex<Header>);

    impl Store {
        fn of(session: &Value) -> Arc<Self> {
            Arc::new(Self(Mutex::new(session.as_object().expect("session").clone())))
        }
    }

    impl RunningHeaders for Store {
        fn header(&self, thread: &ThreadId) -> Option<Arc<Header>> {
            (thread.as_str() == "t1").then(|| Arc::new(self.0.lock().expect("store").clone()))
        }
    }

    #[async_trait]
    impl ThreadState for Store {
        async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
            Ok(self.0.lock().expect("store").clone())
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            unreachable!("the catalog patches conditionally")
        }
        async fn patch_header_at(
            &self,
            thread: &ThreadId,
            at: &mixdog_core_ports::ports::threads::RunFence,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            unset: Vec<String>,
        ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, PortError> {
            mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            _: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            let mut header = self.0.lock().expect("store");
            let current: Map<String, Value> = expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            if current != expect {
                return Ok(Some(current));
            }
            header.extend(set);
            Ok(None)
        }
        async fn store_header(
            &self,
            thread: &ThreadId,
            write: mixdog_core_ports::ports::threads::HeaderWrite,
        ) -> mixdog_core_ports::ports::threads::HeaderStored {
            mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
        }
        fn log_identity(&self, _: &ThreadId) -> Option<String> {
            None
        }
        /// This fake holds nothing but the header it answers.
        async fn held_fields(
            &self,
            thread: &ThreadId,
            keys: &'static [&'static str],
        ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_core_ports::ports::threads::held_of(&mixdog_core_ports::ports::threads::ThreadState::header(self, thread).await?, keys))
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            unreachable!("the catalog publishes nothing")
        }
    }

    #[async_trait]
    impl HeaderUpdates for Store {
        async fn update_header(&self, _: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
            let mut header = self.0.lock().expect("store");
            let change = update(&header);
            header.extend(change.set);
            for key in change.unset {
                header.remove(&key);
            }
            Ok(())
        }
    }

    struct Now;

    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            0
        }
    }
    /// A core that registered every tool but `absent`: `load_tool` and a call consult this one set.
    struct Without(&'static str);

    impl SurfaceHost for Without {
        fn defined(&self, _: &str) -> bool {
            true
        }
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            Value::Null
        }
        fn runs(&self, name: &str) -> bool {
            name != self.0
        }
    }

    struct Stub(mixdog_core_api::domain::tool::ToolSpec);

    #[async_trait]
    impl mixdog_core_api::domain::tool::Tool for Stub {
        fn spec(&self) -> &mixdog_core_api::domain::tool::ToolSpec {
            &self.0
        }
        async fn call(&self, _: &mixdog_core_api::domain::tool::ToolContext, _: Value) -> mixdog_core_api::domain::tool::ToolOutcome {
            Ok(mixdog_core_api::domain::tool::ToolOutput::default())
        }
    }

    fn stub(name: &str) -> Arc<dyn mixdog_core_api::domain::tool::Tool> {
        Arc::new(Stub(mixdog_core_api::domain::tool::ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({}),
            annotations: mixdog_core_api::domain::tool::ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }))
    }

    /// The registry a core holds: the tools it registered, by name.
    struct Registered(Vec<Arc<dyn mixdog_core_api::domain::tool::Tool>>);

    impl mixdog_tools::policy::ToolResolver for Registered {
        fn resolve(&self, _: Option<&str>, name: &str) -> Option<Arc<dyn mixdog_core_api::domain::tool::Tool>> {
            self.0.iter().find(|tool| tool.spec().name == name).cloned()
        }
    }

    fn definition(name: &str) -> Value {
        json!({ "name": name, "description": format!("{name}."), "inputSchema": { "type": "object", "properties": {} } })
    }

    /// A session whose catalog holds `computer` beside the eager `read`; `exposure` is its `toolExposureMode`, if any.
    fn catalog_session(catalog: &[&str], exposure: Option<&str>) -> Value {
        let mut session = json!({
            "provider": "anthropic",
            "model": "smoke",
            "deferredProviderMode": "native",
            "deferredNativeTools": true,
            "deferredSurfaceMode": "lead",
            "tools": [definition("read")],
            "deferredToolCatalog": catalog.iter().map(|name| definition(name)).collect::<Vec<_>>(),
        });
        if let Some(exposure) = exposure {
            session["toolExposureMode"] = json!(exposure);
        }
        session
    }

    /// `load_tool {names}` on `session` as `host` runs it, then the tool set a turn of the session's header executes with over
    /// `registry`: the load's answer, the header it left and the set.
    async fn load_then_set(
        session: &Value,
        host: Arc<dyn SurfaceHost>,
        registry: Vec<Arc<dyn mixdog_core_api::domain::tool::Tool>>,
        names: &[&str],
    ) -> (Value, Header, mixdog_agent::tools::ToolSet) {
        let thread = ThreadId::from("t1");
        let store = Store::of(session);
        let catalog = SessionCatalog::new(store.clone(), store.clone(), store.clone(), Arc::new(NoRouteExclusions), host, Arc::new(Now));
        let answer = mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": names })).await.expect("an answer");
        let header = store.0.lock().expect("store").clone();
        let surface = HeaderToolSurfaces::new(Arc::new(NoRouteExclusions)).surface(&thread, &header);
        let set = super::super::assemble::with_surface_registry(
            mixdog_agent::tools::ToolSet::new(vec![stub("read")]),
            Arc::new(Registered(registry)),
            None,
            &surface,
        );
        (serde_json::from_str(&answer).expect("a JSON answer"), header, set)
    }

    /// A deferred tool whose host is present: `load_tool` reports it loaded, and a call to it by name resolves and runs.
    #[tokio::test]
    async fn a_tool_load_tool_loaded_is_callable_when_its_host_is_present() {
        let session = catalog_session(&["read", "computer"], None);
        let (answer, header, set) = load_then_set(&session, Arc::new(Without("")), vec![stub("read"), stub("computer")], &["computer"]).await;
        assert_eq!(answer["loaded"], json!(["computer"]));
        assert!(answer.get("unavailable").is_none());
        assert!(header["deferredCallableTools"].as_array().expect("callable").iter().any(|name| name == "computer"));
        assert_eq!(set.resolve("computer").expect("a loaded tool is callable").spec().name, "computer");
    }

    /// A deferred tool whose host is absent: `load_tool` does not load it and says why, and a call to it by name is answered
    /// with the same reason, not as unknown; the bridge's describe and `call_tool` say the same.
    #[tokio::test]
    async fn a_tool_whose_host_is_absent_is_unavailable_to_load_tool_and_to_a_call() {
        let reason = ToolSurface::unavailable_reason("computer");
        let session = catalog_session(&["read", "computer"], None);
        let (answer, header, set) = load_then_set(&session, Arc::new(Without("computer")), vec![stub("read")], &["computer"]).await;
        assert_eq!(answer["loaded"], json!([]));
        assert_eq!(answer["selected"]["tools"]["unavailable"], json!([{ "name": "computer", "reason": reason }]));
        assert!(answer["note"].as_str().expect("a note").contains(&reason));
        assert!(!header["deferredCallableTools"].as_array().expect("callable").iter().any(|name| name == "computer"));
        assert!(set.resolve("computer").is_none());
        let called = set.unknown_message("computer");
        assert_eq!(called, mixdog_agent::text::unavailable_tool_message("computer", &reason));
        assert!(called.contains(&reason) && !called.contains("unknown tool"));

        let bridged = catalog_session(&["read", "computer"], Some(super::super::tool_exposure::TOOL_EXPOSURE_BRIDGE));
        let store = Store::of(&bridged);
        let thread = ThreadId::from("t1");
        let catalog = SessionCatalog::new(store.clone(), store.clone(), store, Arc::new(NoRouteExclusions), Arc::new(Without("computer")), Arc::new(Now));
        let page: Value =
            serde_json::from_str(&mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": ["computer"] })).await.expect("a page")).expect("json");
        assert_eq!(page["blocked"], json!([{ "name": "computer", "reason": reason }]));
        assert_eq!(catalog.resolve_call(&thread, "computer"), CallResolution::Unrunnable { name: "computer".to_owned(), reason: reason.clone() });
        // The bridge's own response to the call carries that reason, not the generic catalog sentence.
        struct Never;
        #[async_trait]
        impl mixdog_tools::orch::bridge::ToolDispatcher for Never {
            async fn dispatch(&self, _: &mixdog_core_api::domain::tool::ToolContext, _: &str, _: Value) -> mixdog_core_api::domain::tool::ToolOutcome {
                unreachable!("an unavailable target is never dispatched")
            }
        }
        let call = mixdog_tools::orch::bridge::CallTool::new(Arc::new(catalog), Arc::new(Never));
        let refused =
            mixdog_core_api::domain::tool::CallProjection::project(&call, &thread, &json!({ "name": "computer", "arguments": {} })).expect_err("refused");
        assert!(refused.starts_with("Error: TOOL_UNAVAILABLE:") && refused.contains(&reason) && !refused.contains("current session catalog"), "{refused}");
    }

    /// Whether `computer` and `eagerone` can run is a switch the test flips: a registration that follows a desktop attaching.
    struct Switch(Arc<std::sync::atomic::AtomicBool>);

    impl SurfaceHost for Switch {
        fn defined(&self, _: &str) -> bool {
            true
        }
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            Value::Null
        }
        fn runs(&self, name: &str) -> bool {
            !matches!(name, "computer" | "eagerone") || self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn a_selected_tool_is_active_again_when_it_becomes_runnable_and_nothing_stored_is_lost() {
        let on = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = ThreadId::from("t1");
        let mut session = catalog_session(&["read", "computer"], None);
        session["tools"] = json!([definition("read"), definition("eagerone")]);
        session["deferredCallableTools"] = json!(["read", "computer"]);
        session["deferredSelectedTools"] = json!(["read", "computer"]);
        session["deferredDiscoveredTools"] = json!(["computer"]);
        let store = Store::of(&session);
        let catalog =
            SessionCatalog::new(store.clone(), store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(Switch(on.clone())), Arc::new(Now));
        let set_over = |registered: &[&str]| {
            let header = store.0.lock().expect("store").clone();
            let surface = HeaderToolSurfaces::new(Arc::new(NoRouteExclusions)).surface(&thread, &header);
            let pool = registered.iter().map(|name| stub(name)).collect();
            super::super::assemble::with_surface_registry(mixdog_agent::tools::ToolSet::new(vec![stub("read")]), Arc::new(Registered(pool)), None, &surface)
        };
        let listed = |answer: &Value, key: &str, name: &str| answer[key].as_array().expect("a list").iter().any(|entry| entry == name);

        // Not runnable: neither is active, neither is discovered, no call resolves, and nothing stored changed. The probe is a load
        // of `read`, already active: a load with no names lists the eager names alone (Node's answer), a named one the whole active set.
        let answer: Value =
            serde_json::from_str(&mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": ["read"] })).await.expect("an answer")).expect("json");
        assert!(!listed(&answer, "activeTools", "computer") && !listed(&answer, "activeTools", "eagerone") && !listed(&answer, "discoveredTools", "computer"));
        assert!(set_over(&["read"]).resolve("computer").is_none());
        let kept = store.0.lock().expect("store").clone();
        // The definitions are untouched; a load records what is active (it may add the eager names to the callable intent), but
        // nothing the session had chosen is lost.
        for key in ["tools", "deferredToolCatalog"] {
            assert_eq!(kept[key], session[key], "{key}");
        }
        for key in ["deferredCallableTools", "deferredSelectedTools", "deferredDiscoveredTools"] {
            let now = kept[key].as_array().expect("a list");
            assert!(session[key].as_array().expect("a list").iter().all(|name| now.contains(name)), "{key}: {now:?}");
        }

        // Runnable: the same session, no load in between.
        on.store(true, std::sync::atomic::Ordering::SeqCst);
        let answer: Value =
            serde_json::from_str(&mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": ["read"] })).await.expect("an answer")).expect("json");
        assert!(listed(&answer, "activeTools", "computer") && listed(&answer, "activeTools", "eagerone"));
        assert!(listed(&answer, "discoveredTools", "computer"));
        assert_eq!(set_over(&["read", "computer", "eagerone"]).resolve("computer").expect("callable").spec().name, "computer");
    }

    /// A read-only bridge session that names no tool is told what its `call_tool` runs now, the tools its prompt's roster
    /// lists: not an edit or a shell its read-only rule blocks, not a tool the core cannot run or the session denies, not
    /// a directly defined one.
    #[tokio::test]
    async fn a_read_only_sessions_unknown_name_is_answered_with_what_call_tool_runs() {
        let mut session = catalog_session(
            &["read", "edit", "shell", "web_fetch", "recall", "computer", "memory"],
            Some(super::super::tool_exposure::TOOL_EXPOSURE_BRIDGE),
        );
        session["deferredSurfaceMode"] = json!("readonly");
        session["disallowedTools"] = json!(["memory"]);
        let host = Arc::new(Without("computer"));
        let mut roster = ToolSurface { host: host.as_ref(), clock: &Now }.pool_tool_names(&session);
        let store = Store::of(&session);
        let thread = ThreadId::from("t1");
        let catalog = Arc::new(SessionCatalog::new(store.clone(), store.clone(), store, Arc::new(NoRouteExclusions), host, Arc::new(Now)));
        let mut callable = catalog.callable(&thread);
        assert_eq!(callable, ["web_fetch", "recall"]);
        roster.sort();
        callable.sort();
        assert_eq!(callable, roster);

        struct Never;
        #[async_trait]
        impl mixdog_tools::orch::bridge::ToolDispatcher for Never {
            async fn dispatch(&self, _: &mixdog_core_api::domain::tool::ToolContext, _: &str, _: Value) -> mixdog_core_api::domain::tool::ToolOutcome {
                unreachable!("a name that is no tool is never dispatched")
            }
        }
        let call = mixdog_tools::orch::bridge::CallTool::new(catalog, Arc::new(Never));
        let refused = mixdog_core_api::domain::tool::CallProjection::project(&call, &thread, &json!({ "name": "noop", "arguments": {} })).expect_err("refused");
        assert_eq!(
            refused,
            "Error: TOOL_NOT_FOUND: no tool named \"noop\" is available in this session. call_tool runs: web_fetch, recall. load_tool {names} shows a tool's parameters."
        );
    }

    /// A name in no catalog stays a plain unknown tool, on both sides.
    #[tokio::test]
    async fn a_name_in_no_catalog_is_plain_unknown() {
        let session = catalog_session(&["read"], None);
        let (answer, _, set) = load_then_set(&session, Arc::new(Without("computer")), vec![stub("read"), stub("computer")], &["computer"]).await;
        assert_eq!(answer["missing"], json!(["computer"]));
        assert!(answer.get("unavailable").is_none() && answer["selected"]["tools"].get("unavailable").is_none());
        assert!(set.resolve("computer").is_none());
        assert_eq!(set.unknown_message("computer"), "Error: unknown tool \"computer\"");
    }
}
