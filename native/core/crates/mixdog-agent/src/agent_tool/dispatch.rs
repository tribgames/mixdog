//! The agent tool's request dispatch: list/status/read/cleanup/cancel/close/send/spawn (Node
//! `agent-tool/execute.mjs`, `execute-spawn.mjs`, `execute-send.mjs`, `close-flow.mjs`). The
//! dead-tag send fallback and explicit-tag spawn resolution live here; the flows they call
//! (prepare, dispatch, start a job) are the host's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::ClosedView;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::AgentPort;
use mixdog_tools::orch::agent::AgentRequest;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;

use super::error_text::ErrorText;
use super::host::CallerScopes;
use super::host::CloseOptions;
use super::host::DispatchOptions;
use super::host::Environment;
use super::host::Job;
use super::host::ListOptions;
use super::host::Registry;
use super::host::ResolveOptions;
use super::host::SendFlow;
use super::host::Sessions;
use super::host::SpawnFlow;
use super::host::SpawnOptions;
use super::host::Tasks;
use super::host::TerminalTrace;
use super::host::Views;
use super::model_select::ModelCatalog;
use super::model_select::resolve_requested_model;
use super::resume::ResumeRequest;
use super::resume::TagResume;
use super::resume::resolve_prompt;
use super::scope::Caller;
use super::scope::Scope;
use super::scope::TagRecord;
use super::scope::clean;
use super::scope::clean_str;

const CLOSE_REASON: &str = "cancelled by agent close";

/// The collaborators the agent tool is wired to.
pub struct AgentDeps {
    pub registry: Arc<dyn Registry>,
    pub send_flow: Arc<dyn SendFlow>,
    pub spawn_flow: Arc<dyn SpawnFlow>,
    pub terminal_trace: Arc<dyn TerminalTrace>,
    pub sessions: Arc<dyn Sessions>,
    pub tasks: Arc<dyn Tasks>,
    pub views: Arc<dyn Views>,
    pub env: Arc<dyn Environment>,
    pub catalog: Option<Arc<dyn ModelCatalog>>,
    pub default_cwd: String,
    pub scopes: Arc<dyn CallerScopes>,
    pub errors: Arc<dyn ErrorText>,
}

pub struct AgentRuntime {
    deps: AgentDeps,
    resume: TagResume,
}

/// What an explicit-tag spawn resolved to.
enum SpawnPlan {
    Reused(Box<AgentReply>),
    Fresh { args: Value, respawned: bool },
}

/// `isDeadTarget`: `/not found|is closed/i`.
fn is_dead_target(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("not found") || lowered.contains("is closed")
}

/// `a || b` over raw argument values, then `clean`.
pub(super) fn first_truthy(values: &[Option<&Value>]) -> String {
    for v in values.iter().flatten() {
        let truthy = match v {
            Value::Null | Value::Bool(false) => false,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64() != Some(0.0),
            _ => true,
        };
        if truthy {
            return clean(Some(v));
        }
    }
    String::new()
}

pub(crate) fn wants_session_scan(args: &Value) -> bool {
    ["recover", "scanSessions", "scan_sessions"].iter().any(|k| args.get(k) == Some(&Value::Bool(true)))
}

/// What an explicit spawn asks a reused session to change: only what it names, or `None`.
fn requested_route(args: &Value) -> Option<Value> {
    let mut route = serde_json::Map::new();
    let model = clean(args.get("model"));
    let effort = clean(args.get("effort"));
    if !model.is_empty() {
        route.insert("provider".into(), Value::String(clean(args.get("provider"))));
        route.insert("model".into(), Value::String(model));
    }
    if !effort.is_empty() {
        route.insert("effort".into(), Value::String(effort));
    }
    if let Some(fast) = args.get("fast") {
        route.insert("fast".into(), Value::Bool(fast == &Value::Bool(true)));
    }
    if let Some(auto) = args.get("autoEffort") {
        route.insert("autoEffort".into(), Value::Bool(auto != &Value::Bool(false)));
    }
    (!route.is_empty()).then_some(Value::Object(route))
}

