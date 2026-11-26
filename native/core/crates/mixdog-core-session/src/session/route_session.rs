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
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::route::is_summary_anchor;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::hop_host::HopSession;
use mixdog_core_run::run_host::hop_host::HopSessions;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::owner_route_fallbacks;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;
use mixdog_core_run::run_host::route_fallback::HopWrite;

/// What a route change reads from outside the header, collected by [`RouteChange::lookups`] and
/// handed to [`RouteChange::route_change`]; each implementation downcasts its own.
pub type RouteLookups = Box<dyn std::any::Any + Send + Sync>;

/// WP-RUN-HOST's route-change computation (one function, shared with the run's fallback hop):
/// what a route change does to the session besides its route fields. Node's
/// `applyRouteContextWindow`, `resetSessionForRouteChange` (cache key, cache options, token
/// counters), the cross-provider replay strip with the context-usage and baseline clear
/// (`cross_provider`, applied only when the route changed), and the pending workspace re-root
/// with the `# Session` block rebuild. `header` already carries the new route fields; `previous`
/// is the route (`provider`, `model`) the session ran before.
/// The change is synchronous, like Node's `updateSessionRoute`: it runs on the session's actor,
/// on the header as it stands there (`HeaderUpdates`), and invalidates the route's live prefix baseline.
/// What it reads from outside
/// the header (a new route's tool surface is resolved from a skill list, which Node's
/// `_prepareResumeTools` collects inside the call) is looked up first, by `lookups`.
#[async_trait::async_trait]
pub trait RouteChange: Send + Sync {
    /// The outside reads of the change, awaited on the session's actor over the header the change commits against.
    async fn lookups(&self, _header: &Header, _route: &Route) -> RouteLookups {
        Box::new(())
    }

    fn route_change(&self, header: &Header, route: &Route, previous: &Route, cross_provider: bool, lookups: &RouteLookups) -> HeaderChange;

    /// A cleared conversation's environment reset (Node's resetSessionBp3Environment), as the header
    /// change the clear writes in its own patch.
    fn environment_reset(&self, header: &Header) -> HeaderChange;

    /// `applyTurnContextMeta` (`ask-turn-prepare.mjs`): the window figures a turn starts with, derived anew from the live provider's
    /// model rows, so a provider or model row edited since the route was seated (a custom provider's `contextWindow` override)
    /// reaches the running session. Nothing by default.
    fn turn_window(&self, _header: &Header) -> HeaderChange {
        HeaderChange { set: Default::default(), unset: Vec::new(), patch: Default::default() }
    }
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

type HopRollbackMap = std::collections::HashMap<(ThreadId, Option<u64>), Vec<(String, Option<Value>)>>;

pub struct SessionRouteAdapter {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    change: Arc<dyn RouteChange>,
    statusline: Arc<dyn RouteStatusline>,
    gauge: Arc<dyn ContextStatusCache>,
    config: Arc<dyn RouteConfig>,
    clock: Arc<dyn Clock>,
    hop_rollback_keys: Arc<std::sync::Mutex<HopRollbackMap>>,
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
        Self {
            directory,
            threads,
            change,
            statusline,
            gauge,
            config,
            clock,
            hop_rollback_keys: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
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
        Ok(self.directory.handle(thread).map(|handle| handle.turn_messages_snapshot()).unwrap_or_default())
    }

    async fn turn_running(&self, thread: &ThreadId) -> Result<bool, PortError> {
        Ok(self.directory.handle(thread).is_some_and(|handle| handle.turn_running()))
    }

    fn has_user_conversation(&self, messages: &[Value]) -> bool {
        has_user_conversation(messages)
    }

    fn loaded(&self, thread: &ThreadId) -> bool {
        self.directory.handle(thread).is_some()
    }

    /// `updateSessionRoute(id, route, { crossProvider })`: the route fields and what the route
    /// change does to the session, as one durable header change. `false` when the session is
    /// closed or gone.
    async fn update_route(&self, thread: &ThreadId, route: Route, cross_provider: bool) -> Result<bool, PortError> {
        self.write_route(thread, &route, cross_provider, |_, _| {}).await
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
        let pid =
            self.directory.handle(thread).and_then(|handle| handle.cell.header.load().get("clientHostPid").and_then(Value::as_u64).filter(|pid| *pid > 0));
        self.statusline.write(thread.as_str(), route, pid);
    }

    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.gauge.invalidate(thread);
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

