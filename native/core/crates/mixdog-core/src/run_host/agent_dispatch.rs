//! The production agent dispatch host: Node's `makeAgentDispatch` (`agent-runtime/agent-dispatch.mjs`
//! and `agent-dispatch/{preset,session-prep,watchdog,abort-link,turn,ask-args}.mjs`) behind
//! [`mixdog_agent::subagent::dispatch`], and the inline host's `agentDispatch(payload, { signal })`
//! (`session-runtime-inline-host/agent-dispatch.mjs`) in front of it.
//!
//! One dispatch is one ephemeral hidden-role session: the preset is resolved (the call's route or
//! preset name, else the hidden role's configured route, else Main), an agent admission lease is
//! taken, the session is prepared (the hidden role's permission and tool schema), marked `running`,
//! watched by the progress watchdog (`run_host::watchdog`, policy `agent_tool::watchdog`), asked,
//! and closed `ephemeral-done` or `ephemeral-error`. The session manager and the config are the
//! [`DispatchSessions`] / [`DispatchWorld`] seams; everything the dispatch decides is here and is
//! compared with the Node conversation recorded in `fixtures/agent-dispatch`
//! (`benchmarks/rust-core/recorders/record-agent-dispatch.mjs`).
//!
//! Divergences from Node: the diagnostic lines go to [`DispatchWorld::diagnostic`] instead of
//! stderr; a dispatch with no parent signal still has a (never-aborted) cancel; the
//! `resourceAdmission.runWithLease` ambient context is the lease's yielder, handed to the ask.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::{Admission, AssistantText};
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::watchdog::{AgentKind, Overrides, resolve_policy};
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::{Clock, Yielder};
use mixdog_agent::subagent::{ChildResult, ChildRunner, DispatchRequest, dispatch, partial_handoff_text};
use mixdog_ai::service::admin_route::{normalize_context_tokens, truthy};
use mixdog_core_config::config::agent_disabled;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::run_host::cycle1_dispatch::{AgentDispatch, AgentDispatchPayload};
use crate::run_host::summary_host::trimmed;
use crate::run_host::watchdog::Watchdog;

/// `ROLE_BY_MAINT_KEY`: the settings agent whose route a hidden role runs on.
const ROLE_BY_MAINT_KEY: [(&str, &str); 2] = [("memory", "maintainer"), ("explore", "explore")];

/// `HIDDEN_ROLE_TOOL_SCHEMA_PROFILES.read`.
const READ_SCHEMA: [&str; 6] = ["code_graph", "find", "glob", "list", "grep", "read"];

/// What `prepareAgentSession(spec)` is given.
#[derive(Clone, Debug, PartialEq)]
pub struct PrepareSpec {
    pub agent: String,
    pub preset_name: String,
    pub preset: Value,
    /// `resolveRuntimeSpec(preset, { lane: 'agent', agentId })`.
    pub runtime_spec: Value,
    /// `contextSelectionFromState(..)` of a route that names a context choice, else empty.
    pub context: Map<String, Value>,
    pub permission: Option<String>,
    pub cwd: Option<String>,
    pub source_type: Option<String>,
    pub source_name: Option<String>,
    pub task_type: Option<String>,
    pub parent_session_id: Option<String>,
    pub owner_session_id: Option<String>,
    /// A hidden role's instructions ride in its scoped rules, not in a role reminder.
    pub skip_role_reminder: bool,
    /// The hidden role's tool-schema allowlist; `None` is the full schema.
    pub schema_allowed_tools: Option<Vec<String>>,
}

/// The session `prepareAgentSession` built.
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    pub id: String,
    /// The tool names the session exposes (a diagnostic line lists them).
    pub tools: Vec<String>,
}

/// One `askSession(id, prompt, null, onToolCall, cwd, undefined, askOpts)`.
#[derive(Clone)]
pub struct AskRequest {
    pub prompt: String,
    pub cwd: Option<String>,
    /// `askOpts.liveProjection`: provider streaming for live text. Never set by a dispatch that
    /// has no live-text observer.
    pub live_projection: bool,
    /// The admitted lease's slot, handed back while a provider request is in flight.
    pub slot: Arc<dyn Yielder>,
}

