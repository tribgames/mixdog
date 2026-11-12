//! The real [`CatalogView`]: the tool catalog `load_tool` describes and `call_tool` resolves a
//! name in, read from the running session's header as Node reads its live session
//! (`runtime-core/tool-bridge.mjs`: `availableBridgeTools`, `bridgeBlockReason`,
//! `resolveBridgeTarget`; `tool-catalog.mjs`: `pendingMcpInstructions`).
//!
//! A thread that is not running has no tools: nothing is available there.
//!
//! An eager tool the route can never send (`routeToolExclusionReason`'s schema rule, see
//! `route_schema`) is blocked before it was ever sent, whatever the route's wire family; a tool
//! a request left out is also blocked, through the surface's route exclusions.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_store::schema::record::HeaderChange;
use mixdog_core_session::session::HeaderToolSurfaces;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::ToolSurfaceSource;
use mixdog_mcp::permissions::parse_mcp_tool_name;
use mixdog_store::schema::record::Header;
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
use super::surface_host::thread_mode;
use super::tool_exposure::is_tool_bridge_enabled;
use super::route_schema::Verdict;
use super::route_schema::schema_verdict;
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
    !name.starts_with("mcp__") || session.get("deferredMcpToolNames").and_then(Value::as_array).is_none_or(|names| names.iter().any(|n| n.as_str() == Some(name)))
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
            let set = Map::from_iter([
                ("mcpInstructionsAnnounced".to_owned(), Value::Array(announced)),
                ("mcpInstructionHashes".to_owned(), Value::Object(hashes)),
            ]);
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
            let Value::Object(after) = session else { return HeaderChange { set: Map::new(), unset: Vec::new() } };
            let set = after.into_iter().filter(|(key, value)| header.get(key) != Some(value)).collect();
            HeaderChange { set, unset: Vec::new() }
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

    /// `resolveBridgeTarget` after the argument checks.
    fn resolve_call(&self, thread: &ThreadId, name: &str) -> CallResolution {
        let Some((header, session)) = self.running(thread) else { return CallResolution::NotFound };
        let eager = session.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(tool) = lookup(&eager, name) {
            let direct = tool_name(tool);
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
        if deferred_available(&session, &canonical) { CallResolution::Deferred(canonical) } else { CallResolution::Unavailable(canonical) }
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
        async fn patch_header_if(&self, _: &ThreadId, expect: Map<String, Value>, set: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            let mut header = self.0.lock().expect("store");
            let current: Map<String, Value> = expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            if current != expect {
                return Ok(Some(current));
            }
            header.extend(set);
            Ok(None)
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

    struct Host;

    impl SurfaceHost for Host {
        fn bridge_tools(&self) -> Vec<Value> {
            Vec::new()
        }
        fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
            Value::Null
        }
    }

    struct Now;

    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    fn catalog(store: &Arc<Store>) -> SessionCatalog {
        SessionCatalog::new(store.clone(), store.clone(), store.clone(), Arc::new(NoRouteExclusions), Arc::new(Host), Arc::new(Now))
    }

    /// `load_tool` and `call_tool` over the sessions of `fixtures/tool-pool/catalog.json`, as
    /// Node's `renderToolSearch` and `resolveBridgeTarget` answer them.
    #[tokio::test]
    async fn describe_and_resolve_answer_as_node_does() {
        let golden: Value = mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/tool-pool/catalog.json")).expect("fixture");
        let thread = ThreadId::from("t1");
        for case in golden["cases"].as_array().expect("cases") {
            let store = Store::of(&case["session"]);
            let catalog = catalog(&store);
            for described in case["describe"].as_array().expect("describe") {
                // Each page is described from the session as the case holds it.
                *store.0.lock().expect("store") = case["session"].as_object().expect("session").clone();
                let want: Value = serde_json::from_str(described["result"].as_str().expect("text")).expect("json");
                let got = mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": described["names"] })).await;
                let got: Value = serde_json::from_str(&got.expect("a page")).expect("json");
                assert_eq!(got, want, "{} / {}", case["name"], described["names"]);
            }
            for resolved in case["resolve"].as_array().expect("resolve") {
                let name = resolved["name"].as_str().expect("name");
                let want = &resolved["result"];
                let got = catalog.resolve_call(&thread, name);
                let expected = match (want["error"]["code"].as_str(), want["name"].as_str()) {
                    (Some("USE_DIRECT_TOOL"), _) => CallResolution::Direct(name.to_lowercase()),
                    (Some("TOOL_EXCLUDED"), _) => CallResolution::Excluded(want["error"]["message"].as_str().expect("message").to_owned()),
                    (Some("TOOL_NOT_FOUND"), _) => CallResolution::NotFound,
                    (Some("TOOL_UNAVAILABLE"), _) => CallResolution::Unavailable(name.to_lowercase()),
                    (None, Some(target)) => CallResolution::Deferred(target.to_owned()),
                    other => panic!("{other:?}"),
                };
                assert_eq!(got, expected, "{} / {name}", case["name"]);
            }
        }
    }

    /// One session across pages: a server's text is sent once, again when its text changed, and
    /// the record the page leaves (`mcpInstructionsAnnounced`, `mcpInstructionHashes`) is Node's.
    #[tokio::test]
    async fn a_pages_instructions_are_recorded_so_the_next_page_does_not_repeat_them() {
        let golden: Value = mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/tool-pool/catalog.json")).expect("fixture");
        let thread = ThreadId::from("t1");
        let sequence = &golden["sequence"];
        let store = Store::of(&sequence["session"]);
        let catalog = catalog(&store);
        for step in sequence["steps"].as_array().expect("steps") {
            if let Some(change) = step["change"].as_object() {
                store.0.lock().expect("store").extend(change.clone());
            }
            let want: Value = serde_json::from_str(step["result"].as_str().expect("text")).expect("json");
            let got = mixdog_tools::orch::bridge::load(&catalog, &thread, &json!({ "names": step["names"] })).await;
            assert_eq!(serde_json::from_str::<Value>(&got.expect("a page")).expect("json"), want, "{}", step["names"]);
            let header = store.0.lock().expect("store");
            assert_eq!(header.get("mcpInstructionsAnnounced").cloned().unwrap_or(Value::Null), step["announced"], "{}", step["names"]);
            assert_eq!(header.get("mcpInstructionHashes").cloned().unwrap_or(Value::Null), step["hashes"], "{}", step["names"]);
        }
    }
}