    async fn restore_header(&self, previous: Header) -> Result<(), PortError> {
        self.adapter.restore_header(&self.handle.id, previous).await
    }

    async fn write_hop_with_token(
        &self,
        token: u64,
        route: mixdog_core_ports::ports::domain_sessions::Obj,
        write: &mixdog_core_run::run_host::route_fallback::HopWrite,
    ) -> Result<Option<Header>, PortError> {
        self.adapter.write_hop_with_token(&self.handle.id, token, route, write).await
    }

    fn commit_hop(&self, token: u64) {
        self.adapter.commit_hop(&self.handle.id, token);
    }

    async fn restore_hop(&self, token: u64, previous: Header) -> Result<(), PortError> {
        self.adapter.restore_hop(&self.handle.id, token, previous).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
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
        fn route_change(&self, header: &Header, _route: &Route, previous: &Route, cross: bool, _: &RouteLookups) -> HeaderChange {
            self.0.lock().unwrap().push((Value::Object(header.clone()), Value::Object(previous.clone()), cross));
            HeaderChange { set: obj(json!({ "contextWindow": 200_000 })), unset: vec!["contextUsageSnapshot".into()], patch: Default::default() }
        }
        fn environment_reset(&self, _: &Header) -> HeaderChange {
            HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() }
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

    struct NullWire;
    #[async_trait::async_trait]
    impl RouteChange for NullWire {
        fn route_change(&self, _: &Header, _: &Route, _: &Route, _: bool, _: &RouteLookups) -> HeaderChange {
            HeaderChange { set: obj(json!({ "wireRoute": null })), unset: Vec::new(), patch: Default::default() }
        }
        fn environment_reset(&self, _: &Header) -> HeaderChange {
            HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() }
        }
    }

