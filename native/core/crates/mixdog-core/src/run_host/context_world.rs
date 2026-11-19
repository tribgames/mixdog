//! The live world of `thread/contextStatus` (`ContextWorld` of `mixdog_core_session`): what Node's
//! `createContextStatus` reads through its injected getters (`getSession`, `getRoute`,
//! `getCurrentCwd`, `getMode`, `getNativeTools`), taken from the thread's own ports, and the
//! request tools `snapshotProviderRequestTools` makes of the session's tools.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::tool_schema::ToolAnnotations;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::tool::Freeform;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::failed;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::route::has_session;
use mixdog_core_ports::ports::route::header_names_session;
use mixdog_core_ports::ports::route::is_summary_anchor;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::tools_status::SurfaceHost;
use mixdog_core_session::session::thread_context::ContextSnapshot;
use mixdog_core_session::session::thread_context::ContextWorld;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::session_cache_opts::is_agent_mode_session;
use super::tool_surface::parse_tool_selection;
use super::tool_exposure::native_provider_family;
use super::tool_exposure::native_request_tools;

const DOMAIN: &str = "thread context";

/// The meters of one thread on one provider: its `MediaLowering` (the one compaction meters with),
/// handed over as both the media meter and the image identities.
pub type LoweringFor = dyn Fn(&ThreadId, &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) + Send + Sync;

pub struct LiveContextWorld {
    pub threads: Arc<dyn ThreadState>,
    pub messages: Arc<dyn ThreadMessages>,
    pub routes: Arc<dyn LiveRoute>,
    pub session: Arc<dyn RouteSession>,
    pub host: Arc<dyn SurfaceHost>,
    pub lowering: Arc<LoweringFor>,
}

/// The rows of the transcript signature: each message's own stored row (`message_of` keeps it), as
/// the session's messages carry them in Node. A message no row was read for (the system prompt's blocks, built from
/// the header) is its fresh row, as Node's session holds its leading system messages.
pub(super) struct StoredBodies;

impl MessageRows for StoredBodies {
    fn row(&self, message: &mixdog_agent::message::AgentMessage) -> Value {
        message.stored.as_ref().map_or_else(|| super::message_row::row_of(message), |row| Value::Object((**row).clone()))
    }
}