/// Cancels the background tasks bound to a session before the session closes.
fn cancel_session_tasks(tasks: &dyn Tasks, session_id: &str, target: &str, scope: &Scope) {
    for row in tasks.list(scope) {
        if row.session_id.as_deref() != Some(session_id) && row.tag.as_deref() != Some(target) {
            continue;
        }
        tasks.cancel(&row.task_id, CLOSE_REASON);
    }
}

/// `cancelAgentTree` (`agent-cancel.mjs:112-150`): the session and every agent below it close,
/// descendants first and one at a time, all refusing admission until the last has closed. Each
/// member's own jobs go first with the tree's `reason` (the agent jobs it started, then the jobs
/// bound to it), so the owner of a running turn hears `cancelled` with the turn's partial output
/// rather than the closed turn failing the job. A member that cannot close never skips the rest:
/// once all were attempted the cancel fails, with that one failure's text or, for several, the
/// count of the failed among the tree's sessions and each text. Otherwise whether any member was
/// there to close.
pub async fn cancel_agent_tree(sessions: &dyn Sessions, tasks: &dyn Tasks, session_id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
    let id = mixdog_js::js_trim(session_id);
    if id.is_empty() {
        return Ok(false);
    }
    let mut ordered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    visit_descendants_first(sessions, id, &mut seen, &mut ordered);
    let _cancelling = sessions.begin_cancellation(&ordered);
    let mut closed = false;
    let mut failures = Vec::new();
    for current in &ordered {
        tasks.cancel_owned(current, reason);
        for row in tasks.list(&Scope::default()) {
            if row.session_id.as_deref() == Some(current.as_str()) {
                tasks.cancel(&row.task_id, reason);
            }
        }
        match sessions.try_close_session(current, reason, options).await {
            Ok(done) => closed |= done,
            Err(error) => failures.push(error),
        }
    }
    match failures.len() {
        0 => Ok(closed),
        1 => Err(failures.remove(0)),
        count => Err(format!("agent tree cancel failed for {count} of {} sessions: {}", ordered.len(), failures.join("; "))),
    }
}

fn visit_descendants_first(sessions: &dyn Sessions, current: &str, seen: &mut std::collections::HashSet<String>, ordered: &mut Vec<String>) {
    if !seen.insert(current.to_owned()) {
        return;
    }
    for child in sessions.child_session_ids(current) {
        visit_descendants_first(sessions, &child, seen, ordered);
    }
    ordered.push(current.to_owned());
}

/// The collaborators of [`close_resolved`].
#[derive(Clone, Copy)]
pub struct CloseParts<'a> {
    pub registry: &'a dyn Registry,
    pub sessions: &'a dyn Sessions,
    pub tasks: &'a dyn Tasks,
}

/// `close` once the target resolved to a session (`close-flow.mjs`): the session, its statusline
/// route and its tasks go, and unless `keep_row` (a process exit leaves the row for the next
/// process) its worker rows with them. `agent close all` closes each worker of an owner through
/// this too.
pub async fn close_resolved(
    parts: CloseParts<'_>,
    session_id: &str,
    target: &str,
    scope: &Scope,
    task_id_out: Option<String>,
    keep_row: bool,
) -> Result<ClosedView, String> {
    let CloseParts { registry, sessions, tasks } = parts;
    if registry.live_session(session_id).is_some_and(|s| is_lead_pool_agent(&s.agent)) {
        return Err(format!("agent close: target \"{target}\" is a Lead session"));
    }
    let descendants = sessions.descendant_session_ids(session_id);
    let tag = registry.tag_for_session(session_id);
    sessions.clear_statusline_route(session_id);
    cancel_session_tasks(tasks, session_id, target, scope);
    // Close (and stamp the cancel) before dropping the worker row, so the row never
    // outlives an unrecorded cancel. Closing a runtime cancels its work; only explicit
    // session deletion may tombstone the conversation. An owner's close (not a process
    // exit's) is recorded on the session itself, so a later reuse of its reaped tag never
    // continues it.
    let ok = cancel_agent_tree(sessions, tasks, session_id, "cli-agent-close", CloseOptions { tombstone: false, owner_close: !keep_row }).await?;
    if let Some(id) = &task_id_out {
        tasks.cancel(id, CLOSE_REASON);
    }
    // Drop the row only once the cancellation is durably recorded: a failed close that
    // still forgot the row would leave no cancelled state behind.
    if ok && !keep_row {
        registry.forget_terminal_session(tag.as_deref(), session_id);
        for descendant in &descendants {
            registry.remove_worker_row(descendant);
        }
        // The sessions stay open (a send reuses them), so a later scan, even after a
        // restart, would list them again: remember the owner closed them.
        let mut released = vec![session_id.to_owned()];
        released.extend(descendants.iter().cloned());
        registry.mark_released(&released);
    }
    Ok(ClosedView { closed: ok, tag, session_id: Some(session_id.to_owned()), task_id: task_id_out, forgotten: false })
}