    struct Live(Route);
    impl mixdog_core_ports::ports::route::LiveRoute for Live {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.clone()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    /// `applyRouteFields`: only the fields the route names; a chain restart clears the hop.
    #[test]
    fn route_fields_follow_apply_route_fields() {
        let header = obj(json!({ "provider": "openai", "model": "gpt-a", "effortAuto": false, "routeFallbackIndex": 1 }));
        let change = route_fields(
            &header,
            &obj(json!({
                "provider": "anthropic", "model": "", "fast": "yes", "effortAuto": true, "effort": "",
                "routeFallbacks": [], "modelParameters": 3, "contextPercent": 34, "contextTokens": 0.4,
                "selectedContextWindow": "x",
            })),
        );
        assert_eq!(
            Value::Object(change.set),
            json!({
                "provider": "anthropic", "fast": false, "effortAuto": true, "effort": null, "modelParameters": {},
                "contextPercent": 30, "contextTokens": null, "selectedContextWindow": null,
            })
        );
        assert_eq!(change.unset, ["autoEffort", "routeFallbacks", "routeFallbackIndex", "routeFallbackFailures", "routeFallbackPrimary"]);
        let codex = route_fields(&obj(json!({ "codexWireSessionId": " 0190F0A0-1C2D-7E3F-8A4B-5C6D7E8F9A0D " })), &obj(json!({ "provider": "openai-oauth" })));
        assert_eq!(codex.set["codexWireSessionId"], "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d");
        let minted = route_fields(&obj(json!({ "codexWireSessionId": "nope" })), &obj(json!({ "provider": "openai-oauth" })));
        assert!(is_uuid_v7(minted.set["codexWireSessionId"].as_str().unwrap()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn route_fallback_source_is_persisted_and_cleared_on_null() {
        use crate::session::thread_state::SessionThreads;

        let header = obj(json!({ "provider": "openai", "model": "gpt-a" }));
        let set_change = route_fields(
            &header,
            &obj(json!({
                "provider": "anthropic",
                "model": "claude-x",
                "routeFallbacks": [{ "provider": "openai", "model": "gpt-b" }],
                "routeFallbackSource": { "preset": "preset-a" },
            })),
        );
        assert_eq!(set_change.set.get("routeFallbackSource"), Some(&json!({ "preset": "preset-a" })));
        assert!(!set_change.unset.iter().any(|k| k == "routeFallbackSource"));

        let clear_change = route_fields(
            &applied(&header, &set_change),
            &obj(json!({
                "provider": "openai",
                "model": "gpt-b",
                "routeFallbacks": [],
                "routeFallbackSource": null,
            })),
        );
        assert!(!clear_change.set.contains_key("routeFallbackSource"));
        assert!(clear_change.unset.iter().any(|k| k == "routeFallbackSource"));

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_fallback_source");
        directory
            .create_with_id(
                thread.clone(),
                obj(json!({
                    "provider": "openai",
                    "model": "gpt-a",
                    "routeFallbacks": [{ "provider": "anthropic", "model": "claude-a" }],
                    "routeFallbackSource": { "preset": "preset-a" },
                })),
                json!({}),
            )
            .await
            .expect("create");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            Arc::new(Change(Mutex::default())),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );

        let reassign_b = obj(json!({
            "provider": "anthropic",
            "model": "claude-b",
            "routeFallbacks": [{ "provider": "openai", "model": "gpt-b" }],
            "routeFallbackSource": { "preset": "preset-b" },
        }));
        assert!(adapter.update_route(&thread, reassign_b, true).await.expect("reassign B"));
        let stored_b = threads.header(&thread).await.expect("header B");
        assert_eq!(stored_b.get("routeFallbacks"), Some(&json!([{ "provider": "openai", "model": "gpt-b" }])));
        assert_eq!(stored_b.get("routeFallbackSource"), Some(&json!({ "preset": "preset-b" })));

        let clear = obj(json!({
            "provider": "openai",
            "model": "gpt-c",
            "routeFallbacks": [],
            "routeFallbackSource": null,
        }));
        assert!(adapter.update_route(&thread, clear, true).await.expect("clear source"));
        let stored_cleared = threads.header(&thread).await.expect("header cleared");
        assert!(!stored_cleared.contains_key("routeFallbacks"));
        assert!(!stored_cleared.contains_key("routeFallbackSource"));
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
        let adapter =
            SessionRouteAdapter::new(directory.clone(), threads.clone(), change.clone(), Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone());
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
        let adapter = Arc::new(SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            Arc::new(NullWire),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        ));
        let hops = SessionHops::new(adapter.clone());
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

        // The picker names the fallback model when retuning it. The session runs on its seated fields until
        // turn preparation applies that pending route, even when it is the same provider and model.
        let pick = obj(json!({ "provider": "anthropic", "model": "claude-x", "effort": "high", "effectiveEffort": "high",
            "fast": true, "effortAuto": false, "modelParameters": { "verbosity": "low" } }));
        let records = Arc::new(SessionThreads::new(directory.clone()));
        let routes = mixdog_core_ports::ports::route::SessionRoutes::new(records.clone(), records, adapter, Arc::new(Live(pick)));
        let follow = mixdog_core_ports::ports::route::FollowOptions {
            apply_to_current_session: true,
            defer_until_next_turn: true,
            lease: Some(routes.open_lease(&thread, None)),
            ..Default::default()
        };
        routes.follow(&thread, &follow).await.unwrap();
        let staged = session.header().unwrap();
        assert_ne!(staged.get("fast"), Some(&json!(true)));
        assert_eq!(staged["pendingRoute"]["fast"], true);
        routes.apply_pending(&thread).await.unwrap();
        let seated = session.header().unwrap();
        assert_eq!(
            (&seated["model"], &seated["effort"], &seated["fast"], &seated["effortAuto"]),
            (&json!("claude-x"), &json!("high"), &json!(true), &json!(false))
        );
        assert_eq!(seated["modelParameters"], json!({ "verbosity": "low" }));
        assert!(!seated.contains_key("pendingRoute"));
    }
    /// `continueSessionInModel`'s session half over a real session: the boundary goes on the
    /// reply, the route lands as a cross-provider change, and the switch row follows the reply.
    #[tokio::test(start_paused = true)]
    async fn switch_now_switches_the_conversation_in_place() {
        use crate::eventually_on;
        use crate::session::tests::idle;
        use crate::session::tests::start_thread;
        use crate::session::tests::turn;
        use crate::session::thread_state::SessionThreads;
        use mixdog_core_ports::ports::route::SessionRoutes;

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
        eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.view.load_full().items.len() == 2).then_some(())).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        threads.patch_header(&handle.id, obj(json!({ "provider": "openai", "model": "gpt-a" })), Vec::new()).await.expect("route");
        let change = Arc::new(Change(Mutex::default()));
        let adapter =
            SessionRouteAdapter::new(directory.clone(), threads.clone(), change.clone(), Arc::new(Quiet), Arc::new(Quiet), Arc::new(Quiet), rig.clock.clone());
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