/// The session manager, as a dispatch uses it.
#[async_trait]
pub trait DispatchSessions: Send + Sync {
    /// `prepareAgentSession(spec)`; an error is thrown to the caller.
    async fn prepare(&self, spec: PrepareSpec) -> Result<Prepared, String>;
    /// `updateSessionStatus(id, status)`; a refused write is not an error.
    async fn set_status(&self, id: &str, status: &str);
    /// `session.messages.length`.
    async fn message_count(&self, id: &str) -> usize;
    /// The assistant rows appended from message index `start` on.
    async fn assistant_texts(&self, id: &str, start: usize) -> Vec<AssistantText>;
    /// The turn: the reply text, or the message the ask threw (a stopped turn reads
    /// `Session "<id>" closed: aborted during call: <reason>`).
    async fn ask(&self, id: &str, request: AskRequest, cancel: &Cancel) -> Result<String, String>;
    /// `getSessionProgressSnapshot(id)` at `now`.
    fn progress(&self, id: &str, now: i64) -> Option<Snapshot>;
    /// `sess.lastIterationIndex` when it is a number.
    fn last_iteration_index(&self, id: &str) -> Option<Value>;
    /// `armTurnTimeout(id)`: the watchdog is the source that stops the turn.
    fn arm_turn_timeout(&self, id: &str);
    /// `closeSession(id, reason)`.
    async fn close(&self, id: &str, reason: &str);
}

/// What a dispatch reads of the configuration and the product around it.
pub trait DispatchWorld: Send + Sync {
    /// `getConfigSnapshot({ secrets: false })`.
    fn config(&self) -> Map<String, Value>;
    /// `getHiddenAgent(name)`: the internal role's definition.
    fn hidden_agent(&self, name: &str) -> Option<Value>;
    /// `configuredAgentRouteCandidates(config, role)`.
    fn route_candidates(&self, config: &Map<String, Value>, role: &str) -> Vec<Value>;
    /// `resolveRuntimeSpec(preset, { lane: 'agent', agentId: agent })`.
    fn runtime_spec(&self, preset: &Value, agent: &str) -> Value;
    /// `contextSelectionFromState(resolveRouteContextState(preset, null), preset)`.
    fn context_selection(&self, preset: &Value) -> Map<String, Value>;
    fn env(&self, name: &str) -> Option<String>;
    fn clock(&self) -> Arc<dyn Clock>;
    /// One `[agent-dispatch] ...` diagnostic line (no trailing newline).
    fn diagnostic(&self, line: &str);
    /// `recordAgentWatchdogAbort(ctx)`: the `stall_abort` trace row and failure row of the stop (see `mixdog_trace::watchdog_abort_records`
    /// for the fields of `ctx`).
    fn record_stall_abort(&self, ctx: Map<String, Value>);
}

/// The runner behind [`dispatch`]: Node's `dispatchAdmitted`.
pub struct HiddenRoleRunner {
    admission: Arc<dyn Admission>,
    sessions: Arc<dyn DispatchSessions>,
    world: Arc<dyn DispatchWorld>,
}

impl HiddenRoleRunner {
    pub fn new(admission: Arc<dyn Admission>, sessions: Arc<dyn DispatchSessions>, world: Arc<dyn DispatchWorld>) -> Self {
        Self { admission, sessions, world }
    }