fn is_lead_pool_agent(agent: &str) -> bool {
    clean_str(agent).to_lowercase() == "lead"
}

/// `errorLine`: the presented text, headed `Error:` unless it already is.
fn error_line(presented: &str) -> String {
    let t = mixdog_js::js_trim_start(presented).to_lowercase();
    let headed = t.strip_prefix("error").is_some_and(|rest| mixdog_js::js_trim_start(rest).starts_with(':'));
    if headed { presented.to_owned() } else { format!("Error: {presented}") }
}

impl AgentRuntime {
    pub fn new(deps: AgentDeps) -> Self {
        let resume = TagResume::new(Arc::clone(&deps.registry), Arc::clone(&deps.send_flow), Arc::clone(&deps.env), deps.default_cwd.clone());
        Self { deps, resume }
    }

    fn spawn_result(job: Job) -> AgentReply {
        AgentReply::Task { view: job.view, diagnostics: false }
    }

    /// One request. A failure is the tool's answer, as text, not an error of the call.
    pub async fn handle(&self, args: &Value, caller: &Caller) -> AgentReply {
        match self.run(args, caller).await {
            Ok(reply) => reply,
            Err(message) => AgentReply::Text(error_line(&self.deps.errors.present(&message))),
        }
    }

    async fn run(&self, args: &Value, caller: &Caller) -> Result<AgentReply, String> {
        // A tool call reads every legacy tombstone with its owner.
        self.deps.registry.resolve_tombstone_owners();
        let kind = clean(args.get("type"));
        let kind = if kind.is_empty() { "spawn".to_owned() } else { kind };
        let scope = Scope::of(args, &caller.scope);
        // Rebuild tag ownership from canonical records even if a daemon crash happened before
        // the auxiliary worker row was flushed.
        if self.deps.sessions.rehydrate_agent_sessions().await {
            self.deps.registry.refresh_tags_from_sessions(true, &scope).await;
        }
        let views = &self.deps.views;
        match kind.as_str() {
            "status" | "list" => {
                if kind == "status" && !(clean(args.get("task_id")).is_empty() && clean(args.get("tag")).is_empty() && clean(args.get("sessionId")).is_empty()) {
                    let job = views.get_job_or_worker(args, &scope, false).await?;
                    return Ok(AgentReply::Task { view: job.view, diagnostics: true });
                }
                // Targetless status is the same compact overview as list. Idle workers stay
                // open for follow-ups; the roster counts them and lists a bounded tail.
                let workers = views
                    .list(
                        &scope,
                        ListOptions {
                            scan_sessions: wants_session_scan(args),
                            include_idle: true,
                            include_closed: true,
                            include_terminal: false,
                        },
                    )
                    .await;
                Ok(AgentReply::Roster { workers, jobs: views.list_jobs(&scope).await })
            }
            "read" => self.read_job(args, &scope).await,
            "cleanup" => self.cleanup(args, &scope).await,
            "cancel" | "close" => Ok(AgentReply::Closed(self.close(args, caller, false).await?)),
            "send" => self.send(args, caller, &scope).await,
            "spawn" => self.spawn(args, caller, &scope).await,
            other => Err(format!("agent: unknown type \"{other}\"")),
        }
    }