    #[tokio::test(start_paused = true)]
    async fn restore_header_atomically_undoes_aborted_hop_fields() {
        use crate::session::tests::start_thread;
        use crate::session::thread_state::SessionThreads;

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        threads
            .patch_header(
                &handle.id,
                obj(json!({
                    "provider": "openai",
                    "model": "gpt-4o",
                    "wireRoute": { "provider": "openai", "model": "gpt-4o", "wire": "responses" },
                })),
                Vec::new(),
            )
            .await
            .expect("seed header");
        let before = threads.header(&handle.id).await.expect("before");
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            Arc::new(Change(Mutex::default())),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );
        let hop = mixdog_core_run::run_host::route_fallback::HopWrite {
            chain: vec![json!({ "provider": "anthropic", "model": "claude-x" })],
            primary: Some(json!({ "provider": "openai", "model": "gpt-4o" })),
            index: 1,
            failures: vec![json!({ "provider": "openai", "model": "gpt-4o", "kind": "transient", "error": "503" })],
            checkpoint_route_changed: false,
        };
        adapter.write_hop(&handle.id, obj(json!({ "provider": "anthropic", "model": "claude-x" })), &hop).await.expect("write_hop").expect("open");
        let mid = threads.header(&handle.id).await.expect("mid");
        assert_eq!((mid["provider"].as_str(), mid["model"].as_str()), (Some("anthropic"), Some("claude-x")));
        assert!(mid.contains_key("routeFallbackPrimary"));

        adapter.restore_header(&handle.id, before.clone()).await.expect("restore_header");
        let after = threads.header(&handle.id).await.expect("after");
        assert_eq!((after["provider"].as_str(), after["model"].as_str()), (Some("openai"), Some("gpt-4o")));
        assert_eq!(after.get("wireRoute"), before.get("wireRoute"));
        assert!(!after.contains_key("routeFallbackPrimary"));
        assert!(!after.contains_key("routeFallbackFailures"));
        assert!(!after.contains_key("routeFallbackIndex"));
        assert!(!after.contains_key("routeFallbacks"));
    }

    #[tokio::test(start_paused = true)]
    async fn restore_header_preserves_concurrent_unrelated_updates() {
        use crate::session::tests::start_thread;
        use crate::session::thread_state::SessionThreads;

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        threads
            .patch_header(
                &handle.id,
                obj(json!({
                    "provider": "openai",
                    "model": "gpt-4o",
                    "title": "Initial title",
                    "wireRoute": { "provider": "openai", "model": "gpt-4o", "wire": "responses" },
                })),
                Vec::new(),
            )
            .await
            .expect("seed header");
        let before = threads.header(&handle.id).await.expect("before");
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            Arc::new(Change(Mutex::default())),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );
        let hop = mixdog_core_run::run_host::route_fallback::HopWrite {
            chain: vec![json!({ "provider": "anthropic", "model": "claude-x" })],
            primary: Some(json!({ "provider": "openai", "model": "gpt-4o" })),
            index: 1,
            failures: vec![json!({ "provider": "openai", "model": "gpt-4o", "kind": "transient", "error": "503" })],
            checkpoint_route_changed: false,
        };
        adapter.write_hop(&handle.id, obj(json!({ "provider": "anthropic", "model": "claude-x" })), &hop).await.expect("write_hop").expect("open");

        // Concurrent unrelated header updates committed between write_hop and rollback.
        let pending = json!({ "provider": "gemini", "model": "gemini-2.5-pro" });
        threads
            .patch_header(
                &handle.id,
                obj(json!({
                    "title": "User renamed thread",
                    "pendingRoute": pending,
                })),
                Vec::new(),
            )
            .await
            .expect("concurrent patch");

        adapter.restore_header(&handle.id, before.clone()).await.expect("restore_header");
        let after = threads.header(&handle.id).await.expect("after");
        assert_eq!((after["provider"].as_str(), after["model"].as_str()), (Some("openai"), Some("gpt-4o")));
        assert_eq!(after.get("wireRoute"), before.get("wireRoute"));
        assert!(!after.contains_key("routeFallbackPrimary"));
        assert!(!after.contains_key("routeFallbackFailures"));
        assert!(!after.contains_key("routeFallbackIndex"));
        assert!(!after.contains_key("routeFallbacks"));
        assert_eq!(after.get("title").and_then(Value::as_str), Some("User renamed thread"), "concurrent title update must survive rollback");
        assert_eq!(after.get("pendingRoute"), Some(&pending), "concurrent pendingRoute update must survive rollback");
    }

