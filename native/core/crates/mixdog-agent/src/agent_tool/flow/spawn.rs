//! A spawn: what it will be, the session it creates and the job that runs it (Node
//! `spawn-flow/spawn-plan.mjs`, `spawn-prep.mjs`, `deferred-spawn.mjs`). A spawn runs entirely
//! inside its job: prepared, its worker row flipped to running, and cancellation checked around
//! the turn.
//!
//! A spawn that has not finished preparing within `SPAWN_PREP_DEADLINE` fails
//! (`prepareWithDeadline`); a session it prepares after that is closed.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::TaskClass;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::resolve_route_context_state;
use mixdog_ai::service::admin_route::truthy;
use serde_json::Value;

use super::job_starter::JobStarter;
use super::job_starter::StartContext;
use super::preset::SpawnPreset;
use super::preset::merge_prepared_meta;
use super::preset::pending_spawn_meta;
use super::preset::preset_descriptor;
use super::preset::prepared_spawn_meta;
use super::preset::resolve_agent_spawn_preset;
use super::reconcile::JobHandle;
use super::result::WorkerResult;
use super::turn::TurnPlan;
use super::turn::TurnRunner;
use super::world::Created;
use super::world::SpawnAdmission;
use super::world::SpawnContext;
use super::world::SpawnWorld;
use crate::agent_tool::board::JobBoard;
use crate::agent_tool::board::JobMeta;
use crate::agent_tool::dispatch::wants_session_scan;
use crate::agent_tool::host::CloseOptions;
use crate::agent_tool::host::Environment;
use crate::agent_tool::host::Job;
use crate::agent_tool::host::Registry;
use crate::agent_tool::host::ResolveOptions;
use crate::agent_tool::host::Sessions;
use crate::agent_tool::host::SpawnFlow;
use crate::agent_tool::host::SpawnOptions;
use crate::agent_tool::resume::resolve_prompt;
use crate::agent_tool::scope::Caller;
use crate::agent_tool::scope::Scope;
use crate::agent_tool::scope::clean;
use crate::agent_tool::scope::normalize_agent_name;
use crate::agent_tool::scope::resolve_path;
use crate::agent_tool::stamp::iso_from_ms;
use crate::agent_tool::views::JobViews;
use crate::env::Clock;

/// How long a spawn may prepare before it fails (`MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS`, 120 s).
const SPAWN_PREP_DEADLINE: Duration = Duration::from_secs(120);
const SPAWN_PREP_TIMED_OUT: &str = "agent spawn prep timed out before session bind";

/// `prepareWithDeadline`: `work`'s outcome, or the timeout's message once `deadline` passes. The
/// work keeps running on its own task; what it produces after the caller stopped waiting (the
/// deadline passed, or the caller was dropped) goes to `late`, which tears it down.
async fn within_deadline<T, W, L, F>(deadline: Duration, work: W, late: L) -> Result<T, String>
where
    T: Send + 'static,
    W: Future<Output = Result<T, String>> + Send + 'static,
    L: FnOnce(T) -> F + Send + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    drop(mixdog_rt::spawn("agent-spawn-prep", TaskClass::Work, async move {
        if let Err(Ok(value)) = tx.send(work.await) {
            late(value).await;
        }
    }));
    match mixdog_rt::time::timeout(deadline, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err("agent spawn prep ended without a result".into()),
        Err(_) => Err(SPAWN_PREP_TIMED_OUT.into()),
    }
}

/// What a spawn will be, before anything is created.
#[derive(Clone, Debug)]
pub struct SpawnPlan {
    pub config: Obj,
    pub agent: String,
    pub agent_perm: Option<Value>,
    pub preset_name: Value,
    pub preset: Value,
    pub tag: String,
    pub worker_cwd: String,
    pub prompt: String,
}

/// A prepared spawn: the live worker session and the turn it will run.
#[derive(Clone, Debug)]
pub struct PreparedSpawn {
    pub args: Value,
    pub tag: String,
    pub session: Value,
    pub agent: String,
    pub preset: Value,
    pub preset_name: Value,
    pub worker_cwd: String,
    pub prompt: String,
}

impl PreparedSpawn {
    pub fn session_id(&self) -> String {
        self.session.get("id").and_then(Value::as_str).unwrap_or_default().to_owned()
    }
}