    async fn read_job(&self, args: &Value, scope: &Scope) -> Result<AgentReply, String> {
        let mut job = self.deps.views.get_job_or_worker(args, scope, true).await?;
        if job.task_id.is_none()
            && let Some(handoff) = self.deps.sessions.read_session_handoff(job.session_id.as_deref().unwrap_or_default()).await
            && !handoff.is_empty()
        {
            job.view.result = Some(TaskResult::Content(handoff));
        }
        // A worker's own text read off its session leaves it: its sensitive values read as the marker, as in its report.
        if job.task_id.is_none()
            && let Some(TaskResult::Content(text)) = &mut job.view.result
        {
            *text = self.deps.sessions.redact_text(job.session_id.as_deref().unwrap_or_default(), std::mem::take(text));
        }
        Ok(AgentReply::Task { view: job.view, diagnostics: true })
    }

    // ---- close / cleanup -------------------------------------------------------------------

    /// Stale local metadata only: `resolve_tag` found no session in this scope, so there is no
    /// sessionId-safe worker row to delete. `tags`/`tagAgents` are shared by every caller on
    /// the canonical agent, so a binding alone does not prove the caller owns it: only a live
    /// session or a persisted row inside the caller's scope does.
    fn tag_bound_by_caller(&self, target: &str, scope: &Scope) -> bool {
        let registry = &self.deps.registry;
        let live = registry.tag_session(target).and_then(|id| registry.live_session(&id));
        if let Some(live) = live {
            return scope.owns(&live.owner);
        }
        registry.read_worker_rows(scope).map(|rows| rows.iter().any(|r| clean_str(&r.tag) == target)).unwrap_or(false)
    }

    /// `keep_row`: a process exit closes the worker but leaves its row for the next process.
    pub async fn close(&self, args: &Value, caller: &Caller, keep_row: bool) -> Result<ClosedView, String> {
        let scope = Scope::of(args, &caller.scope);
        let registry = &self.deps.registry;
        registry.refresh_tags_from_sessions(wants_session_scan(args), &scope).await;
        let task_id = clean(args.get("task_id"));
        let task = if task_id.is_empty() { None } else { self.deps.tasks.get(&task_id, &caller.scope) };
        let task_session = task.as_ref().and_then(|t| t.session_id.clone());
        let target = {
            let named = first_truthy(&[args.get("tag"), args.get("sessionId")]);
            if named.is_empty() { task_session.clone().unwrap_or_default() } else { named }
        };
        if target.is_empty() {
            if let Some(task) = task {
                self.deps.tasks.cancel(&task.task_id, CLOSE_REASON);
                return Ok(ClosedView { closed: true, tag: task.tag.clone(), session_id: None, task_id: Some(task.task_id), forgotten: false });
            }
            return Err("agent close: tag or sessionId is required".into());
        }
        let task_id_out = task.as_ref().map(|t| t.task_id.clone());
        let Some(session_id) = registry.resolve_tag(&target, &scope, ResolveOptions { scan_sessions: wants_session_scan(args), exclude_terminal_traces: false })? else {
            if !target.starts_with("sess_") && registry.has_tag_agent(&target) && self.tag_bound_by_caller(&target, &scope) {
                registry.unbind_tag(&target);
                if let Some(id) = &task_id_out {
                    self.deps.tasks.cancel(id, CLOSE_REASON);
                }
                return Ok(ClosedView { closed: true, tag: Some(target), session_id: None, task_id: task_id_out, forgotten: true });
            }
            return Err(format!("agent close: target \"{target}\" not found"));
        };
        close_resolved(CloseParts { registry: &*self.deps.registry, sessions: &*self.deps.sessions, tasks: &*self.deps.tasks }, &session_id, &target, &scope, task_id_out, keep_row).await
    }

    async fn cleanup(&self, args: &Value, scope: &Scope) -> Result<AgentReply, String> {
        let registry = &self.deps.registry;
        let before = registry.tag_count() as i64;
        registry.refresh_tags_from_sessions(wants_session_scan(args), scope).await;
        let cleaned = self.deps.tasks.cleanup(scope, args.get("force") == Some(&Value::Bool(true)));
        let tags_removed = before - registry.tag_count() as i64;
        let tasks = self.deps.views.list_jobs(scope).await.len();
        // Cleanup reports how many worker rows remain known (idle/terminal included).
        let workers = self
            .deps
            .views
            .list(scope, ListOptions { scan_sessions: wants_session_scan(args), include_terminal: true, ..ListOptions::default() })
            .await
            .len();
        Ok(AgentReply::Json(json!({
            "tasksRemoved": cleaned.removed,
            "tagsRemoved": tags_removed,
            "tasks": tasks,
            "workers": workers,
        })))
    }

