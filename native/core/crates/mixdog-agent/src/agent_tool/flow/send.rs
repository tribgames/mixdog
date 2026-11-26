//! A `send` to an existing worker (Node `send-flow.mjs`): resolve the live session, follow the
//! route its agent is configured on, queue the prompt behind a running turn or start a
//! background send job that runs one follow-up turn. The worker row follows the turn itself
//! ([`super::worker_turns`]).
//!
//! The stopped-by-watchdog branch of `runSend` is in [`super::turn`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::resolve_route_context_state;
use mixdog_ai::service::admin_route::truthy;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::QueuedView;
use serde_json::Map;
use serde_json::Value;

use super::job_starter::JobStarter;
use super::job_starter::StartContext;
use super::preset::agent_preset_name;
use super::preset::preset_key;
use super::preset::resolve_agent_spawn_preset;
use super::reconcile::JobHandle;
use super::result::WorkerResult;
use super::seams::TurnKind;
use super::turn::TurnPlan;
use super::turn::TurnRunner;
use super::worker_turns::TurnOwner;
use super::world::SendWorld;
use super::world::SpawnContext;
use crate::agent_tool::board::JobMeta;
use crate::agent_tool::dispatch::wants_session_scan;
use crate::agent_tool::host::DispatchOptions;
use crate::agent_tool::host::Environment;
use crate::agent_tool::host::Prepared;
use crate::agent_tool::host::Registry;
use crate::agent_tool::host::ResolveOptions;
use crate::agent_tool::host::SendFlow;
use crate::agent_tool::host::Sessions;
use crate::agent_tool::resume::resolve_prompt;
use crate::agent_tool::scope::Caller;
use crate::agent_tool::scope::Owner;
use crate::agent_tool::scope::Scope;
use crate::agent_tool::scope::SessionFacts;
use crate::agent_tool::scope::clean;
use crate::agent_tool::scope::clean_str;
use crate::agent_tool::scope::normalize_agent_name;
use crate::agent_tool::views::JobViews;