/// `assertBotChainTarget`: the contact agent a hand-off reaches is neither the one handing it on
/// nor already in the chain.
pub fn assert_bot_chain_target(target: &str, chain: &[String], this: &str, prefix: &str) -> Result<(), String> {
    if target.is_empty() {
        return Ok(());
    }
    if target == this {
        return Err(format!("{prefix}: the contact agent \"{target}\" cannot hand work to itself; do it yourself or delegate to a sub-agent"));
    }
    if chain.iter().any(|c| c == target) {
        let mut path = chain.to_vec();
        if !this.is_empty() && chain.last().map(String::as_str) != Some(this) {
            path.push(this.to_owned());
        }
        path.push(target.to_owned());
        return Err(format!(
            "{prefix}: the contact agent \"{target}\" is already in this delegation chain ({}); do not hand the work back, answer or delegate to a sub-agent instead",
            path.join(" → ")
        ));
    }
    Ok(())
}

pub struct SpawnFlowImpl {
    world: Arc<dyn SpawnWorld>,
    admission: Arc<dyn SpawnAdmission>,
    registry: Arc<dyn Registry>,
    sessions: Arc<dyn Sessions>,
    env: Arc<dyn Environment>,
    board: JobBoard,
    views: Arc<JobViews>,
    starter: Arc<JobStarter>,
    runner: Arc<TurnRunner>,
    clock: Arc<dyn Clock>,
    status_changed: Arc<dyn Fn() + Send + Sync>,
    default_cwd: String,
    mcp_scope_id: Option<String>,
}

pub struct SpawnFlowDeps {
    pub world: Arc<dyn SpawnWorld>,
    pub admission: Arc<dyn SpawnAdmission>,
    pub registry: Arc<dyn Registry>,
    pub sessions: Arc<dyn Sessions>,
    pub env: Arc<dyn Environment>,
    pub board: JobBoard,
    pub views: Arc<JobViews>,
    pub starter: Arc<JobStarter>,
    pub runner: Arc<TurnRunner>,
    pub clock: Arc<dyn Clock>,
    pub status_changed: Arc<dyn Fn() + Send + Sync>,
    pub default_cwd: String,
    pub mcp_scope_id: Option<String>,
}

impl SpawnFlowImpl {
    pub fn new(deps: SpawnFlowDeps) -> Self {
        Self {
            world: deps.world,
            admission: deps.admission,
            registry: deps.registry,
            sessions: deps.sessions,
            env: deps.env,
            board: deps.board,
            views: deps.views,
            starter: deps.starter,
            runner: deps.runner,
            clock: deps.clock,
            status_changed: deps.status_changed,
            default_cwd: deps.default_cwd,
            mcp_scope_id: deps.mcp_scope_id,
        }
    }

    /// `resolveSpawnPlan`: the shared validations (agent, preset, tag, cwd, prompt).
    pub async fn resolve_spawn_plan(&self, args: &Value, caller_cwd: Option<&str>, context: &SpawnContext) -> Result<SpawnPlan, String> {
        let world = &self.world;
        let config = world.load_config().await?;
        let agent = normalize_agent_name(&clean(args.get("agent")));
        if agent.is_empty() {
            return Err("agent spawn: agent is required".into());
        }
        // A deleted or unknown agent fails here: it would otherwise still spawn as a role-less
        // generic agent by its remembered name.
        if !world.agent_defined(&agent).await? {
            return Err(format!("agent spawn: unknown agent \"{agent}\""));
        }
        // Switched off in settings: the role is dropped from the Lead prompt, so a spawn can only
        // arrive from a stale name.
        if world.agent_disabled(&config, &agent) {
            return Err(format!("agent spawn: agent \"{agent}\" is turned off"));
        }
        // A contact agent never goes to one already in the delegation chain, itself included.
        let kind = world.agent_kind(&agent).await?;
        if world.is_contact_agent(&agent, kind.as_deref()) {
            let delegation = world.delegation(&context.caller_id());
            assert_bot_chain_target(&agent, &delegation.chain, &delegation.acting, "agent spawn")?;
        }
        let agent_perm = world.agent_permission(&agent).await?;
        let candidates = world.route_candidates(&config, &agent).await?;
        let SpawnPreset { preset_name, preset } = resolve_agent_spawn_preset(&config, args, &candidates)?;
        let explicit = clean(args.get("tag"));
        let tag = if explicit.is_empty() { world.next_tag(&agent, context) } else { explicit };
        // Any resolved same-tag binding in this terminal (live or lingering trace) blocks a
        // fresh spawn; live reuse is routed before a spawn is prepared.
        let scan = wants_session_scan(args);
        let existing = self.registry.resolve_tag(&tag, &context.scope(), ResolveOptions { scan_sessions: scan, exclude_terminal_traces: false })?;
        if existing.is_some() {
            return Err(format!("agent spawn: tag \"{tag}\" already exists"));
        }
        // Workers share their Lead's execution root. While the Lead runs in its worktree that
        // root is locked: neither `args.cwd` nor an inherited cwd can send a worker elsewhere.
        let owners = [context.owner_id(), context.caller_id()];
        let locked = self.admission.workspace_cwd_lock(&owners).filter(|l| !l.is_empty());
        let current = self.env.current_dir();
        let base_source = locked.clone().or_else(|| caller_cwd.filter(|c| !c.is_empty()).map(str::to_owned)).or_else(|| Some(self.default_cwd.clone()).filter(|d| !d.is_empty())).unwrap_or_else(|| current.clone());
        let base_cwd = resolve_path(&current, &base_source);
        let requested = clean(args.get("cwd"));
        let worker_cwd = if locked.is_none() && !requested.is_empty() { resolve_path(&base_cwd, &requested) } else { base_cwd };
        let prompt = resolve_prompt(args, &worker_cwd, &*self.env).await?;
        Ok(SpawnPlan { config, agent, agent_perm, preset_name, preset, tag, worker_cwd, prompt })
    }