    // ---- send ------------------------------------------------------------------------------

    async fn dispatch_prepared(&self, prepared: &super::host::Prepared, caller: &Caller, options: DispatchOptions) -> Result<AgentReply, String> {
        self.deps.send_flow.adopt_caller(prepared, caller).await?;
        self.deps.send_flow.dispatch_to_existing_session(prepared, caller, options).await
    }

    async fn send(&self, args: &Value, caller: &Caller, scope: &Scope) -> Result<AgentReply, String> {
        let attempt = async {
            let prepared = self.deps.send_flow.prepare_send(args, scope).await?;
            self.dispatch_prepared(&prepared, caller, DispatchOptions::default()).await
        }
        .await;
        match attempt {
            Ok(reply) => Ok(reply),
            Err(error) => self.respawn_dead_tag_send(error, args, caller, scope).await,
        }
    }

    /// A retained row, a reap tombstone, or (once a pruned row's tombstone has expired) the
    /// tag's own session record proves that this terminal owned the tag. Unknown tags stay
    /// errors even when the caller supplies an agent/cwd: typo absorption requires persisted
    /// same-tag evidence.
    fn inherited_tag_identity(&self, tag: &str, caller: &Caller, args: &Value, caller_cwd: &str) -> Option<Inherited> {
        let registry = &self.deps.registry;
        let row = registry.read_worker_rows(&caller.scope).ok().and_then(|rows| rows.into_iter().find(|r| clean_str(&r.tag) == tag));
        let tombstone = registry.tag_tombstone_for_tag(tag, &caller.scope);
        let record = if row.is_some() || tombstone.is_some() { None } else { registry.last_tag_session(tag, &caller.scope) };
        if row.is_none() && tombstone.is_none() && record.is_none() {
            return None;
        }
        let pick = |from_args: String, fields: [Option<&str>; 3]| -> String {
            std::iter::once(from_args).chain(fields.into_iter().map(|f| clean_str(f.unwrap_or_default()))).find(|s| !s.is_empty()).unwrap_or_default()
        };
        let (r_agent, t_agent, c_agent) = (row.as_ref().map(|r| r.agent.as_str()), tombstone.as_ref().map(|r| r.agent.as_str()), record.as_ref().map(|r| r.agent.as_str()));
        let (r_cwd, t_cwd, c_cwd) = (row.as_ref().map(|r| r.cwd.as_str()), tombstone.as_ref().map(|r| r.cwd.as_str()), record.as_ref().map(|r| r.cwd.as_str()));
        let agent = pick(clean(args.get("agent")), [r_agent, t_agent, c_agent]);
        let mut cwd = pick(clean(args.get("cwd")), [r_cwd, t_cwd, c_cwd]);
        if cwd.is_empty() {
            cwd = clean_str(caller_cwd);
        }
        if agent.is_empty() || cwd.is_empty() {
            return None;
        }
        let session_id = clean_str(row.as_ref().map_or("", |r| r.session_id.as_str()));
        let resume_session_id = [
            session_id.clone(),
            clean_str(tombstone.as_ref().map_or("", |t| t.session_id.as_str())),
            clean_str(record.as_ref().map_or("", |r| r.session_id.as_str())),
        ]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
        Some(Inherited { tombstone, session_id, resume_session_id, agent, cwd })
    }

