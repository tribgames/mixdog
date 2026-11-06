//! The session side of a route change: Node's `followSession`, `applySessionTuning`,
//! `applyPendingRoute` / `clearPendingRoute` (`model-route/set-route.mjs`,
//! `model-route/route-persist.mjs`) and the chat fan-out of a bot's saved route
//! (`standalone/session-service/agent-route-follow.mjs`).
//!
//! Adopting a route (resolving it, saving the model settings, refreshing the effort) is the
//! route service's; it runs first and leaves the adopted route on [`LiveRoute`]. What this
//! port decides is what that route does to the thread: nothing, a tune, a switch in place, a
//! recreated empty session, or a pick held for the next turn.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_agent::compact::fresh::SUMMARY_PREFIX;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

use super::memory_source::ThreadMessages;
use super::threads::ThreadState;

/// A route as the runtime holds it (Node's route object): `provider`, `model`, `fast`,
/// `effort`, `effectiveEffort`, `autoEffort`, `modelParameters`, context fields.
pub type Route = Map<String, Value>;

/// `AGENT_ROUTE_KEYS` of `agent-profile-changes.mjs`.
pub const AGENT_ROUTE_KEYS: [&str; 8] =
    ["provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];

/// `TUNED_PARAMETERS`: `serviceTier` and the OpenRouter sort parameter.
const TUNED_PARAMETERS: [&str; 2] = ["serviceTier", "providerSort"];

/// The options of `setRoute` the session side reads.
#[derive(Clone, Default, Debug)]
pub struct FollowOptions {
    pub defer_until_next_turn: bool,
    pub switch_established: bool,
    pub apply_to_current_session: bool,
    /// The session generation the selection was enqueued under (`originGeneration`, else the
    /// generation when it was opened). Only an addressed selection holds a lease on it.
    pub lease: Option<u64>,
}

impl FollowOptions {
    fn switch_established(&self) -> bool {
        self.apply_to_current_session || self.switch_established
    }

    fn addressed(&self) -> bool {
        self.switch_established() || self.defer_until_next_turn
    }
}

/// What a follow produced: the recorded model-switch boundary, when the conversation was
/// switched in place (`{ ...getRoute(), modelSwitch }`).
#[derive(Clone, PartialEq, Default, Debug)]
pub struct Followed {
    pub model_switch: Option<Value>,
}

/// The runtime's live route per thread (`getRoute` / `setRouteState`).
pub trait LiveRoute: Send + Sync {
    fn route(&self, thread: &ThreadId) -> Route;
    /// Makes a route held by an earlier process the live one again
    /// (`setRouteState(resolveRoute(config, held))`).
    fn adopt_held(&self, thread: &ThreadId, held: &Route);
}

/// What the session and the runtime around it do for a route change (the session side is
/// `session::SessionRouteAdapter`).
///
/// Every thread is an addressed session (each client reaches the core through the daemon, by
/// thread id), so an empty session is always updated in place: Node closes and recreates one
/// only in an unaddressed runtime (`set-route.mjs:433-448`), which the core never hosts.
#[async_trait]
pub trait RouteSession: Send + Sync {
    /// The session generation (Node: advances whenever another conversation, or none, is
    /// installed); an addressed thread keeps one for its lifetime.
    fn generation(&self, thread: &ThreadId) -> u64;
    /// `session.liveTurnMessages`: the first turn's working messages before they are committed.
    async fn live_turn_messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError>;
    /// `hasUserConversationMessage`: a user message that is not a protected context turn, a
    /// reference-files message or a summary anchor.
    fn has_user_conversation(&self, messages: &[Value]) -> bool;
    /// `updateSessionRoute`: applies the fields, resets the session for a changed route (and
    /// strips provider replay and context readings on `cross_provider`), rebuilds the prompt's
    /// `Model:` line and saves. `false` when the session is closed or gone.
    async fn update_route(&self, thread: &ThreadId, fields: Route, cross_provider: bool) -> Result<bool, PortError>;
    /// Records a display-only boundary on the switch anchor message (see
    /// [`record_transcript_boundary`]); `false` when there is no message to mark.
    async fn record_boundary(&self, thread: &ThreadId, field: &str, boundary: Value) -> Result<bool, PortError>;
    /// `rebuildToolSurfaceForProviderWithMigration`.
    async fn rebuild_tool_surface(&self, thread: &ThreadId, provider: &str) -> Result<(), PortError>;
    /// The fallback chain of a Lead-class session on `provider/model` (`ownerRouteFallbacks`);
    /// `None` for a session with no owner agent (an agent's session keeps its own).
    fn owner_fallbacks(&self, thread: &ThreadId, header: &Header, provider: &str, model: &str) -> Option<Vec<Value>>;
    /// `writeStatuslineRoute`.
    fn write_statusline(&self, thread: &ThreadId, route: &Route);
    /// `invalidateContextStatusCache`.
    fn invalidate_context_status(&self, thread: &ThreadId);
}

/// The truthiness of a JS value.
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

pub(crate) fn is_summary_anchor(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
        && message.get("content").and_then(Value::as_str).is_some_and(|c| c.starts_with(SUMMARY_PREFIX))
}

/// `heldRoutePick`: the route fields a model pick held for the next turn keeps on its session.
pub fn held_route_pick(route: &Route) -> Route {
    let mut pick = Route::new();
    let mut put = |key: &str, value: Value| {
        pick.insert(key.to_owned(), value);
    };
    put("provider", route.get("provider").cloned().unwrap_or(Value::Null));
    put("model", route.get("model").cloned().unwrap_or(Value::Null));
    if truthy(route.get("preset")) {
        put("preset", route["preset"].clone());
    }
    if let Some(effort) = route.get("effort") {
        put("effort", effort.clone());
    }
    put("fast", Value::Bool(route.get("fast") == Some(&Value::Bool(true))));
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        put("autoEffort", Value::Bool(false));
    }
    if truthy(route.get("modelParameters")) {
        put("modelParameters", route["modelParameters"].clone());
    }
    if let Some(percent) = route.get("contextPercent") {
        put("contextPercent", percent.clone());
    }
    for key in ["contextTokens", "selectedContextWindow"] {
        if truthy(route.get(key)) {
            put(key, route[key].clone());
        }
    }
    pick
}