    /// `spawnSessionSpec`: the normalized in-process agent session spec.
    fn spawn_session_spec(&self, plan: &SpawnPlan, args: &Value, context: &SpawnContext) -> Obj {
        let caller = context.caller_id();
        let owner = context.owner_id();
        let mut spec = Obj::new();
        spec.insert("agent".into(), plan.agent.clone().into());
        spec.insert("presetName".into(), plan.preset_name.clone());
        spec.insert("preset".into(), plan.preset.clone());
        spec.insert("runtimeSpec".into(), self.world.resolve_runtime_spec(&plan.preset, &plan.tag));
        spec.insert("owner".into(), "agent".into());
        spec.insert("cwd".into(), plan.worker_cwd.clone().into());
        spec.insert("sourceType".into(), "cli".into());
        spec.insert("sourceName".into(), plan.agent.clone().into());
        spec.insert("parentSessionId".into(), if caller.is_empty() { Value::Null } else { caller.into() });
        spec.insert("ownerSessionId".into(), if owner.is_empty() { Value::Null } else { owner.into() });
        spec.insert("visibility".into(), "agent-only".into());
        spec.insert("clientHostPid".into(), context.client_host_pid.filter(|p| *p > 0).map_or(Value::Null, Value::from));
        spec.insert("agentTag".into(), plan.tag.clone().into());
        let task_type = clean(args.get("taskType"));
        let task_type = if task_type.is_empty() { clean(args.get("typeHint")) } else { task_type };
        if !task_type.is_empty() {
            spec.insert("taskType".into(), task_type.into());
        }
        if let Some(permission) = &plan.agent_perm {
            spec.insert("permission".into(), permission.clone());
        }
        if truthy(args.get("cacheKey")) {
            spec.insert("cacheKeyOverride".into(), args["cacheKey"].clone());
        }
        spec.insert("mcpScopeId".into(), self.mcp_scope_id.clone().map_or(Value::Null, Value::from));
        spec
    }

    /// A sub-100 context share needs the window it selects; a model whose window is not known
    /// resolves to nothing, so the agent's own choice travels as stored (the session sizes it
    /// from the provider's window) instead of being dropped for the model's default.
    fn context_selection(&self, preset: &Value) -> Obj {
        let route = preset.as_object().cloned().unwrap_or_default();
        let provider = clean(preset.get("provider"));
        let model = clean(preset.get("model"));
        let meta = self.world.route_window_meta(&provider, &model);
        let state = resolve_route_context_state(&route, meta.as_ref());
        let window_known = state.context_default_percent.is_some();
        let num = |v: f64| mixdog_ai::service::admin_route::jnum(v);
        let mut chosen = Obj::new();
        let percent = state.context_percent.map(num).or_else(|| route.get("contextPercent").cloned());
        let window = state.selected_context_window.map(num);
        let tokens = state.context_tokens.map(num).or_else(|| if window_known { None } else { route.get("contextTokens").cloned() });
        for (key, value) in [("contextPercent", percent), ("selectedContextWindow", window), ("contextTokens", tokens)] {
            if let Some(value) = value.filter(|v| truthy(Some(v))) {
                chosen.insert(key.into(), value);
            }
        }
        chosen
    }