    /// Dead-tag fallback: a same-scope follow-up can land after its tag was reaped, or after
    /// its session was closed or deleted. A reaped tag whose saved session is still stored and
    /// open continues that session (`resumed`, prior context kept). Otherwise a FRESH session
    /// is respawned under the same tag with the message as its brief (`respawned: true`).
    /// Only tag-addressed sends fall back; explicit sessionId sends keep erroring.
    async fn respawn_dead_tag_send(&self, error: String, args: &Value, caller: &Caller, scope: &Scope) -> Result<AgentReply, String> {
        let tag = clean(args.get("tag"));
        if tag.is_empty() || tag.starts_with("sess_") || !is_dead_target(&error) {
            return Err(error);
        }
        self.resume
            .serialized(&tag, caller, async {
                // A competing send or spawn of this tag may have resumed or respawned it while
                // this one waited: then this is an ordinary send to it.
                let prepared = match self.deps.send_flow.prepare_send(args, scope).await {
                    Ok(p) => Some(p),
                    Err(retry) if is_dead_target(&retry) => None,
                    Err(retry) => return Err(retry),
                };
                if let Some(prepared) = prepared {
                    return self.dispatch_prepared(&prepared, caller, DispatchOptions::default()).await;
                }
                self.resume_or_respawn(error, &tag, args, caller).await
            })
            .await
    }

    async fn resume_or_respawn(&self, error: String, tag: &str, args: &Value, caller: &Caller) -> Result<AgentReply, String> {
        let caller_cwd = caller.cwd.as_str();
        let base = if caller_cwd.is_empty() { self.deps.default_cwd.as_str() } else { caller_cwd };
        let prompt = resolve_prompt(args, base, self.deps.env.as_ref()).await?;
        let Some(inherited) = self.inherited_tag_identity(tag, caller, args, caller_cwd) else {
            return Err(error);
        };
        let resumed = self
            .resume
            .resume_tag(
                tag,
                &inherited.resume_session_id,
                ResumeRequest { operation: "send", args, caller_cwd, caller, notify: caller, tombstone: inherited.tombstone.as_ref(), route: None },
            )
            .await?;
        if let Some(reply) = resumed {
            return Ok(reply);
        }
        // Drop this terminal's trace and remove ONLY the persisted row matching the inherited
        // sessionId: a tag-wide removal would delete peer terminals' same-tag rows.
        self.deps.registry.forget_terminal_session(Some(tag), &inherited.session_id);
        if let Some(tombstone) = &inherited.tombstone {
            self.deps.registry.consume_tag_tombstone(tombstone);
        }
        let mut spawn_args = args.clone();
        if let Some(map) = spawn_args.as_object_mut() {
            map.insert("type".into(), "spawn".into());
            map.insert("tag".into(), tag.into());
            map.insert("prompt".into(), prompt.into());
            map.shift_remove("message");
            map.insert("agent".into(), inherited.agent.into());
            map.insert("cwd".into(), inherited.cwd.into());
        }
        let job = self.deps.spawn_flow.start_deferred_spawn_job(&spawn_args, caller_cwd, caller, caller, SpawnOptions { respawned: true }).await?;
        Ok(Self::spawn_result(job))
    }

    // ---- spawn -----------------------------------------------------------------------------