/// `modelSwitchAnchorIndex`: the last message before a trailing unanswered prompt, which a
/// retry may rewind; else the last non-system message.
pub fn model_switch_anchor_index(messages: &[Value]) -> Option<usize> {
    let role = |m: &Value| m.get("role").and_then(Value::as_str).map(str::to_owned);
    let mut index = messages.len() as isize - 1;
    while index >= 0 && matches!(role(&messages[index as usize]).as_deref(), Some("user" | "system")) {
        index -= 1;
    }
    if index >= 0 {
        return Some(index as usize);
    }
    messages.iter().rposition(|m| role(m).as_deref() != Some("system"))
}

/// `recordTranscriptBoundary`: appends `boundary` to `meta[field]` of the switch anchor
/// message unless `same` finds it recorded; the anchor is replaced, not edited in place (the
/// session log diffs messages by identity). `false` when there is no anchor.
pub fn record_transcript_boundary(
    messages: &mut [Value],
    field: &str,
    boundary: Value,
    same: impl Fn(&Value) -> bool,
) -> bool {
    let Some(index) = model_switch_anchor_index(messages) else { return false };
    let anchor = &messages[index];
    let mut switches: Vec<Value> = anchor.pointer(&format!("/meta/{field}")).and_then(Value::as_array).cloned().unwrap_or_default();
    if switches.iter().any(same) {
        return true;
    }
    switches.push(boundary);
    let mut next = anchor.clone();
    let meta = next.as_object_mut().expect("a message is an object").entry("meta").or_insert_with(|| Value::Object(Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(Map::new());
    }
    meta.as_object_mut().expect("meta is an object").insert(field.to_owned(), Value::Array(switches));
    messages[index] = next;
    true
}

pub struct SessionRoutes {
    threads: Arc<dyn ThreadState>,
    messages: Arc<dyn ThreadMessages>,
    session: Arc<dyn RouteSession>,
    live: Arc<dyn LiveRoute>,
    /// A deferred pick and the generation it was made under (`pending`).
    pending: Mutex<HashMap<String, Option<u64>>>,
}

/// The thread's live route as the session holds it.
#[derive(Clone, PartialEq, Debug)]
pub struct ThreadRouteView {
    pub provider: String,
    pub model: String,
    pub fast: bool,
    pub effort: Option<String>,
    pub auto_effort: bool,
}

impl SessionRoutes {
    pub fn new(
        threads: Arc<dyn ThreadState>,
        messages: Arc<dyn ThreadMessages>,
        session: Arc<dyn RouteSession>,
        live: Arc<dyn LiveRoute>,
    ) -> Self {
        Self { threads, messages, session, live, pending: Mutex::new(HashMap::new()) }
    }

    /// The generation a selection addressed to this thread is opened under: its origin when
    /// the surface named one, else now.
    pub fn open_lease(&self, thread: &ThreadId, origin: Option<u64>) -> u64 {
        origin.unwrap_or_else(|| self.session.generation(thread))
    }

    /// The route the thread's session runs.
    pub async fn read(&self, thread: &ThreadId) -> Result<ThreadRouteView, PortError> {
        let header = self.threads.header(thread).await?;
        Ok(ThreadRouteView {
            provider: text(&header, "provider").to_owned(),
            model: text(&header, "model").to_owned(),
            fast: header.get("fast") == Some(&Value::Bool(true)),
            effort: header.get("effort").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_owned),
            auto_effort: header.get("autoEffort") != Some(&Value::Bool(false)),
        })
    }

    /// `hasRouteHistoryMessage`.
    fn has_route_history(&self, messages: &[Value]) -> bool {
        self.session.has_user_conversation(messages) || messages.iter().any(is_summary_anchor)
    }

    /// `sessionRouteCommitted`: a model reply, a compaction summary or a first turn in flight.
    async fn route_committed(&self, thread: &ThreadId) -> Result<bool, PortError> {
        let live = self.session.live_turn_messages(thread).await?;
        if self.has_route_history(&live) {
            return Ok(true);
        }
        let messages = self.messages.messages(thread).await?;
        Ok(messages.iter().any(|m| m.get("role").and_then(Value::as_str) == Some("assistant") || is_summary_anchor(m)))
    }

    fn fallback_fields(&self, thread: &ThreadId, header: &Header, route: &Route) -> Route {
        let mut fields = Route::new();
        if let Some(chain) = self.session.owner_fallbacks(thread, header, text(route, "provider"), text(route, "model")) {
            fields.insert("routeFallbacks".into(), Value::Array(chain));
        }
        fields
    }

    /// `updateSessionInPlace`: the addressed session takes the route it was asked to run on.
    async fn update_in_place(&self, thread: &ThreadId, header: &Header, cross_provider: bool) -> Result<(), PortError> {
        let route = self.live.route(thread);
        let mut fields = Route::new();
        fields.insert("provider".into(), route.get("provider").cloned().unwrap_or(Value::Null));
        fields.insert("model".into(), route.get("model").cloned().unwrap_or(Value::Null));
        fields.insert("fast".into(), Value::Bool(route.get("fast") == Some(&Value::Bool(true))));
        fields.insert("autoEffort".into(), Value::Bool(route.get("autoEffort") != Some(&Value::Bool(false))));
        let or_null = |key: &str| if truthy(route.get(key)) { route[key].clone() } else { Value::Null };
        fields.insert("effort".into(), or_null("effectiveEffort"));
        fields.insert(
            "modelParameters".into(),
            if truthy(route.get("modelParameters")) { route["modelParameters"].clone() } else { Value::Object(Map::new()) },
        );
        if let Some(percent) = route.get("contextPercent") {
            fields.insert("contextPercent".into(), percent.clone());
        }
        fields.insert("contextTokens".into(), or_null("contextTokens"));
        fields.insert("selectedContextWindow".into(), or_null("selectedContextWindow"));
        fields.extend(self.fallback_fields(thread, header, &route));
        if !self.session.update_route(thread, fields.clone(), cross_provider).await? {
            self.threads.patch_header(thread, fields, Vec::new()).await?;
        }
        self.session.rebuild_tool_surface(thread, text(&route, "provider")).await?;
        self.session.write_statusline(thread, &route);
        Ok(())
    }

    /// `switchSessionInPlace`: the recorded boundary, or `None` when the session has nothing
    /// to mark (or the model is unchanged).
    async fn switch_in_place(&self, thread: &ThreadId, header: &Header) -> Result<Option<Value>, PortError> {
        let route = self.live.route(thread);
        if text(&route, "provider") == text(header, "provider") && text(&route, "model") == text(header, "model") {
            self.update_in_place(thread, header, false).await?;
            return Ok(None);
        }
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let boundary = serde_json::json!({ "provider": route.get("provider"), "modelId": route.get("model"), "at": at });
        let recorded = self.session.record_boundary(thread, "modelSwitches", boundary.clone()).await?;
        self.update_in_place(thread, header, true).await?;
        Ok(recorded.then_some(boundary))
    }

    /// `continueSessionInModel`'s session half: the adopted route switches the conversation in
    /// place whatever it holds, then drops the stale context gauge and any held pick. The
    /// recorded boundary, or `None` when nothing switched.
    pub async fn switch_now(&self, thread: &ThreadId) -> Result<Option<Value>, PortError> {
        let header = self.threads.header(thread).await?;
        let model_switch = self.switch_in_place(thread, &header).await?;
        self.session.invalidate_context_status(thread);
        self.clear_pending(thread).await?;
        Ok(model_switch)
    }

    /// `refreshSessionFallbacks`: a same-model selection restarts the chain when the owner's no
    /// longer matches the session's.
    async fn refresh_fallbacks(&self, thread: &ThreadId, header: &Header) -> Result<(), PortError> {
        let fields = self.fallback_fields(thread, header, &self.live.route(thread));
        let Some(chain) = fields.get("routeFallbacks") else { return Ok(()) };
        let held = header.get("routeFallbacks").filter(|v| truthy(Some(*v))).cloned().unwrap_or(Value::Array(Vec::new()));
        if mixdog_js::json_stringify(chain) == mixdog_js::json_stringify(&held) {
            return Ok(());
        }
        self.session.update_route(thread, fields, false).await.map(|_| ())
    }

    /// `applySessionTuning`: effort / Fast / parameters of the live route onto the session, when
    /// the session runs that route (a selection for the heir must not leak into its source).
    pub async fn tune(&self, thread: &ThreadId) -> Result<(), PortError> {
        let header = self.threads.header(thread).await?;
        let route = self.live.route(thread);
        if text(&header, "provider") != text(&route, "provider") || text(&header, "model") != text(&route, "model") {
            return Ok(());
        }
        let mut set = Map::new();
        let mut unset = Vec::new();
        set.insert("fast".into(), Value::Bool(route.get("fast") == Some(&Value::Bool(true))));
        // Absent means on; only the off state is stored on the session.
        if route.get("autoEffort") == Some(&Value::Bool(false)) {
            set.insert("autoEffort".into(), Value::Bool(false));
        } else {
            unset.push("autoEffort".to_owned());
        }
        set.insert("effort".into(), if truthy(route.get("effectiveEffort")) { route["effectiveEffort"].clone() } else { Value::Null });
        let mut parameters = header.get("modelParameters").and_then(Value::as_object).cloned().unwrap_or_default();
        for key in TUNED_PARAMETERS {
            parameters.shift_remove(key);
            if let Some(value) = route.get("modelParameters").and_then(|p| p.get(key)).filter(|v| truthy(Some(*v))) {
                parameters.insert(key.to_owned(), value.clone());
            }
        }
        set.insert("modelParameters".into(), Value::Object(parameters));
        self.threads.patch_header(thread, set, unset).await?;
        self.session.write_statusline(thread, &route);
        self.session.invalidate_context_status(thread);
        Ok(())
    }

    fn pending_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<u64>>> {
        self.pending.lock().expect("pending picks lock")
    }

    /// What the adopted route does to the thread it was selected for (`followSession`).
    pub async fn follow(&self, thread: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        // A selection addressed to a conversation belongs to the generation it was enqueued
        // under; once that moved, every session effect is skipped and the current route stands.
        let token = options.addressed().then_some(options.lease).flatten();
        if options.addressed() && token.is_some_and(|t| t != self.session.generation(thread)) {
            return Ok(Followed::default());
        }
        let header = self.threads.header(thread).await?;
        let route = self.live.route(thread);
        let key = thread.as_str().to_owned();
        if options.defer_until_next_turn {
            self.pending_lock().insert(key, token);
            // Held on the session too, so a restart before the next turn still applies it.
            let mut set = Map::new();
            set.insert("pendingRoute".into(), Value::Object(held_route_pick(&route)));
            self.threads.patch_header(thread, set, Vec::new()).await?;
            return Ok(Followed::default());
        }
        self.pending_lock().remove(&key);
        if header.contains_key("pendingRoute") {
            self.threads.patch_header(thread, Map::new(), vec!["pendingRoute".into()]).await?;
        }
        let same_model = text(&route, "provider") == text(&header, "provider") && text(&route, "model") == text(&header, "model");
        if self.route_committed(thread).await? {
            if !options.switch_established() {
                return Ok(Followed::default());
            }
            // Another model switches the conversation itself; a same-model update (effort,
            // Fast) only tunes the session from its next turn.
            if !same_model {
                let model_switch = self.switch_in_place(thread, &header).await?;
                self.session.invalidate_context_status(thread);
                return Ok(Followed { model_switch });
            }
            self.tune(thread).await?;
            self.refresh_fallbacks(thread, &header).await?;
            return Ok(Followed::default());
        }
        // An addressed runtime keeps its durable id: the empty session is updated in place,
        // never closed and replaced by a freshly minted one (`set-route.mjs:433-448`).
        self.update_in_place(thread, &header, false).await?;
        self.session.invalidate_context_status(thread);
        Ok(Followed::default())
    }

    /// `setRoute.applyPendingRoute`: the model pick held for the next turn takes effect. The
    /// recorded boundary, or `None` when nothing switched.
    pub async fn apply_pending(&self, thread: &ThreadId) -> Result<Option<Value>, PortError> {
        let mut header = self.threads.header(thread).await?;
        let held = header.get("pendingRoute").and_then(Value::as_object).cloned();
        if held.is_some() {
            self.threads.patch_header(thread, Map::new(), vec!["pendingRoute".into()]).await?;
            header.shift_remove("pendingRoute");
        }
        let selection = self.pending_lock().remove(thread.as_str());
        match (selection, &held) {
            (Some(token), _) => {
                // The live route is the latest selection: effort/Fast tuned after the deferred
                // model choice replace it.
                if token != Some(self.session.generation(thread)) {
                    return Ok(None);
                }
            }
            (None, Some(held)) if truthy(held.get("provider")) && truthy(held.get("model")) => {
                // Held by an earlier process: the saved pick becomes the live route again.
                self.live.adopt_held(thread, held);
            }
            _ => return Ok(None),
        }
        let model_switch = self.switch_in_place(thread, &header).await?;
        self.session.invalidate_context_status(thread);
        Ok(model_switch)
    }

    /// `setRoute.clearPendingRoute`.
    pub async fn clear_pending(&self, thread: &ThreadId) -> Result<(), PortError> {
        self.pending_lock().remove(thread.as_str());
        let header = self.threads.header(thread).await?;
        if header.contains_key("pendingRoute") {
            self.threads.patch_header(thread, Map::new(), vec!["pendingRoute".into()]).await?;
        }
        Ok(())
    }
}