    async fn create_spawned_session(&self, plan: &SpawnPlan, spec: &Obj) -> Result<Created, String> {
        let mut session_spec = spec.clone();
        if truthy(plan.preset.get("contextPercent")) || truthy(plan.preset.get("contextTokens")) {
            session_spec.extend(self.context_selection(&plan.preset));
        }
        // Session creation composes the git startup line synchronously; its probes answer
        // off-thread here so that composition never spawns git on the event loop.
        let cwd = session_spec.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
        let probes = self.world.prewarm_git_probes(&cwd);
        if self.world.canonical_surface() && self.world.can_create_child() {
            probes.await;
            return self.world.create_child(&session_spec, &plan.prompt, &plan.tag).await;
        }
        self.world.ensure_provider(&plan.config, &clean(plan.preset.get("provider"))).await?;
        probes.await;
        self.world.prepare_session(&session_spec).await
    }

    /// `prepareSpawnInProcess` after `refreshTagsFromSessions`.
    pub async fn prepare_spawn(&self, args: &Value, caller_cwd: Option<&str>, context: &SpawnContext) -> Result<PreparedSpawn, String> {
        self.registry.refresh_tags_from_sessions(false, &context.scope()).await;
        // Shared admission with Lead workspace transitions: no spawn is prepared while the
        // Lead's workspace changes, no transition starts mid-spawn.
        let _leave = self.admission.enter_worker_spawn(&[context.owner_id(), context.caller_id()])?;
        let plan = self.resolve_spawn_plan(args, caller_cwd, context).await?;
        let spec = self.spawn_session_spec(&plan, args, context);
        let Created { session, effective_cwd } = self.create_spawned_session(&plan, &spec).await?;
        // Agent sessions are built here, not through a Lead's create: mirror its registrations,
        // or the statusline cannot resolve the agent route/model.
        let session_id = session.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.world.write_statusline_route(&session_id, &plan.preset);
        let mut descriptor = preset_descriptor(&plan.agent, &plan.preset, &plan.preset_name);
        descriptor.insert("status".into(), "idle".into());
        descriptor.insert("stage".into(), "idle".into());
        self.world.bind_tag(&plan.tag, &session, &descriptor);
        drop(_leave);
        if !self.world.canonical_surface() {
            self.world.prewarm_transport(&clean(plan.preset.get("provider")), &session);
        }
        Ok(PreparedSpawn {
            args: args.clone(),
            tag: plan.tag,
            session,
            agent: plan.agent,
            preset: plan.preset,
            preset_name: plan.preset_name,
            worker_cwd: effective_cwd.filter(|c| !c.is_empty()).unwrap_or(plan.worker_cwd),
            prompt: plan.prompt,
        })
    }

    /// `closePreparedSpawn`.
    pub async fn close_prepared_spawn(&self, prepared: &PreparedSpawn, reason: &str) {
        let id = prepared.session_id();
        if id.is_empty() {
            return;
        }
        self.sessions.close_session(&id, reason, CloseOptions::default()).await;
        self.sessions.clear_statusline_route(&id);
        self.registry.forget_terminal_session(Some(&prepared.tag), &id);
    }

    /// What `runSpawn` runs: the prepared worker's first turn.
    pub fn turn_plan(&self, prepared: &PreparedSpawn) -> TurnPlan {
        let mut identity = serde_json::Map::new();
        identity.insert("tag".into(), prepared.tag.clone().into());
        identity.insert("sessionId".into(), prepared.session_id().into());
        identity.extend(preset_descriptor(&prepared.agent, &prepared.preset, &prepared.preset_name));
        let text = |key: &str| prepared.session.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        TurnPlan {
            kind: super::seams::TurnKind::Spawn,
            session_id: prepared.session_id(),
            parent_session_id: text("parentSessionId"),
            session_owner_id: text("ownerSessionId"),
            tag: prepared.tag.clone(),
            agent: prepared.agent.clone(),
            identity,
            prompt: prepared.prompt.clone(),
            attachments: prepared.args.get("attachmentParts").and_then(Value::as_array).cloned().unwrap_or_default(),
            context: prepared.args.get("context").filter(|c| truthy(Some(c))).cloned(),
            cwd: prepared.worker_cwd.clone(),
            skill_selection: prepared.args.get("skillSelection").and_then(Value::as_str).map(str::to_owned),
            canonical: self.world.canonical_surface(),
        }
    }

