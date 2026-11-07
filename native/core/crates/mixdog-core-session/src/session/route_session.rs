//! The session side of a route change (`ports::route::RouteSession`) over the session
//! directory: Node's `updateSessionRoute` (`session-lifecycle.mjs:492`), the model-switch
//! boundary, the tool-surface rebuild, the owner's fallback chain, the statusline and the
//! context gauge.
//!
//! Every thread is an addressed session: each client reaches the core through the daemon, by
//! thread id. Node closes and recreates an empty session only in an unaddressed runtime
//! (`set-route.mjs:433-448`), so nothing here recreates one, and a thread keeps one generation
//! for its lifetime (Node's advances only when another conversation, or none, is installed).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Clock;
use super::SessionDirectory;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::route::is_summary_anchor;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::hop_host::HopSession;
use mixdog_core_run::run_host::hop_host::HopSessions;
use mixdog_core_run::run_host::route_fallback::HopWrite;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_run::run_host::route_chain::owner_route_fallbacks;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;

/// WP-RUN-HOST's route-change computation (one function, shared with the run's fallback hop):
/// what a route change does to the session besides its route fields. Node's
/// `applyRouteContextWindow`, `resetSessionForRouteChange` (cache key, cache options, token
/// counters), the cross-provider replay strip with the context-usage and baseline clear
/// (`cross_provider`, applied only when the route changed), and the pending workspace re-root
/// with the `# Session` block rebuild. `header` already carries the new route fields; `previous`
/// is the route (`provider`, `model`) the session ran before.
/// Async: a new route's tool surface is resolved from a skill list collected at the change, as
/// Node's `_prepareResumeTools` collects inside the call.
#[async_trait::async_trait]
pub trait RouteChange: Send + Sync {
    async fn route_change(&self, header: &Header, route: &Route, previous: &Route, cross_provider: bool) -> HeaderChange;

    /// A cleared conversation's environment reset (Node's resetSessionBp3Environment), as the header
    /// change the clear writes in its own patch.
    fn environment_reset(&self, header: &Header) -> HeaderChange;
}

/// `statusRoutes.writeGatewaySessionRoute(session.id, routeForStatusline(route), { clientHostPid })`
/// (`statusline-route.mjs:28`): `client_host_pid` is the session's own, `None` for this process.
pub trait RouteStatusline: Send + Sync {
    fn write(&self, session: &str, route: &Route, client_host_pid: Option<u64>);
}

/// `invalidateContextStatusCache`: drop the context gauge's memo for the thread. Node's gauge
/// memoizes its last status; the Rust gauge measures live on every read, so its implementation
/// (`LiveGauge`) has nothing to drop.
pub trait ContextStatusCache: Send + Sync {
    fn invalidate(&self, thread: &ThreadId);
}

/// The config and the bot route store the owner's chain is read from, at the moment of the call.
pub trait RouteConfig: Send + Sync {
    fn agent_config(&self) -> Obj;
    fn bots(&self) -> &(dyn BotRoutes + Send + Sync);
}

pub struct SessionRouteAdapter {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    change: Arc<dyn RouteChange>,
    statusline: Arc<dyn RouteStatusline>,
    gauge: Arc<dyn ContextStatusCache>,
    config: Arc<dyn RouteConfig>,
    clock: Arc<dyn Clock>,
}

impl SessionRouteAdapter {
    pub fn new(
        directory: Arc<SessionDirectory>,
        threads: Arc<dyn ThreadState>,
        change: Arc<dyn RouteChange>,
        statusline: Arc<dyn RouteStatusline>,
        gauge: Arc<dyn ContextStatusCache>,
        config: Arc<dyn RouteConfig>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { directory, threads, change, statusline, gauge, config, clock }
    }
}

/// Whether the route names another provider or model than `previous` (`routeChanged` of
/// `updateSessionRoute`). The adapter passes it to `route_prompt_refresh`.
pub fn route_changed(route: &Route, previous: &Route) -> bool {
    let changed_field = |key: &str| truthy(route.get(key)) && route.get(key) != previous.get(key);
    changed_field("provider") || changed_field("model")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

fn text<'a>(map: &'a Map<String, Value>, key: &str) -> &'a str {
    map.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `UUID_V7_RE` of `session-id.mjs`.
fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    let hex = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_hexdigit);
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&at| bytes[at] == b'-')
        && hex(0..8)
        && hex(9..13)
        && bytes[14] == b'7'
        && hex(15..18)
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && hex(20..23)
        && hex(24..36)
}

/// A change that sets `key`.
fn set(change: &mut HeaderChange, key: &str, value: Value) {
    change.unset.retain(|k| k != key);
    change.set.insert(key.to_owned(), value);
}

/// A change that removes `key`.
fn unset(change: &mut HeaderChange, key: &str) {
    change.set.shift_remove(key);
    if !change.unset.iter().any(|k| k == key) {
        change.unset.push(key.to_owned());
    }
}

/// `applyRouteFields(session, route)`: the route's own fields onto the session.
fn route_fields(header: &Header, route: &Route) -> HeaderChange {
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new() };
    for key in ["provider", "model"] {
        if truthy(route.get(key)) {
            set(&mut change, key, route[key].clone());
        }
    }
    if let Some(fast) = route.get("fast") {
        set(&mut change, "fast", json!(fast == &Value::Bool(true)));
    }
    if let Some(auto) = route.get("autoEffort") {
        if auto == &Value::Bool(false) {
            set(&mut change, "autoEffort", json!(false));
        } else {
            unset(&mut change, "autoEffort");
        }
    }
    if let Some(effort) = route.get("effort") {
        set(&mut change, "effort", if truthy(Some(effort)) { effort.clone() } else { Value::Null });
    }
    // A deliberate route choice restarts the chain (a fallback hop never passes this).
    if let Some(chain) = route.get("routeFallbacks") {
        if chain.as_array().is_some_and(|list| !list.is_empty()) {
            set(&mut change, "routeFallbacks", chain.clone());
        } else {
            unset(&mut change, "routeFallbacks");
        }
        for key in ["routeFallbackIndex", "routeFallbackFailures", "routeFallbackPrimary"] {
            unset(&mut change, key);
        }
    }
    // `ensureCodexWireSessionId`: an `openai-oauth` session carries a UUIDv7 wire id.
    let provider = change.set.get("provider").or_else(|| header.get("provider"));
    if provider.and_then(Value::as_str) == Some("openai-oauth") {
        let current = header.get("codexWireSessionId").map(|v| if truthy(Some(v)) { mixdog_js::value_to_string(v) } else { String::new() });
        let current = mixdog_js::js_trim(current.as_deref().unwrap_or_default()).to_lowercase();
        let wire = if is_uuid_v7(&current) { current } else { uuid::Uuid::now_v7().to_string() };
        set(&mut change, "codexWireSessionId", json!(wire));
    }
    if let Some(parameters) = route.get("modelParameters") {
        set(&mut change, "modelParameters", if parameters.is_object() { parameters.clone() } else { json!({}) });
    }
    if let Some(percent) = route.get("contextPercent") {
        let percent = mixdog_ai::service::admin_route::clean_context_percent(Some(percent));
        set(&mut change, "contextPercent", percent.map_or(Value::Null, mixdog_js::json_number));
    }
    if let Some(tokens) = route.get("contextTokens") {
        let tokens = mixdog_ai::service::admin_route::normalize_context_tokens(Some(tokens));
        set(&mut change, "contextTokens", tokens.map_or(Value::Null, mixdog_js::json_number));
    }
    if let Some(window) = route.get("selectedContextWindow") {
        let window = mixdog_js::to_number(window);
        let window = if window.is_finite() && window != 0.0 { mixdog_js::json_number(window) } else { Value::Null };
        set(&mut change, "selectedContextWindow", window);
    }
    change
}

/// `change` applied to `header`.
fn applied(header: &Header, change: &HeaderChange) -> Header {
    let mut next = header.clone();
    for key in &change.unset {
        next.shift_remove(key);
    }
    for (key, value) in &change.set {
        next.insert(key.clone(), value.clone());
    }
    next
}