fn text(map: &serde_json::Map<String, Value>, key: &str) -> String {
    map.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// A session tool document as the wire serialization reads it (`serializeToolSchemas`).
fn definition(doc: &Value) -> ToolDefinition {
    let schema = ["inputSchema", "input_schema", "parameters", "schema"].into_iter().find_map(|key| present(doc.get(key)));
    ToolDefinition {
        name: doc.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
        description: doc.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
        input_schema: schema.cloned().unwrap_or(Value::Null),
        defer_loading: doc.get("deferLoading") == Some(&Value::Bool(true)) || doc.get("defer_loading") == Some(&Value::Bool(true)),
        freeform: Freeform::from_definition(doc),
    }
}

/// `messageToolReferences`: the tool names a message's native tool search referenced, when it ran
/// on this provider (or the other first-party Anthropic one).
fn message_tool_references(row: &Value, provider: &str) -> Vec<String> {
    native_references(row.get("nativeToolSearch"), provider)
}

/// `messageToolReferences` over a message's `nativeToolSearch` record.
pub(super) fn native_references(native: Option<&Value>, provider: &str) -> Vec<String> {
    let source = mixdog_js::js_trim(native.and_then(|n| n.get("provider")).and_then(Value::as_str).unwrap_or_default()).to_lowercase();
    let anthropic = |p: &str| matches!(p, "anthropic" | "anthropic-oauth");
    if !source.is_empty() && source != provider && !(anthropic(&source) && anthropic(provider)) {
        return Vec::new();
    }
    parse_tool_selection(native.and_then(|n| n.get("toolReferences")))
}

/// `snapshotProviderRequestTools` over the session's stored tools (no native tools ride a
/// conversation's request): `baseToolSnapshot` (object entries with a name, once each; Node listed `mcp__`
/// ones only while the connected list named them, which a live epoch here never does), then, for a native-deferred Anthropic-family session, the catalog tools
/// the session discovered (`deferredDiscoveredTools`, tool references in the transcript, and the
/// one anchor that keeps tool-search mode in the cached prefix), each marked `defer_loading`.
pub(super) fn request_definitions(header: &serde_json::Map<String, Value>, docs: &[Value], rows: &[Value], provider: &str) -> Vec<ToolDefinition> {
    let provider = mixdog_js::js_trim(provider).to_lowercase();
    let base = docs.iter().filter(|doc| doc.is_object()).map(definition).collect();
    let referenced = rows.iter().flat_map(|row| message_tool_references(row, &provider)).collect();
    snapshot_tools(header, base, referenced, &provider)
}

/// The same snapshot over tool definitions the caller already holds (`base`, in session order) and the tool names
/// the transcript's native tool searches referenced: the run's request takes it at every request boundary.
///
/// Nothing here is judged against the hub: an entry its owner withdrew (an MCP server publishing a catalog without it) stays in
/// the request, as a tool that is only unavailable (its server down, its scope moved) does, until a cold fold or an explicit
/// rebuild repairs the stored lists (`ToolSurface::repair`).
pub(super) fn snapshot_tools(header: &serde_json::Map<String, Value>, base: Vec<ToolDefinition>, referenced: Vec<String>, provider: &str) -> Vec<ToolDefinition> {
    let mut names = HashSet::new();
    let mut out: Vec<ToolDefinition> = base
        .into_iter()
        .filter(|tool| {
            let name = mixdog_js::js_trim(&tool.name).to_owned();
            !name.is_empty() && names.insert(name)
        })
        .collect();
    let provider = mixdog_js::js_trim(provider).to_lowercase();
    if out.is_empty()
        || header.get("deferredNativeTools") != Some(&Value::Bool(true))
        || native_provider_family(&provider, header.get("wireRoute")) != "anthropic"
    {
        return out;
    }
    let catalog_of = |key: &str| header.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let catalog = catalog_of("deferredToolCatalog");
    let mut discovered: HashSet<String> = parse_tool_selection(header.get("deferredDiscoveredTools")).into_iter().collect();
    discovered.extend(referenced);
    // `deferredModeAnchor`.
    let anchor = catalog.iter().find_map(|tool| {
        let name = mixdog_js::js_trim(tool.get("name").and_then(Value::as_str)?);
        (!name.is_empty() && !name.starts_with("mcp__") && !names.contains(name)).then(|| name.to_owned())
    });
    discovered.extend(anchor);
    if discovered.is_empty() {
        return out;
    }
    // The catalog by trimmed name: a later entry of the same name replaces the earlier one in place.
    let mut by_name: Vec<(String, Value)> = Vec::new();
    for tool in catalog.into_iter().chain(catalog_of("deferredLateToolCatalog")) {
        let Some(captured) = tool.get("name").and_then(Value::as_str) else { continue };
        let name = mixdog_js::js_trim(captured).to_owned();
        if name.is_empty() {
            continue;
        }
        match by_name.iter_mut().find(|(known, _)| *known == name) {
            Some(slot) => slot.1 = tool,
            None => by_name.push((name, tool)),
        }
    }
    for (name, tool) in by_name {
        if !tool.is_object() || !discovered.contains(&name) || names.contains(&name) {
            continue;
        }
        names.insert(name);
        let mut deferred = definition(&tool);
        deferred.defer_loading = true;
        out.push(deferred);
    }
    out
}
#[async_trait]
impl ContextWorld for LiveContextWorld {
    async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError> {
        // The daemon addresses every session by thread id; there is no ambient current session.
        let Some(thread) = thread else { return Ok(None) };
        let Ok(header) = self.threads.header(thread).await else { return Ok(None) };
        self.snapshot_for(thread, header).await
    }

    async fn snapshot_for(&self, thread: &ThreadId, header: serde_json::Map<String, Value>) -> Result<Option<ContextSnapshot>, CoreError> {
        self.snapshot_of(thread, header, false).await
    }

    async fn header_snapshot(&self, thread: &ThreadId) -> Result<Option<ContextSnapshot>, CoreError> {
        let Ok(header) = self.threads.header(thread).await else { return Ok(None) };
        self.snapshot_of(thread, header, true).await
    }

    fn lowering(&self, thread: &ThreadId, provider: &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) {
        (self.lowering)(thread, provider)
    }
}

impl LiveContextWorld {
    /// The snapshot of `thread` under `header`. `header_only`: the snapshot a session's open reads for its measurement and display
    /// figures ([`ContextWorld::header_snapshot`]), which equal the full snapshot's: the transcript is read only up to its newest
    /// row that makes a conversation (the whole of it when none does), its counts and media are not taken, and a case in
    /// which the transcript moves the figures otherwise reads it whole as the full snapshot does.
    async fn snapshot_of(&self, thread: &ThreadId, header: serde_json::Map<String, Value>, header_only: bool) -> Result<Option<ContextSnapshot>, CoreError> {
        let route = self.routes.route(thread);
        let live = self.session.live_turn_messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
        // The transcript moves the header-only figures through one answer only, whether it holds a conversation, unless a turn
        // runs, the header names no session, or its deferred native tools take the tools the transcript referenced: then it is
        // read whole.
        let header_only = header_only && live.is_empty() && header_names_session(&header) && header.get("deferredNativeTools") != Some(&Value::Bool(true));
        let rows = if !live.is_empty() {
            live
        } else if header_only {
            // The newest rows up to the newest one that makes a conversation: `active` below answers as over the whole transcript.
            let session = self.session.clone();
            let conversation = move |message: &Value| session.has_user_conversation(std::slice::from_ref(message)) || is_summary_anchor(message);
            self.messages.messages_until(thread, &conversation).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        } else {
            self.messages.messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        };
        if !has_session(&header, &rows) {
            // No session yet: Node's `contextStatus` is `emptyContextStatus(null, getRoute(), env)` - the live route and the
            // folder, nothing of the record - until a model route has created the session.
            let provider = text(&route, "provider");
            let (media, images) = (self.lowering)(thread, &provider);
            return Ok(Some(ContextSnapshot {
                header: Default::default(),
                model: text(&route, "model"),
                context_window: route.get("contextWindow").cloned().unwrap_or(Value::Null),
                cwd: Value::String(text(&header, "cwd")),
                mode: Value::String(self.host.mode(Some(&header))),
                messages: Vec::new(),
                active: false,
                request_native: Vec::new(),
                request_defined: Vec::new(),
                session_defined: Vec::new(),
                agent_mode: false,
                annotations: HashMap::new(),
                media,
                images,
                rows: Arc::new(StoredBodies),
                replay_owner: ProviderId::from(provider.as_str()),
                provider,
            }));
        }
        let active = self.session.has_user_conversation(&rows) || rows.iter().any(is_summary_anchor);
        // Header-only: the rows read are a tail, which the counts below must not take for the conversation.
        let rows = if header_only { Vec::new() } else { rows };
        // Node's `session.messages` lead with the system blocks the request is sent with; the turn builds its request from the
        // same header fields (`system_messages`), so the status counts that request, not the transcript alone.
        let messages = super::factory::session_messages(&header, &rows).map_err(|e| failed(DOMAIN, e))?;
        let provider = Some(text(&header, "provider")).filter(|p| !p.is_empty()).unwrap_or_else(|| text(&route, "provider"));
        let model = Some(text(&header, "model")).filter(|m| !m.is_empty()).unwrap_or_else(|| text(&route, "model"));
        let docs: Vec<Value> = header.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let request_defined = request_definitions(&header, &docs, &rows, &provider);
        let annotations: HashMap<String, ToolAnnotations> = docs
            .iter()
            .filter_map(|doc| {
                let name = doc.get("name").and_then(Value::as_str)?;
                let annotations = doc.get("annotations");
                Some((
                    name.to_owned(),
                    ToolAnnotations {
                        mixdog_kind: annotations.and_then(|a| a.get("mixdogKind")).and_then(Value::as_str).map(str::to_owned),
                        agent_hidden: annotations.and_then(|a| a.get("agentHidden")).is_some_and(|v| match v {
                            Value::Null | Value::Bool(false) => false,
                            Value::String(s) => !s.is_empty(),
                            Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
                            _ => true,
                        }),
                    },
                ))
            })
            .collect();
        let (media, images) = (self.lowering)(thread, &provider);
        // The meter is synchronous: the facts of the stored media and the counts of every inline PDF (the page counts a read's
        // document block carries) are read into it first, as the compaction does (`Compactor::prepare`). A read that fails
        // leaves that part unpriced, as there.
        if !header_only {
            let _ = media.prepare(&messages).await;
        }
        let agent_mode = is_agent_mode_session(&header);
        let request_native = native_request_tools(&Value::Object(header.clone()));
        let replay_owner = ProviderId::from(provider.as_str());
        Ok(Some(ContextSnapshot {
            provider,
            model,
            context_window: route.get("contextWindow").cloned().unwrap_or(Value::Null),
            cwd: Value::String(text(&header, "cwd")),
            mode: Value::String(self.host.mode(Some(&header))),
            messages,
            active,
            request_native,
            request_defined,
            session_defined: docs.iter().map(definition).collect(),
            agent_mode,
            annotations,
            media,
            images,
            rows: Arc::new(StoredBodies),
            replay_owner,
            header,
        }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #[cfg(node_twin)]
    use mixdog_agent::compact::estimate::PartMeter;
    #[cfg(node_twin)]
    use mixdog_core_api::domain::provider::ContentPart;
    #[cfg(node_twin)]
    use mixdog_core_ports::ports::threads::Section;
    #[cfg(node_twin)]
    use mixdog_core_session::session::thread_context::ContextStatusHost;
    #[cfg(node_twin)]
    use mixdog_core_session::session::thread_context::LiveContextStatus;
    #[cfg(node_twin)]
    use mixdog_store::schema::record::Header;
    #[cfg(node_twin)]
    use mixdog_tools::orch::status::StatusSurface;
    #[cfg(node_twin)]
    use mixdog_tools::orch::util::PortError;
    #[cfg(node_twin)]
    use serde_json::Map;
    use serde_json::json;

    use super::*;
    #[cfg(node_twin)]
    use mixdog_core_ports::ports::route::Route;

    #[cfg(node_twin)]
    struct TextOnly;
    #[cfg(node_twin)]
    impl MediaMeter for TextOnly {
        fn part(&self, part: &ContentPart) -> PartMeter {
            panic!("media part in a text-only golden: {part:?}")
        }
    }
    #[cfg(node_twin)]
    impl ImageIdentities for TextOnly {
        fn images(&self, _: &mixdog_agent::message::AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
            Vec::new()
        }
    }

    /// One golden case as a live session: the stored header, the committed rows, the live route.
    #[cfg(node_twin)]
    struct Live {
        case: Value,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl ThreadState for Live {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            if thread.as_str() != self.case["name"] {
                return Err(PortError::Denied("no such thread".into()));
            }
            let mut header = self.case["header"].as_object().cloned().ok_or_else(|| PortError::Denied("no session".into()))?;
            // The stored header carries the session's tool list and cwd (`tools`, `cwd`).
            header.insert("tools".into(), self.case["tools"].clone());
            header.insert("cwd".into(), self.case["cwd"].clone());
            Ok(header)
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            Ok(())
        }
        async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            Ok(None)
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl ThreadMessages for Live {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(self.case["messages"].as_array().cloned().unwrap_or_default())
        }
    }

    #[cfg(node_twin)]
    impl LiveRoute for Live {
        fn route(&self, _: &ThreadId) -> Route {
            json!({ "contextWindow": self.case["route"]["contextWindow"], "provider": self.case["route"]["provider"], "model": self.case["route"]["model"] })
                .as_object()
                .cloned()
                .expect("route")
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl RouteSession for Live {
        fn generation(&self, _: &ThreadId) -> u64 {
            0
        }
        async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
        fn has_user_conversation(&self, messages: &[Value]) -> bool {
            messages.iter().any(|m| m["role"] == "user" && !is_summary_anchor(m))
        }
        async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, PortError> {
            Ok(true)
        }
        async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, PortError> {
            Ok(true)
        }
        async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), PortError> {
            Ok(())
        }
        async fn owner_fallbacks(&self, _: &ThreadId, _: &Header, _: &str, _: &str) -> Result<Option<Vec<Value>>, PortError> {
            Ok(None)
        }
        fn write_statusline(&self, _: &ThreadId, _: &Route) {}
        fn invalidate_context_status(&self, _: &ThreadId) {}
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl SurfaceHost for Live {
        fn mode(&self, _: Option<&serde_json::Map<String, Value>>) -> String {
            self.case["mode"].as_str().expect("mode").to_owned()
        }
        async fn preview(&self) -> Result<StatusSurface, CoreError> {
            Ok(StatusSurface::default())
        }
        async fn reconcile_empty(&self, _: &ThreadId) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[cfg(node_twin)]
    fn world(case: &Value) -> LiveContextWorld {
        let live = Arc::new(Live { case: case.clone() });
        LiveContextWorld {
            threads: live.clone(),
            messages: live.clone(),
            routes: live.clone(),
            session: live.clone(),
            host: live,
            lowering: Arc::new(|_, _| (Arc::new(TextOnly), Arc::new(TextOnly))),
        }
    }

    /// The `fixtures/context-status` cases whose recorded request left out a discovered MCP definition that Node's connected list
    /// did not name (see [`MCP_AVAILABILITY_DEPARTURES`] for the decision).
    #[cfg(node_twin)]
    const STATUS_MCP_DEPARTURES: [&str; 1] = ["anthropic deferred expansion"];

    /// The route the recorded runtime held (`rt.route`), whose window the gauge reads.
    #[cfg(node_twin)]
    struct RecordedRoute(Route);
    #[cfg(node_twin)]
    impl LiveRoute for RecordedRoute {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.clone()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    #[cfg(node_twin)]
    fn system_messages_of(case: &Value) -> usize {
        super::super::factory::system_messages(case["header"].as_object().expect("header")).len()
    }

    /// The route facts of a route change over the window rule alone (no catalog row): the model's window as
    /// `resolveSessionContextMeta` states it.
    #[cfg(node_twin)]
    pub(crate) struct WindowFacts;
    #[async_trait]
    #[cfg(node_twin)]
    impl crate::run_host::route_change::RouteFacts for WindowFacts {
        fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
            Some(mixdog_core_run::run_host::session_context_meta::resolve_context_meta(None, None, provider, model, seed, false))
        }
        fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &Header) -> Option<Value> {
            None
        }
    }

    #[cfg(node_twin)]
    pub(crate) struct Fixed;

    /// The route cell of the replay: a thread's live route, set by the adoptions the recorded actions make.
    #[derive(Default)]
    #[cfg(node_twin)]
    struct Cells(std::sync::Mutex<HashMap<ThreadId, Route>>);

    #[cfg(node_twin)]
    impl Cells {
        #[cfg(node_twin)]
        fn set(&self, thread: &ThreadId, route: Route) {
            self.0.lock().expect("the cells").insert(thread.clone(), route);
        }
    }

    #[cfg(node_twin)]
    impl LiveRoute for Cells {
        fn route(&self, thread: &ThreadId) -> Route {
            self.0.lock().expect("the cells").get(thread).cloned().expect("a thread's route is set when it is created")
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    /// The route half of a thread's start, as `RouteService` does it (`adopt_control`: the live route as it is; `seat`: a route
    /// with a model is put on the created thread by the follow of an `applyToCurrentSession` selection, one without writes
    /// nothing).
    #[cfg(node_twin)]
    struct Seat {
        cells: Arc<Cells>,
        follow: std::sync::OnceLock<Arc<mixdog_core_ports::ports::route::SessionRoutes>>,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_core_session::session::NewThreadRoute for Seat {
        // `createCurrentSession` on a thread that is there readies its live route, which the replay's cell holds as it is.
        async fn adopt(&self, thread: &ThreadId, _: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
            Ok(self.cells.route(thread))
        }
        async fn adopt_control(&self, thread: &ThreadId) -> Result<Map<String, Value>, String> {
            Ok(self.cells.route(thread))
        }
        async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
            if text(&self.cells.route(thread), "model").is_empty() {
                return Ok(());
            }
            self.follow.get().expect("the follow is bound").seat(thread).await.map_err(|e| format!("{e:?}"))
        }
    }

    #[cfg(node_twin)]
    pub(crate) struct Quiet;
    #[cfg(node_twin)]
    impl mixdog_core_session::session::route_session::RouteStatusline for Quiet {
        fn write(&self, _: &str, _: &Route, _: Option<u64>) {}
    }
    #[cfg(node_twin)]
    impl mixdog_core_session::session::route_session::ContextStatusCache for Quiet {
        fn invalidate(&self, _: &ThreadId) {}
    }
    #[cfg(node_twin)]
    struct NoBots;
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }
    #[cfg(node_twin)]
    impl mixdog_core_session::session::route_session::RouteConfig for Quiet {
        fn agent_config(&self) -> mixdog_core_ports::ports::domain_sessions::Obj {
            mixdog_core_ports::ports::domain_sessions::Obj::new()
        }
        fn bots(&self) -> &(dyn mixdog_core_run::run_host::route_chain::BotRoutes + Send + Sync) {
            &NoBots
        }
    }

    /// The tool mode the surface host answers: the recording's own.
    #[cfg(node_twin)]
    struct Mode(String);
    #[async_trait]
    #[cfg(node_twin)]
    impl SurfaceHost for Mode {
        fn mode(&self, _: Option<&serde_json::Map<String, Value>>) -> String {
            self.0.clone()
        }
        async fn preview(&self) -> Result<StatusSurface, CoreError> {
            Ok(StatusSurface::default())
        }
        async fn reconcile_empty(&self, _: &ThreadId) -> Result<(), CoreError> {
            Ok(())
        }
    }

    /// Reads never price anything.
    #[cfg(node_twin)]
    struct NoPrices;
    #[cfg(node_twin)]
    impl mixdog_ledger::refresh::Pricer for NoPrices {
        fn revision(&self) -> String {
            String::new()
        }
        fn price(&self, _: &mixdog_ledger::repair::PriceRequest) -> mixdog_ledger::Result<mixdog_ledger::repair::Priced> {
            Ok(mixdog_ledger::repair::Priced { cost_usd: None, rates: None })
        }
    }

    /// No model list is ever fetched: the catalog reads the config's own rows.
    #[cfg(node_twin)]
    struct Offline;
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_ai::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
            _: mixdog_ai::transport::Exchange,
        ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
            Err(mixdog_core_api::domain::provider::ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Transient,
                mixdog_core_api::domain::provider::DeliveryState::NotSent,
            ))
        }
    }

    /// The last-request readings of a status's `usage`.
    #[cfg(node_twin)]
    const LAST_READINGS: [&str; 7] =
        ["lastInputTokens", "lastUncachedInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens", "lastPromptTokens", "lastContextTokens"];

    /// A decided departure from every status Node recorded (`mixdog-agent` `compact/pressure/status.rs` `usage_counters`): a
    /// last-request reading keeps missing evidence missing, `null` when the session holds no number for it, where Node
    /// answered `0` and reported no `lastPromptTokens` at all. The expected status is Node's with each of those readings
    /// that is `0` (or absent) made `null`, unless the session's header (`header`, `None` for no session) stores that `0`.
    #[cfg(node_twin)]
    fn with_unmeasured_readings(status: &Value, header: Option<&Map<String, Value>>) -> Value {
        let mut status = status.clone();
        if let Some(usage) = status.get_mut("usage").and_then(Value::as_object_mut) {
            for key in LAST_READINGS {
                let recorded = usage.get(key).cloned().unwrap_or(Value::Null);
                let stored = header.and_then(|header| header.get(key)).filter(|value| value.is_number());
                // What Node recorded stays when it is a reading; its `0` is a reading only where the session stores that `0`.
                let value = if recorded.as_f64().is_some_and(|n| n != 0.0) {
                    recorded
                } else if stored.is_some_and(|n| n.as_f64() == Some(0.0)) {
                    json!(0)
                } else {
                    Value::Null
                };
                usage.insert(key.into(), value);
            }
        }
        status
    }

    /// The paths at which two answers differ, in document order.
    fn differences(got: &Value, want: &Value, path: &str, out: &mut Vec<String>) {
        match (got, want) {
            (Value::Object(g), Value::Object(w)) => {
                for key in g.keys().chain(w.keys().filter(|key| !g.contains_key(*key))) {
                    let at = format!("{path}.{key}");
                    match (g.get(key), w.get(key)) {
                        (Some(g), Some(w)) => differences(g, w, &at, out),
                        (Some(g), None) => out.push(format!("{at}: rust {g} node (absent)")),
                        (None, Some(w)) => out.push(format!("{at}: rust (absent) node {w}")),
                        (None, None) => unreachable!("a key of either object"),
                    }
                }
            }
            _ if got == want => {}
            _ => out.push(format!("{path}: rust {got} node {want}")),
        }
    }

    #[test]
    fn a_missing_key_differs_from_a_null_one() {
        let mut out = Vec::new();
        differences(&json!({}), &json!({ "k": null }), "$", &mut out);
        differences(&json!({ "k": null }), &json!({}), "$", &mut out);
        assert_eq!(out, ["$.k: rust (absent) node null", "$.k: rust null node (absent)"]);
    }

    /// What a session's open takes of a status (`apply_measurement` and `display_figures` of the actor).
    #[cfg(node_twin)]
    fn open_figures(status: &Value) -> Value {
        let compaction = &status["compaction"];
        json!({
            "measurement": status["measurement"],
            "contextWindow": status["contextWindow"],
            "boundaryTokens": compaction["boundaryTokens"],
            "triggerTokens": compaction["triggerTokens"],
            "autoCompactTokenLimit": compaction["autoCompactTokenLimit"],
        })
    }

    /// The route change whose outside read waits on a gate once armed: it says when it has entered the actor and goes on when
    /// released.
    #[cfg(node_twin)]
    struct GatedLookup {
        inner: Arc<crate::run_host::route_change::RunHostRouteChange>,
        armed: Arc<std::sync::atomic::AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_core_session::session::route_session::RouteChange for GatedLookup {
        async fn lookups(&self, header: &Header, route: &Route) -> mixdog_core_session::session::route_session::RouteLookups {
            if self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.inner.lookups(header, route).await
        }
        fn route_change(&self, header: &Header, route: &Route, previous: &Route, cross: bool, lookups: &mixdog_core_session::session::route_session::RouteLookups) -> mixdog_store::schema::record::HeaderChange {
            self.inner.route_change(header, route, previous, cross, lookups)
        }
        fn environment_reset(&self, header: &Header) -> mixdog_store::schema::record::HeaderChange {
            self.inner.environment_reset(header)
        }
    }

    /// The Node-recorded steps whose recording filtered an MCP definition because the connected list (`deferredMcpToolNames`) did
    /// not name it, and that this core answers otherwise by decision: a server dropping or a scope moving never removes a
    /// definition from a live epoch (the owner's rule that tool definitions sit at the front of the cached prefix and must not
    /// move on availability), so the unlisted definition stays where it was, an owner's withdrawal included (the cold fold's
    /// `ToolSurface::repair` removes it), which these recordings cannot tell apart from a drop. Case name and step; an unlisted step
    /// that is not here fails, and so does a listed one whose input has nothing unlisted.
    #[cfg(node_twin)]
    pub(crate) const MCP_AVAILABILITY_DEPARTURES: [(&str, usize); 5] = [
        ("a disconnected MCP tool leaves the surface", 1),
        ("a disconnected MCP tool leaves the surface", 2),
        ("a removed and a re-added tool take the end", 1),
        ("without a connected snapshot every MCP tool is available", 2),
        ("a deferred catalog tool joins a native session once it is discovered", 2),
    ];

    /// One provider-visible definition: name, description, schema, loading flag.
    type Row = (String, String, Value, bool);

    /// The approved delta of each departure over Node's recording, enumerated by hand from the recorded inputs and never read
    /// from the output: the definitions that stay in the request though the recording dropped them, each as `(position in the
    /// departed request, stored name, deferred)`, in ascending position. Everything else in the departed request is the recording.
    #[cfg(node_twin)]
    const APPROVED_DEPARTURES: [(&str, usize, &[(usize, &str, bool)]); 5] = [
        ("a disconnected MCP tool leaves the surface", 1, &[(1, "mcp__alpha__list", false)]),
        // Both servers are unlisted here (`deferredMcpToolNames` is empty), so both definitions stay at their stored places.
        ("a disconnected MCP tool leaves the surface", 2, &[(1, "mcp__alpha__list", false), (3, "mcp__beta__ping", false)]),
        ("a removed and a re-added tool take the end", 1, &[(1, "mcp__alpha__list", false)]),
        ("without a connected snapshot every MCP tool is available", 2, &[(1, "mcp__alpha__list", false), (3, "mcp__alpha__get", false)]),
        // A discovered deferred definition follows the catalog's order, after the tools and the recorded discoveries before it.
        ("a deferred catalog tool joins a native session once it is discovered", 2, &[(4, "mcp__alpha__get", true)]),
    ];

    /// The complete expected departed request: the recording with the approved inserts, each insert's whole payload taken from
    /// the stored definition (the step's tools, else its deferred catalog) and its loading flag from the delta.
    fn expected_departure(want: &[Row], inserts: &[(usize, &str, bool)], stored_in: &dyn Fn(&str) -> Value) -> Vec<Row> {
        let mut expected = want.to_vec();
        for (at, name, deferred) in inserts {
            let doc = stored_in(name);
            let row = (name.to_string(), doc["description"].as_str().expect("description").to_owned(), doc["inputSchema"].clone(), *deferred);
            expected.insert(*at, row);
        }
        expected
    }

    /// The departure check fails on a corrupted unchanged description or schema, a corrupted retained payload, a moved retained
    /// definition, a flipped loading flag and a dropped one: the whole sequence is compared, every field of every row.
    #[test]
    fn the_departure_check_rejects_a_moved_or_flipped_definition() {
        let row = |name: &str, description: &str, deferred: bool| (name.to_owned(), description.to_owned(), json!({ "type": "object", "properties": { name: {} } }), deferred);
        let want = vec![row("read", "r.", false), row("office", "o.", true)];
        let stored = |name: &str| json!({ "name": name, "description": "k.", "inputSchema": { "type": "object", "properties": { name: {} } } });
        let expected = expected_departure(&want, &[(1, "mcp__alpha__list", false)], &stored);
        assert_eq!(expected, [row("read", "r.", false), row("mcp__alpha__list", "k.", false), row("office", "o.", true)]);
        let mut corrupted = expected.clone();
        corrupted[0].1 = "changed.".into();
        assert_ne!(corrupted, expected, "an unchanged definition's description");
        let mut corrupted = expected.clone();
        corrupted[0].2 = json!({ "type": "object" });
        assert_ne!(corrupted, expected, "an unchanged definition's schema");
        let mut corrupted = expected.clone();
        corrupted[1].1 = "changed.".into();
        assert_ne!(corrupted, expected, "the retained payload");
        let mut corrupted = expected.clone();
        corrupted.swap(0, 1);
        assert_ne!(corrupted, expected, "a retained definition's position");
        let mut corrupted = expected.clone();
        corrupted[1].3 = true;
        assert_ne!(corrupted, expected, "a loading flag");
        assert_ne!(expected[..2], expected[..], "a dropped definition");
    }

    /// The `mcp__` names of `names` that a present `deferredMcpToolNames` of `header` does not list.
    #[cfg(node_twin)]
    fn unlisted_mcp<'a>(header: &serde_json::Map<String, Value>, names: impl Iterator<Item = &'a str>) -> Vec<String> {
        let Some(listed) = header.get("deferredMcpToolNames").and_then(Value::as_array) else { return Vec::new() };
        names.filter(|name| name.starts_with("mcp__") && !listed.iter().any(|n| n.as_str() == Some(*name))).map(str::to_owned).collect()
    }

    /// A stored MCP entry of `publisher` (none: stored before publishers were recorded) with `description` as its payload.
    fn entry(name: &str, publisher: Option<&str>, description: &str) -> Value {
        let doc = json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": {} } });
        match publisher {
            Some(server) => mixdog_core_api::domain::tool::StoredTool::mcp(doc, server, Some("n")).encode(),
            None => doc,
        }
    }

    /// A tool its owner withdrew is not removed at a request boundary: the request is the session's stored definitions, a
    /// discovered deferred definition included, whoever still lists them. The definition leaves with the cold fold's repair or an
    /// explicit rebuild (`ToolSurface::repair`), so a warm prefix is never rewritten between two sends.
    #[test]
    fn the_request_boundary_sends_the_stored_definitions_whatever_their_owner_publishes() {
        let catalog = vec![entry("read", None, "r."), entry("mcp__alpha__gone", Some("alpha"), "g."), entry("mcp__beta__down", Some("beta"), "d.")];
        let header = json!({
            "provider": "anthropic", "deferredNativeTools": true, "deferredMcpToolNames": [],
            "deferredDiscoveredTools": ["mcp__alpha__gone", "mcp__beta__down"], "deferredToolCatalog": catalog,
        });
        let base = vec![definition(&entry("read", None, "r.")), definition(&entry("mcp__alpha__gone", Some("alpha"), "g."))];
        let sent: Vec<String> = super::super::assemble::boundary_tools(header.as_object().expect("header"), base, &[]).into_iter().map(|t| t.name).collect();
        assert_eq!(sent, ["read", "mcp__alpha__gone", "mcp__beta__down"], "nothing is judged against the hub here");
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_ai::registry::providers::ProviderBuilder for CustomBuilder {
        async fn build(&self, name: &str, cfg: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
            let protocol = serde_json::from_value(cfg["protocol"].clone()).map_err(|error| error.to_string())?;
            let listing = mixdog_ai::providers::custom::listing::CustomListing::new(
                name,
                protocol,
                cfg["baseURL"].as_str().unwrap_or_default(),
                Vec::new(),
                Arc::new(Offline),
                Arc::new(mixdog_ai::providers::connect::rewrite::StaticCredential(None)),
                true,
                cfg,
                mixdog_ai::catalog::ListingLookup::new(),
            );
            self.listings.lock().unwrap().insert(name.to_owned(), Arc::new(listing));
            Ok(Arc::new(mixdog_core_api::domain::mock::MockProvider::new([])))
        }
        fn cached_model_info(&self, name: &str) -> Option<Arc<dyn mixdog_ai::catalog::CachedModelInfo>> {
            self.listings.lock().unwrap().get(name).map(|listing| listing.clone() as Arc<dyn mixdog_ai::catalog::CachedModelInfo>)
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }
    /// `LiveRouteWriter` over the replay's route cell, without the provider preparation (the replay has no provider to
    /// prepare): the same `refresh_route_fields` over the same config and catalog row.
    #[cfg(node_twin)]
    struct Writer {
        cells: Arc<Cells>,
        session: Arc<dyn RouteSession>,
        config: mixdog_core_config::config::Config,
        catalog: Arc<mixdog_ai::catalog::CatalogService>,
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_core_ports::ports::route_write::RouteWriter for Writer {
        fn route(&self, thread: &ThreadId) -> Route {
            self.cells.route(thread)
        }
        fn set_route_state(&self, thread: &ThreadId, route: Route) {
            self.cells.set(thread, route);
        }
        fn generation(&self, thread: &ThreadId) -> u64 {
            self.session.generation(thread)
        }
        async fn refresh_route_effort(&self, thread: &ThreadId, meta: Option<Value>, _: bool, _: Option<u64>) -> Result<Option<Route>, PortError> {
            let target = self.cells.route(thread);
            let config = self.config.agent();
            let (provider, model) = (text(&target, "provider"), text(&target, "model"));
            let meta = meta.unwrap_or_else(|| self.catalog.model_meta_in(&provider, &model, config.get("providers").and_then(|providers| providers.get(provider.as_str()))));
            let fast = |provider: &str, meta: &Value, effort: Option<&str>, params: &Value| self.catalog.fast_capable(provider, meta, effort, params);
            let route = mixdog_ai::service::admin_route::refresh_route_fields(
                &config,
                &target,
                Some(&meta),
                &provider,
                &fast,
                &|provider, model| self.catalog.cached_windows(provider, model).and_then(|w| serde_json::to_value(w).ok()),
            );
            self.cells.set(thread, route.clone());
            Ok(Some(route))
        }
        fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
    }

    #[cfg(node_twin)]
    impl mixdog_agent::env::Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }
    /// The provider registry the readiness holds builds nothing: no replayed call prepares a provider.
    /// The registry's builder as production has it for a custom provider (`build_custom_parts`): an adapter that lists, and
    /// the adapter-owned `getCachedModelInfo` of its listing (`CustomListing`, seeded from the config's own rows before any
    /// listing). The wire is never used by this replay.
    #[derive(Default)]
    #[cfg(node_twin)]
    struct CustomBuilder {
        listings: std::sync::Mutex<HashMap<String, Arc<mixdog_ai::providers::custom::listing::CustomListing>>>,
    }


    /// A loaded session answers Node's `contextStatusForSession` record for every golden case
    /// (the transcript read from its stored rows, the request tools made of its stored tools);
    /// a thread that is not loaded answers `null`. Node's `session.messages` lead with the system prompt; the core keeps it in
    /// the header (`promptBase`) and drops a stored leading system row on load, so each case states its prompt there.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn live_session_status_equals_nodes() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/context-status/golden.json")).expect("golden");
        let mut compared = 0;
        for case in golden["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let mut case = case.clone();
            if case["messages"][0]["role"] == "system" {
                case["header"]["promptBase"] = case["messages"][0]["content"].clone();
            }
            // The MCP definitions Node's connected list left out of the request: a decided departure (a server dropping never
            // removes a definition from a live epoch, see `MCP_AVAILABILITY_DEPARTURES`). Replayed on the input Node effectively
            // saw it must answer the recording; on the recorded input it answers one definition more.
            // A case recorded with no session has no header, so nothing in it can be unlisted.
            let unlisted = case["header"].as_object().map_or_else(Vec::new, |header| unlisted_mcp(header, case["header"]["deferredDiscoveredTools"].as_array().into_iter().flatten().filter_map(Value::as_str)));
            assert_eq!(unlisted.is_empty(), !STATUS_MCP_DEPARTURES.contains(&name), "{name}: an unlisted MCP definition is a decided departure, and only those");
            if !unlisted.is_empty() {
                let host = LiveContextStatus::new(Arc::new(world(&case)));
                let departed = host.context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status");
                // The complete expected departed status is the recording plus one enumerated delta per unlisted definition, every number
                // taken from what Node recorded in this case, none computed by the code under test:
                //  - the `mcp` breakdown row grows by one definition, and by the tokens Node recorded for a deferred MCP definition in
                //    this same case (its row holds exactly one, `mcp__ok__found`, deferred): a deferred definition is metered alone as
                //    the empty list, so every unlisted one costs that same recorded amount;
                //  - the totals (`toolSchemaTokens`, `reserveTokens`, `requestOverheadTokens`) and everything else are unchanged: a
                //    deferred definition adds nothing to the serialized request, which the recording shows (the recorded 161 of the case
                //    with five deferred definitions is the recorded 161 of the cases with none), and every other field of the status is
                //    a function of those totals and of the messages.
                // What no recording pins: a deferred MCP definition whose stored text is large would still be metered at that recorded
                // amount only because deferred schemas are left out of the count; no case records one metered otherwise.
                let mut expected = with_unmeasured_readings(&case["status"], case["header"].as_object());
                let recorded_mcp = expected["request"]["toolSchemaBreakdown"]["mcp"].clone();
                assert_eq!(recorded_mcp["count"], 1, "{name}: the recorded row is that of one deferred MCP definition");
                let (count, tokens) = (recorded_mcp["count"].as_u64().expect("count"), recorded_mcp["tokens"].as_u64().expect("tokens"));
                let added = unlisted.len() as u64;
                expected["request"]["toolSchemaBreakdown"]["mcp"] = json!({ "count": count + added, "tokens": tokens + added * tokens });
                assert_eq!(departed, expected, "{name}: the whole departed status");
                case["header"]["deferredDiscoveredTools"].as_array_mut().expect("discovered").retain(|d| !d.as_str().is_some_and(|d| unlisted.iter().any(|u| u == d)));
            }
            let host = LiveContextStatus::new(Arc::new(world(&case)));
            let answer = host.context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status");
            assert_eq!(answer, with_unmeasured_readings(&case["status"], case["header"].as_object()), "{name}");
            compared += 1;
        }
        assert_eq!(compared, 15);
        let host = LiveContextStatus::new(Arc::new(world(&golden["cases"][1])));
        assert_eq!(host.context_status(Some(ThreadId::from("absent".to_owned())), None).await.expect("status"), Value::Null);
    }
    /// The Context inspector's requests (`fixtures/context-inspection`, `record-context-inspection.mjs`): Node's session runtime
    /// built the session by a real turn against a scripted provider and answered every call through `contextStatusSettled`, the
    /// boundary the desktop's request reaches (the list, a preview of each listed entry against its revision, an entry never
    /// listed, the revision of a list read before the session's second turn, a revision no list had, the list again). Node's session store is migrated and opened through the real store, thread
    /// directory and route session, and each recorded request is sent to the core as the desktop sends it
    /// (`thread/contextStatus {threadId, options}`). What stands in: the route the runtime held and its tool mode. Each answer
    /// is Node's, whole.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn the_inspectors_requests_over_a_session_built_by_real_turns_answer_what_node_answered() {
        use mixdog_core_api::service::DomainService as _;
        use mixdog_core_session::session::route_session::SessionRouteAdapter;
        use mixdog_core_session::session::thread_context::CONTEXT_STATUS;
        use mixdog_core_session::session::thread_context::ThreadContextService;
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/context-inspection");
        let golden: Value = serde_json::from_slice(&std::fs::read(fixture.join("golden.json")).expect("golden")).expect("golden json");
        let (_dir, roots) = crate::run_host::migrated_fixture::migrated_from(&fixture).await;
        let (_index, threads) = crate::run_host::migrated_fixture::opened(&roots).await;
        let rig = mixdog_core_session::session::testing::Rig::new();
        let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(rig.deps_parts(threads))));
        let state = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
        let change = Arc::new(crate::run_host::route_change::RunHostRouteChange::new(Arc::new(WindowFacts), Arc::new(Fixed)));
        let adapter = Arc::new(SessionRouteAdapter::new(directory.clone(), state.clone(), change, Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone()));
        let calls = golden["calls"].as_array().expect("calls");
        let world = LiveContextWorld {
            threads: state.clone(),
            messages: state.clone(),
            routes: Arc::new(RecordedRoute(golden["route"].as_object().cloned().expect("route"))),
            session: adapter,
            // The recorder's own input (`record-context-inspection.mjs` `options.toolMode`), not read from an answer.
            host: Arc::new(Mode("full".to_owned())),
            lowering: Arc::new(|_, _| (Arc::new(TextOnly), Arc::new(TextOnly))),
        };
        let service = ThreadContextService::new(Arc::new(LiveContextStatus::new(Arc::new(world))));
        let thread = golden["sessionId"].as_str().expect("session id");
        for (at, call) in calls.iter().enumerate() {
            let req = mixdog_core_api::call::CoreRequest {
                method: mixdog_core_api::ids::Method(CONTEXT_STATUS),
                params: json!({ "threadId": thread, "options": call["options"] }),
                op: None,
                ctx: mixdog_core_api::call::CallContext::internal("desktop"),
            };
            let mixdog_core_api::call::Reply::Value(answer) = service.call(req).await.expect("thread/contextStatus") else { panic!("thread/contextStatus answers a value") };
            let header = mixdog_core_ports::ports::threads::ThreadState::header(&*state, &ThreadId::from(thread.to_owned())).await.ok();
            let mut diff = Vec::new();
            differences(&answer, &with_unmeasured_readings(&call["status"], header.as_ref()), "$", &mut diff);
            assert!(diff.is_empty(), "call {at} {}: {diff:#?}", call["options"]);
        }
        let listed = calls[0]["status"]["inspection"]["revision"].clone();
        assert!(
            calls.iter().any(|call| call["options"]["revision"].as_str().is_some_and(|r| r != "not-a-revision") && call["options"]["revision"] != listed),
            "the revision of an earlier list is asked"
        );
        assert!(calls.iter().any(|call| call["options"]["revision"] == "not-a-revision"), "a revision no list had is asked");
        assert!(calls.iter().any(|call| call["options"]["entryId"] == "message:999"), "an entry never listed is asked");
    }
    /// The status counts the request's messages as Node's `session.messages` hold them: the header's system blocks (the ones
    /// `system_messages` sends) lead the stored rows (the recorded task session of `fixtures/context-status-route` answers
    /// 4 system messages after its turn, with the text not recorded, so the blocks here are stated).
    #[tokio::test]
    #[cfg(node_twin)]
    async fn the_status_counts_the_system_messages_the_request_is_sent_with() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/context-status/golden.json")).expect("golden");
        let case = golden["cases"].as_array().expect("cases").iter().find(|case| case["status"]["messages"]["count"].as_u64() > Some(0)).expect("a case with messages");
        let name = ThreadId::from(case["name"].as_str().expect("name").to_owned());
        let read = |case: Value| {
            let name = name.clone();
            async move { LiveContextStatus::new(Arc::new(world(&case))).context_status(Some(name), None).await.expect("status") }
        };
        let mut stated = case.clone();
        let fields = [("promptBase", "rules"), ("promptStable", "stable"), ("bp3CoreContext", "core"), ("promptEnv", "env")];
        for (key, value) in fields {
            stated["header"][key] = json!(value);
        }
        stated["header"]["bp3EnvSplit"] = json!(true);
        let sent = system_messages_of(&stated);
        assert_eq!(sent, 4, "the header states four blocks");
        let (without, with) = (read(case.clone()).await, read(stated).await);
        let count = |status: &Value, path: &[&str]| path.iter().fold(status, |v, k| &v[*k]).as_u64().expect("a count");
        assert_eq!(count(&with, &["messages", "count"]), count(&without, &["messages", "count"]) + 4);
        assert_eq!(count(&with, &["messages", "roles", "system", "count"]), count(&without, &["messages", "roles", "system", "count"]) + 4);
        assert!(count(&with, &["currentEstimatedTokens"]) > count(&without, &["currentEstimatedTokens"]));
    }
    /// `thread/getSessionUsage` over a copy of the ledger of `fixtures/session-usage` (it holds nothing of the replay's threads).
    #[cfg(node_twin)]
    async fn usage_service(
        dir: &std::path::Path,
        threads: Arc<mixdog_core_session::session::thread_state::SessionThreads>,
    ) -> Arc<mixdog_core_domains::domains::ai_account::usage::session_usage::SessionUsageService> {
        let path = dir.join("ledger.sqlite");
        // On a checkout without the recorded ledger the usage service reads an empty one.
        #[cfg(node_twin)]
        tokio::fs::copy(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-usage/ledger.sqlite"), &path).await.expect("the ledger");
        let tokens = mixdog_rt::testing::tokens();
        let writer = mixdog_ledger::writer::UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the writer");
        writer.sums_built().await.expect("the sums");
        let reader = mixdog_ledger::reader::UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
        let refresher = mixdog_ledger::refresh::UsageRefresher::new(Arc::new(NoPrices), tokens.cpu_bulk);
        let ledger = mixdog_ledger::ledger::UsageLedger { writer, reader, refresher };
        let accounts_dir = dir.join("accounts");
        tokio::fs::create_dir_all(&accounts_dir).await.expect("the accounts folder");
        let accounts = mixdog_ai::accounts::AccountStore::new(accounts_dir, mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        mixdog_core_domains::domains::ai_account::usage::session_usage::SessionUsageService::new(Arc::new(Arc::new(ledger)), accounts, threads.clone(), threads)
    }
    #[cfg(node_twin)]
    impl Replay {
        async fn new(mode: &str, provider: &Value, config_file: &Value) -> Self {
            Self::with_change(mode, provider, config_file, |change| change).await
        }

        /// [`Self::new`] whose route change is `wrap` of the real one.
        async fn with_change(
            mode: &str,
            provider: &Value,
            config_file: &Value,
            wrap: impl FnOnce(Arc<crate::run_host::route_change::RunHostRouteChange>) -> Arc<dyn mixdog_core_session::session::route_session::RouteChange>,
        ) -> Self {
            use mixdog_core_session::session::route_session::SessionRouteAdapter;
            let rig = mixdog_core_session::session::testing::Rig::new();
            let cells = Arc::new(Cells::default());
            let seat = Arc::new(Seat { cells: cells.clone(), follow: std::sync::OnceLock::new() });
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.new_route = seat.clone();
            let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(deps)));
            let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
            let change = wrap(Arc::new(crate::run_host::route_change::RunHostRouteChange::new(Arc::new(WindowFacts), Arc::new(Fixed))));
            let adapter = Arc::new(SessionRouteAdapter::new(directory.clone(), threads.clone(), change, Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone()));
            let follow = Arc::new(mixdog_core_ports::ports::route::SessionRoutes::new(threads.clone(), threads.clone(), adapter.clone(), cells.clone()));
            seat.follow.set(follow.clone()).ok().expect("one follow");
            let world = LiveContextWorld {
                threads: threads.clone(),
                messages: threads.clone(),
                routes: cells.clone(),
                session: adapter.clone(),
                host: Arc::new(Mode(mode.to_owned())),
                lowering: Arc::new(|_, _| (Arc::new(TextOnly), Arc::new(TextOnly))),
            };
            let route_adapter = adapter.clone();
            let session_port: Arc<dyn RouteSession> = adapter;
            let dir = tempfile::tempdir().expect("a folder");
            let usage = usage_service(dir.path(), threads.clone()).await;
            let main: Route = [("provider".to_owned(), provider.clone()), ("model".to_owned(), json!(""))].into_iter().collect();
            let config_dir = tempfile::tempdir().expect("a folder");
            let path = config_dir.path().join("mixdog-config.json");
            tokio::fs::write(&path, serde_json::to_vec(config_file).expect("config")).await.expect("the config file");
            let tokens = mixdog_rt::testing::tokens();
            let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
            let (config, _) = mixdog_core_config::config::Config::open(&path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("the config");
            let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
            let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), config_dir.path().to_path_buf(), io);
            let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await);
            let registry = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(CustomBuilder::default())));
            let readiness = mixdog_ai::catalog::ProviderReadiness::new(registry, catalog.clone());
            // The providers of the config are registered the way the daemon registers them at boot.
            readiness.ensure_providers_ready(config.agent().get("providers").and_then(Value::as_object).cloned()).await.expect("the providers register");
            let facts = Arc::new(mixdog_core_domains::domains::ai_admin::chain::CatalogFacts { catalog: catalog.clone(), readiness, config: config.clone() });
            let models = Arc::new(mixdog_core_domains::domains::ai_admin::model_list::ModelListService {
                catalog: catalog.clone(),
                config: config.clone(),
                primary_provider: Arc::new(String::new),
                unsupported: Arc::new(mixdog_ai::service::effort_configuration::UnsupportedEfforts::default()),
                host: None,
            });
            let writer = Arc::new(Writer { cells: cells.clone(), session: session_port, config: config.clone(), catalog });
            let service = mixdog_core_domains::domains::ai_admin::route_service::RouteService { config, facts, writer, session: follow.clone(), models, controls: directory.clone() };
            Self { _rig: rig, _dir: dir, directory, threads, adapter: route_adapter, cells, follow, status: LiveContextStatus::new(Arc::new(world)), usage, main, ids: HashMap::new(), workspace: None, service, _config_dir: config_dir }
        }

        fn id(&self, name: &str) -> ThreadId {
            self.ids.get(name).cloned().expect("the session was created")
        }

        /// The ids the recording keeps as `$control` and `$second`.
        fn tokenized(&self, value: Value) -> Value {
            let mut text = value.to_string();
            for (name, id) in &self.ids {
                text = text.replace(&format!("\"{}\"", id.as_str()), &format!("\"${name}\""));
            }
            if let Some(raw) = &self.workspace {
                let raw = serde_json::to_string(raw).expect("json");
                text = text.replace(&raw, "\"$workspace\"");
            }
            serde_json::from_str(&text).expect("json")
        }

        fn tokenized_back(&self, value: &Value) -> Value {
            let mut text = value.to_string();
            for (name, id) in &self.ids {
                text = text.replace(&format!("\"${name}\""), &format!("\"{}\"", id.as_str()));
            }
            serde_json::from_str(&text).expect("json")
        }

        /// `session.create`: the thread, with the folder the call opened, on the route the config resolves to, and the
        /// installed session following the saved compaction settings (the config has none).
        async fn create(&mut self, name: &str, open: &Value) {
            use mixdog_core_ports::ports::threads::HeaderUpdates;
            let id = ThreadId::from(format!("sess_{name}"));
            let header = json!({ "cwd": open["cwd"] }).as_object().cloned().expect("header");
            self.directory.create_with_id(id.clone(), header, json!({})).await.expect("create");
            self.cells.set(&id, self.main.clone());
            let saved = json!({});
            self.threads.update_header(&id, Box::new(move |header| crate::run_host::compaction_follow::sync_change(header, &saved))).await.expect("install");
            self.ids.insert(name.to_owned(), id);
        }

        /// `setRoute(pick)`: the pick adopted as the thread's route (and the Main route, unless `keepMainModel` is true), then its
        /// follow on the session.
        async fn set_route(&mut self, name: &str, pick: &Value) {
            use mixdog_core_ports::ports::route::FollowOptions;
            let id = self.id(name);
            let pick = pick.as_object().expect("a pick");
            let route: Route = pick.iter().filter(|(key, _)| !["applyToCurrentSession", "keepMainModel"].contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
            let apply = pick.get("applyToCurrentSession") == Some(&json!(true));
            if pick.get("keepMainModel") == Some(&json!(false)) {
                self.main = route.clone();
                if let Some(control) = self.ids.get("control").filter(|control| text(&self.cells.route(control), "model").is_empty()) {
                    self.cells.set(control, route.clone());
                }
            }
            self.cells.set(&id, route);
            let options = FollowOptions { apply_to_current_session: apply, lease: apply.then(|| self.follow.open_lease(&id, None)), ..FollowOptions::default() };
            self.follow.follow(&id, &options).await.expect("follow");
        }

        /// A session Node recorded (`stored`) as this core's header holds it: the ids back, the folder raw, the conversation's
        /// rows left to the message log, and the system prompt as the blocks it is built from (`SystemBlocks`): Node keeps it as
        /// the session's leading messages, of which the two untiered ones are `promptBase` and `promptStable` and the `env` one
        /// `promptEnv`. The prompt names the folder, and a route change rebuilds its `# Session` block from the header's cwd.
        fn recorded_header(&self, stored: &Value) -> serde_json::Map<String, Value> {
            let mut recorded = self.tokenized_back(stored);
            let text_of = |row: &Value| row["content"].as_str().expect("a text block").to_owned();
            let system: Vec<&Value> = stored["messages"].as_array().expect("messages").iter().filter(|row| row["role"] == "system").collect();
            let untiered: Vec<String> = system.iter().filter(|row| row.get("cacheTier").is_none()).map(|row| text_of(row)).collect();
            let [base, stable] = untiered.as_slice() else { panic!("two untiered system messages") };
            let env = system.iter().find(|row| row["cacheTier"] == "env").map(|row| text_of(row)).expect("the env message");
            let blocks = recorded.as_object_mut().expect("the stored header");
            blocks.remove("messages");
            for (key, text) in [("promptBase", base), ("promptStable", stable), ("promptEnv", &env)] {
                blocks.insert(key.into(), Value::String(text.clone()));
            }
            blocks.clone()
        }

        /// The user prompt a submit stores on the session, and what Node's seed turn wrote into it that this replay has no
        /// machinery for (the prompt assembly, the tool surface, the pre-send check): `stored` is the recorded session, and
        /// each of its header fields the replay's own steps did not produce is installed as the turn left it.
        async fn seed(&mut self, name: &str, prompt: &str, stored: &Value) {
            use mixdog_core_ports::ports::threads::HeaderUpdates;
            use mixdog_core_session::session::room_log::RoomLog;
            let row = json!({ "role": "user", "content": prompt, "meta": { "transcript": { "messageId": "seed" } } });
            // The turn creates the session on the route it has (`turn-prepare.mjs`: `createCurrentSession`).
            self.follow.seat(&self.id(name)).await.expect("the turn's session");
            let recorded = Value::Object(self.recorded_header(stored));
            self.workspace = Some(stored["cwd"].as_str().expect("the cwd").to_owned());
            self.threads
                .update_header(
                    &self.id(name),
                    Box::new(move |header| {
                        let mut set = serde_json::Map::new();
                        for (key, value) in recorded.as_object().expect("the stored header") {
                            match (header.get(key), value) {
                                (None, _) if key != "messages" => {
                                    set.insert(key.clone(), value.clone());
                                }
                                // The route change cleared the wire; the turn resolved it before its first request.
                                (Some(Value::Null), _) if key == "wireRoute" => {
                                    set.insert(key.clone(), value.clone());
                                }
                                (Some(_), _) if key == "cwd" => {
                                    set.insert(key.clone(), value.clone());
                                }
                                // The record the pre-send check wrote joins the one the install made.
                                (Some(Value::Object(held)), Value::Object(turn)) if key == "compaction" => {
                                    let mut joined = held.clone();
                                    for (field, value) in turn {
                                        joined.entry(field.clone()).or_insert_with(|| value.clone());
                                    }
                                    set.insert(key.clone(), Value::Object(joined));
                                }
                                _ => {}
                            }
                        }
                        mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
                    }),
                )
                .await
                .expect("the turn's writes");
            let log = mixdog_core_session::session::room_log::SessionRoomLog::new(self.directory.clone());
            assert_eq!(log.append_rows(self.id(name).as_str(), vec![row]).await.expect("store the prompt"), 1);
        }

        /// The stored header of `name`, when its thread holds one.
        async fn header(&self, name: &str) -> Option<Map<String, Value>> {
            mixdog_core_ports::ports::threads::ThreadState::header(&*self.threads, &self.id(name)).await.ok()
        }

        async fn context_status(&self, name: &str) -> Value {
            let answer = self.status.context_status(Some(self.id(name)), None).await.expect("status");
            // A session's open reads the header status: at every recorded step it shows what the full status shows.
            let open = self.status.header_status(self.id(name)).await.expect("header status");
            assert_eq!(open_figures(&open), open_figures(&answer), "the header status of {name} shows the full status's figures");
            self.tokenized(answer)
        }

        async fn session_usage(&self, name: &str) -> Value {
            use mixdog_core_api::DomainService;
            let request = mixdog_core_api::CoreRequest {
                method: mixdog_core_api::ids::Method("thread/getSessionUsage"),
                params: json!({ "threadId": self.id(name) }),
                op: None,
                ctx: mixdog_core_api::call::CallContext::internal("replay"),
            };
            let Ok(mixdog_core_api::Reply::Value(got)) = self.usage.call(request).await else { panic!("a value reply") };
            self.tokenized(got)
        }
    }
    /// The desktop's control session and a task session as Node answered the harness's calls (`fixtures/context-status-route`,
    /// recorded from the Node daemon of b6f10295a), replayed action by action over the real directory: every `contextStatus` and
    /// `getSessionUsage` of the control session equals Node's answer in full, with no session before `inheritFrom`'s create, with
    /// the Main route that follows the second session's pick, and with the session the create made, before and after
    /// `setFast`/`setRoute`. The task session is the one the recording read addressed to it, so its `auto` comes from its own
    /// installed compaction record, not from the control session's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn the_recorded_sequence_is_answered_as_nodes_answered_it() {
        let text = mixdog_testkit::fixture!("../../fixtures/context-status-route/golden.json");
        let golden: Value = serde_json::from_str(&text).expect("golden");
        let steps = golden["steps"].as_array().expect("steps");
        let first = steps.iter().find(|step| step["session"] == "control" && step["action"] == "contextStatus").expect("a first control status");
        let mut replay = Replay::new(first["value"]["toolMode"].as_str().expect("toolMode"), &first["value"]["provider"], &golden["config"]).await;
        let (mut control_reads, mut task_reads) = (0, 0);
        for (n, step) in steps.iter().enumerate() {
            let (name, action, args) = (step["session"].as_str().expect("session"), step["action"].as_str().expect("action"), step["args"].as_array().expect("args"));
            let at = format!("step {n}: {name}.{action}");
            match action {
                "createSession" => replay.create(name, &args[0]).await,
                "setRoute" => replay.set_route(name, &args[0]).await,
                // The seed turn: its prompt is stored as the turn stores it, which makes the session an active conversation; the
                // system prompt, tool surface and pre-send check are the turn machinery's, which this replay has none of.
                "submit" => replay.seed(name, args[0].as_str().expect("the prompt"), &golden["stored"]).await,
                "contextStatus" if name == "control" => {
                    let got = replay.context_status(name).await;
                    assert_eq!(got, with_unmeasured_readings(&step["value"], replay.header(name).await.as_ref()), "{at}");
                    control_reads += 1;
                }
                "contextStatus" => {
                    let got = replay.context_status(name).await;
                    let want = with_unmeasured_readings(&step["value"], replay.header(name).await.as_ref());
                    let mut differing = Vec::new();
                    differences(&got, &want, "$", &mut differing);
                    assert!(differing.is_empty(), "{at}: {differing:#?}");
                    task_reads += 1;
                }
                "getSessionUsage" => assert_eq!(replay.session_usage(name).await, step["value"], "{at}"),
                "inheritFrom" => {
                    assert!(step["ok"] == false, "{at}: the recording refuses it");
                    let params = json!({ "threadId": args[0], "intoThreadId": replay.id(name), "opId": "op-inherit" });
                    let request = mixdog_core_api::CoreRequest {
                        method: mixdog_core_api::ids::Method("thread/fork"),
                        params,
                        op: Some(mixdog_core_api::ids::OpId::from("op-inherit".to_owned())),
                        ctx: mixdog_core_api::call::CallContext::internal("replay"),
                    };
                    use mixdog_core_api::ThreadDirectory;
                    let refused = replay.directory.request(request).await;
                    assert!(matches!(refused, Err(CoreError::ThreadNotFound { .. })), "{at}: {refused:?}");
                }
                // Through the real route service: what it refuses, it refuses with Node's text, and what it accepts leaves the
                // route (and the session that follows it) as the recording's later reads show.
                "setFast" => {
                    use mixdog_core_domains::domains::ai_admin::route_service::FastValue;
                    let value = if args[0] == json!(true) { FastValue::On } else { FastValue::Off };
                    let answered = replay.service.set_fast(&replay.id(name), value).await;
                    match (step["ok"].as_bool().expect("ok"), answered) {
                        (true, Ok(_)) => {}
                        (false, Err(message)) => assert_eq!(Value::String(message), step["error"], "{at}"),
                        (recorded, answered) => panic!("{at}: the recording's ok is {recorded}, the service answered {answered:?}"),
                    }
                }
                other => panic!("{at}: an action the replay does not know: {other}"),
            }
        }
        assert_eq!((control_reads, task_reads), (5, 2), "every recorded status was compared");
        // What the store holds of the task session's `compaction` after the installation's sync, the seed turn and the route
        // change, in full: the sync's fields survive the route change.
        use mixdog_core_ports::ports::threads::ThreadState;
        let held = replay.threads.header(&replay.id("second")).await.expect("the task session");
        assert_eq!(held.get("compaction"), Some(&golden["afterRoute"]["compaction"]));
    }
    #[cfg(node_twin)]
    impl Gated {
        async fn new() -> Self {
            let text = mixdog_testkit::fixture!("../../fixtures/context-status-route/golden.json");
            let golden: Value = serde_json::from_str(&text).expect("golden");
            let steps = golden["steps"].as_array().expect("steps");
            let first = steps.iter().find(|step| step["session"] == "control" && step["action"] == "contextStatus").expect("a first control status");
            let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
            let (a, e, r) = (armed.clone(), entered.clone(), release.clone());
            let mut replay = Replay::with_change(first["value"]["toolMode"].as_str().expect("toolMode"), &first["value"]["provider"], &golden["config"], move |inner| {
                Arc::new(GatedLookup { inner, armed: a, entered: e, release: r })
            })
            .await;
            // The task session up to the seed turn, as the recording made it.
            for step in steps.iter().filter(|step| step["session"] == "second").take(3) {
                let (name, args) = ("second", step["args"].as_array().expect("args"));
                match step["action"].as_str().expect("action") {
                    "createSession" => replay.create(name, &args[0]).await,
                    "setRoute" => replay.set_route(name, &args[0]).await,
                    "submit" => replay.seed(name, args[0].as_str().expect("the prompt"), &golden["stored"]).await,
                    other => panic!("an action the setup does not know: {other}"),
                }
            }
            let id = replay.id("second");
            Self { replay, golden, armed, entered, release, id }
        }

        /// Starts the route change Node's `updateSessionInPlace` makes and waits until it is inside the actor, awaiting its lookup.
        async fn begin_route_change(&self) -> tokio::task::JoinHandle<Result<bool, mixdog_tools::orch::util::PortError>> {
            use mixdog_core_ports::ports::route::RouteSession;
            let route: Route = self.golden["inFlight"]["fields"].as_object().cloned().expect("the recorded route fields");
            self.armed.store(true, std::sync::atomic::Ordering::SeqCst);
            let routing = tokio::spawn({
                let (adapter, id) = (self.replay.adapter.clone(), self.id.clone());
                async move { adapter.update_route(&id, route, false).await }
            });
            self.entered.notified().await;
            routing
        }

        /// A header write accepted into the actor's inbox (so queued behind the route change), and the header it computed from.
        async fn submit(&self, write: &str, seen: &Arc<std::sync::Mutex<Vec<Header>>>) -> mixdog_core_session::session::thread_state::PendingHeaderUpdate {
            let (saved, moved) = (self.golden["inFlight"]["saved"].clone(), self.golden["inFlight"]["movedTo"].clone());
            let (seen, write) = (seen.clone(), write.to_owned());
            self.replay
                .directory
                .submit_header_update(
                    &self.id,
                    Box::new(move |header| {
                        seen.lock().unwrap().push(header.clone());
                        match write.as_str() {
                            "sync" => crate::run_host::compaction_follow::sync_change(header, &saved),
                            "folder" => mixdog_store::schema::record::HeaderChange { set: [("cwd".to_owned(), moved)].into_iter().collect(), unset: Vec::new() },
                            "none" => mixdog_store::schema::record::HeaderChange { set: Default::default(), unset: Vec::new() },
                            other => panic!("an unknown write: {other}"),
                        }
                    }),
                )
                .await
                .expect("the write is accepted into the inbox")
        }

        /// The stored header equals the recorded session `want` in full, but for the times (Node's are its own clock's).
        async fn assert_header_is(&self, want: &Value, what: &str) {
            self.assert_header_is_but(want, what, &[]).await;
        }

        /// [`Self::assert_header_is`] but for the `skipped` fields, which both headers still hold.
        async fn assert_header_is_but(&self, want: &Value, what: &str, skipped: &[&str]) {
            use mixdog_core_ports::ports::threads::ThreadState;
            let mut got = self.replay.threads.header(&self.id).await.expect("the session");
            let mut want = self.replay.recorded_header(want);
            // `offloadSources` and `offloadSourcesRules` (every session's reference set, empty for one naming no other
            // session's sidecars, and the rules it was computed under) are the fix of `node-fix-prune-after-save.patch`,
            // which this recording of Node as shipped predates: their value is replayed by the offload-prune-order set.
            assert!(got.remove("offloadSources").is_some_and(|sources| sources.is_array()), "{what}: the session holds its reference set");
            assert_eq!(got.remove("offloadSourcesRules"), Some(Value::from(mixdog_store::offload_sources::RULES)), "{what}: under the present rules");
            // Every header this compares is one a route change ran on, and an applied route change names a new transcript lineage
            // (`RunHostRouteChange::reset`: the actor's kept prefix guard belongs to the lineage its turn ran on, so the new one deletes
            // it); Node's route change keeps the recorded epoch, which is the one the session held before the change. The
            // core's is a fresh UUID v7 (the actor's mint is `new_id()`, a route change's `Uuid::now_v7()`), so the relationship
            // asserted is: the session held an epoch before, and the stored one is a new id other than it.
            let before = want.remove("transcriptEpoch");
            let before = before.as_ref().and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: the recorded session names its lineage"));
            let after = got.remove("transcriptEpoch");
            let after = after.as_ref().and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: the route change names a lineage"));
            assert_ne!(after, before, "{what}: the route change named a new lineage");
            assert_eq!(uuid::Uuid::parse_str(after).map(|id| id.get_version_num()), Ok(7), "{what}: the new lineage is a fresh id");
            for header in [&mut got, &mut want] {
                assert!(header.get("updatedAt").is_some_and(Value::is_number), "{what}: a stored time");
                header.remove("updatedAt");
                for field in skipped {
                    assert!(header.contains_key(*field), "{what}: {field} is held");
                    header.remove(*field);
                }
            }
            let mut differing = Vec::new();
            differences(&Value::Object(got), &Value::Object(want), "$", &mut differing);
            assert!(differing.is_empty(), "{what}: {differing:#?}");
        }
    }
    /// Ownership never reaches a request: a request's definitions are the same with and without the publisher recorded on every
    /// stored MCP entry, over every recorded step, and so is the status the request's accounting feeds (counts and tokens).
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_recorded_publisher_changes_no_request_byte_and_no_accounting() {
        use mixdog_core_api::domain::tool::StoredTool;
        let owned = |doc: &Value| -> Value {
            let name = doc["name"].as_str().unwrap_or_default();
            let mut parts = name.splitn(3, "__");
            match (parts.next(), parts.next(), parts.next()) {
                (Some("mcp"), Some(server), Some(leaf)) => StoredTool::mcp(doc.clone(), server, Some(leaf)).encode(),
                _ => doc.clone(),
            }
        };
        let with_owners = |value: &mut Value| {
            for key in ["tools", "deferredToolCatalog", "deferredLateToolCatalog"] {
                if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
                    *items = items.iter().map(owned).collect();
                }
            }
        };
        let golden: Value = mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/request-tools/golden.json")).expect("request tools golden");
        let mut owned_docs = 0;
        for case in golden["cases"].as_array().expect("cases") {
            for step in case["steps"].as_array().expect("steps") {
                let (mut header, rows) = (step["header"].clone(), step["messages"].as_array().expect("messages"));
                let docs: Vec<Value> = step["tools"].as_array().expect("tools").clone();
                let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned();
                let plain = request_definitions(header.as_object().expect("header"), &docs, rows, &provider);
                let stamped: Vec<Value> = docs.iter().map(owned).collect();
                owned_docs += stamped.iter().zip(&docs).filter(|(a, b)| a != b).count();
                with_owners(&mut header);
                assert_eq!(request_definitions(header.as_object().expect("header"), &stamped, rows, &provider), plain, "{}", case["name"]);
            }
        }
        assert!(owned_docs > 0, "the recordings hold MCP tools to stamp");
        let status: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/context-status/golden.json")).expect("golden");
        for case in status["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let ask = |case: Value| async move { LiveContextStatus::new(Arc::new(world(&case))).context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status") };
            let mut plain = case.clone();
            if plain["messages"][0]["role"] == "system" {
                plain["header"]["promptBase"] = plain["messages"][0]["content"].clone();
            }
            let mut stamped = plain.clone();
            with_owners(&mut stamped["header"]);
            assert_eq!(ask(stamped).await, ask(plain).await, "{name}: counts and tokens");
        }
    }
    /// `snapshotProviderRequestTools` as Node recorded it (`fixtures/request-tools`). Every step is replayed twice. On the input
    /// Node effectively saw (the MCP definitions its connected list left out removed from the tools and from the discoveries) the
    /// answer is Node's recording, whole. On the recorded input itself a step in [`MCP_AVAILABILITY_DEPARTURES`] differs from the
    /// recording in exactly one way: the unlisted definitions are present, each as stored, the rest in the recorded order.
    #[test]
    #[cfg(node_twin)]
    fn the_request_snapshot_follows_node() {
        let golden: Value = mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/request-tools/golden.json")).expect("request tools golden");
        let rows_of = |t: &Value| (t["name"].as_str().unwrap().to_owned(), t["description"].as_str().unwrap().to_owned(), t["inputSchema"].clone(), t["deferLoading"] == true);
        let (mut steps, mut deferred, mut departed) = (0, 0, 0);
        for case in golden["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            for (n, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
                let header = step["header"].as_object().expect("header");
                let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
                let (docs, rows) = (step["tools"].as_array().expect("tools"), step["messages"].as_array().expect("messages"));
                let want: Vec<(String, String, Value, bool)> = step["candidate"].as_array().expect("candidate").iter().map(rows_of).collect();
                let shape = |defs: Vec<ToolDefinition>| -> Vec<(String, String, Value, bool)> { defs.into_iter().map(|t| (t.name, t.description, t.input_schema, t.defer_loading)).collect() };
                let unlisted_docs = unlisted_mcp(header, docs.iter().filter_map(|d| d["name"].as_str()));
                let discovered: Vec<&str> = header.get("deferredDiscoveredTools").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                let unlisted_discovered = unlisted_mcp(header, discovered.iter().copied());
                let is_departure = MCP_AVAILABILITY_DEPARTURES.contains(&(name, n));
                assert_eq!(is_departure, !unlisted_docs.is_empty() || !unlisted_discovered.is_empty(), "{name} (step {n}): an unlisted MCP definition is a decided departure, and only those");
                // Node's effective input.
                let mut effective = header.clone();
                if let Some(list) = effective.get_mut("deferredDiscoveredTools").and_then(Value::as_array_mut) {
                    list.retain(|d| !d.as_str().is_some_and(|d| unlisted_discovered.iter().any(|u| u == d)));
                }
                let effective_docs: Vec<Value> = docs.iter().filter(|d| !d["name"].as_str().is_some_and(|d| unlisted_docs.iter().any(|u| u == d))).cloned().collect();
                let node = shape(request_definitions(&effective, &effective_docs, rows, provider));
                assert_eq!(node, want, "{name} (step {n})");
                deferred += node.iter().filter(|t| t.3).count();
                steps += 1;
                // The recorded input under the decided rule.
                let got = shape(request_definitions(header, docs, rows, provider));
                if !is_departure {
                    assert_eq!(got, want, "{name} (step {n})");
                    continue;
                }
                departed += 1;
                let inserts = APPROVED_DEPARTURES.iter().find(|(case, step, _)| (*case, *step) == (name, n)).expect("every departure states its delta").2;
                let stored_in = |wanted: &str| docs.iter().chain(header.get("deferredToolCatalog").and_then(Value::as_array).into_iter().flatten()).find(|d| d["name"] == *wanted).expect("a stored definition").clone();
                assert_eq!(got, expected_departure(&want, inserts, &stored_in), "{name} (step {n}): the recording and the approved delta, whole");
            }
        }
        assert!(steps > 30 && deferred > 0);
        assert_eq!(departed, MCP_AVAILABILITY_DEPARTURES.len(), "every listed departure was replayed");
    }

    /// The recorded sequence over the real thread directory and store,
    /// route follow (`SessionRoutes`), route change
    /// (`RunHostRouteChange`), installed-compaction sync (`sync_change`), context status and session usage service. What stands in
    /// for the config is the Main route it resolves to: its provider before any model was chosen is the recording's first answer,
    /// and a `keepMainModel: false` pick writes the picked route to it, which the control session's runtime adopts
    /// (`syncEmptyMainRoute`).
    #[cfg(node_twin)]
    struct Replay {
        _rig: mixdog_core_session::session::testing::Rig,
        _dir: tempfile::TempDir,
        directory: Arc<mixdog_core_session::session::SessionDirectory>,
        threads: Arc<mixdog_core_session::session::thread_state::SessionThreads>,
        adapter: Arc<mixdog_core_session::session::route_session::SessionRouteAdapter>,
        cells: Arc<Cells>,
        follow: Arc<mixdog_core_ports::ports::route::SessionRoutes>,
        status: LiveContextStatus,
        usage: Arc<mixdog_core_domains::domains::ai_account::usage::session_usage::SessionUsageService>,
        main: Route,
        ids: HashMap<String, ThreadId>,
        /// The folder the recorded second session ran in, which the seed turn's prompt names; the status shows it as `$workspace`.
        workspace: Option<String>,
        /// The real route service over the recording's config and the catalog it states: `setFast` goes through it.
        service: mixdog_core_domains::domains::ai_admin::route_service::RouteService,
        _config_dir: tempfile::TempDir,
    }
    /// The recorded task session, as the seed turn left it, with a gated route change.
    #[cfg(node_twin)]
    struct Gated {
        replay: Replay,
        golden: Value,
        armed: Arc<std::sync::atomic::AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        id: ThreadId,
    }
    /// A compaction sync and a folder change submitted while the route change is in flight (accepted into the actor's inbox
    /// before the lookup is released) apply after it, in the order submitted: each computes from the header the one before left,
    /// and the stored header ends as Node's live session ends by the same sequence (`inFlight`: the route change, then the sync
    /// and the folder change in this order or the other), in full.
    #[cfg(node_twin)]
    async fn writes_in_flight_end_as_node_ends(order: [&str; 2], recorded: &str) {
        let gated = Gated::new().await;
        let routing = gated.begin_route_change().await;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut pending = Vec::new();
        for write in order {
            pending.push(gated.submit(write, &seen).await);
        }
        // Both writes are in the inbox now (their submission resolved), and the route change is still awaiting its lookup: it
        // holds the actor, so neither has run.
        assert!(!routing.is_finished());
        for write in &mut pending {
            assert!(write.still_waiting(), "a queued write waits behind the route change");
        }
        assert!(seen.lock().unwrap().is_empty(), "no write has computed yet");
        gated.release.notify_one();
        assert!(routing.await.expect("route task").expect("update"), "the route change wrote");
        for write in pending {
            write.durable().await.expect("the queued write");
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].get("contextTokens") == Some(&Value::Null), "the first write computed from the header the route change left");
        let folder_seen = |header: &Header| header.get("cwd") == gated.golden["inFlight"].get("movedTo");
        assert_eq!(folder_seen(&seen[1]), order[0] == "folder", "the second write computed from the header the first left");
        gated.assert_header_is(&gated.golden["inFlight"][recorded], recorded).await;
    }
    /// A route change to another model on a session holding a value its tool surface is resolved from that is not what it
    /// should be (`schemaAllowedTools`, `mcpScopeId`, `agent`, `preset`, `cwd`, `disallowedTools`): as in Node's pass (no
    /// throw), the change commits, the model changes, and the stored header equals Node's in full.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_route_change_over_malformed_surface_values_ends_as_nodes_ends() {
        use mixdog_core_ports::ports::route::RouteSession;
        use mixdog_core_ports::ports::threads::HeaderUpdates;
        let probes = Gated::new().await.golden["inFlight"]["surfaceProbes"].as_array().cloned().expect("the recorded probes");
        assert_eq!(probes.len(), 6);
        for probe in probes {
            let key = probe["key"].as_str().expect("key").to_owned();
            let gated = Gated::new().await;
            let mut route: Route = gated.golden["inFlight"]["fields"].as_object().cloned().expect("the recorded route fields");
            let other = probe["model"].as_str().expect("model").to_owned();
            route.insert("model".into(), json!(other));
            let value = probe["value"].clone();
            let held = (key.clone(), value);
            gated
                .replay
                .threads
                .update_header(&gated.id, Box::new(move |_| mixdog_store::schema::record::HeaderChange { set: [held].into_iter().collect(), unset: Vec::new() }))
                .await
                .expect("the malformed value");
            assert!(probe["thrown"].is_null(), "{key}: Node did not throw");
            let wrote = gated.replay.adapter.update_route(&gated.id, route, false).await;
            assert!(wrote.is_ok(), "{key}: the route change did not fail: {wrote:?}");
            // The tool list and its spec are the surface the route change resolves from the tool pool; this replay wires none,
            // so they stay as the seed left them (`resume_tools`' `malformed_values_resolve_as_nodes_do` replays the spec
            // against these same probes). The reset's time is the replay clock's, Node's is its own.
            gated.assert_header_is_but(&probe["header"], &key, &["tools", "toolSpec", "lastContextTokensUpdatedAt"]).await;
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_sync_then_a_folder_change_in_flight_end_as_nodes_sequence_ends() {
        writes_in_flight_end_as_node_ends(["sync", "folder"], "syncThenFolder").await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_folder_change_then_a_sync_in_flight_end_as_nodes_sequence_ends() {
        writes_in_flight_end_as_node_ends(["folder", "sync"], "folderThenSync").await;
    }
    /// Node's pass cannot be cancelled once begun: it runs to its write. The route change whose caller is dropped while the
    /// lookup is awaited on the actor still commits, and the header is Node's after the route change, in full.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_route_change_whose_caller_is_dropped_in_flight_still_commits() {
        let gated = Gated::new().await;
        let routing = gated.begin_route_change().await;
        routing.abort();
        assert!(routing.await.expect_err("the caller was dropped").is_cancelled());
        gated.release.notify_one();
        // A write submitted behind it: once it is durable the route change has run.
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let behind = gated.submit("none", &seen).await;
        behind.durable().await.expect("the queued write");
        assert!(seen.lock().unwrap()[0].get("contextTokens") == Some(&Value::Null), "the route change ran first");
        gated.assert_header_is(&gated.golden["inFlight"]["afterRoute"], "afterRoute").await;
    }
}