    #[tokio::test]
    async fn restore_header_sequential_hop_cancelled_mid_write_never_reverts_prior_hop() {
        use crate::session::tests::start_thread;
        use crate::session::thread_state::SessionThreads;

        struct GatedChange {
            gate_provider: &'static str,
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        }

        #[async_trait]
        impl RouteChange for GatedChange {
            async fn lookups(&self, _: &Header, route: &Route) -> RouteLookups {
                if route.get("provider").and_then(Value::as_str) == Some(self.gate_provider) {
                    if let Some(tx) = self.entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    let rx = self.release.lock().unwrap().take();
                    if let Some(rx) = rx {
                        let _ = rx.await;
                    }
                }
                Box::new(())
            }
            fn route_change(&self, _: &Header, _: &Route, _: &Route, _: bool, _: &RouteLookups) -> HeaderChange {
                HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() }
            }
            fn environment_reset(&self, _: &Header) -> HeaderChange {
                HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() }
            }
        }

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let threads = Arc::new(SessionThreads::new(directory.clone()));
        threads
            .patch_header(
                &handle.id,
                obj(json!({
                    "provider": "openai",
                    "model": "gpt-a",
                    "title": "Keep title",
                    "wireRoute": { "provider": "openai", "model": "gpt-a", "wire": "responses" },
                })),
                Vec::new(),
            )
            .await
            .expect("seed header A");

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let adapter = SessionRouteAdapter::new(
            directory.clone(),
            threads.clone(),
            Arc::new(GatedChange { gate_provider: "gemini", entered: Mutex::new(Some(entered_tx)), release: Mutex::new(Some(release_rx)) }),
            Arc::new(Quiet),
            Arc::new(Quiet),
            Arc::new(Quiet),
            rig.clock.clone(),
        );

        // Hop 1: A -> B succeeds and commits (discarding token 1's rollback snapshot).
        let hop_ab = mixdog_core_run::run_host::route_fallback::HopWrite {
            chain: vec![json!({ "provider": "anthropic", "model": "claude-b" }), json!({ "provider": "gemini", "model": "gem-c" })],
            primary: Some(json!({ "provider": "openai", "model": "gpt-a" })),
            index: 1,
            failures: vec![json!({ "provider": "openai", "model": "gpt-a", "kind": "transient", "error": "503" })],
            checkpoint_route_changed: false,
        };
        let header_b = adapter
            .write_hop_with_token(&handle.id, 1, obj(json!({ "provider": "anthropic", "model": "claude-b" })), &hop_ab)
            .await
            .expect("write_hop A->B")
            .expect("open");
        adapter.commit_hop(&handle.id, 1);
        assert_eq!((header_b["provider"].as_str(), header_b["model"].as_str()), (Some("anthropic"), Some("claude-b")));

        // Hop 2: B -> C starts with token 2 and is cancelled mid-write_hop while lookups is paused on the actor.
        let hop_bc = mixdog_core_run::run_host::route_fallback::HopWrite {
            chain: vec![json!({ "provider": "anthropic", "model": "claude-b" }), json!({ "provider": "gemini", "model": "gem-c" })],
            primary: Some(json!({ "provider": "openai", "model": "gpt-a" })),
            index: 2,
            failures: vec![
                json!({ "provider": "openai", "model": "gpt-a", "kind": "transient", "error": "503" }),
                json!({ "provider": "anthropic", "model": "claude-b", "kind": "transient", "error": "503" }),
            ],
            checkpoint_route_changed: false,
        };
        let cancelled = tokio::select! {
            _ = adapter.write_hop_with_token(&handle.id, 2, obj(json!({ "provider": "gemini", "model": "gem-c" })), &hop_bc) => false,
            _ = entered_rx => true,
        };
        assert!(cancelled, "B->C write_hop must be cancelled mid-flight");

        // Release the in-flight actor lookup and run token 2's rollback (simulating HopRollbackGuard::drop).
        let _ = release_tx.send(());
        adapter.restore_hop(&handle.id, 2, header_b.clone()).await.expect("restore_hop token 2");

        let after_bc = threads.header(&handle.id).await.expect("after B->C rollback");
        assert_eq!(
            (after_bc["provider"].as_str(), after_bc["model"].as_str()),
            (Some("anthropic"), Some("claude-b")),
            "cancelling B->C mid-write_hop must restore B, never revert to A"
        );
        assert_eq!(after_bc.get("routeFallbackIndex"), Some(&json!(1)));
        assert_eq!(after_bc.get("title").and_then(Value::as_str), Some("Keep title"));

        // A stray restore_hop for a token whose write_hop never reached the actor must be a strict no-op.
        let header_a = obj(json!({ "provider": "openai", "model": "gpt-a" }));
        adapter.restore_hop(&handle.id, 99, header_a).await.expect("restore_hop unexecuted token");
        let after_noop = threads.header(&handle.id).await.expect("after noop");
        assert_eq!(
            (after_noop["provider"].as_str(), after_noop["model"].as_str()),
            (Some("anthropic"), Some("claude-b")),
            "unexecuted hop token restore must never clobber live route B"
        );
    }
}