    /// `startDeferredSpawnJob`: the job whose work is the whole spawn.
    pub async fn start_deferred_spawn_job(
        self: &Arc<Self>,
        args: &Value,
        caller_cwd: &str,
        context: &SpawnContext,
        notify: &SpawnContext,
        options: SpawnOptions,
    ) -> Result<Arc<JobHandle>, String> {
        let missing = |key: &str| clean(args.get(key)).is_empty();
        // Best effort: the pending card shows the model even when the caller named none.
        let resolved = if missing("model") || missing("provider") { self.pending_preset(args).await } else { None };
        let meta = pending_spawn_meta(args, resolved.as_ref(), options.respawned);
        let start = StartContext {
            caller_session_id: Some(notify.caller_id()).filter(|c| !c.is_empty()),
            owner_session_id: Some(notify.owner_id()).filter(|c| !c.is_empty()),
            client_host_pid: notify.client_host_pid,
            hop: None,
            tool_call_id: None,
        };
        let (flow, args, caller_cwd, context) = (self.clone(), args.clone(), caller_cwd.to_owned(), context.clone());
        let respawned = options.respawned;
        self.starter.start_job("spawn", meta, start, move |job, owner_context| async move {
            if job.is_cancelled() {
                return Ok(None);
            }
            let prepared = {
                let (preparing, closing) = (flow.clone(), flow.clone());
                let (args, caller_cwd, context) = (args.clone(), caller_cwd.clone(), context.clone());
                within_deadline(
                    SPAWN_PREP_DEADLINE,
                    async move { preparing.prepare_spawn(&args, Some(&caller_cwd), &context).await },
                    move |late: PreparedSpawn| async move { closing.close_prepared_spawn(&late, "agent-spawn-prep-timeout").await },
                )
                .await?
            };
            let merged_meta = prepared_spawn_meta(&prepared.tag, &prepared.session_id(), &prepared.agent, &prepared.preset, &prepared.preset_name, respawned);
            flow.board.update_meta(job.task_id(), |current| *current = merge_prepared_meta(current, &merged_meta));
            let started = job.snapshot().map(|s| s.started_ms).unwrap_or_default();
            let mut row = Obj::new();
            for (key, value) in meta_json(&merged_meta) {
                row.insert(key, value);
            }
            row.insert("status".into(), "running".into());
            row.insert("stage".into(), "running".into());
            row.insert("task_id".into(), job.task_id().into());
            row.insert("startedAt".into(), iso_from_ms(started).into());
            row.insert("turnStartedAt".into(), iso_from_ms(flow.clock.now_ms()).into());
            flow.world.upsert_worker_row(&prepared.session, &prepared.tag, &row);
            (flow.status_changed)();
            if job.is_cancelled() {
                flow.close_prepared_spawn(&prepared, "agent-task-cancel").await;
                return Ok(None);
            }
            let plan = flow.turn_plan(&prepared);
            let value: WorkerResult = flow.runner.run(plan, Some(owner_context), Some(job)).await?;
            Ok(Some(value))
        })
    }