/// The chats a bot has in this process.
pub trait AgentChats: Send + Sync {
    /// The bot's home thread and its hosted room-member sessions; `None` when it has no home.
    fn chats_of(&self, agent_id: &str) -> Option<Vec<ThreadId>>;
}

/// A chat's own route selection (its runtime's `setRoute`, then the projection step).
#[async_trait]
pub trait ChatRouteSetter: Send + Sync {
    async fn set_route(&self, thread: &ThreadId, pick: Route, options: FollowOptions) -> Result<(), PortError>;
}

/// `createAgentRouteFollow`: a bot's saved route reaches the chats it already has, from their
/// next turn; each chat takes its updates one at a time, in publication order.
pub struct AgentRouteFollow {
    chats: Arc<dyn AgentChats>,
    setter: Arc<dyn ChatRouteSetter>,
    #[allow(clippy::disallowed_types, reason = "held across a chat's set_route on purpose: the chat takes the next update once the one before settled")]
    tails: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AgentRouteFollow {
    pub fn new(chats: Arc<dyn AgentChats>, setter: Arc<dyn ChatRouteSetter>) -> Self {
        Self { chats, setter, tails: Mutex::new(HashMap::new()) }
    }

    /// `sessionRoutePick`.
    fn pick_of(route: &Route) -> Route {
        let mut pick = Route::new();
        pick.insert("sessionOnly".into(), Value::Bool(true));
        for key in AGENT_ROUTE_KEYS {
            if let Some(value) = route.get(key).filter(|v| !v.is_null()) {
                pick.insert(key.to_owned(), value.clone());
            }
        }
        pick
    }

    /// Rejects once every chat settled when any refused the route.
    pub async fn follow(&self, agent_id: &str, route: &Route) -> Result<(), PortError> {
        let Some(chats) = self.chats.chats_of(agent_id) else { return Ok(()) };
        if !truthy(route.get("provider")) || !truthy(route.get("model")) {
            return Ok(());
        }
        let pick = Self::pick_of(route);
        let options = FollowOptions { defer_until_next_turn: true, switch_established: true, ..FollowOptions::default() };
        let queued = chats.iter().map(|thread| {
            let turn = self
                .tails
                .lock()
                .expect("tails lock")
                .entry(thread.as_str().to_owned())
                .or_default()
                .clone();
            let (pick, options) = (pick.clone(), options.clone());
            async move {
                let _turn = turn.lock().await;
                self.setter.set_route(thread, pick, options).await
            }
        });
        let failures = futures_lite_join(queued).await.into_iter().filter(Result::is_err).count();
        if failures > 0 {
            return Err(PortError::Failed {
                capability: "agent route".into(),
                message: format!("{failures} chat(s) of {agent_id} did not take the route"),
            });
        }
        Ok(())
    }
}

/// Polls the futures in order, so each chat's turn is queued in publication order.
async fn futures_lite_join<F: std::future::Future>(futures: impl Iterator<Item = F>) -> Vec<F::Output> {
    let mut futures: Vec<std::pin::Pin<Box<F>>> = futures.map(Box::pin).collect();
    let mut done: Vec<Option<F::Output>> = futures.iter().map(|_| None).collect();
    std::future::poll_fn(move |cx| {
        let mut pending = false;
        for (future, slot) in futures.iter_mut().zip(done.iter_mut()) {
            if slot.is_none() {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(value) => *slot = Some(value),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(done.iter_mut().map(|slot| slot.take().expect("every future finished")).collect())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[derive(Default)]
    struct Calls(Mutex<Vec<String>>);
    impl Calls {
        fn log(&self, entry: impl Into<String>) {
            self.0.lock().unwrap().push(entry.into());
        }
        fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    struct Threads {
        header: Mutex<Header>,
        calls: Arc<Calls>,
    }
    #[async_trait]
    impl ThreadState for Threads {
        async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
            Ok(self.header.lock().unwrap().clone())
        }
        async fn patch_header(&self, _: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
            let mut header = self.header.lock().unwrap();
            self.calls.log(format!("patch {} -{}", Value::Object(set.clone()), unset.join(",")));
            header.extend(set);
            for key in unset {
                header.shift_remove(&key);
            }
            Ok(())
        }
        async fn publish(&self, _: &ThreadId, _: crate::session::Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    struct Messages(Vec<Value>);
    #[async_trait]
    impl ThreadMessages for Messages {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(self.0.clone())
        }
    }

    struct Live(Route);
    impl LiveRoute for Live {
        fn route(&self, _: &ThreadId) -> Route {
            self.0.clone()
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    struct Session {
        calls: Arc<Calls>,
        generation: u64,
    }
    #[async_trait]
    impl RouteSession for Session {
        fn generation(&self, _: &ThreadId) -> u64 {
            self.generation
        }
        async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
        fn has_user_conversation(&self, messages: &[Value]) -> bool {
            messages.iter().any(|m| m["role"] == "user")
        }
        async fn update_route(&self, _: &ThreadId, fields: Route, cross: bool) -> Result<bool, PortError> {
            self.calls.log(format!("update {} cross={cross}", fields["model"]));
            Ok(true)
        }
        async fn record_boundary(&self, _: &ThreadId, field: &str, _: Value) -> Result<bool, PortError> {
            self.calls.log(format!("boundary {field}"));
            Ok(true)
        }
        async fn rebuild_tool_surface(&self, _: &ThreadId, provider: &str) -> Result<(), PortError> {
            self.calls.log(format!("surface {provider}"));
            Ok(())
        }
        fn owner_fallbacks(&self, _: &ThreadId, _: &Header, _: &str, _: &str) -> Option<Vec<Value>> {
            None
        }
        fn write_statusline(&self, _: &ThreadId, _: &Route) {
            self.calls.log("statusline");
        }
        fn invalidate_context_status(&self, _: &ThreadId) {}
    }

    fn routes(header: Value, messages: Vec<Value>, live: Value) -> (SessionRoutes, Arc<Calls>) {
        let calls = Arc::new(Calls::default());
        let threads = Threads { header: Mutex::new(obj(header)), calls: calls.clone() };
        let session = Session { calls: calls.clone(), generation: 3 };
        let routes = SessionRoutes::new(Arc::new(threads), Arc::new(Messages(messages)), Arc::new(session), Arc::new(Live(obj(live))));
        (routes, calls)
    }

    fn thread() -> ThreadId {
        ThreadId::from("t1")
    }

    fn established() -> Vec<Value> {
        vec![json!({"role": "user", "content": "hi"}), json!({"role": "assistant", "content": "yo"})]
    }

    #[tokio::test]
    async fn an_established_session_keeps_its_route_unless_addressed() {
        let (routes, calls) = routes(json!({"provider": "openai", "model": "gpt-a"}), established(), json!({"provider": "anthropic", "model": "claude-x"}));
        let followed = routes.follow(&thread(), &FollowOptions::default()).await.unwrap();
        assert_eq!((followed, calls.all()), (Followed::default(), Vec::<String>::new()));
    }

    #[tokio::test]
    async fn an_addressed_pick_of_another_model_switches_in_place_and_records_the_boundary() {
        let (routes, calls) = routes(json!({"provider": "openai", "model": "gpt-a"}), established(), json!({"provider": "anthropic", "model": "claude-x"}));
        let options = FollowOptions { switch_established: true, ..FollowOptions::default() };
        let followed = routes.follow(&thread(), &options).await.unwrap();
        let boundary = followed.model_switch.expect("a boundary");
        assert_eq!((boundary["provider"].clone(), boundary["modelId"].clone()), (json!("anthropic"), json!("claude-x")));
        assert_eq!(calls.all(), ["boundary modelSwitches", "update \"claude-x\" cross=true", "surface anthropic", "statusline"]);
    }

    #[tokio::test]
    async fn a_same_model_pick_only_tunes_the_session() {
        let (routes, calls) = routes(
            json!({"provider": "openai", "model": "gpt-a", "autoEffort": false, "modelParameters": {"serviceTier": "fast", "keep": "1"}}),
            established(),
            json!({"provider": "openai", "model": "gpt-a", "fast": true, "effectiveEffort": "low", "modelParameters": {}}),
        );
        let options = FollowOptions { switch_established: true, ..FollowOptions::default() };
        routes.follow(&thread(), &options).await.unwrap();
        let header = routes.threads.header(&thread()).await.unwrap();
        assert_eq!((header["fast"].clone(), header["effort"].clone(), header["modelParameters"].clone()), (json!(true), json!("low"), json!({"keep": "1"})));
        assert!(!header.contains_key("autoEffort"));
        assert!(calls.all().contains(&"statusline".to_owned()));
    }

    /// An addressed session is never recreated: an empty one takes the route in place.
    #[tokio::test]
    async fn an_empty_session_takes_the_route_in_place() {
        let live = json!({"provider": "anthropic", "model": "claude-x"});
        let header = json!({"provider": "openai", "model": "gpt-a"});
        let (routes, calls) = routes(header, Vec::new(), live);
        routes.follow(&thread(), &FollowOptions::default()).await.unwrap();
        assert_eq!(calls.all(), ["update \"claude-x\" cross=false", "surface anthropic", "statusline"]);
    }

    #[tokio::test]
    async fn a_stale_lease_skips_every_effect() {
        let (routes, calls) = routes(json!({"provider": "openai", "model": "gpt-a"}), established(), json!({"provider": "anthropic", "model": "claude-x"}));
        let options = FollowOptions { switch_established: true, lease: Some(2), ..FollowOptions::default() };
        assert_eq!(routes.follow(&thread(), &options).await.unwrap(), Followed::default());
        assert!(calls.all().is_empty());
    }

    #[tokio::test]
    async fn a_deferred_pick_is_held_then_applied_at_the_next_turn() {
        let live = json!({"provider": "anthropic", "model": "claude-x", "fast": false, "preset": "p", "contextTokens": 0});
        let (routes, calls) = routes(json!({"provider": "openai", "model": "gpt-a"}), established(), live);
        let options = FollowOptions { switch_established: true, defer_until_next_turn: true, lease: Some(3), ..FollowOptions::default() };
        routes.follow(&thread(), &options).await.unwrap();
        let held = routes.threads.header(&thread()).await.unwrap()["pendingRoute"].clone();
        assert_eq!(held, json!({"provider": "anthropic", "model": "claude-x", "preset": "p", "fast": false}));
        assert!(calls.all().iter().all(|c| !c.starts_with("update")), "a held pick changes nothing yet");
        let switched = routes.apply_pending(&thread()).await.unwrap().expect("a boundary");
        assert_eq!(switched["modelId"], "claude-x");
        assert!(!routes.threads.header(&thread()).await.unwrap().contains_key("pendingRoute"));
        assert_eq!(routes.apply_pending(&thread()).await.unwrap(), None);
    }

    #[test]
    fn the_boundary_goes_on_the_last_message_before_a_trailing_prompt() {
        let mut messages = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "a"}),
            json!({"role": "assistant", "content": "b"}),
            json!({"role": "user", "content": "c"}),
        ];
        assert_eq!(model_switch_anchor_index(&messages), Some(2));
        let boundary = json!({"modelId": "m", "at": 1});
        let same = |e: &Value| e["at"] == 1 && e["modelId"] == "m";
        assert!(record_transcript_boundary(&mut messages, "modelSwitches", boundary.clone(), same));
        assert!(record_transcript_boundary(&mut messages, "modelSwitches", boundary.clone(), same));
        assert_eq!(messages[2]["meta"]["modelSwitches"], json!([boundary]));
        // Nothing but prompts: the last non-system message (`findLastIndex`), not none.
        assert_eq!(model_switch_anchor_index(&[json!({"role": "user"}), json!({"role": "system"})]), Some(0));
        assert_eq!(model_switch_anchor_index(&[json!({"role": "system"})]), None);
    }

    struct Chats;
    impl AgentChats for Chats {
        fn chats_of(&self, agent: &str) -> Option<Vec<ThreadId>> {
            (agent == "bot").then(|| vec![ThreadId::from("home"), ThreadId::from("room")])
        }
    }
    struct Setter(Arc<Calls>);
    #[async_trait]
    impl ChatRouteSetter for Setter {
        async fn set_route(&self, thread: &ThreadId, pick: Route, options: FollowOptions) -> Result<(), PortError> {
            let mut keys: Vec<&str> = pick.keys().map(String::as_str).collect();
            keys.sort_unstable();
            self.0.log(format!("{} {} {} defer={}", thread.as_str(), keys.join(","), pick["model"], options.defer_until_next_turn));
            if thread.as_str() == "room" {
                return Err(PortError::Cancelled);
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_bots_route_reaches_every_chat_and_a_refusal_is_reported_after_all_settled() {
        let calls = Arc::new(Calls::default());
        let follow = AgentRouteFollow::new(Arc::new(Chats), Arc::new(Setter(calls.clone())));
        let route = obj(json!({"provider": "openai", "model": "gpt-6", "effort": null, "fast": true, "other": 1}));
        let error = follow.follow("bot", &route).await.unwrap_err();
        assert_eq!(error, PortError::Failed { capability: "agent route".into(), message: "1 chat(s) of bot did not take the route".into() });
        let pick = "fast,model,provider,sessionOnly \"gpt-6\"";
        assert_eq!(calls.all(), [format!("home {pick} defer=true"), format!("room {pick} defer=true")]);
        assert!(follow.follow("nobody", &route).await.is_ok());
        assert!(follow.follow("bot", &obj(json!({"provider": "openai"}))).await.is_ok());
    }
}
