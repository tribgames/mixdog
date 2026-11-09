//! A `send` to an existing worker (Node `send-flow.mjs`): resolve the live session, follow the
//! route its agent is configured on, queue the prompt behind a running turn or start a
//! background send job that runs one follow-up turn. The worker row follows the turn itself
//! ([`super::worker_turns`]).
//!
//! The stopped-by-watchdog branch of `runSend` is in [`super::turn`].

use std::sync::Arc;

use async_trait::async_trait;
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
use super::result::WorkerResult;
use super::turn::TurnPlan;
use super::turn::TurnRunner;
use super::world::SendWorld;
use super::world::SpawnContext;
use super::worker_turns::TurnOwner;
use crate::agent_tool::board::JobMeta;
use crate::agent_tool::dispatch::wants_session_scan;
use crate::agent_tool::host::DispatchOptions;
use crate::agent_tool::host::Environment;
use crate::agent_tool::host::Prepared;
use crate::agent_tool::host::Registry;
use crate::agent_tool::host::ResolveOptions;
use crate::agent_tool::host::SendFlow;
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
        }
    }

    /// The session a prepared send runs on, as the manager holds it now.
    fn session_of(&self, prepared: &Prepared) -> Value {
        self.world.session(&prepared.session_id).unwrap_or_else(|| {
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
        self.registry.refresh_tags_from_sessions(scan, scope).await;
        let target = either(args, "tag", "sessionId");
        if target.is_empty() {
            return Err("agent send: tag or sessionId is required".into());
        }
        let session_id = self
            .registry
            .resolve_tag(&target, scope, ResolveOptions { scan_sessions: scan, exclude_terminal_traces: false })?
            .ok_or_else(|| format!("agent send: target \"{target}\" not found"))?;
        let session = self.world.session(&session_id).filter(|s| s.get("closed") != Some(&Value::Bool(true)));
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
        if !self.world.surface_runs(&session) || !self.world.can_set_route() {
            return Err(format!("agent spawn: this surface cannot change the model of reused session \"{id}\""));
        }
        self.world.set_route(&session, route).await?;
        Ok(self.world.session(&id).unwrap_or(session))
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
        if spawned_on.is_empty() || !(own.iter().any(|o| *o == spawned_on) || named) {
            return Ok(None);
        }
        if !truthy(preset.get("provider")) || !truthy(preset.get("model")) {
            return Ok(None);
        }
        // Every route key the agent's route sets (an effort or Fast change alone included); a
        // key it leaves unset is the route default either way.
        let value = |key: &str, source: &Value| -> Value {
            match key {
                "fast" => Value::Bool(source.get("fast") == Some(&Value::Bool(true))),
                "autoEffort" => Value::Bool(source.get("autoEffort") != Some(&Value::Bool(false))),
                _ => match source.get(key) {
                    None | Some(Value::Null) => Value::Null,
                    Some(v) => Value::String(v.to_string()),
                },
            }
        };
        let set: Vec<&str> = AGENT_ROUTE_KEYS
            .into_iter()
            .filter(|key| *key == "fast" || *key == "autoEffort" || !matches!(preset.get(*key), None | Some(Value::Null)))
            .collect();
        let matches = |target: &Value| set.iter().all(|key| value(key, preset) == value(key, target));
        // Against the route the session's next turn runs on: one held for it (an in-process
        // worker that was busy), else its own.
        let id = id_of(session);
        if matches(session) {
            // Saved back to the running route: an earlier hold is obsolete.
            if truthy(session.get("heldRoute")) {
                self.world.hold_session_route(&id, None);
            }
            return Ok(None);
        }
        if let Some(held) = session.get("heldRoute").filter(|h| truthy(Some(h))) {
            let mut merged = session.as_object().cloned().unwrap_or_default();
            merged.extend(held.as_object().cloned().unwrap_or_default());
            if matches(&Value::Object(merged)) {
                return Ok(None);
            }
        }
        let mut route = Map::new();
        for key in set {
            match key {
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
        Ok(Some(Value::Object(route)))
    }

    /// `dispatchToExistingSession`: a busy session queues the prompt; an idle one runs a
    /// background send job that continues the existing session (context kept).
    pub async fn dispatch_to_existing_session(
        self: &Arc<Self>,
        prepared: &Prepared,
        notify: &SpawnContext,
        options: DispatchOptions,
    ) -> Result<AgentReply, String> {
        let mut session = self.session_of(prepared);
        let id = prepared.session_id.clone();
        let mut followed = if prepared.route.is_some() { None } else { self.agent_route_to_follow(&session).await? };
        if let Some(route) = followed.as_ref().filter(|_| !self.world.surface_runs(&session)) {
            // An in-process session takes the followed route in place, between turns; a running
            // one finishes on the route it started on and holds the new one for its next turn,
            // which runs the queued work.
            if !self.world.is_busy(&id) {
                let cross = route.get("provider") != session.get("provider") || route.get("model") != session.get("model");
                self.world.update_session_route(&id, route, &session, cross);
            } else {
                self.world.hold_session_route(&id, Some(route));
            }
            followed = None;
        }
        if let Some(route) = prepared.route.clone().or(followed) {
            session = self.apply_requested_route(session, &route).await?;
        }
        let prompt = prepared.prompt.clone().unwrap_or_default();
        let tag = self.registry.tag_for_session(&id);
        let busy = self.world.is_busy(&id);
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
        if self.world.surface_runs(&session) && busy {
            if let Some(queued) = self.world.enqueue_turn(&session, &prompt, &attachments, context).await? {
                return Ok(queued_view(queued.get("queueDepth").and_then(Value::as_u64)));
            }
        }
        if !self.world.surface_runs(&session) && busy {
            // The queued follow-up keeps the forwarded files, as the canonical queue does.
            if let Some(depth) = self.world.enqueue_pending(&id, &prompt, &attachments) {
                return Ok(queued_view(Some(depth)));
            }
        }
        let meta = JobMeta {
            tag: tag.clone().filter(|t| !t.is_empty()),
            session_id: Some(id.clone()),
            agent: text(&session, "agent"),
            provider: text(&session, "provider"),
            model: text(&session, "model"),
            preset: text(&session, "presetName"),
            effort: text(&session, "effort"),
            fast: Some(session.get("fast") == Some(&Value::Bool(true))),
            respawned: false,
            resumed: options.resumed,
            auto_effort_off: session.get("autoEffort") == Some(&Value::Bool(false)),
        };
        let start = StartContext {
            caller_session_id: Some(notify.caller_id()).filter(|c| !c.is_empty()),
            owner_session_id: Some(notify.owner_id()).filter(|c| !c.is_empty()),
            client_host_pid: notify.client_host_pid,
            hop: None,
            tool_call_id: None,
        };
        let (flow, prepared_run) = (self.clone(), prepared.clone());
        let job = self.starter.start_job("send", meta, start, move |job, owner_context| async move {
            let plan = flow.turn_plan(&prepared_run);
            let value: WorkerResult = flow.runner.run(plan, Some(owner_context), Some(job)).await?;
            Ok(Some(value))
        })?;
        let mut card = self.views.card(job.task_id(), &Scope::default(), false).await.ok_or_else(|| "agent job did not start".to_owned())?;
        card.view.reused = options.reused;
        card.view.resumed = options.resumed || card.view.resumed;
        Ok(AgentReply::Task { view: card.view, diagnostics: false })
    }

    /// What `runSend` runs: a follow-up turn on the existing worker.
    pub fn turn_plan(&self, prepared: &Prepared) -> TurnPlan {
        let session = self.session_of(prepared);
        let id = prepared.session_id.clone();
        let send_agent = text(&session, "agent").unwrap_or_else(|| normalize_agent_name(&clean(prepared.args.get("agent"))));
        let tag = self.registry.tag_for_session(&id).unwrap_or_default();
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

    /// A background-task completion was queued for this worker. A busy worker takes it at its
    /// next tool boundary; an idle one runs a follow-up turn on an empty prompt, which drains the
    /// queued completion (never an empty user turn). Its answer reaches the owner like any send.
    pub fn wake_idle_worker(self: &Arc<Self>, session_id: &str) -> bool {
        let id = clean_str(session_id);
        if id.is_empty() || self.world.is_busy(&id) {
            return false;
        }
        let Some(session) = self.world.session(&id).filter(|s| s.get("closed") != Some(&Value::Bool(true))) else { return false };
        let owner = either(&session, "ownerSessionId", "parentSessionId");
        let notify = SpawnContext {
            caller_session_id: Some(owner.clone()).filter(|o| !o.is_empty()),
            session_id: None,
            owner_session_id: Some(owner).filter(|o| !o.is_empty()),
            client_host_pid: session.get("clientHostPid").and_then(Value::as_u64),
        };
        let prepared = Prepared { args: Value::Object(Map::new()), session: facts_of(&session), session_id: id, prompt: Some(String::new()), route: None };
        let flow = self.clone();
        // A wake that cannot dispatch has nobody to tell: the completion stays queued, and Node
        // writes the failure to stderr (`send-flow.mjs:340-344`).
        drop(mixdog_rt::spawn("agent-completion-wake", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = flow.dispatch_to_existing_session(&prepared, &notify, DispatchOptions::default()).await {
                mixdog_rt::node_stderr!("[agent] completion wake failed session={}: {error}", prepared.session_id);
            }
        }));
        true
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