    async fn admitted(&self, request: &DispatchRequest, cancel: &Cancel, slot: Arc<dyn Yielder>) -> Result<String, String> {
        let agent = request.agent.as_str();
        let config = self.world.config();
        let hidden = self.world.hidden_agent(agent);
        let (preset, preset_name) = resolve_preset(first_set(request.preset.as_ref(), request.default_preset.as_ref()), agent, &config, self.world.as_ref())?;
        let runtime_spec = self.world.runtime_spec(&preset, agent);
        // `nonEmptyString(callCwd) || nonEmptyString(opts.cwd)`.
        let cwd = non_empty(&request.cwd).or_else(|| non_empty(&request.default_cwd));
        let context = if truthy(preset.get("contextPercent")) || truthy(preset.get("contextTokens")) {
            self.world.context_selection(&preset)
        } else {
            Map::new()
        };
        let spec = PrepareSpec {
            agent: agent.to_owned(),
            preset_name: preset_name.clone(),
            preset: preset.clone(),
            runtime_spec,
            context,
            permission: session_permission(agent, hidden.as_ref(), request.default_permission.as_deref()),
            cwd: cwd.clone(),
            source_type: non_empty(&request.source_type),
            source_name: non_empty(&request.source_name).or_else(|| non_empty(&request.default_source_name)),
            task_type: non_empty(&request.task_type),
            parent_session_id: parent_of(request),
            owner_session_id: owner_of(request),
            skip_role_reminder: hidden.is_some(),
            schema_allowed_tools: hidden.as_ref().and_then(|hidden| schema_allowed_tools(hidden, self.world.as_ref())),
        };
        let session = self.sessions.prepare(spec).await?;
        self.world.diagnostic(&format!("[agent-dispatch] agent={agent} tool-list ({}): {}", session.tools.len(), session.tools.join(",")));
        let id = session.id;
        self.sessions.set_status(&id, "running").await;

        let clock = self.world.clock();
        let policy = resolve_policy(
            AgentKind {
                name: Some(agent),
                hidden: hidden.is_some(),
                stall_cap_idle_seconds: hidden.as_ref().and_then(|hidden| hidden.pointer("/stallCap/idleSeconds")).and_then(Value::as_i64),
            },
            Overrides {
                // `Number.isFinite(call) ? call : opts.idleTimeoutMs`.
                idle_timeout_ms: [request.idle_timeout_ms, request.default_idle_timeout_ms].into_iter().flatten().find(|ms| ms.is_finite()).filter(|ms| *ms >= 0.0).map(|ms| ms.floor() as i64),
                ..Overrides::default()
            },
            &|name: &str| self.world.env(name),
        );
        let stopped = Cancel::new();
        let watchdog = Watchdog::arm(
            true,
            policy,
            stopped.clone(),
            clock.clone(),
            {
                let (sessions, id) = (self.sessions.clone(), id.clone());
                move |now| sessions.progress(&id, now)
            },
            {
                // `startDispatchWatchdog`: the stop is recorded with the clocks it judged, then the turn's own timeout is armed, then the abort.
                let (sessions, world, id, agent) = (self.sessions.clone(), self.world.clone(), id.clone(), agent.to_owned());
                let anchor_ts = clock.now_ms();
                move |snapshot: &Snapshot, message: &str, now: i64| {
                    let mut ctx = Map::new();
                    ctx.insert("sessionId".into(), json!(id));
                    ctx.insert("agent".into(), json!(agent));
                    ctx.insert("error".into(), json!({ "message": message }));
                    ctx.insert("snapshot".into(), snapshot_ctx(snapshot));
                    ctx.insert("policy".into(), json!({ "idleStaleMs": policy.idle_stale_ms }));
                    ctx.insert("now".into(), json!(now));
                    ctx.insert("anchorTs".into(), json!(anchor_ts));
                    ctx.insert("iteration".into(), sessions.last_iteration_index(&id).unwrap_or(Value::Null));
                    ctx.insert("buildVersion".into(), json!(env!("CARGO_PKG_VERSION")));
                    world.record_stall_abort(ctx);
                    sessions.arm_turn_timeout(&id);
                }
            },
        );
        // One composite survives the ask's controller swap: the caller's abort and the watchdog's
        // both reach the provider call, the first one to fire keeping its reason.
        let link = Cancel::linked(&[cancel.clone(), stopped]);
        self.world.diagnostic(&format!(
            "[agent-dispatch] agent={agent} preset={preset_name} model={} provider={} session={id}",
            js_text(preset.get("model")),
            js_text(preset.get("provider")),
        ));
        let start = self.sessions.message_count(&id).await;
        let began = clock.now_ms();
        let asked = self
            .sessions
            .ask(&id, AskRequest { prompt: request.prompt.clone(), cwd, live_projection: false, slot }, &link)
            .await;
        if asked.is_ok() {
            self.world.diagnostic(&format!("[agent-dispatch] agent={agent} session={id} elapsed={}ms", clock.now_ms() - began));
        }
        // A caller that opted into salvage gets the text this run wrote before it was stopped (read
        // before the close); such a dispatch has answered, so it settles as done.
        let settled = match asked {
            Err(message) if request.salvage_partial => {
                partial_handoff_text(&self.sessions.assistant_texts(&id, start).await).ok_or(message)
            }
            other => other,
        };
        drop(watchdog);
        // Out of 'running' before the close plants its tombstone, so a live pane never keeps busy.
        self.sessions.set_status(&id, if settled.is_ok() { "idle" } else { "error" }).await;
        self.sessions.close(&id, if settled.is_ok() { "ephemeral-done" } else { "ephemeral-error" }).await;
        settled
    }
}