    /// `runToCompletion`: one workflow agent run to its end for a caller with no session to hand
    /// the result to (a routine's executor). `context.caller_session_id` is the id the agent is
    /// created under. Resolves the agent's session id and final content; fails when the agent
    /// fails or is cancelled, or `cancel` fires (which cancels it silently). The agent's session is
    /// closed afterwards.
    pub async fn run_to_completion(
        self: &Arc<Self>,
        args: &Value,
        caller_cwd: &str,
        context: &SpawnContext,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<(Option<String>, String), String> {
        const ABORTED: &str = "agent run aborted";
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        let mut spawn_args = args.clone();
        spawn_args["type"] = Value::String("spawn".into());
        let job = self.start_deferred_spawn_job(&spawn_args, caller_cwd, context, context, SpawnOptions::default()).await?;
        let task = job.task_id().to_owned();
        let row = tokio::select! {
            row = self.board.wait_terminal(&task) => row,
            () = cancel.cancelled() => {
                self.board.cancel(&task, ABORTED, crate::agent_tool::board::CancelNotice::Never);
                self.board.wait_terminal(&task).await
            }
        };
        let row = row.ok_or_else(|| "the agent run failed".to_owned())?;
        let result_value = match &row.result {
            Some(mixdog_tools::orch::agent::TaskResult::Json(value)) => value.clone(),
            _ => Value::Null,
        };
        let session = row.meta.session_id.clone().filter(|s| !s.is_empty()).or_else(|| Some(clean(result_value.get("sessionId"))).filter(|s| !s.is_empty()));
        if let Some(session) = &session {
            // The run's result stands; a close that fails is swept with the idle agents.
            self.sessions.close_session(session, "routine-executor-finished", CloseOptions { tombstone: false, owner_close: false }).await;
        }
        if cancel.is_cancelled() {
            return Err(ABORTED.into());
        }
        match row.status.as_str() {
            "cancelled" => Err("the agent run was cancelled".into()),
            "completed" => {
                let content = result_value.get("content").filter(|c| !c.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
                Ok((session, content))
            }
            _ => Err(row.error.filter(|e| !e.is_empty()).unwrap_or_else(|| "the agent run failed".into())),
        }
    }

    /// The preset a pending card shows; an error shows nothing.
    async fn pending_preset(&self, args: &Value) -> Option<Value> {
        let config = self.world.loaded_config()?;
        let agent = normalize_agent_name(&clean(args.get("agent")));
        let candidates = self.world.route_candidates(&config, &agent).await.ok()?;
        resolve_agent_spawn_preset(&config, args, &candidates).ok().map(|s| s.preset)
    }
}

/// A prepared meta as the worker row spreads it (`...preparedSpawnMeta`).
fn meta_json(meta: &JobMeta) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    if meta.respawned {
        out.push(("respawned".to_owned(), Value::Bool(true)));
    }
    let mut put = |key: &str, value: Option<&String>| out.push((key.to_owned(), value.map_or(Value::Null, |v| Value::String(v.clone()))));
    put("tag", meta.tag.as_ref());
    put("sessionId", meta.session_id.as_ref());
    put("agent", meta.agent.as_ref());
    put("preset", meta.preset.as_ref());
    put("provider", meta.provider.as_ref());
    put("model", meta.model.as_ref());
    put("effort", meta.effort.as_ref());
    out.push(("fast".to_owned(), Value::Bool(meta.fast == Some(true))));
    if meta.auto_effort_off {
        out.push(("autoEffort".to_owned(), Value::Bool(false)));
    }
    out
}

#[async_trait]
impl SpawnFlow for Arc<SpawnFlowImpl> {
    async fn start_deferred_spawn_job(&self, args: &Value, caller_cwd: &str, caller: &Caller, notify: &Caller, options: SpawnOptions) -> Result<Job, String> {
        let job = SpawnFlowImpl::start_deferred_spawn_job(self, args, caller_cwd, &caller.into(), &notify.into(), options).await?;
        let card = self.views.card(job.task_id(), &Scope::default(), false).await;
        card.ok_or_else(|| "agent job did not start".to_owned())
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test(start_paused = true)]
    async fn a_prepare_past_the_deadline_fails_and_its_session_is_closed() {
        mixdog_rt::testing::tokens();
        let closed = Arc::new(Mutex::new(Vec::new()));
        let sink = closed.clone();
        let work = async {
            mixdog_rt::time::sleep(Duration::from_secs(200)).await;
            Ok::<_, String>("session".to_owned())
        };
        let out = within_deadline(SPAWN_PREP_DEADLINE, work, move |late| async move { sink.lock().unwrap().push(late) }).await;
        assert_eq!(out.unwrap_err(), SPAWN_PREP_TIMED_OUT);
        assert!(closed.lock().unwrap().is_empty());
        mixdog_rt::time::sleep(Duration::from_secs(100)).await;
        assert_eq!(*closed.lock().unwrap(), vec!["session".to_owned()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_prepare_in_time_is_returned_and_never_closed() {
        mixdog_rt::testing::tokens();
        let closed = Arc::new(Mutex::new(0));
        let sink = closed.clone();
        let out = within_deadline(SPAWN_PREP_DEADLINE, async { Ok::<_, String>(7) }, move |_| async move { *sink.lock().unwrap() += 1 }).await;
        assert_eq!(out, Ok(7));
        mixdog_rt::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(*closed.lock().unwrap(), 0);
    }
}