/// `applyRouteFields(session, route)`: the route's own fields onto the session.
fn route_fields(header: &Header, route: &Route) -> HeaderChange {
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
    for key in ["provider", "model"] {
        if truthy(route.get(key)) {
            set(&mut change, key, route[key].clone());
        }
    }
    if let Some(fast) = route.get("fast") {
        set(&mut change, "fast", json!(fast == &Value::Bool(true)));
    }
    if let Some(mode) = mixdog_ai::effort::EffortAuto::read_explicit(route) {
        set(&mut change, mixdog_ai::effort::EffortAuto::KEY, Value::Bool(mode.as_bool()));
        unset(&mut change, mixdog_ai::effort::EffortAuto::LEGACY_KEY);
    } else if route.contains_key(mixdog_ai::effort::EffortAuto::KEY) {
        unset(&mut change, mixdog_ai::effort::EffortAuto::KEY);
        unset(&mut change, mixdog_ai::effort::EffortAuto::LEGACY_KEY);
    } else if route.contains_key(mixdog_ai::effort::EffortAuto::LEGACY_KEY) {
        match route.get(mixdog_ai::effort::EffortAuto::LEGACY_KEY).and_then(Value::as_bool) {
            Some(enabled) => set(&mut change, mixdog_ai::effort::EffortAuto::LEGACY_KEY, Value::Bool(enabled)),
            None => unset(&mut change, mixdog_ai::effort::EffortAuto::LEGACY_KEY),
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
    if let Some(source) = route.get("routeFallbackSource") {
        if truthy(Some(source)) {
            set(&mut change, "routeFallbackSource", source.clone());
        } else {
            unset(&mut change, "routeFallbackSource");
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

impl SessionRouteAdapter {
    /// `advanceAgentRoute`'s one write: `updateSessionRoute(id, route, { crossProvider: true })`
    const HOP_OWNED_KEYS: &[&str] = &[
        "provider",
        "model",
        "fast",
        "autoEffort",
        "effortAuto",
        "effort",
        "effectiveEffort",
        "wireRoute",
        "codexWireSessionId",
        "modelParameters",
        "contextPercent",
        "contextTokens",
        "selectedContextWindow",
        "contextWindow",
        "contextUsageSnapshot",
        "routeFallbacks",
        "routeFallbackPrimary",
        "routeFallbackIndex",
        "routeFallbackFailures",
        "activeTurnCheckpoint",
        "updatedAt",
    ];

    /// followed by the hop's fields, in the one header change. The route change leaves
    /// `wireRoute` null. The updated header; `None` when the session is closed or gone.
    pub(crate) async fn write_hop(
        &self,
        thread: &ThreadId,
        route: Route,
        hop: &mixdog_core_run::run_host::route_fallback::HopWrite,
    ) -> Result<Option<Header>, PortError> {
        self.write_hop_inner(thread, None, route, hop).await
    }

    pub(crate) async fn write_hop_with_token(
        &self,
        thread: &ThreadId,
        token: u64,
        route: Route,
        hop: &mixdog_core_run::run_host::route_fallback::HopWrite,
    ) -> Result<Option<Header>, PortError> {
        self.write_hop_inner(thread, Some(token), route, hop).await
    }

    pub(crate) fn commit_hop(&self, thread: &ThreadId, token: u64) {
        self.hop_rollback_keys.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&(thread.clone(), Some(token)));
    }

    async fn write_hop_inner(
        &self,
        thread: &ThreadId,
        token: Option<u64>,
        route: Route,
        hop: &mixdog_core_run::run_host::route_fallback::HopWrite,
    ) -> Result<Option<Header>, PortError> {
        let hop = hop.clone();
        let rollback_keys = self.hop_rollback_keys.clone();
        let key = (thread.clone(), token);
        let hop_fields = move |header: &Header, change: &mut HeaderChange| {
            unset(change, "effectiveEffort");
            set(change, "routeFallbacks", Value::Array(hop.chain.clone()));
            if let Some(primary) = hop.primary.clone() {
                set(change, "routeFallbackPrimary", primary);
            }
            set(change, "routeFallbackIndex", json!(hop.index));
            set(change, "routeFallbackFailures", Value::Array(hop.failures.clone()));
            if hop.checkpoint_route_changed
                && let Some(Value::Object(checkpoint)) = header.get("activeTurnCheckpoint")
            {
                let mut checkpoint = checkpoint.clone();
                checkpoint.insert("routeChanged".into(), Value::Bool(true));
                set(change, "activeTurnCheckpoint", Value::Object(checkpoint));
            }
            let mut seen = std::collections::HashSet::<String>::new();
            let mut snapshot = Vec::new();
            for key_name in change.set.keys().map(String::as_str).chain(change.unset.iter().map(String::as_str)).chain(std::iter::once("wireRoute")) {
                if seen.insert(key_name.to_owned()) {
                    snapshot.push((key_name.to_owned(), header.get(key_name).cloned()));
                }
            }
            rollback_keys.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, snapshot);
        };
        if !self.write_route(thread, &route, true, hop_fields).await? {
            if let Some(token) = token {
                self.commit_hop(thread, token);
            }
            return Ok(None);
        }
        self.threads.header(thread).await.map(Some)
    }

    /// Atomically restores only the exact hop-owned header keys modified by [`Self::write_hop`] (or the hop-owned
    /// allowlist if called without a prior hop record), preserving concurrent unrelated updates such as `title` or
    /// `pendingRoute`.
    pub(crate) async fn restore_header(&self, thread: &ThreadId, previous: Header) -> Result<(), PortError> {
        self.restore_header_inner(thread, None, previous).await
    }

    /// Atomically restores only the exact hop-owned header keys modified by [`Self::write_hop_with_token`] for `token`.
    /// When `token` never committed on the actor (or was already committed/restored), performs a strict no-op so a
    /// cancelled hop can never consume an earlier hop's snapshot or clobber a newer route.
    pub(crate) async fn restore_hop(&self, thread: &ThreadId, token: u64, previous: Header) -> Result<(), PortError> {
        self.restore_header_inner(thread, Some(token), previous).await
    }

    async fn restore_header_inner(&self, thread: &ThreadId, token: Option<u64>, previous: Header) -> Result<(), PortError> {
        let rollback_keys = self.hop_rollback_keys.clone();
        let key = (thread.clone(), token);
        let update: super::actor::AwaitingHeaderUpdate = Box::new(move |current| {
            Box::pin(async move {
                let recorded = rollback_keys.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&key);
                if current.get("closed") == Some(&Value::Bool(true)) {
                    return HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
                }
                let mut change = HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
                if let Some(entries) = recorded {
                    for (key, old_value) in entries {
                        match old_value {
                            Some(value) => {
                                if current.get(&key) != Some(&value) {
                                    set(&mut change, &key, value);
                                }
                            }
                            None => {
                                if current.contains_key(&key) {
                                    unset(&mut change, &key);
                                }
                            }
                        }
                    }
                } else if token.is_none() {
                    for &key in Self::HOP_OWNED_KEYS {
                        match previous.get(key) {
                            Some(value) => {
                                if current.get(key) != Some(value) {
                                    set(&mut change, key, value.clone());
                                }
                            }
                            None => {
                                if current.contains_key(key) {
                                    unset(&mut change, key);
                                }
                            }
                        }
                    }
                }
                change
            })
        });
        match self.directory.update_header_awaiting(thread, update).await {
            Ok(()) | Err(mixdog_core_api::CoreError::ThreadNotFound { .. }) => Ok(()),
            Err(error) => Err(mixdog_core_ports::ports::threads::port_error(error)),
        }
    }

    /// `updateSessionRoute` as one read-modify-write on the session's actor, the header's only writer: Node reads
    /// the live session, lists the skills of its `cwd` (`_prepareResumeTools` -> `collectPromptSkillsCached`),
    /// computes and writes in one synchronous pass. Here the whole pass is one step of the actor that awaits its
    /// lookup there, so every other header write (the installation's compaction sync, a folder change) queues
    /// behind it and the lookup is always for the header it commits against: nothing is retried and nothing can
    /// fail for a moved header. The lookup reads the skill catalog, never this session's actor. `extra` adds the
    /// caller's own fields to the same change. `false` when the session is closed or gone.
    async fn write_route(
        &self,
        thread: &ThreadId,
        route: &Route,
        cross_provider: bool,
        extra: impl FnOnce(&Header, &mut HeaderChange) + Send + 'static,
    ) -> Result<bool, PortError> {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (change, clock, route) = (self.change.clone(), self.clock.clone(), route.clone());
        let written = Arc::new(AtomicBool::new(false));
        let moved = Arc::new(AtomicBool::new(false));
        let (seen, moving) = (written.clone(), moved.clone());
        let update: super::actor::AwaitingHeaderUpdate = Box::new(move |header| {
            Box::pin(async move {
                if header.get("closed") == Some(&Value::Bool(true)) {
                    return HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
                }
                let lookups = change.lookups(&header, &route).await;
                let previous: Route = ["provider", "model"].into_iter().filter_map(|key| Some((key.to_owned(), header.get(key)?.clone()))).collect();
                moving.store(route_changed(&route, &previous), Ordering::SeqCst);
                Self::route_write(&*change, &*clock, &header, &route, cross_provider, &lookups, extra, &seen)
            })
        });
        match self.directory.update_header_awaiting(thread, update).await {
            Ok(()) => {
                let written = written.load(Ordering::SeqCst);
                // `resetSessionForRouteChange`: the cached prefix is the old route's, so its warm chain ends.
                if written && moved.load(Ordering::SeqCst) {
                    self.directory.deps().side.forget(thread, super::turn_ops::SideEnd::Route);
                }
                Ok(written)
            }
            Err(mixdog_core_api::CoreError::ThreadNotFound { .. }) => Ok(false),
            Err(error) => Err(mixdog_core_ports::ports::threads::port_error(error)),
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn route_write(
        change: &dyn RouteChange,
        clock: &dyn Clock,
        header: &Header,
        route: &Route,
        cross_provider: bool,
        lookups: &RouteLookups,
        extra: impl FnOnce(&Header, &mut HeaderChange),
        seen: &std::sync::atomic::AtomicBool,
    ) -> HeaderChange {
        {
            let mut previous = Route::new();
            for key in ["provider", "model"] {
                if let Some(value) = header.get(key) {
                    previous.insert(key.to_owned(), value.clone());
                }
            }
            let mut next = route_fields(header, route);
            let routed = applied(header, &next);
            let derived = change.route_change(&routed, route, &previous, cross_provider, lookups);
            // The prompt half: a staged workspace change applies on a new route, and the
            // `# Session` block is rebuilt for the session's cwd.
            let changed = route_changed(route, &previous);
            let prompt = super::worktree::route_prompt_refresh(&super::worktree::PromptView { header: &routed, tier3: None, env: None }, changed);
            for part in [derived, prompt.change] {
                for key in part.unset {
                    unset(&mut next, &key);
                }
                for (key, value) in part.set {
                    set(&mut next, &key, value);
                }
            }
            set(&mut next, "updatedAt", json!(clock.now_ms()));
            extra(header, &mut next);
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
            next
        }
    }
}

#[cfg(test)]
mod auto_effort_tests {
    use super::*;
    use mixdog_ai::effort::EffortAuto;

    #[test]
    fn explicit_effort_auto_survives_session_header_save_and_load_and_strips_legacy() {
        let mut header: Header = json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "autoEffort": true }).as_object().cloned().unwrap();
        for (label, state) in [("auto", EffortAuto::Auto), ("manual", EffortAuto::Manual)] {
            let mut update = Route::new();
            update.insert("provider".into(), json!("openai"));
            update.insert("model".into(), json!("gpt-5"));
            update.insert("effort".into(), json!("high"));
            state.write_to(&mut update);

            let change = route_fields(&header, &update);
            header = applied(&header, &change);
            assert_eq!(EffortAuto::read_explicit(&header), Some(state), "saved header preserves {label}");
            assert!(header.get("autoEffort").is_none(), "writing effortAuto clears legacy autoEffort");

            let loaded_off = super::super::new_route::record_route(&header, false).expect("record_route");
            let loaded_on = super::super::new_route::record_route(&header, true).expect("record_route");
            assert_eq!(EffortAuto::read_explicit(&loaded_off), Some(state), "loaded record_route (switch off) preserves {label}");
            assert_eq!(EffortAuto::read_explicit(&loaded_on), Some(state), "loaded record_route (switch on) preserves {label}");
        }
    }
}
