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
/// the session's messages carry them in Node.
pub(super) struct StoredBodies;

impl MessageRows for StoredBodies {
    fn row(&self, message: &mixdog_agent::message::AgentMessage) -> Value {
        message.stored.as_ref().map_or(Value::Null, |row| Value::Object((**row).clone()))
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

/// `isDeferredToolAvailable`: an `mcp__` tool only while the session's deferred MCP list (when it
/// has one) names it.
fn available(header: &serde_json::Map<String, Value>, name: &str) -> bool {
    !name.starts_with("mcp__") || header.get("deferredMcpToolNames").and_then(Value::as_array).is_none_or(|names| names.iter().any(|n| n.as_str() == Some(name)))
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
/// conversation's request): `baseToolSnapshot` (object entries with a name, once each, `mcp__`
/// ones only while listed), then, for a native-deferred Anthropic-family session, the catalog tools
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
pub(super) fn snapshot_tools(header: &serde_json::Map<String, Value>, base: Vec<ToolDefinition>, referenced: Vec<String>, provider: &str) -> Vec<ToolDefinition> {
    let mut names = HashSet::new();
    let mut out: Vec<ToolDefinition> = base
        .into_iter()
        .filter(|tool| {
            let name = mixdog_js::js_trim(&tool.name).to_owned();
            !name.is_empty() && available(header, &tool.name) && names.insert(name)
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
        if !tool.is_object() || !discovered.contains(&name) || names.contains(&name) || !available(header, &name) {
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
        let route = self.routes.route(thread);
        let live = self.session.live_turn_messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
        let rows = if live.is_empty() {
            self.messages.messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        } else {
            live
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

    fn lowering(&self, thread: &ThreadId, provider: &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) {
        (self.lowering)(thread, provider)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::estimate::PartMeter;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_ports::ports::threads::Section;
    use mixdog_core_session::session::thread_context::ContextStatusHost;
    use mixdog_core_session::session::thread_context::LiveContextStatus;
    use mixdog_store::schema::record::Header;
    use mixdog_tools::orch::status::StatusSurface;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Map;
    use serde_json::json;

    use super::*;
    use mixdog_core_ports::ports::route::Route;

    struct TextOnly;
    impl MediaMeter for TextOnly {
        fn part(&self, part: &ContentPart) -> PartMeter {
            panic!("media part in a text-only golden: {part:?}")
        }
    }
    impl ImageIdentities for TextOnly {
        fn images(&self, _: &mixdog_agent::message::AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
            Vec::new()
        }
    }

    /// One golden case as a live session: the stored header, the committed rows, the live route.
    struct Live {
        case: Value,
    }

    #[async_trait]
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
    impl ThreadMessages for Live {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(self.case["messages"].as_array().cloned().unwrap_or_default())
        }
    }

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

    /// A loaded session answers Node's `contextStatusForSession` record for every golden case
    /// (the transcript read from its stored rows, the request tools made of its stored tools);
    /// a thread that is not loaded answers `null`.
    #[tokio::test]
    async fn live_session_status_equals_nodes() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/context-status/golden.json")).expect("golden");
        let mut compared = 0;
        for case in golden["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let host = LiveContextStatus::new(Arc::new(world(case)));
            let answer = host.context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status");
            assert_eq!(answer, case["status"], "{name}");
            compared += 1;
        }
        assert_eq!(compared, 15);
        let host = LiveContextStatus::new(Arc::new(world(&golden["cases"][1])));
        assert_eq!(host.context_status(Some(ThreadId::from("absent".to_owned())), None).await.expect("status"), Value::Null);
    }

    /// The status counts the request's messages as Node's `session.messages` hold them: the header's system blocks (the ones
    /// `system_messages` sends) lead the stored rows (the recorded task session of `fixtures/context-status-route` answers
    /// 4 system messages after its turn, with the text not recorded, so the blocks here are stated).
    #[tokio::test]
    async fn the_status_counts_the_system_messages_the_request_is_sent_with() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/context-status/golden.json")).expect("golden");
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

    fn system_messages_of(case: &Value) -> usize {
        super::super::factory::system_messages(case["header"].as_object().expect("header")).len()
    }

    /// The route facts of a route change over the window rule alone (no catalog row): the model's window as
    /// `resolveSessionContextMeta` states it.
    struct WindowFacts;
    #[async_trait]
    impl crate::run_host::route_change::RouteFacts for WindowFacts {
        fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
            Some(mixdog_core_run::run_host::session_context_meta::resolve_context_meta(None, None, provider, model, seed, false))
        }
        fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &Header) -> Option<Value> {
            None
        }
    }

    struct Fixed;
    impl mixdog_agent::env::Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    /// The route cell of the replay: a thread's live route, set by the adoptions the recorded actions make.
    #[derive(Default)]
    struct Cells(std::sync::Mutex<HashMap<ThreadId, Route>>);

    impl Cells {
        fn set(&self, thread: &ThreadId, route: Route) {
            self.0.lock().expect("the cells").insert(thread.clone(), route);
        }
    }

    impl LiveRoute for Cells {
        fn route(&self, thread: &ThreadId) -> Route {
            self.0.lock().expect("the cells").get(thread).cloned().expect("a thread's route is set when it is created")
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    /// The route half of a thread's start, as `RouteService` does it (`adopt_control`: the live route as it is; `seat`: a route
    /// with a model is put on the created thread by the follow of an `applyToCurrentSession` selection, one without writes
    /// nothing).
    struct Seat {
        cells: Arc<Cells>,
        follow: std::sync::OnceLock<Arc<mixdog_core_ports::ports::route::SessionRoutes>>,
    }

    #[async_trait]
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

    struct Quiet;
    impl mixdog_core_session::session::route_session::RouteStatusline for Quiet {
        fn write(&self, _: &str, _: &Route, _: Option<u64>) {}
    }
    impl mixdog_core_session::session::route_session::ContextStatusCache for Quiet {
        fn invalidate(&self, _: &ThreadId) {}
    }
    struct NoBots;
    #[async_trait]
    impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }
    impl mixdog_core_session::session::route_session::RouteConfig for Quiet {
        fn agent_config(&self) -> mixdog_core_ports::ports::domain_sessions::Obj {
            mixdog_core_ports::ports::domain_sessions::Obj::new()
        }
        fn bots(&self) -> &(dyn mixdog_core_run::run_host::route_chain::BotRoutes + Send + Sync) {
            &NoBots
        }
    }

    /// The tool mode the surface host answers: the recording's own.
    struct Mode(String);
    #[async_trait]
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
    struct NoPrices;
    impl mixdog_ledger::refresh::Pricer for NoPrices {
        fn revision(&self) -> String {
            String::new()
        }
        fn price(&self, _: &mixdog_ledger::repair::PriceRequest) -> mixdog_ledger::Result<mixdog_ledger::repair::Priced> {
            Ok(mixdog_ledger::repair::Priced { cost_usd: None, rates: None })
        }
    }

    /// `thread/getSessionUsage` over a copy of the ledger of `fixtures/session-usage` (it holds nothing of the replay's threads).
    async fn usage_service(
        dir: &std::path::Path,
        threads: Arc<mixdog_core_session::session::thread_state::SessionThreads>,
    ) -> Arc<mixdog_core_domains::domains::ai_account::usage::session_usage::SessionUsageService> {
        let path = dir.join("ledger.sqlite");
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

    /// No model list is ever fetched: the catalog reads the config's own rows.
    struct Offline;
    #[async_trait]
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

    /// The provider registry the readiness holds builds nothing: no replayed call prepares a provider.
    /// The registry's builder as production has it for a custom provider (`build_custom_parts`): an adapter that lists, and
    /// the adapter-owned `getCachedModelInfo` of its listing (`CustomListing`, seeded from the config's own rows before any
    /// listing). The wire is never used by this replay.
    #[derive(Default)]
    struct CustomBuilder {
        listings: std::sync::Mutex<HashMap<String, Arc<mixdog_ai::providers::custom::listing::CustomListing>>>,
    }

    #[async_trait]
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
    struct Writer {
        cells: Arc<Cells>,
        session: Arc<dyn RouteSession>,
        config: mixdog_core_config::config::Config,
        catalog: Arc<mixdog_ai::catalog::CatalogService>,
    }

    #[async_trait]
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
            let route = mixdog_ai::service::admin_route::refresh_route_fields(&config, &target, Some(&meta), &provider, &fast);
            self.cells.set(thread, route.clone());
            Ok(Some(route))
        }
        fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {}
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

    /// The recorded sequence over the real thread directory and store,
    /// route follow (`SessionRoutes`), route change
    /// (`RunHostRouteChange`), installed-compaction sync (`sync_change`), context status and session usage service. What stands in
    /// for the config is the Main route it resolves to: its provider before any model was chosen is the recording's first answer,
    /// and a `keepMainModel: false` pick writes the picked route to it, which the control session's runtime adopts
    /// (`syncEmptyMainRoute`).
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

        async fn context_status(&self, name: &str) -> Value {
            let answer = self.status.context_status(Some(self.id(name)), None).await.expect("status");
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
    async fn the_recorded_sequence_is_answered_as_nodes_answered_it() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/context-status-route/golden.json")).expect("golden");
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
                    assert_eq!(replay.context_status(name).await, step["value"], "{at}");
                    control_reads += 1;
                }
                "contextStatus" => {
                    let (got, want) = (replay.context_status(name).await, &step["value"]);
                    let mut differing = Vec::new();
                    differences(&got, want, "$", &mut differing);
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

    /// The route change whose outside read waits on a gate once armed: it says when it has entered the actor and goes on when
    /// released.
    struct GatedLookup {
        inner: Arc<crate::run_host::route_change::RunHostRouteChange>,
        armed: Arc<std::sync::atomic::AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    #[async_trait]
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

    /// The recorded task session, as the seed turn left it, with a gated route change.
    struct Gated {
        replay: Replay,
        golden: Value,
        armed: Arc<std::sync::atomic::AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        id: ThreadId,
    }

    impl Gated {
        async fn new() -> Self {
            let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/context-status-route/golden.json")).expect("golden");
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
            use mixdog_core_ports::ports::threads::ThreadState;
            let mut got = self.replay.threads.header(&self.id).await.expect("the session");
            let mut want = self.replay.recorded_header(want);
            for header in [&mut got, &mut want] {
                assert!(header.get("updatedAt").is_some_and(Value::is_number), "{what}: a stored time");
                header.remove("updatedAt");
            }
            let mut differing = Vec::new();
            differences(&Value::Object(got), &Value::Object(want), "$", &mut differing);
            assert!(differing.is_empty(), "{what}: {differing:#?}");
        }
    }

    /// A compaction sync and a folder change submitted while the route change is in flight (accepted into the actor's inbox
    /// before the lookup is released) apply after it, in the order submitted: each computes from the header the one before left,
    /// and the stored header ends as Node's live session ends by the same sequence (`inFlight`: the route change, then the sync
    /// and the folder change in this order or the other), in full.
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sync_then_a_folder_change_in_flight_end_as_nodes_sequence_ends() {
        writes_in_flight_end_as_node_ends(["sync", "folder"], "syncThenFolder").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_folder_change_then_a_sync_in_flight_end_as_nodes_sequence_ends() {
        writes_in_flight_end_as_node_ends(["folder", "sync"], "folderThenSync").await;
    }

    /// Node's pass cannot be cancelled once begun: it runs to its write. The route change whose caller is dropped while the
    /// lookup is awaited on the actor still commits, and the header is Node's after the route change, in full.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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

    /// `snapshotProviderRequestTools` as Node recorded it (`fixtures/request-tools`): the session's tools as its
    /// connected MCP names leave them available, once each, and for a native Anthropic-family session the catalog tools
    /// it discovered (and the anchor) added marked `defer_loading`.
    #[test]
    fn the_request_snapshot_follows_node() {
        let golden: Value = mixdog_js::fixture_tools::parse_golden(include_str!("../../../../fixtures/request-tools/golden.json")).expect("request tools golden");
        let (mut steps, mut deferred) = (0, 0);
        for case in golden["cases"].as_array().expect("cases") {
            for (n, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
                let header = step["header"].as_object().expect("header");
                let (docs, rows) = (step["tools"].as_array().expect("tools"), step["messages"].as_array().expect("messages"));
                let got = request_definitions(header, docs, rows, header.get("provider").and_then(Value::as_str).unwrap_or_default());
                let want: Vec<(String, String, Value, bool)> = step["candidate"]
                    .as_array()
                    .expect("candidate")
                    .iter()
                    .map(|t| (t["name"].as_str().unwrap().to_owned(), t["description"].as_str().unwrap().to_owned(), t["inputSchema"].clone(), t["deferLoading"] == true))
                    .collect();
                let got: Vec<(String, String, Value, bool)> = got.into_iter().map(|t| (t.name, t.description, t.input_schema, t.defer_loading)).collect();
                assert_eq!(got, want, "{} (step {n})", case["name"]);
                deferred += got.iter().filter(|t| t.3).count();
                steps += 1;
            }
        }
        assert!(steps > 30 && deferred > 0);
    }
}