#[async_trait]
impl ChildRunner for HiddenRoleRunner {
    async fn run_child(&self, request: &DispatchRequest, cancel: Cancel) -> ChildResult {
        // The lease is held for the whole dispatch and released whatever the outcome.
        let lease = match self.admission.acquire(&request.agent, owner_key(request).as_deref(), &cancel).await {
            Ok(lease) => lease,
            Err(message) => return ChildResult { outcome: Err(message) },
        };
        let outcome = self.admitted(request, &cancel, lease.yielder()).await;
        lease.release().await;
        ChildResult { outcome }
    }
}

/// The call's value when it is truthy, else the factory's (`a || b`).
fn first_set<'a>(call: Option<&'a Value>, factory: Option<&'a Value>) -> Option<&'a Value> {
    call.filter(|value| truthy(Some(value))).or(factory)
}
/// `getSessionProgressSnapshot`'s object, as `recordAgentWatchdogAbort` reads it (`awaitingUser` is present only while a person is asked).
fn snapshot_ctx(snapshot: &Snapshot) -> Value {
    let mut object = Map::new();
    object.insert("stage".into(), json!(snapshot.stage.as_deref().unwrap_or("idle")));
    object.insert("askStartedAt".into(), json!(snapshot.ask_started_at));
    object.insert("modelRequestStartedAt".into(), json!(snapshot.model_request_started_at));
    object.insert("firstActivityAt".into(), json!(snapshot.first_activity_at));
    object.insert("currentTool".into(), snapshot.current_tool.as_ref().map_or(Value::Null, |tool| json!(tool)));
    object.insert("lastProgressAt".into(), json!(snapshot.last_progress_at));
    object.insert("lastKeepaliveAt".into(), json!(snapshot.last_keepalive_at));
    object.insert("waitingForTransport".into(), json!(snapshot.waiting_for_transport));
    object.insert("waitingForFirstSemantic".into(), json!(snapshot.waiting_for_first_semantic));
    if snapshot.awaiting_user {
        object.insert("awaitingUser".into(), json!("approval"));
    }
    Value::Object(object)
}

fn non_empty(text: &Option<String>) -> Option<String> {
    text.clone().filter(|text| !text.is_empty())
}

/// `opts.parentSessionId || null`.
fn parent_of(request: &DispatchRequest) -> Option<String> {
    request.parent_session_id.clone().filter(|id| !id.is_empty())
}

/// `opts.ownerSessionId === undefined ? opts.parentSessionId || null : opts.ownerSessionId`.
fn owner_of(request: &DispatchRequest) -> Option<String> {
    match &request.owner_session_id {
        None => parent_of(request),
        Some(owner) => owner.clone(),
    }
}

/// The admission queue's owner key: the owner, else the parent.
fn owner_key(request: &DispatchRequest) -> Option<String> {
    owner_of(request).filter(|id| !id.is_empty()).or_else(|| parent_of(request))
}

/// `String(value)` as a template literal reads it.
fn js_text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), mixdog_js::value_to_string)
}

/// A JS number as a JSON number: whole values stay integers.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 { Value::from(value as i64) } else { Value::from(value) }
}