/// `isReferenceFilesMessage`: `/^Reference files:\s*/i` on the trimmed-start text.
fn is_reference_files(message: &Value) -> bool {
    let Some(content) = message.get("content").and_then(Value::as_str) else { return false };
    let start = mixdog_js::js_trim_start(content);
    start.get(..16).is_some_and(|head| head.eq_ignore_ascii_case("reference files:"))
}

/// `hasUserConversationMessage` (`prompt-utils.mjs:610`).
pub fn has_user_conversation(messages: &[Value]) -> bool {
    messages.iter().any(|message| {
        message.get("role").and_then(Value::as_str) == Some("user")
            && !mixdog_store::user_message_kind::is_protected_context_user_message(message)
            && !is_reference_files(message)
            && !is_summary_anchor(message)
    })
}

#[async_trait]
impl RouteSession for SessionRouteAdapter {
    fn generation(&self, _thread: &ThreadId) -> u64 {
        0
    }

    async fn live_turn_messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(self.directory.handle(thread).map(|handle| (**handle.cell.turn_messages.borrow()).clone()).unwrap_or_default())
    }

    fn has_user_conversation(&self, messages: &[Value]) -> bool {
        has_user_conversation(messages)
    }

    /// `updateSessionRoute(id, route, { crossProvider })`: the route fields and what the route
    /// change does to the session, as one durable header change. `false` when the session is
    /// closed or gone.
    async fn update_route(&self, thread: &ThreadId, route: Route, cross_provider: bool) -> Result<bool, PortError> {
        let Some((_, change)) = self.route_patch(thread, &route, cross_provider).await? else { return Ok(false) };
        self.threads.patch_header(thread, change.set, change.unset).await?;
        Ok(true)
    }

    async fn record_boundary(&self, thread: &ThreadId, field: &str, boundary: Value) -> Result<bool, PortError> {
        if field != "modelSwitches" {
            return Err(PortError::Invalid { field: "field".into(), reason: format!("{field} is not a recorded boundary") });
        }
        super::record_model_switch(&self.directory, thread, &boundary).await.map_err(mixdog_core_ports::ports::threads::port_error)
    }

    /// `rebuildToolSurfaceForProviderWithMigration`: the session re-derives its tool surface
    /// from its header, which already names the new provider.
    async fn rebuild_tool_surface(&self, thread: &ThreadId, _provider: &str) -> Result<(), PortError> {
        let handle = self
            .directory
            .open_handle(thread, &mixdog_core_api::call::CallContext::internal("route"))
            .await
            .map_err(mixdog_core_ports::ports::threads::port_error)?;
        handle.refresh_surface().map_err(mixdog_core_ports::ports::threads::port_error)
    }

    /// `sessionRouteFallbackFields`: the owner's chain on `provider/model` for a session acting
    /// as an agent; `None` for a delegated worker, which keeps its own.
    async fn owner_fallbacks(&self, thread: &ThreadId, header: &Header, provider: &str, model: &str) -> Result<Option<Vec<Value>>, PortError> {
        let mut session = header.clone();
        session.insert("id".into(), json!(thread.as_str()));
        let (mode, agent) = resolve_session_mode(&Value::Object(session));
        if agent.is_empty() {
            return Ok(None);
        }
        let chain = owner_route_fallbacks(mode, &agent, provider, model, &self.config.agent_config(), self.config.bots()).await;
        // An unread store is a failed switch, not a chain from the config.
        chain.map(Some).map_err(|error| PortError::Failed { capability: "route".into(), message: error.to_string() })
    }

    /// `writeStatuslineRoute(statusRoutes, session, route)`.
    fn write_statusline(&self, thread: &ThreadId, route: &Route) {
        let pid = self
            .directory
            .handle(thread)
            .and_then(|handle| handle.cell.header.load().get("clientHostPid").and_then(Value::as_u64).filter(|pid| *pid > 0));
        self.statusline.write(thread.as_str(), route, pid);
    }

    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.gauge.invalidate(thread);
    }
}