/// `AGENT_ROUTE_KEYS` (`agent-profile-changes.mjs`).
const AGENT_ROUTE_KEYS: [&str; 8] = ["provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];

fn text(session: &Value, key: &str) -> Option<String> {
    session.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn id_of(session: &Value) -> String {
    session.get("id").and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The first non-empty of `a || b`, cleaned.
fn either(session: &Value, a: &str, b: &str) -> String {
    let pick = if truthy(session.get(a)) { session.get(a) } else { session.get(b) };
    clean(pick)
}

fn facts_of(session: &Value) -> SessionFacts {
    SessionFacts {
        id: id_of(session),
        agent: text(session, "agent").unwrap_or_default(),
        cwd: text(session, "cwd").unwrap_or_default(),
        owner: Owner {
            parent_session_id: text(session, "parentSessionId").unwrap_or_default(),
            owner_session_id: text(session, "ownerSessionId").unwrap_or_default(),
            client_host_pid: session.get("clientHostPid").and_then(Value::as_u64),
        },
    }
}

fn normalized_params(source: &Value) -> Option<&Map<String, Value>> {
    source.get("modelParameters").and_then(Value::as_object).filter(|o| !o.is_empty())
}

fn provider_model_window_meta(config: &Obj, raw_provider: &str, canonical_provider: &str, model: &str) -> Option<Value> {
    let providers = config.get("providers").and_then(Value::as_object)?;
    let entry = providers.get(raw_provider).or_else(|| providers.get(canonical_provider))?;
    let models = entry.get("models").and_then(Value::as_array)?;
    models
        .iter()
        .find(|row| {
            let id = clean(row.get("id"));
            (id == model || id.eq_ignore_ascii_case(model)) && (row.get("contextWindow").is_some() || row.get("maxContextWindow").is_some())
        })
        .cloned()
}

fn effective_target_window(target: &Value, config: &Obj) -> Option<f64> {
    if let Some(window) = mixdog_ai::service::admin_route::normalize_context_tokens(target.get("selectedContextWindow")) {
        return Some(window);
    }
    let obj = target.as_object()?;
    if (target.get("contextWindow").is_some() || target.get("maxContextWindow").is_some())
        && let Some(window) = resolve_route_context_state(obj, Some(target)).selected_context_window
    {
        return Some(window);
    }
    let raw_provider = clean(target.get("provider"));
    let canonical = mixdog_ai::service::routes::canonical_route_provider(&raw_provider);
    let model = clean(target.get("model"));
    if !canonical.is_empty()
        && !model.is_empty()
        && let Some(meta) = provider_model_window_meta(config, &raw_provider, &canonical, &model)
    {
        return resolve_route_context_state(obj, Some(&meta)).selected_context_window;
    }
    None
}

fn route_field_matches(key: &str, preset: &Value, target: &Value, config: &Obj) -> bool {
    match key {
        "provider" => {
            mixdog_ai::service::routes::canonical_route_provider(&clean(preset.get("provider")))
                == mixdog_ai::service::routes::canonical_route_provider(&clean(target.get("provider")))
        }
        "model" | "effort" => clean(preset.get(key)) == clean(target.get(key)),
        "fast" => (preset.get("fast") == Some(&Value::Bool(true))) == (target.get("fast") == Some(&Value::Bool(true))),
        "autoEffort" => (preset.get("autoEffort") != Some(&Value::Bool(false))) == (target.get("autoEffort") != Some(&Value::Bool(false))),
        "modelParameters" => normalized_params(preset) == normalized_params(target),
        "contextPercent" => {
            mixdog_ai::service::admin_route::clean_context_percent(preset.get("contextPercent"))
                == mixdog_ai::service::admin_route::clean_context_percent(target.get("contextPercent"))
        }
        "contextTokens" => {
            let want = mixdog_ai::service::admin_route::normalize_context_tokens(preset.get("contextTokens"));
            let have = mixdog_ai::service::admin_route::normalize_context_tokens(target.get("contextTokens"));
            if want == have {
                return true;
            }
            if let Some(tokens) = want
                && have.is_none()
            {
                return effective_target_window(target, config) == Some(tokens);
            }
            false
        }
        _ => preset.get(key) == target.get(key),
    }
}

fn route_matches(keys: &[&str], preset: &Value, target: &Value, config: &Obj) -> bool {
    keys.iter().all(|key| route_field_matches(key, preset, target, config))
}

fn fallback_source_changed(session: &Value, preset: &Value) -> bool {
    let Some(current) = session.get("routeFallbackSource").filter(|s| truthy(Some(s))) else {
        return false;
    };
    Some(current) != preset.get("fallbackSource").filter(|s| truthy(Some(s)))
}

fn fallbacks_changed(session: &Value, preset: &Value, config: &Obj) -> bool {
    let current = session.get("routeFallbacks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let wanted = preset.get("fallbacks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if current.len() != wanted.len() {
        return true;
    }
    current.iter().zip(wanted.iter()).any(|(a, b)| !route_matches(&AGENT_ROUTE_KEYS, b, a, config))
}

fn active_fallback_permitted(session: &Value, preset: &Value, config: &Obj) -> bool {
    let wanted = preset.get("fallbacks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    wanted.iter().any(|entry| {
        let keys: Vec<&str> = AGENT_ROUTE_KEYS
            .into_iter()
            .filter(|key| {
                matches!(*key, "provider" | "model" | "effort" | "fast" | "autoEffort" | "modelParameters" | "contextTokens")
                    || !matches!(entry.get(*key), None | Some(Value::Null))
            })
            .collect();
        route_matches(&keys, entry, session, config)
    })
}

/// When a worker has hopped off its primary onto an active fallback route, returns the configured
/// primary assignment it hopped from (`(primary, full_fields)`). `full_fields` is true when
/// `routeFallbackPrimary` carries the full route leaf and false when falling back to a failure entry.
fn active_fallback_primary(session: &Value) -> Option<(&Value, bool)> {
    let hopped = session.get("routeFallbackIndex").and_then(Value::as_f64).is_some_and(|i| i > 0.0)
        || session.get("routeFallbackFailures").and_then(Value::as_array).is_some_and(|f| !f.is_empty());
    if !hopped {
        return None;
    }
    if let Some(primary) = session.get("routeFallbackPrimary").filter(|p| truthy(p.get("provider")) && truthy(p.get("model"))) {
        return Some((primary, true));
    }
    session
        .get("routeFallbackFailures")
        .and_then(Value::as_array)
        .and_then(|f| f.first())
        .filter(|p| truthy(p.get("provider")) && truthy(p.get("model")))
        .map(|p| (p, false))
}

fn route_to_set(keys: &[&str], preset: &Value, clear_context_tokens: bool) -> Value {
    let mut route = Map::new();
    for key in keys {
        match *key {
            "fast" => {
                route.insert("fast".into(), Value::Bool(preset.get("fast") == Some(&Value::Bool(true))));
            }
            "autoEffort" => {
                if preset.get("autoEffort") == Some(&Value::Bool(false)) {
                    route.insert("autoEffort".into(), Value::Bool(false));
                }
            }
            other => {
                route.insert(other.into(), preset[other].clone());
            }
        }
    }
    if clear_context_tokens && !route.contains_key("contextTokens") {
        route.insert("contextTokens".into(), Value::Null);
    }
    route.insert("routeFallbacks".into(), Value::Array(preset.get("fallbacks").and_then(Value::as_array).cloned().unwrap_or_default()));
    if let Some(source) = preset.get("fallbackSource").filter(|s| truthy(Some(s))) {
        route.insert("routeFallbackSource".into(), source.clone());
    }
    Value::Object(route)
}

fn send_job_meta(session: &Value, id: &str, tag: Option<String>, resumed: bool) -> JobMeta {
    JobMeta {
        tag: tag.filter(|t| !t.is_empty()),
        session_id: Some(id.to_owned()),
        agent: text(session, "agent"),
        provider: text(session, "provider"),
        model: text(session, "model"),
        preset: text(session, "presetName"),
        effort: text(session, "effort"),
        fast: Some(session.get("fast") == Some(&Value::Bool(true))),
        respawned: false,
        resumed,
        auto_effort_off: session.get("autoEffort") == Some(&Value::Bool(false)),
    }
}

fn send_start_context(notify: &SpawnContext) -> StartContext {
    StartContext {
        caller_session_id: Some(notify.caller_id()).filter(|c| !c.is_empty()),
        owner_session_id: Some(notify.owner_id()).filter(|c| !c.is_empty()),
        client_host_pid: notify.client_host_pid,
        hop: (notify.hop > 0).then(|| serde_json::json!(notify.hop)),
        tool_call_id: notify.tool_call_id.clone(),
    }
}

pub struct SendFlowDeps {
    pub world: Arc<dyn SendWorld>,
    pub registry: Arc<dyn Registry>,
    pub env: Arc<dyn Environment>,
    pub views: Arc<JobViews>,
    pub starter: Arc<JobStarter>,
    pub runner: Arc<TurnRunner>,
    pub turns: Arc<dyn TurnOwner>,
    pub default_cwd: String,
}

pub struct SendFlowImpl {
    world: Arc<dyn SendWorld>,
    registry: Arc<dyn Registry>,
    env: Arc<dyn Environment>,
    views: Arc<JobViews>,
    starter: Arc<JobStarter>,
    runner: Arc<TurnRunner>,
    turns: Arc<dyn TurnOwner>,
    default_cwd: String,
    /// Lists a closed agent's session again when a completion wakes it (`revealSession`).
    sessions: Option<Arc<dyn Sessions>>,
}

impl SendFlowImpl {
    pub fn new(deps: SendFlowDeps) -> Self {
        Self {
            world: deps.world,
            registry: deps.registry,
            env: deps.env,
            views: deps.views,
            starter: deps.starter,
            runner: deps.runner,
            turns: deps.turns,
            default_cwd: deps.default_cwd,
            sessions: None,
        }
    }

    /// The sessions a wake reveals (a closed agent's session is hidden from the lists; used again it is listed again).
    pub fn with_sessions(mut self, sessions: Arc<dyn Sessions>) -> Self {
        self.sessions = Some(sessions);
        self
    }

    /// The session a prepared send runs on, as the manager holds it now.
    async fn session_of(&self, prepared: &Prepared) -> Value {
        self.world.session(&prepared.session_id).await.unwrap_or_else(|| {
            let mut session = Map::new();
            session.insert("id".into(), prepared.session.id.clone().into());
            session.insert("agent".into(), prepared.session.agent.clone().into());
            session.insert("cwd".into(), prepared.session.cwd.clone().into());
            Value::Object(session)
        })
    }

    /// `prepareSend`.
    pub async fn prepare_send(&self, args: &Value, scope: &Scope) -> Result<Prepared, String> {
        let scan = wants_session_scan(args);
        self.registry.refresh_tags_from_sessions(scan, scope).await?;
        let target = either(args, "tag", "sessionId");
        if target.is_empty() {
            return Err("agent send: tag or sessionId is required".into());
        }
        let session_id = self
            .registry
            .resolve_tag(&target, scope, ResolveOptions { scan_sessions: scan, exclude_terminal_traces: false, skip_released: false })
            .await?
            .ok_or_else(|| format!("agent send: target \"{target}\" not found"))?;
        let session = self.world.session(&session_id).await.filter(|s| s.get("closed") != Some(&Value::Bool(true)));
        let Some(session) = session else {
            return Err(format!("agent send: session \"{session_id}\" is closed"));
        };
        let cwd = text(&session, "cwd").unwrap_or_else(|| self.default_cwd.clone());
        let prompt = resolve_prompt(args, &cwd, &*self.env).await?;
        Ok(Prepared { args: args.clone(), session: facts_of(&session), session_id, prompt: Some(prompt), route: None })
    }

    /// The calling session hands this worker new work: from now on the worker acts as that caller
    /// does. Not for a completion wake, which is the worker's own continuation.
    pub async fn adopt_caller(&self, prepared: &Prepared, notify: &SpawnContext) -> Result<(), String> {
        let caller = notify.caller_session_id.as_deref().filter(|c| !c.is_empty());
        self.world.rebind_delegation(&prepared.session_id, caller).await
    }

    /// An explicit model on a reused tag goes through the session's own route API, which saves it
    /// and applies it from the session's next turn.
    async fn apply_requested_route(&self, session: Value, route: &Value) -> Result<Value, String> {
        let id = id_of(&session);
        if !self.world.surface_runs(&session).await || !self.world.can_set_route() {
            return Err(format!("agent spawn: this surface cannot change the model of reused session \"{id}\""));
        }
        self.world.set_route(&session, route).await?;
        Ok(self.world.session(&id).await.unwrap_or(session))
    }

    /// `agentRouteToFollow`: a worker that runs on its agent's configured route follows that
    /// route, as a bot's home chat does: a model picked for the agent since the spawn applies
    /// from this send. A worker started on an explicit model or preset keeps it.
    async fn agent_route_to_follow(&self, session: &Value) -> Result<Option<Value>, String> {
        let agent = normalize_agent_name(&clean(session.get("agent")));
        if agent.is_empty() {
            return Ok(None);
        }
        let Some(config) = self.world.load_config().await? else { return Ok(None) };
        let candidates = self.world.route_candidates(&config, &agent).await?;
        let Ok(current) = resolve_agent_spawn_preset(&config, &serde_json::json!({ "agent": agent }), &candidates) else {
            return Ok(None);
        };
        let spawned_on = either(session, "presetName", "preset");
        let preset = &current.preset;
        let own = [format!("agent-{agent}"), agent_preset_name(&agent), preset_key(Some(preset))];
        let named = current.preset_name.as_str().is_some_and(|n| n == spawned_on);
        if spawned_on.is_empty() || !(own.contains(&spawned_on) || named) {
            return Ok(None);
        }
        if !truthy(preset.get("provider")) || !truthy(preset.get("model")) {
            return Ok(None);
        }
        let set: Vec<&str> = AGENT_ROUTE_KEYS
            .into_iter()
            .filter(|key| *key == "fast" || *key == "autoEffort" || !matches!(preset.get(*key), None | Some(Value::Null)))
            .collect();
        let mut compare_keys = set.clone();
        if !compare_keys.contains(&"contextTokens") {
            compare_keys.push("contextTokens");
        }
        let id = id_of(session);
        let source_changed = fallback_source_changed(session, preset);
        if route_matches(&compare_keys, preset, session, &config) && !source_changed && !fallbacks_changed(session, preset, &config) {
            // Saved back to the running route: an earlier hold is obsolete.
            if truthy(session.get("heldRoute")) {
                self.world.hold_session_route(&id, None);
            }
            return Ok(None);
        }
        // Keep an active fallback route only when the agent's configured assignment has not changed
        // and the active fallback is still permitted by the current fallback chain.
        let chain_compatible =
            active_fallback_permitted(session, preset, &config) && (truthy(session.get("routeFallbackSource")) || !fallbacks_changed(session, preset, &config));
        let active_primary = active_fallback_primary(session);
        if !source_changed
            && chain_compatible
            && let Some((primary, full_fields)) = active_primary
        {
            let same_assignment = if full_fields {
                route_matches(&compare_keys, preset, primary, &config)
            } else {
                route_field_matches("provider", preset, primary, &config) && route_field_matches("model", preset, primary, &config)
            };
            if same_assignment {
                if truthy(session.get("heldRoute")) {
                    self.world.hold_session_route(&id, None);
                }
                return Ok(None);
            }
        }
        if let Some(held) = session.get("heldRoute").filter(|h| truthy(Some(h))) {
            let mut merged = session.as_object().cloned().unwrap_or_default();
            merged.extend(held.as_object().cloned().unwrap_or_default());
            let merged = Value::Object(merged);
            if route_matches(&compare_keys, preset, &merged, &config)
                && !fallback_source_changed(&merged, preset)
                && !fallbacks_changed(&merged, preset, &config)
            {
                return Ok(None);
            }
        }
        let clear_context_tokens = mixdog_ai::service::admin_route::normalize_context_tokens(preset.get("contextTokens")).is_none()
            && (mixdog_ai::service::admin_route::normalize_context_tokens(session.get("contextTokens")).is_some()
                || active_primary
                    .is_some_and(|(primary, _)| mixdog_ai::service::admin_route::normalize_context_tokens(primary.get("contextTokens")).is_some()));
        Ok(Some(route_to_set(&set, preset, clear_context_tokens)))
    }

    async fn settle_route(&self, prepared: &Prepared, mut session: Value) -> Result<Value, String> {
        let id = &prepared.session_id;
        let mut followed = if prepared.route.is_some() { None } else { self.agent_route_to_follow(&session).await? };
        if let Some(route) = followed.as_ref()
            && !self.world.surface_runs(&session).await
        {
            if !self.world.is_busy(id).await {
                let cross = route.get("provider") != session.get("provider") || route.get("model") != session.get("model");
                self.world.update_session_route(id, route, &session, cross);
            } else {
                self.world.hold_session_route(id, Some(route));
            }
            followed = None;
        }
        if let Some(route) = prepared.route.clone().or(followed) {
            session = self.apply_requested_route(session, &route).await?;
        }
        Ok(session)
    }

    /// `dispatchToExistingSession`: a busy session queues the prompt; an idle one runs a
    /// background send job that continues the existing session (context kept).
    pub async fn dispatch_to_existing_session(
        self: &Arc<Self>,
        prepared: &Prepared,
        notify: &SpawnContext,
        options: DispatchOptions,
    ) -> Result<AgentReply, String> {
        let session = self.settle_route(prepared, self.session_of(prepared).await).await?;
        let id = prepared.session_id.clone();
        let prompt = prepared.prompt.clone().unwrap_or_default();
        let tag = self.registry.tag_for_session(&id).await;
        let busy = self.world.is_busy(&id).await;
        // Queued work runs as the worker's own later turn (or steers into the running one): the
        // owner follows it from that turn's start.
        if busy {
            self.turns.observe(&id);
        }
        let attachments = prepared.args.get("attachmentParts").and_then(Value::as_array).cloned().unwrap_or_default();
        let context = prepared.args.get("context").filter(|c| truthy(Some(c)));
        let queued_view = |queue_depth: Option<u64>| {
            AgentReply::Queued(QueuedView {
                reused: options.reused,
                resumed: options.resumed,
                tag: tag.clone().filter(|t| !t.is_empty()),
                session_id: Some(id.clone()),
                agent: text(&session, "agent"),
                queue_depth,
            })
        };
        let runs = self.world.surface_runs(&session).await;
        if runs
            && busy
            && let Some(queued) = self.world.enqueue_turn(&session, &prompt, &attachments, context).await?
        {
            return Ok(queued_view(queued.get("queueDepth").and_then(Value::as_u64)));
        }
        if !runs && busy {
            // The queued follow-up keeps the forwarded files, as the canonical queue does.
            if let Some(depth) = self.world.enqueue_pending(&id, &prompt, &attachments) {
                return Ok(queued_view(Some(depth)));
            }
        }
        let job = self.start_send_job(prepared, &session, tag, notify, options.resumed, TurnKind::Send, None)?;
        let mut card = self.views.card(job.task_id(), &Scope::default(), false).await.ok_or_else(|| "agent job did not start".to_owned())?;
        card.view.reused = options.reused;
        card.view.resumed = options.resumed || card.view.resumed;
        Ok(AgentReply::Task { view: card.view, diagnostics: false })
    }

    /// The background send job that runs one turn of `kind` on the worker `prepared` names; `held` lives as long as the job's
    /// work, or until the job ends without it.
    #[allow(clippy::too_many_arguments, reason = "One job start, its pieces as both dispatches have them")]
    fn start_send_job(
        self: &Arc<Self>,
        prepared: &Prepared,
        session: &Value,
        tag: Option<String>,
        notify: &SpawnContext,
        resumed: bool,
        kind: TurnKind,
        held: Option<Box<dyn Send>>,
    ) -> Result<Arc<JobHandle>, String> {
        let meta = send_job_meta(session, &prepared.session_id, tag, resumed);
        let (flow, prepared) = (self.clone(), prepared.clone());
        self.starter.start_job("send", meta, send_start_context(notify), move |job, owner_context| async move {
            let _held = held;
            let plan = TurnPlan { kind, ..flow.turn_plan(&prepared).await };
            let value: WorkerResult = flow.runner.run(plan, Some(owner_context), Some(job)).await?;
            Ok(Some(value))
        })
    }

    /// What `runSend` runs: a follow-up turn on the existing worker.
    pub async fn turn_plan(&self, prepared: &Prepared) -> TurnPlan {
        let session = self.session_of(prepared).await;
        let id = prepared.session_id.clone();
        let send_agent = text(&session, "agent").unwrap_or_else(|| normalize_agent_name(&clean(prepared.args.get("agent"))));
        let tag = self.registry.tag_for_session(&id).await.unwrap_or_default();
        let mut identity = Map::new();
        identity.insert("tag".into(), tag.clone().into());
        identity.insert("sessionId".into(), id.clone().into());
        identity.insert("agent".into(), if truthy(session.get("agent")) { session["agent"].clone() } else { Value::Null });
        identity.insert("provider".into(), session.get("provider").cloned().unwrap_or(Value::Null));
        identity.insert("model".into(), session.get("model").cloned().unwrap_or(Value::Null));
        TurnPlan {
            kind: super::seams::TurnKind::Send,
            session_id: id,
            parent_session_id: text(&session, "parentSessionId"),
            session_owner_id: text(&session, "ownerSessionId"),
            tag,
            agent: send_agent,
            identity,
            prompt: prepared.prompt.clone().unwrap_or_default(),
            attachments: prepared.args.get("attachmentParts").and_then(Value::as_array).cloned().unwrap_or_default(),
            context: prepared.args.get("context").filter(|c| truthy(Some(c))).cloned(),
            cwd: text(&session, "cwd").unwrap_or_else(|| self.default_cwd.clone()),
            skill_selection: None,
            canonical: self.world.canonical_surface(),
        }
    }

    /// The worker's session found a background completion queued while the worker was idle and
    /// handed its wake here: the wake is a send job of the worker's owner, whose turn
    /// ([`TurnKind::Wake`]) takes the queued completions as its input (never an empty user turn),
    /// so its answer reaches the owner and the board like any send. A busy worker is never woken:
    /// its running turn takes the completion at its next tool boundary. `handoff` is the session's
    /// hand-off of the wake, held while the wake's job lasts: let go before the wake's turn started
    /// (the job could not start or start its turn), the session hands its next wake on.
    pub async fn wake_worker(self: &Arc<Self>, session_id: &str, handoff: Box<dyn Send>) -> Result<(), String> {
        let id = clean_str(session_id);
        let session =
            self.world.session(&id).await.filter(|s| s.get("closed") != Some(&Value::Bool(true))).ok_or_else(|| format!("agent session \"{id}\" is closed"))?;
        // `dispatchToExistingSession` reveals the session first (`send-flow.mjs:236`): a closed agent woken is listed again.
        if let Some(sessions) = &self.sessions {
            sessions.reveal_session(&id).await;
        }
        let owner = either(&session, "ownerSessionId", "parentSessionId");
        let notify = SpawnContext {
            caller_session_id: Some(owner.clone()).filter(|o| !o.is_empty()),
            session_id: None,
            owner_session_id: Some(owner).filter(|o| !o.is_empty()),
            client_host_pid: session.get("clientHostPid").and_then(Value::as_u64),
            ..SpawnContext::default()
        };
        let prepared = Prepared { args: Value::Object(Map::new()), session: facts_of(&session), session_id: id, prompt: Some(String::new()), route: None };
        let session = self.settle_route(&prepared, session).await?;
        let tag = self.registry.tag_for_session(&prepared.session_id).await;
        self.start_send_job(&prepared, &session, tag, &notify, false, TurnKind::Wake, Some(handoff)).map(drop)
    }
}

#[async_trait]
impl SendFlow for Arc<SendFlowImpl> {
    async fn prepare_send(&self, args: &Value, scope: &Scope) -> Result<Prepared, String> {
        SendFlowImpl::prepare_send(self, args, scope).await
    }

    async fn adopt_caller(&self, prepared: &Prepared, notify: &Caller) -> Result<(), String> {
        SendFlowImpl::adopt_caller(self, prepared, &notify.into()).await
    }

    async fn dispatch_to_existing_session(&self, prepared: &Prepared, notify: &Caller, options: DispatchOptions) -> Result<AgentReply, String> {
        SendFlowImpl::dispatch_to_existing_session(self, prepared, &notify.into(), options).await
    }
}