/// `normalizeMaintenanceCandidate`: a complete `{ provider, model }` route in its canonical
/// shape; anything that is not an object is returned as it is when it is truthy (a preset name).
fn normalize_candidate(candidate: &Value) -> Option<Value> {
    let Some(route) = candidate.as_object() else { return truthy(Some(candidate)).then(|| candidate.clone()) };
    let (provider, model) = (trimmed(route.get("provider")), trimmed(route.get("model")));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("provider".into(), provider.into());
    out.insert("model".into(), model.into());
    let effort = trimmed(route.get("effort"));
    if !effort.is_empty() {
        out.insert("effort".into(), effort.into());
    }
    out.insert("fast".into(), (route.get("fast") == Some(&Value::Bool(true))).into());
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), false.into());
    }
    if let Some(parameters) = route.get("modelParameters").filter(|parameters| parameters.is_object()) {
        out.insert("modelParameters".into(), parameters.clone());
    }
    let percent = mixdog_js::to_number_of(route.get("contextPercent"));
    if percent > 0.0 {
        out.insert("contextPercent".into(), number(percent));
    }
    if let Some(tokens) = normalize_context_tokens(route.get("contextTokens")) {
        out.insert("contextTokens".into(), number(tokens));
    }
    Some(Value::Object(out))
}

/// `resolveMaintenanceRoute({ preset, agent, config })`: the explicit preset, else a hidden role's
/// configured route (agent route, then Main), else nothing.
fn maintenance_route(preset: Option<&Value>, agent: &str, config: &Map<String, Value>, world: &dyn DispatchWorld) -> Option<Value> {
    if let Some(preset) = preset.filter(|preset| truthy(Some(preset))) {
        return Some(preset.clone());
    }
    if agent.is_empty() {
        return None;
    }
    let hidden = world.hidden_agent(agent)?;
    let key = ["maintKey", "slot"].into_iter().find_map(|field| hidden.get(field).and_then(Value::as_str).filter(|key| !key.is_empty())).unwrap_or_default();
    let Some((_, role)) = ROLE_BY_MAINT_KEY.iter().find(|(maint, _)| *maint == key) else {
        return config.get("maintenance").and_then(|maintenance| maintenance.get(key)).filter(|route| !route.is_null()).cloned();
    };
    // A disabled agent must not silently fall back to Main: off means the role does not run.
    if agent_disabled(config, role) {
        return None;
    }
    world.route_candidates(config, role).into_iter().chain(config.get("default").cloned()).find_map(|candidate| normalize_candidate(&candidate))
}

/// `maintenanceRouteToPreset`: a route that carries a provider and a model, as a session preset.
fn route_to_preset(route: &Value, agent: &str) -> Option<Value> {
    let route = route.as_object()?;
    let (provider, model) = (trimmed(route.get("provider")), trimmed(route.get("model")));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), format!("maint-{agent}").into());
    out.insert("name".into(), format!("MAINT {}", agent.to_uppercase()).into());
    out.insert("type".into(), "agent".into());
    out.insert("provider".into(), provider.into());
    out.insert("model".into(), model.into());
    if let Some(fallbacks) = route.get("fallbacks").filter(|fallbacks| fallbacks.as_array().is_some_and(|list| !list.is_empty())) {
        out.insert("fallbacks".into(), fallbacks.clone());
    }
    out.insert("tools".into(), "full".into());
    let effort = trimmed(route.get("effort"));
    if !effort.is_empty() {
        out.insert("effort".into(), effort.into());
    }
    if route.get("fast") == Some(&Value::Bool(true)) {
        out.insert("fast".into(), true.into());
    }
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), false.into());
    }
    if let Some(parameters) = route.get("modelParameters").filter(|parameters| parameters.is_object()) {
        out.insert("modelParameters".into(), parameters.clone());
    }
    let percent = mixdog_js::to_number_of(route.get("contextPercent"));
    if percent > 0.0 {
        out.insert("contextPercent".into(), number(percent));
    }
    if let Some(tokens) = normalize_context_tokens(route.get("contextTokens")) {
        out.insert("contextTokens".into(), number(tokens));
    }
    Some(Value::Object(out))
}