    /// Explicit-tag spawn priority (an auto tag always creates a fresh session):
    ///   1) live session -> send to it (reuse; it queues if busy)
    ///   2) lingering terminal trace -> reap the trace and spawn fresh under the same tag
    ///   3) reaped tag (tombstone, or past it this owner's last session record) whose saved
    ///      session can continue -> resume it; a tombstone whose session cannot -> fresh spawn
    ///      inheriting agent/cwd (`respawned`)
    ///   4) genuinely new tag -> fresh deferred spawn
    async fn resolve_explicit_tag_spawn(&self, tag: &str, args: &Value, caller: &Caller, scope: &Scope) -> Result<SpawnPlan, String> {
        let registry = &self.deps.registry;
        let caller_cwd = caller.cwd.as_str();
        let live_session_id = registry
            .resolve_tag(tag, scope, ResolveOptions { scan_sessions: wants_session_scan(args), exclude_terminal_traces: true })
            .ok()
            .flatten();
        if let Some(id) = live_session_id
            && registry.live_session(&id).is_some()
        {
            let mut named = args.clone();
            named["tag"] = Value::String(tag.to_owned());
            let mut prepared = self.deps.send_flow.prepare_send(&named, scope).await?;
            self.deps.send_flow.adopt_caller(&prepared, caller).await?;
            prepared.route = requested_route(args);
            let reply = self
                .deps
                .send_flow
                .dispatch_to_existing_session(&prepared, caller, DispatchOptions { reused: true, ..DispatchOptions::default() })
                .await?;
            return Ok(SpawnPlan::Reused(Box::new(reply)));
        }
        if self.deps.terminal_trace.has_terminal_trace(tag, scope)? {
            self.deps.terminal_trace.reap_terminal_trace_for_tag(tag, scope);
            return Ok(SpawnPlan::Fresh { args: args.clone(), respawned: true });
        }
        // Tombstone inheritance and resume never honor allTerminals/global scope.
        if let Some(tombstone) = registry.tag_tombstone_for_tag(tag, &caller.scope) {
            let resumed = self
                .resume
                .resume_tag(
                    tag,
                    &tombstone.session_id,
                    ResumeRequest { operation: "spawn", args, caller_cwd, caller, notify: caller, tombstone: Some(&tombstone), route: requested_route(args) },
                )
                .await?;
            if let Some(reply) = resumed {
                return Ok(SpawnPlan::Reused(Box::new(reply)));
            }
            registry.consume_tag_tombstone(&tombstone);
            let mut spawn_args = args.clone();
            let agent = {
                let named = clean(args.get("agent"));
                if named.is_empty() { clean_str(&tombstone.agent) } else { named }
            };
            if let Some(map) = spawn_args.as_object_mut() {
                map.insert("agent".into(), agent.into());
                if clean(args.get("cwd")).is_empty() && !clean_str(&tombstone.cwd).is_empty() {
                    map.insert("cwd".into(), tombstone.cwd.clone().into());
                }
            }
            return Ok(SpawnPlan::Fresh { args: spawn_args, respawned: true });
        }
        let foreign = registry
            .read_all_tag_tombstones()
            .into_iter()
            .any(|row| clean_str(&row.tag) == tag && !caller.scope.owns(&row.owner));
        if foreign {
            return Err(format!("agent spawn: tag \"{tag}\" belongs to another terminal"));
        }
        if let Some(record) = registry.last_tag_session(tag, &caller.scope) {
            let resumed = self
                .resume
                .resume_tag(
                    tag,
                    &record.session_id,
                    ResumeRequest { operation: "spawn", args, caller_cwd, caller, notify: caller, tombstone: None, route: requested_route(args) },
                )
                .await?;
            if let Some(reply) = resumed {
                return Ok(SpawnPlan::Reused(Box::new(reply)));
            }
        }
        Ok(SpawnPlan::Fresh { args: args.clone(), respawned: false })
    }

    async fn spawn(&self, request_args: &Value, caller: &Caller, scope: &Scope) -> Result<AgentReply, String> {
        // Resolve a user-pinned model before deferring, so a miss or an ambiguous name answers
        // this call instead of failing the background job.
        let args = resolve_requested_model(request_args, self.deps.catalog.as_deref()).await?;
        let tag = clean(args.get("tag"));
        let (spawn_args, respawned) = if tag.is_empty() {
            (args, false)
        } else {
            // One decision at a time per owner's tag: a spawn queued behind a send or spawn that
            // resumed this tag reuses it instead of resuming it again.
            match self.resume.serialized(&tag, caller, self.resolve_explicit_tag_spawn(&tag, &args, caller, scope)).await? {
                SpawnPlan::Reused(reply) => return Ok(*reply),
                SpawnPlan::Fresh { args, respawned } => (args, respawned),
            }
        };
        let job = self.deps.spawn_flow.start_deferred_spawn_job(&spawn_args, &caller.cwd, caller, caller, SpawnOptions { respawned }).await?;
        Ok(Self::spawn_result(job))
    }
}

struct Inherited {
    tombstone: Option<TagRecord>,
    session_id: String,
    resume_session_id: String,
    agent: String,
    cwd: String,
}

#[async_trait]
impl AgentPort for AgentRuntime {
    async fn execute(&self, request: AgentRequest<'_>) -> Result<AgentReply, PortError> {
        let caller = Caller { scope: self.deps.scopes.scope_of(request.thread), cwd: request.cwd.as_path().to_string_lossy().into_owned() };
        Ok(self.handle(&request.args, &caller).await)
    }
}