impl SessionRouteAdapter {
    /// The one header change of `updateSessionRoute(id, route, { crossProvider })`: the route's
    /// fields and what the route change does to the session. `None` when the session is closed
    /// or gone. The header returned is the one the change was computed from.
    pub(crate) async fn route_patch(&self, thread: &ThreadId, route: &Route, cross_provider: bool) -> Result<Option<(Header, HeaderChange)>, PortError> {
        let header = match self.threads.header(thread).await {
            Ok(header) => header,
            Err(PortError::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        if header.get("closed") == Some(&Value::Bool(true)) {
            return Ok(None);
        }
        let mut previous = Route::new();
        for key in ["provider", "model"] {
            if let Some(value) = header.get(key) {
                previous.insert(key.to_owned(), value.clone());
            }
        }
        let mut change = route_fields(&header, &route);
        let routed = applied(&header, &change);
        let derived = self.change.route_change(&routed, &route, &previous, cross_provider).await;
        // The prompt half: a staged workspace change applies on a new route, and the
        // `# Session` block is rebuilt for the session's cwd.
        let changed = route_changed(&route, &previous);
        let prompt = super::worktree::route_prompt_refresh(&super::worktree::PromptView { header: &routed, tier3: None, env: None }, changed);
        for part in [derived, prompt.change] {
            for key in part.unset {
                unset(&mut change, &key);
            }
            for (key, value) in part.set {
                set(&mut change, &key, value);
            }
        }
        set(&mut change, "updatedAt", json!(self.clock.now_ms()));
        Ok(Some((header, change)))
    }

    /// `advanceAgentRoute`'s one write: `updateSessionRoute(id, route, { crossProvider: true })`
    /// followed by the hop's fields, in the one header change. The route change leaves
    /// `wireRoute` null. The updated header; `None` when the session is closed or gone.
    pub(crate) async fn write_hop(&self, thread: &ThreadId, route: Route, hop: &mixdog_core_run::run_host::route_fallback::HopWrite) -> Result<Option<Header>, PortError> {
        let Some((header, mut change)) = self.route_patch(thread, &route, true).await? else { return Ok(None) };
        set(&mut change, "routeFallbacks", Value::Array(hop.chain.clone()));
        if let Some(primary) = &hop.primary {
            set(&mut change, "routeFallbackPrimary", primary.clone());
        }
        set(&mut change, "routeFallbackIndex", json!(hop.index));
        set(&mut change, "routeFallbackFailures", Value::Array(hop.failures.clone()));
        if hop.checkpoint_route_changed
            && let Some(Value::Object(checkpoint)) = header.get("activeTurnCheckpoint")
        {
            let mut checkpoint = checkpoint.clone();
            checkpoint.insert("routeChanged".into(), Value::Bool(true));
            set(&mut change, "activeTurnCheckpoint", Value::Object(checkpoint));
        }
        self.threads.patch_header(thread, change.set, change.unset).await?;
        self.threads.header(thread).await.map(Some)
    }
}

/// The sessions a route hop can write (`run_host::hop_host::HopSessions`): the threads this
/// process hosts.
pub struct SessionHops {
    adapter: Arc<SessionRouteAdapter>,
}

impl SessionHops {
    pub fn new(adapter: Arc<SessionRouteAdapter>) -> Self {
        Self { adapter }
    }
}

impl HopSessions for SessionHops {
    /// `None` when the thread is not loaded here.
    fn open(&self, thread: &ThreadId) -> Option<Arc<dyn HopSession>> {
        let handle = self.adapter.directory.handle(thread)?;
        Some(Arc::new(SessionHop { adapter: self.adapter.clone(), handle }))
    }
}

struct SessionHop {
    adapter: Arc<SessionRouteAdapter>,
    handle: Arc<super::SessionHandle>,
}

#[async_trait]
impl HopSession for SessionHop {
    fn header(&self) -> Option<Arc<Header>> {
        let header = self.handle.cell.header.load_full();
        let closed = self.handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) || header.get("closed") == Some(&Value::Bool(true));
        (!closed).then_some(header)
    }

    async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError> {
        self.adapter.write_hop(&self.handle.id, route, write).await
    }

    async fn write_wire_pin(&self, pin: Value) -> Result<(), PortError> {
        let mut set = Map::new();
        set.insert("wireRoute".into(), pin);
        self.adapter.threads.patch_header(&self.handle.id, set, Vec::new()).await
    }

    async fn rebuild_tool_surface(&self, provider: &str) -> Result<(), PortError> {
        RouteSession::rebuild_tool_surface(&*self.adapter, &self.handle.id, provider).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    /// `applyRouteFields`: only the fields the route names; a chain restart clears the hop.
    #[test]
    fn route_fields_follow_apply_route_fields() {
        let header = obj(json!({ "provider": "openai", "model": "gpt-a", "autoEffort": false, "routeFallbackIndex": 1 }));
        let change = route_fields(
            &header,
            &obj(json!({
                "provider": "anthropic", "model": "", "fast": "yes", "autoEffort": true, "effort": "",
                "routeFallbacks": [], "modelParameters": 3, "contextPercent": 34, "contextTokens": 0.4,
                "selectedContextWindow": "x",
            })),
        );
        assert_eq!(
            Value::Object(change.set),
            json!({
                "provider": "anthropic", "fast": false, "effort": null, "modelParameters": {},
                "contextPercent": 30, "contextTokens": null, "selectedContextWindow": null,
            })
        );
        assert_eq!(change.unset, ["autoEffort", "routeFallbacks", "routeFallbackIndex", "routeFallbackFailures", "routeFallbackPrimary"]);
        let codex = route_fields(&obj(json!({ "codexWireSessionId": " 0190F0A0-1C2D-7E3F-8A4B-5C6D7E8F9A0D " })), &obj(json!({ "provider": "openai-oauth" })));
        assert_eq!(codex.set["codexWireSessionId"], "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d");
        let minted = route_fields(&obj(json!({ "codexWireSessionId": "nope" })), &obj(json!({ "provider": "openai-oauth" })));
        assert!(is_uuid_v7(minted.set["codexWireSessionId"].as_str().unwrap()));
    }

    /// `hasUserConversationMessage`: reminders, reference files and summary anchors are no turn.
    #[test]
    fn a_user_conversation_is_a_real_user_turn() {
        assert!(!has_user_conversation(&[json!({ "role": "user", "content": "<system-reminder>x</system-reminder>" })]));
        assert!(!has_user_conversation(&[json!({ "role": "user", "content": "  reference FILES: a.rs" })]));
        assert!(has_user_conversation(&[json!({ "role": "user", "content": "hello" })]));
        assert!(!has_user_conversation(&[json!({ "role": "assistant", "content": "hello" })]));
    }

    struct Change(Mutex<Vec<(Value, Value, bool)>>);
    #[async_trait::async_trait]
    impl RouteChange for Change {
        async fn route_change(&self, header: &Header, _route: &Route, previous: &Route, cross: bool) -> HeaderChange {
            self.0.lock().unwrap().push((Value::Object(header.clone()), Value::Object(previous.clone()), cross));
            HeaderChange { set: obj(json!({ "contextWindow": 200_000 })), unset: vec!["contextUsageSnapshot".into()] }
        }
        fn environment_reset(&self, _: &Header) -> HeaderChange {
            HeaderChange { set: Map::new(), unset: Vec::new() }
        }
    }
    struct Quiet;
    impl RouteStatusline for Quiet {
        fn write(&self, _: &str, _: &Route, _: Option<u64>) {}
    }
    impl ContextStatusCache for Quiet {
        fn invalidate(&self, _: &ThreadId) {}
    }
    struct NoBots;
    #[async_trait::async_trait]
    impl BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }
    impl RouteConfig for Quiet {
        fn agent_config(&self) -> Obj {
            Obj::new()
        }
        fn bots(&self) -> &(dyn BotRoutes + Send + Sync) {
            &NoBots
        }
    }

    /// `updateSessionRoute`: the route fields and the route change land as one header change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_route_update_is_one_header_change_with_the_route_change() {
        use crate::session::thread_state::SessionThreads;
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_route");
        let header = obj(json!({ "provider": "openai", "model": "gpt-a", "contextUsageSnapshot": { "usedTokens": 9 } }));
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let change = Arc::new(Change(Mutex::default()));
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            change.clone(),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );
        let route = obj(json!({ "provider": "anthropic", "model": "claude-x", "fast": true }));
        assert!(adapter.update_route(&thread, route, true).await.expect("update"));
        let stored = threads.header(&thread).await.expect("header");
        assert_eq!((stored["provider"].clone(), stored["model"].clone(), stored["fast"].clone()), (json!("anthropic"), json!("claude-x"), json!(true)));
        assert_eq!(stored["contextWindow"], 200_000);
        assert!(!stored.contains_key("contextUsageSnapshot"));
        assert_eq!(stored["updatedAt"], json!(rig.clock.now_ms()));
        let (seen, previous, cross) = change.0.lock().unwrap()[0].clone();
        assert_eq!((seen["model"].clone(), previous, cross), (json!("claude-x"), json!({ "provider": "openai", "model": "gpt-a" }), true));
        assert!(!adapter.update_route(&ThreadId::from("sess_gone"), Route::new(), false).await.expect("gone"));
    }

    struct NullWire;
    #[async_trait::async_trait]
    impl RouteChange for NullWire {
        async fn route_change(&self, _: &Header, _: &Route, _: &Route, _: bool) -> HeaderChange {
            HeaderChange { set: obj(json!({ "wireRoute": null })), unset: Vec::new() }
        }
        fn environment_reset(&self, _: &Header) -> HeaderChange {
            HeaderChange { set: Map::new(), unset: Vec::new() }
        }
    }

    /// `advanceAgentRoute`'s write: the route change and the hop's fields land as one header
    /// change; the primary is written only when the hop names one, the checkpoint is marked only
    /// when asked, and the wire pin is a later write of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hop_writes_the_route_and_its_fields_in_one_header_change() {
        use crate::session::thread_state::SessionThreads;
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_hop");
        let header = obj(json!({
            "provider": "openai", "model": "gpt-a", "wireRoute": { "wire": "responses" },
            "routeFallbackPrimary": { "provider": "openai", "model": "gpt-a" },
            "activeTurnCheckpoint": { "turn": 3 },
        }));
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let adapter = Arc::new(SessionRouteAdapter::new(directory.clone(), threads.clone(), Arc::new(NullWire), Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone()));
        let hops = SessionHops::new(adapter);
        assert!(hops.open(&ThreadId::from("sess_gone")).is_none());
        let session = hops.open(&thread).expect("loaded");
        assert_eq!(session.header().expect("open")["model"], "gpt-a");

        let next = json!({ "provider": "anthropic", "model": "claude-x" });
        let write = HopWrite {
            chain: vec![next.clone()],
            primary: None,
            index: 1,
            failures: vec![json!({ "provider": "openai", "model": "gpt-a", "kind": "overloaded" })],
            checkpoint_route_changed: false,
        };
        let stored = session.write_hop(obj(next.clone()), &write).await.expect("hop").expect("open session");
        assert_eq!((stored["provider"].clone(), stored["model"].clone()), (json!("anthropic"), json!("claude-x")));
        assert_eq!(stored["wireRoute"], Value::Null, "the route change leaves the wire unpinned");
        assert_eq!((stored["routeFallbacks"].clone(), stored["routeFallbackIndex"].clone()), (json!([next]), json!(1)));
        assert_eq!(stored["routeFallbackFailures"][0]["kind"], "overloaded");
        assert_eq!(stored["routeFallbackPrimary"], json!({ "provider": "openai", "model": "gpt-a" }), "no primary named: the stored one stays");
        assert_eq!(stored["activeTurnCheckpoint"], json!({ "turn": 3 }), "not marked unless asked");

        let primary = json!({ "provider": "anthropic", "model": "claude-x" });
        let write = HopWrite { primary: Some(primary.clone()), index: 2, checkpoint_route_changed: true, ..write };
        let stored = session.write_hop(obj(primary.clone()), &write).await.expect("hop").expect("open session");
        assert_eq!((stored["routeFallbackPrimary"].clone(), stored["routeFallbackIndex"].clone()), (primary, json!(2)));
        assert_eq!(stored["activeTurnCheckpoint"], json!({ "turn": 3, "routeChanged": true }));

        let pin = json!({ "provider": "anthropic", "model": "claude-x", "wire": "messages" });
        session.write_wire_pin(pin.clone()).await.expect("pin");
        assert_eq!(session.header().expect("open")["wireRoute"], pin);
        session.rebuild_tool_surface("anthropic").await.expect("rebuild");
    }

    /// A route change on a session with a staged re-root applies it in the same header change,
    /// as Node's `updateSessionRoute` does (the `applied` golden's header).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_route_change_applies_a_staged_reroot_in_the_same_header_change() {
        use crate::session::thread_state::SessionThreads;
        let cases: Vec<Value> = serde_json::from_str(include_str!("worktree_goldens/reroot_goldens.json")).expect("goldens");
        let case = &cases[0];
        let before = obj(case["before"]["header"].clone());
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_reroot");
        directory.create_with_id(thread.clone(), before.clone(), json!({})).await.expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let none = Arc::new(Change(Mutex::default()));
        let adapter = SessionRouteAdapter::new(directory.clone(), threads.clone(), none, Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone());
        let route = obj(json!({ "model": "another-model" }));
        assert!(adapter.update_route(&thread, route, false).await.expect("update"));
        let stored = threads.header(&thread).await.expect("header");
        let applied = case["applied"]["header"].as_object().expect("applied header");
        for key in ["cwd", "rootCwd"] {
            assert_eq!(stored.get(key), applied.get(key), "{key}");
        }
        assert!(super::super::worktree::pending_workspace_reroot(&stored).is_none(), "the staged change is applied");
    }

    struct Live(Route);
    impl mixdog_core_ports::ports::route::LiveRoute for Live {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.clone()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    /// `continueSessionInModel`'s session half over a real session: the boundary goes on the
    /// reply, the route lands as a cross-provider change, and the switch row follows the reply.
    #[tokio::test(start_paused = true)]
    async fn switch_now_switches_the_conversation_in_place() {
        use mixdog_core_ports::ports::route::SessionRoutes;
        use crate::session::thread_state::SessionThreads;
        use crate::session::tests::eventually;
        use crate::session::tests::idle;
        use crate::session::tests::start_thread;
        use crate::session::tests::turn;

        let rig = crate::session::testing::Rig::new();
        rig.set_script(Arc::new(|run| {
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let reply = crate::session::ItemCommit {
                    iid: mixdog_core_api::ids::ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "assistant", "content": "done" }),
                    prompt: None,
                };
                run.port.commit_item(reply).await.expect("commit");
                crate::session::RunOutcome::Completed(Default::default())
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        turn(&handle, "hello", "op-1").await;
        eventually(|| (idle(&handle) && handle.cell.view.load_full().items.len() == 2).then_some(())).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        threads.patch_header(&handle.id, obj(json!({ "provider": "openai", "model": "gpt-a" })), Vec::new()).await.expect("route");
        let change = Arc::new(Change(Mutex::default()));
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            change.clone(),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );
        let live = Live(obj(json!({ "provider": "anthropic", "model": "claude-x" })));
        let routes = SessionRoutes::new(threads.clone(), threads.clone(), Arc::new(adapter), Arc::new(live));

        let boundary = routes.switch_now(&handle.id).await.expect("switch").expect("a boundary");
        assert_eq!((boundary["provider"].clone(), boundary["modelId"].clone()), (json!("anthropic"), json!("claude-x")));
        let header = threads.header(&handle.id).await.expect("header");
        assert_eq!((header["provider"].clone(), header["model"].clone()), (json!("anthropic"), json!("claude-x")));
        assert!(change.0.lock().unwrap()[0].2, "a switch of model is a cross-provider change");
        let items = handle.cell.view.load_full().items.clone();
        assert_eq!(items.len(), 3, "the switch row follows the reply");
        assert!(items[2].id().as_str().starts_with(&format!("{}:model:", items[1].id().as_str())));
    }
}