/// `resolveDispatchPreset`: the preset object and its stable label.
fn resolve_preset(explicit: Option<&Value>, agent: &str, config: &Map<String, Value>, world: &dyn DispatchWorld) -> Result<(Value, String), String> {
    let route = maintenance_route(explicit, agent, config, world)
        .ok_or_else(|| format!("[agent-dispatch] maintenance route unresolved for agent \"{agent}\" (preset=\"\")"))?;
    let preset = match route_to_preset(&route, agent) {
        Some(preset) => preset,
        None => {
            let name = mixdog_js::js_trim(&mixdog_js::value_to_string(&route)).to_owned();
            config
                .get("presets")
                .and_then(Value::as_array)
                .and_then(|presets| presets.iter().find(|p| [p.get("id"), p.get("name")].into_iter().any(|field| field.and_then(Value::as_str) == Some(name.as_str()))))
                .cloned()
                .ok_or_else(|| format!("[agent-dispatch] maintenance route for agent \"{agent}\" is neither a {{provider,model}} route nor a known preset name (\"{name}\")"))?
        }
    };
    let label = [preset.get("id"), preset.get("name")]
        .into_iter()
        .find(|field| truthy(*field))
        .map_or_else(|| format!("maint-{agent}"), |field| mixdog_js::value_to_string(field.unwrap_or(&Value::Null)));
    Ok((preset, label))
}

/// `resolveAgentSessionPermission(agent, opts.permission ?? (isPoolC ? hidden.permission || 'read' : null))`
/// (`session-prep.mjs:75-78`): a hidden role asks for its declared permission, `read` when it
/// declares none, and a role declared read-only is locked to it; a public agent asks for none.
fn session_permission(agent: &str, hidden: Option<&Value>, option: Option<&str>) -> Option<String> {
    let asked = option.or_else(|| hidden.map(|hidden| hidden.get("permission").and_then(Value::as_str).filter(|permission| !permission.is_empty()).unwrap_or("read")));
    super::agent_spawn_world::resolve_agent_session_permission(agent, asked)
}

/// `resolveHiddenRoleSchemaAllowedTools`: an explicit allowlist, else the role's tool-schema profile.
fn schema_allowed_tools(hidden: &Value, world: &dyn DispatchWorld) -> Option<Vec<String>> {
    if let Some(list) = hidden.get("schemaAllowedTools").and_then(Value::as_array) {
        return Some(list.iter().map(|name| trimmed(Some(name))).filter(|name| !name.is_empty()).collect());
    }
    let profile = Some(trimmed(hidden.get("toolSchemaProfile"))).filter(|profile| !profile.is_empty()).unwrap_or_else(|| "full".to_owned());
    match profile.as_str() {
        "full" => None,
        "none" => Some(Vec::new()),
        "read" => Some(READ_SCHEMA.iter().map(|name| (*name).to_owned()).collect()),
        other => {
            let named = hidden.get("agent").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("unknown");
            world.diagnostic(&format!("[agent-dispatch] unknown hidden-agent toolSchemaProfile=\"{other}\" agent=\"{named}\"; using full schema"));
            None
        }
    }
}

/// Everything the inline host reads of the product around a dispatch.
#[async_trait]
pub trait HostWorld: Send + Sync {
    /// `assertOpen(signal)`: the host is open, and the signal (when given) has not aborted — an
    /// aborted one throws its own reason.
    fn assert_open(&self, cancel: Option<&Cancel>) -> Result<(), String>;
    /// `prepareAgentProviders(signal)`: the providers the dispatch will reach are registered.
    async fn prepare_providers(&self, cancel: &Cancel) -> Result<(), String>;
}

/// What the first payload of an agent fixed for it (`payload.options` of the cached dispatcher).
#[derive(Clone)]
struct Options {
    task_type: &'static str,
    source_type: &'static str,
    brief: bool,
    permission: Option<String>,
}

/// What a registered run holds until it leaves the table (see [`RunWatch::started`]).
pub type RunHold = Box<dyn Send + Sync>;

/// The runs of the dispatch as the daemon counts them: Node's broker calls `onActivityChanged` as a dispatch enters and leaves its
/// in-flight table (`agent-dispatch-broker.mjs:120-131`), and the daemon reads `snapshot().inFlight` as busy memory agents and
/// rechecks its self-shutdown on each change (`daemon.mjs:449`, `:1064`).
pub trait RunWatch: Send + Sync {
    /// A run entered the table; the hold is dropped when it left (after the table no longer lists it).
    fn started(&self) -> RunHold;
}

/// `createInlineAgentDispatch`: the run table in front of the dispatcher.
pub struct InlineAgentDispatch {
    runner: Arc<dyn ChildRunner>,
    world: Arc<dyn HostWorld>,
    watch: Arc<dyn RunWatch>,
    runs: Mutex<HashMap<String, Cancel>>,
    /// `agentDispatchers`: a dispatcher is made once per agent, with the first payload's options.
    dispatchers: Mutex<HashMap<String, Options>>,
}

/// Takes a run out of the table when the dispatch ends, however it ends.
struct Registered<'a> {
    host: &'a InlineAgentDispatch,
    id: String,
    /// Dropped after `drop` has taken the run out of the table.
    _hold: RunHold,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.host.runs.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.id);
    }
}

impl InlineAgentDispatch {
    pub fn new(runner: Arc<dyn ChildRunner>, world: Arc<dyn HostWorld>, watch: Arc<dyn RunWatch>) -> Self {
        Self { runner, world, watch, runs: Mutex::default(), dispatchers: Mutex::default() }
    }

    /// `agentDispatch(payload, { signal })`.
    pub async fn run(&self, payload: AgentDispatchPayload, parent: &Cancel) -> Result<String, String> {
        self.world.assert_open(None)?;
        if payload.dispatch_id.is_empty() {
            return Err("agent dispatch id is required".to_owned());
        }
        let controller = Cancel::linked(std::slice::from_ref(parent));
        let _registered = {
            let mut runs = self.runs.lock().unwrap_or_else(PoisonError::into_inner);
            if runs.contains_key(&payload.dispatch_id) {
                return Err(format!("agent dispatch {} is already running", payload.dispatch_id));
            }
            runs.insert(payload.dispatch_id.clone(), controller.clone());
            Registered { host: self, id: payload.dispatch_id.clone(), _hold: self.watch.started() }
        };
        self.world.assert_open(Some(&controller))?;
        self.world.prepare_providers(&controller).await?;
        self.world.assert_open(Some(&controller))?;
        let options = self
            .dispatchers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(payload.agent.to_owned())
            .or_insert(Options { task_type: payload.task_type, source_type: payload.source_type, brief: payload.brief, permission: payload.permission })
            .clone();
        let request = DispatchRequest {
            agent: payload.agent.to_owned(),
            prompt: payload.prompt,
            brief: options.brief,
            preset: payload.preset.filter(|preset| truthy(Some(preset))),
            cwd: payload.cwd.filter(|cwd| !cwd.is_empty()),
            idle_timeout_ms: payload.idle_timeout_ms.filter(|ms| ms.is_finite() && *ms > 0.0).map(f64::floor),
            task_type: Some(options.task_type.to_owned()),
            source_type: Some(options.source_type.to_owned()),
            default_permission: options.permission,
            ..DispatchRequest::default()
        };
        dispatch(self.runner.as_ref(), &request, &controller).await.map_err(|error| error.to_string())
    }

    /// `abortAll(reason)`: every running dispatch is aborted with the reason.
    pub fn abort_all(&self, reason: &str) {
        let runs = std::mem::take(&mut *self.runs.lock().unwrap_or_else(PoisonError::into_inner));
        for controller in runs.values() {
            controller.abort(reason);
        }
    }
}

#[async_trait]
impl AgentDispatch for InlineAgentDispatch {
    async fn agent_dispatch(&self, payload: AgentDispatchPayload, cancel: &CancellationToken) -> Result<String, String> {
        self.run(payload, &Cancel::from_token(cancel)).await
    }
}

#[cfg(test)]
mod tests;
