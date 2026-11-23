//! The agent tool's request dispatch: list/status/read/cleanup/cancel/close/send/spawn (Node
//! `agent-tool/execute.mjs`, `execute-spawn.mjs`, `execute-send.mjs`, `close-flow.mjs`). The
//! dead-tag send fallback and explicit-tag spawn resolution live here; the flows they call
//! (prepare, dispatch, start a job) are the host's.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_tools::orch::agent::AgentPort;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::AgentRequest;
use mixdog_tools::orch::agent::ClosedView;
use mixdog_tools::orch::agent::HideFailed;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::error_text::ErrorText;
use super::host::CallerScopes;
use super::host::CloseOptions;
use super::host::DispatchOptions;
use super::host::Environment;
use super::host::Hide;
use super::host::Job;
use super::host::ListOptions;
use super::host::MemberClose;
use super::host::MemberOutcome;
use super::host::OpenSession;
use super::host::Recovered;
use super::host::Registry;
use super::host::Release;
use super::host::ReleaseOutcome;
use super::host::Released;
use super::host::ResolveOptions;
use super::host::SendFlow;
use super::host::Sessions;
use super::host::Spared;
use super::host::SpawnFlow;
use super::host::SpawnOptions;
use super::host::TaskFacts;
use super::host::Tasks;
use super::host::TerminalTrace;
use super::host::Topology;
use super::host::TurnMark;
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
use super::views::is_open_idle;

const CLOSE_REASON: &str = "cancelled by agent close";
/// The reason an owner's close is recorded with on each session of the tree.
const AGENT_CLOSE_REASON: &str = "cli-agent-close";
/// `closeFailureReason`'s fallback: the close left no barrier failure to name.
const CLOSE_NOT_RECORDED: &str = "the session close was not recorded";

/// What became of an idle agent (`releaseIdle`, `parkIdle`).
#[derive(Clone, PartialEq, Debug)]
pub enum IdleOutcome {
    /// Closed; `hide_failed`: the closed sessions that stay listed, with the reason.
    Closed {
        hide_failed: Vec<HideFailed>,
    },
    /// Its runtime was released; the agent stays open and listed.
    Parked,
    /// Its session was deleted: only the row was left, and is dropped.
    Gone,
    Busy,
    Undelivered,
    Failed {
        reason: Option<String>,
    },
}

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

/// `dropGoneRow`: a deleted session has nothing left to close, only its row and tag remain.
fn drop_gone_row(registry: &dyn Registry, tasks: &dyn Tasks, tag: &str, session_id: &str) {
    registry.remove_worker_row(session_id);
    if !tag.is_empty() {
        registry.unbind_tag(tag);
    }
    tasks.forget_lost(session_id);
}

/// `rowContext`: the scope of the row's owner session, else of its host process.
fn row_scope(row: &TagRecord) -> Scope {
    let owner = [&row.owner.parent_session_id, &row.owner.owner_session_id].into_iter().map(|id| clean_str(id)).find(|id| !id.is_empty());
    match owner {
        Some(owner) => Scope { caller_session_id: Some(owner), host_pid: None },
        None => Scope { caller_session_id: None, host_pid: row.owner.client_host_pid },
    }
}

/// `resultDelivered(row, scopedContext)`: see [`Tasks::result_delivered`]. A tag is its owner's: the row's, else the caller.
fn result_delivered(tasks: &dyn Tasks, row: &TagRecord, scope: &Scope) -> bool {
    let owner = [row.owner.parent_session_id.as_str(), row.owner.owner_session_id.as_str(), scope.caller_session_id.as_deref().unwrap_or_default()]
        .into_iter()
        .find(|id| !id.is_empty())
        .unwrap_or_default();
    tasks.result_delivered(&row.session_id, &row.tag, owner, scope)
}

/// `parkIdle(row)` (`close-flow.mjs`), the idle timer's release: an idle agent whose last result was delivered gives up
/// its runtime but stays open, listed and unhidden; a send resumes it from disk.
pub async fn park_idle(parts: CloseParts<'_>, row: &TagRecord) -> IdleOutcome {
    let CloseParts { registry, sessions, tasks } = parts;
    let scope = row_scope(row);
    if sessions.session_gone(&row.session_id).await {
        drop_gone_row(registry, tasks, &clean_str(&row.tag), &row.session_id);
        return IdleOutcome::Gone;
    }
    if sessions.turn_in_flight(&row.session_id) {
        return IdleOutcome::Busy;
    }
    if !result_delivered(tasks, row, &scope) {
        return IdleOutcome::Undelivered;
    }
    if sessions.park_session(&row.session_id).await {
        IdleOutcome::Parked
    } else {
        IdleOutcome::Failed { reason: Some("the session runtime could not be released".to_owned()) }
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
    let (ordered, _cancelling) = sessions.cancel_tree(id).await?;
    close_tree_members(sessions, tasks, &ordered, reason, options).await
}

/// The closes of a tree whose cancel holds its admission ([`Sessions::cancel_tree`]), `ordered` descendants first, as
/// [`cancel_agent_tree`] makes them.
pub async fn close_tree_members(sessions: &dyn Sessions, tasks: &dyn Tasks, ordered: &[String], reason: &str, options: CloseOptions) -> Result<bool, String> {
    let mut closed = false;
    let mut failures = Vec::new();
    for current in ordered {
        tasks.cancel_owned(current, reason);
        for row in tasks.list(&Scope::default()) {
            if row.session_id.as_deref() == Some(current.as_str()) {
                tasks.cancel(&row.task_id, reason);
            }
        }
        match sessions.try_close_covered(current, reason, options).await {
            Ok(done) => closed |= done,
            Err(error) => failures.push(error),
        }
    }
    tree_outcome(closed, failures, ordered.len())
}

/// A tree's close once every member was tried: one failure's text, or for several the count of the failed among the
/// tree's `members` and each text; otherwise whether any member was there to close.
fn tree_outcome(closed: bool, mut failures: Vec<String>, members: usize) -> Result<bool, String> {
    match failures.len() {
        0 => Ok(closed),
        1 => Err(failures.remove(0)),
        count => Err(format!("agent tree cancel failed for {count} of {members} sessions: {}", failures.join("; "))),
    }
}

/// The tree below `current` (each session once across `seen`), descendants first.
pub fn visit_descendants_first(children: &dyn Fn(&str) -> Vec<String>, current: &str, seen: &mut HashSet<String>, ordered: &mut Vec<String>) {
    if !seen.insert(current.to_owned()) {
        return;
    }
    for child in children(current) {
        visit_descendants_first(children, &child, seen, ordered);
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
    if registry.live_session(session_id).await.is_some_and(|s| is_lead_pool_agent(&s.agent)) {
        return Err(format!("agent close: target \"{target}\" is a Lead session"));
    }
    let tag = registry.tag_for_session(session_id).await;
    if sessions.session_gone(session_id).await {
        let row_tag = match tag.as_deref().filter(|tag| !tag.is_empty()) {
            Some(tag) => tag,
            None if target.starts_with("sess_") => "",
            None => target,
        };
        drop_gone_row(registry, tasks, row_tag, session_id);
        if let Some(id) = &task_id_out {
            tasks.cancel(id, CLOSE_REASON);
        }
        return Ok(ClosedView {
            closed: true,
            session_gone: true,
            note: Some("the session was already gone; its row was dropped".to_owned()),
            tag,
            session_id: Some(session_id.to_owned()),
            task_id: task_id_out,
            ..ClosedView::default()
        });
    }
    let descendants = sessions.descendant_session_ids(session_id).await?;
    let mut hide_failed = Vec::new();
    sessions.clear_statusline_route(session_id);
    cancel_session_tasks(tasks, session_id, target, scope);
    let ok = cancel_agent_tree(sessions, tasks, session_id, AGENT_CLOSE_REASON, CloseOptions { tombstone: false, owner_close: !keep_row }).await?;
    if let Some(id) = &task_id_out {
        tasks.cancel(id, CLOSE_REASON);
    }
    // Drop the row only once the cancellation is durably recorded: a failed close that
    // still forgot the row would leave no cancelled state behind.
    if ok && !keep_row {
        // The sessions stay open (a send reuses them), so a later scan, even after a
        // restart, would list them again: the owner's close is remembered on each.
        let Released { releases, spared } = registry.release_closed_at(scope, tag.as_deref(), session_id, &descendants, None);
        let Receipts { hides, unstored, .. } = receipts(releases).await;
        // A closed agent's session is hidden from the lists once its release is stored; a send that uses it again
        // lists it again. A member that was spared, or whose release is not stored, stays listed and says why.
        hide_failed.extend(spared.into_iter().map(|Spared { session_id, reason }| HideFailed { session_id, reason }));
        hide_failed.extend(unstored.into_iter().map(|(session_id, reason)| HideFailed { session_id, reason: format!("its release was not stored: {reason}") }));
        hide_failed.extend(sessions.hide_sessions(&hides).await);
    }
    // A close that did not land names why. Node reads the barrier failure its runtime entry kept; a close that fails
    // its durable stamp is this function's `Err` here, so what is left is the close that recorded nothing.
    let reason = (!ok).then(|| CLOSE_NOT_RECORDED.to_owned());
    Ok(ClosedView { closed: ok, tag, session_id: Some(session_id.to_owned()), task_id: task_id_out, reason, hide_failed, ..ClosedView::default() })
}

fn is_lead_pool_agent(agent: &str) -> bool {
    clean_str(agent).to_lowercase() == "lead"
}

/// The collaborators of [`cleanup_idle`], owned: a close it accepted goes on after its caller stops waiting.
#[derive(Clone)]
pub struct CleanupParts {
    pub registry: Arc<dyn Registry>,
    pub sessions: Arc<dyn Sessions>,
    pub tasks: Arc<dyn Tasks>,
}

/// What [`cleanup_idle`] did.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct CleanupReport {
    pub agents_closed: u64,
    pub gone_rows_cleared: u64,
    /// The tags the cleanup itself unbound: of the rows it cleared and the trees it closed.
    pub tags_removed: u64,
    pub leftovers_hidden: usize,
    pub not_closed: Vec<Value>,
    pub not_hidden: Vec<Value>,
    /// The scope's worker rows a list shows, as the cleanup ends.
    pub workers: usize,
    /// The scope's jobs, as the cleanup ends.
    pub tasks: usize,
    /// The cancellation stopped it before every planned close was begun.
    pub cancelled: bool,
}

/// An open idle worker the plan closes with the agents below it: `members` descendants first and the root last, each
/// member in one tree of the whole cleanup.
struct Tree {
    row: TagRecord,
    lead: bool,
    members: Vec<Member>,
}

struct Member {
    id: String,
    /// The turn the plan judged idle.
    turn: Option<TurnMark>,
}

/// The one reading a cleanup decides from.
struct CleanupPlan {
    scope: Scope,
    gone: Vec<TagRecord>,
    trees: Vec<Tree>,
    open: Vec<OpenSession>,
    jobs: Vec<TaskFacts>,
    scoped_jobs: Vec<TaskFacts>,
}

async fn plan_cleanup(parts: &CleanupParts, scope: &Scope, topology: Topology) -> CleanupPlan {
    let CleanupParts { registry, sessions, tasks } = parts;
    let Topology { children, present, leads, open } = topology;
    let mut plan =
        CleanupPlan { scope: scope.clone(), gone: Vec::new(), trees: Vec::new(), open, jobs: tasks.list(&Scope::default()), scoped_jobs: tasks.list(scope) };
    let mut visited = HashSet::new();
    for row in registry.read_worker_rows(scope).unwrap_or_default() {
        let id = clean_str(&row.session_id);
        if id.is_empty() {
            continue;
        }
        // A row of any status whose session was deleted is only a leftover. A listed session is there.
        if !present.contains(&id) && sessions.session_gone(&id).await {
            plan.gone.push(row);
            continue;
        }
        if !is_open_idle(&row.status, &row.stage) || visited.contains(&id) {
            continue;
        }
        let mut members = Vec::new();
        visit_descendants_first(&|current| children.get(current).cloned().unwrap_or_default(), &id, &mut visited, &mut members);
        // A tree whose every session its owner closed, with no turn started on any since, is closed already: a scan
        // indexed it again so a send reaches it.
        if members.iter().all(|member| registry.is_released(member)) {
            continue;
        }
        let members = members.into_iter().map(|id| Member { turn: registry.turn_mark(&id), id }).collect();
        plan.trees.push(Tree { lead: leads.contains(&id), row, members });
    }
    plan
}

/// `agent cleanup`'s closes (`close-flow.mjs`), over one plan read from `topology` (the listing of the agent sessions
/// the caller's refresh made, [`Registry::refresh_topology`]): the rows whose session was deleted are dropped, and each
/// open idle worker whose last result was delivered is closed with the agents below it, as `agent close` closes it;
/// then the idle sessions of the scope no row points to are hidden.
///
/// The plan is applied on a task of its own: a member whose close began is closed, released and hidden whether or not
/// the caller still waits. `cancel` is read before each member's close; once it is cancelled no other close begins.
/// Each tree is read again before its close: one that is no longer owned, open and idle, whose member is running or at
/// another turn than the plan judged idle, or that holds an unread result, is left alone, and each member's stamp lands
/// only at that turn. The agent-status signals of the planned sessions are announced once, at its end.
pub async fn cleanup_idle(
    parts: CleanupParts,
    scope: &Scope,
    (topology, recovered): (Topology, Recovered),
    cancel: CancellationToken,
) -> Result<CleanupReport, String> {
    let scope = scope.clone();
    // The task owns what the scan recovered from before the plan is read: a caller that stops waiting leaves one announcement.
    let cleanup = async move {
        let plan = plan_cleanup(&parts, &scope, topology).await;
        apply_cleanup(parts, plan, recovered, cancel).await
    };
    mixdog_rt::spawn("agent-cleanup", mixdog_rt::TaskClass::Work, cleanup).await.map_err(|error| format!("agent cleanup: {error}"))
}

async fn apply_cleanup(parts: CleanupParts, plan: CleanupPlan, recovered: Recovered, cancel: CancellationToken) -> CleanupReport {
    let CleanupParts { registry, sessions, tasks } = &parts;
    let Recovered { sessions: scanned, holds: scan_holds } = recovered;
    let held: Vec<String> = scanned
        .into_iter()
        .chain(plan.gone.iter().map(|row| clean_str(&row.session_id)))
        .chain(plan.trees.iter().flat_map(|tree| tree.members.iter().map(|m| m.id.clone())))
        .collect();
    let hold = sessions.hold_publication(&held);
    // What the refresh's scan wrote is owed to this hold from here.
    drop(scan_holds);
    let mut report = CleanupReport::default();
    let mut removed = HashSet::new();
    // What an earlier cleanup released and could not store is stored first, as the operation it was, and hidden now
    // that it is: its hide waited for this receipt.
    let recovered = receipts(registry.recover_releases(&plan.scope)).await;
    for (member, reason) in recovered.unstored {
        report.not_closed.push(release_not_stored("", &member, &reason));
    }
    for failed in sessions.hide_sessions(&recovered.hides).await {
        report.not_hidden.push(json!({ "tag": Value::Null, "sessionId": failed.session_id, "reason": failed.reason }));
    }
    for row in &plan.gone {
        if cancel.is_cancelled() {
            report.cancelled = true;
            break;
        }
        let id = clean_str(&row.session_id);
        cancel_planned_jobs(&**tasks, &plan.scoped_jobs, &id, &id);
        // The tag goes only while it is this row's: it may have been bound to another session since the plan.
        let tag = clean_str(&row.tag);
        report.tags_removed += u64::from(registry.tag_session(&tag).as_deref() == Some(id.as_str()));
        registry.forget_terminal_session(Some(&tag), &id);
        tasks.forget_lost(&id);
        removed.insert(id);
        report.gone_rows_cleared += 1;
    }
    for tree in &plan.trees {
        if report.cancelled || cancel.is_cancelled() {
            report.cancelled = true;
            break;
        }
        close_tree(&parts, &plan, tree, &cancel, &mut report, &mut removed).await;
    }
    if !report.cancelled {
        let (hidden, failed) = hide_leftovers(&parts, &plan, &removed).await;
        report.leftovers_hidden = hidden;
        for failed in failed {
            report.not_hidden.push(json!({ "tag": Value::Null, "sessionId": failed.session_id, "reason": failed.reason }));
        }
    }
    sessions.publish_held(hold).await;
    // Counted once the cleanup's writes landed: what the scope lists as the reply is made.
    report.tasks = tasks.list(&plan.scope).len();
    report.workers = registry
        .read_worker_rows(&plan.scope)
        .unwrap_or_default()
        .iter()
        .filter(|row| !clean_str(&row.tag).is_empty() && !registry.is_released(&clean_str(&row.session_id)))
        .count();
    report
}

fn tag_or_null(tag: &str) -> Value {
    if tag.is_empty() { Value::Null } else { Value::String(tag.to_owned()) }
}

/// The planned jobs bound to `session_id` or `target`, cancelled before the session closes.
fn cancel_planned_jobs(tasks: &dyn Tasks, jobs: &[TaskFacts], session_id: &str, target: &str) {
    for job in jobs.iter().filter(|job| job.session_id.as_deref() == Some(session_id) || job.tag.as_deref() == Some(target)) {
        tasks.cancel(&job.task_id, CLOSE_REASON);
    }
}

/// What a batch of releases came to, each one's own receipt awaited.
#[derive(Default)]
struct Receipts {
    /// Every member a release was decided for, whatever became of it.
    released: Vec<String>,
    /// The hide of each release that came back stored. No other outcome hides its session: what the store holds of it
    /// is then not this release, whatever the registry's map says.
    hides: Vec<Hide>,
    /// Those whose release did not come back stored, with why.
    unstored: Vec<(String, String)>,
}

async fn receipts(releases: Vec<Release>) -> Receipts {
    let mut receipts = Receipts::default();
    for Release { receipt, done } in releases {
        match done.outcome().await {
            ReleaseOutcome::Stored => receipts.hides.push(receipt.hide()),
            ReleaseOutcome::Refused(reason) => receipts.unstored.push((receipt.session_id.clone(), reason)),
            ReleaseOutcome::Superseded(reason) => receipts.unstored.push((receipt.session_id.clone(), format!("superseded: {reason}"))),
            ReleaseOutcome::Indeterminate(reason) => receipts.unstored.push((receipt.session_id.clone(), format!("{reason} (outcome unknown)"))),
        }
        receipts.released.push(receipt.session_id);
    }
    receipts
}

/// The `notClosed` entry of a member whose release is not stored: the session a later cleanup recovers.
fn release_not_stored(tag: &str, session_id: &str, reason: &str) -> Value {
    json!({ "tag": tag_or_null(tag), "sessionId": session_id, "reason": format!("agent close: the release of \"{session_id}\" was not stored: {reason}") })
}

/// One tree of the plan, closed as [`close_resolved`] closes it once it is read again: each member under the tree's
/// admission guard and only at the turn the plan judged idle; its jobs (and the root's statusline route) go once its
/// stamp landed. A tree stopped partway (a cancellation, a member that moved on, a failure) leaves its stamped members
/// closed, released and hidden, and the rest as they were.
async fn close_tree(
    parts: &CleanupParts,
    plan: &CleanupPlan,
    tree: &Tree,
    cancel: &CancellationToken,
    report: &mut CleanupReport,
    removed: &mut HashSet<String>,
) {
    let CleanupParts { registry, sessions, tasks } = parts;
    let root = clean_str(&tree.row.session_id);
    let ids: Vec<String> = tree.members.iter().map(|member| member.id.clone()).collect();
    let Some(row) = registry.worker_row(&root) else { return };
    if !is_open_idle(&row.status, &row.stage) || !plan.scope.owns(&row.owner) {
        return;
    }
    for member in &tree.members {
        if sessions.turn_in_flight(&member.id) || registry.turn_mark(&member.id) != member.turn {
            return;
        }
        let current = if member.id == root { Some(row.clone()) } else { registry.worker_row(&member.id) };
        if current.is_some_and(|current| !result_delivered(&**tasks, &current, &plan.scope)) {
            return;
        }
    }
    let not_closed = |reason: String| json!({ "tag": tag_or_null(&row.tag), "sessionId": root, "reason": reason });
    if tree.lead {
        report.not_closed.push(not_closed(format!("agent close: target \"{root}\" is a Lead session")));
        return;
    }
    // No turn is admitted in the tree from here.
    let _cancelling = sessions.begin_cancellation(&ids);
    let tag = registry.tag_for_session(&root).await;
    // Each member's own outcome, under its own id: none stands in for another's.
    let of_member =
        |member: &str, reason: String| json!({ "tag": tag_or_null(if member == root { &row.tag } else { "" }), "sessionId": member, "reason": reason });
    let another_turn = |member: &str| format!("agent close: \"{member}\" started another turn during the cleanup");
    let (mut closed, mut stamped, mut failed, mut moved) = (false, Vec::new(), false, None);
    for member in &tree.members {
        if cancel.is_cancelled() {
            report.cancelled = true;
            break;
        }
        let fence = MemberClose { turn: member.turn.clone(), stamped: registry.is_released(&member.id) };
        match sessions.close_member(&member.id, AGENT_CLOSE_REASON, CloseOptions { tombstone: false, owner_close: true }, fence).await {
            // Neither has anything of this close to stop: the member's jobs are its running turn's. A member that
            // moved on before anything was done to it leaves the tree as it was, which is said only when members
            // before it were closed; one stamped and then resumed was not left as it was, and always says so.
            Ok(outcome @ (MemberOutcome::Moved | MemberOutcome::Resumed)) => {
                if outcome == MemberOutcome::Resumed {
                    report.not_closed.push(of_member(&member.id, another_turn(&member.id)));
                } else if !stamped.is_empty() {
                    report.not_closed.push(not_closed(another_turn(&member.id)));
                }
                moved = Some(member.id.clone());
                break;
            }
            Ok(outcome) => {
                if member.id == root {
                    sessions.clear_statusline_route(&root);
                    cancel_planned_jobs(&**tasks, &plan.scoped_jobs, &root, &root);
                }
                tasks.cancel_owned(&member.id, AGENT_CLOSE_REASON);
                for job in plan.jobs.iter().filter(|job| job.session_id.as_deref() == Some(member.id.as_str())) {
                    tasks.cancel(&job.task_id, AGENT_CLOSE_REASON);
                }
                if outcome == MemberOutcome::Closed {
                    closed = true;
                    stamped.push(member.id.clone());
                }
            }
            Err(error) => {
                failed = true;
                report.not_closed.push(of_member(&member.id, error));
            }
        }
    }
    let whole = moved.is_none() && !report.cancelled;
    // A tree left as it was (the first member moved on, or the cancellation came first) is no failure; one every
    // member of which was tried and none closed recorded nothing.
    if whole && !failed && !closed {
        report.not_closed.push(not_closed(CLOSE_NOT_RECORDED.to_owned()));
    }
    let complete = whole && !failed && closed;
    // A member a turn started on since its close keeps its row: it is released only at the turn the plan judged idle.
    let at: HashMap<String, Option<TurnMark>> = tree.members.iter().map(|member| (member.id.clone(), member.turn.clone())).collect();
    // A release of the root unbinds its tag only while the tag is still its own.
    let bound = tag.as_deref().is_some_and(|tag| registry.tag_session(tag).as_deref() == Some(root.as_str()));
    let (hides, released, unstored, spared) = if complete {
        let Released { releases, mut spared } = registry.release_closed_at(&plan.scope, tag.as_deref(), &root, &ids[..ids.len() - 1], Some(&at));
        let Receipts { released, hides, unstored } = receipts(releases).await;
        // A planned member the registry answered nothing for has no receipt either: it is spared like the others.
        for id in ids.iter().filter(|id| !released.contains(id)) {
            if !spared.iter().any(|member| member.session_id == *id) {
                spared.push(Spared { session_id: id.clone(), reason: "was not released".to_owned() });
            }
        }
        if released.contains(&root) {
            // The tree counts once, here, when its root qualified, no required member was spared and every required
            // receipt came back stored. The unbind in memory, the hide below and a later recovery of a release that
            // was not stored stand in for none of them: a partial invocation is never counted.
            report.agents_closed += u64::from(unstored.is_empty() && spared.is_empty());
            report.tags_removed += u64::from(bound);
        }
        (hides, released, unstored, spared)
    } else {
        // The root comes last. One that closed gives its tag back as in a whole close: the next scan indexes it again and
        // the cleanup after it reaches the members left open below it. One left open keeps its tag and row.
        let Some((last, rest)) = stamped.split_last() else { return };
        let tag = if *last == root { tag.as_deref() } else { None };
        let Released { releases, spared } = registry.release_closed_at(&plan.scope, tag, last, rest, Some(&at));
        let Receipts { released, hides, unstored } = receipts(releases).await;
        report.tags_removed += u64::from(tag.is_some() && bound && released.contains(&root));
        (hides, released, unstored, spared)
    };
    // Each spared member is its own outcome, under its own id and with its own reason.
    for Spared { session_id, reason } in spared {
        let tag = if session_id == root { row.tag.as_str() } else { "" };
        report.not_closed.push(json!({ "tag": tag_or_null(tag), "sessionId": session_id, "reason": format!("agent close: \"{session_id}\" {reason}") }));
    }
    for (member, reason) in unstored {
        report.not_closed.push(release_not_stored(if member == root { &row.tag } else { "" }, &member, &reason));
    }
    removed.extend(released);
    for failed in sessions.hide_sessions(&hides).await {
        report.not_hidden.push(json!({ "tag": tag_or_null(&row.tag), "sessionId": failed.session_id, "reason": failed.reason }));
    }
}

/// `hideLeftovers`: the idle sessions of the scope's agents that no worker row points to (what earlier closes left open)
/// are hidden, not closed; a session this cleanup closed was hidden with its close. What is read here only picks them:
/// each hide is written only while no turn runs on its session ([`Hide`]), so one taken up since stays listed. Answers
/// how many hides were asked for and did not fail, and the ones that failed.
async fn hide_leftovers(parts: &CleanupParts, plan: &CleanupPlan, closed: &HashSet<String>) -> (usize, Vec<HideFailed>) {
    let CleanupParts { registry, sessions, tasks } = parts;
    let mut pointed: HashSet<String> = registry.read_worker_rows(&Scope::default()).unwrap_or_default().iter().map(|row| clean_str(&row.session_id)).collect();
    pointed.extend(registry.bound_sessions());
    let mut leftovers = Vec::new();
    for session in &plan.open {
        let (id, tag, status) = (clean_str(&session.id), clean_str(&session.tag), clean_str(&session.status));
        if id.is_empty() || pointed.contains(&id) || closed.contains(&id) {
            continue;
        }
        if tag.is_empty() || is_lead_pool_agent(&session.agent) || !plan.scope.owns(&session.owner) {
            continue;
        }
        if !(status.is_empty() || status == "idle") || sessions.turn_in_flight(&id) || sessions.is_hidden(&id).await {
            continue;
        }
        // The row Node builds here names the session and its tag only: the tag's owner is the caller.
        let row = TagRecord { session_id: id.clone(), tag, ..TagRecord::default() };
        if result_delivered(&**tasks, &row, &plan.scope) {
            leftovers.push(Hide { session_id: id, released_at: None });
        }
    }
    let failed = sessions.hide_sessions(&leftovers).await;
    (leftovers.len().saturating_sub(failed.len()), failed)
}

/// `errorLine`: the presented text, headed `Error:` unless it already is.
pub(crate) fn error_line(presented: &str) -> String {
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
        match self.run(args, caller, &CancellationToken::new()).await {
            Ok(reply) => reply,
            Err(message) => AgentReply::Text(error_line(&self.deps.errors.present(&message))),
        }
    }

    async fn run(&self, args: &Value, caller: &Caller, cancel: &CancellationToken) -> Result<AgentReply, String> {
        // A tool call reads every legacy tombstone with its owner.
        self.deps.registry.resolve_tombstone_owners().await;
        let kind = clean(args.get("type"));
        let kind = if kind.is_empty() { "spawn".to_owned() } else { kind };
        let scope = Scope::of(args, &caller.scope);
        // Rebuild tag ownership from canonical records even if a daemon crash happened before
        // the auxiliary worker row was flushed.
        // A cleanup makes this refresh itself, from the one listing it plans over.
        let rehydrated = self.deps.sessions.rehydrate_agent_sessions().await;
        if rehydrated && kind != "cleanup" {
            self.deps.registry.refresh_tags_from_sessions(true, &scope).await?;
        }
        let views = &self.deps.views;
        match kind.as_str() {
            "status" | "list" => {
                if kind == "status" && !(clean(args.get("task_id")).is_empty() && clean(args.get("tag")).is_empty() && clean(args.get("sessionId")).is_empty())
                {
                    let job = views.get_job_or_worker(args, &scope, false).await?;
                    return Ok(AgentReply::Task { view: job.view, diagnostics: true });
                }
                // Targetless status is the same compact overview as list. Idle workers stay
                // open for follow-ups; the roster counts them and lists a bounded tail.
                let workers = views
                    .list(&scope, ListOptions { scan_sessions: wants_session_scan(args), include_idle: true, include_closed: true, include_terminal: false })
                    .await?;
                Ok(AgentReply::Roster { workers, jobs: views.list_jobs(&scope).await })
            }
            "read" => self.read_job(args, &scope).await,
            "cleanup" => self.cleanup(args, &scope, rehydrated, cancel).await,
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

    async fn tag_bound_by_caller(&self, target: &str, scope: &Scope) -> bool {
        let registry = &self.deps.registry;
        let live = match registry.tag_session(target) {
            Some(id) => registry.live_session(&id).await,
            None => None,
        };
        if let Some(live) = live {
            return scope.owns(&live.owner);
        }
        registry.read_worker_rows(scope).map(|rows| rows.iter().any(|r| clean_str(&r.tag) == target)).unwrap_or(false)
    }

    /// `keep_row`: a process exit closes the worker but leaves its row for the next process.
    pub async fn close(&self, args: &Value, caller: &Caller, keep_row: bool) -> Result<ClosedView, String> {
        let scope = Scope::of(args, &caller.scope);
        let registry = &self.deps.registry;
        registry.refresh_tags_from_sessions(wants_session_scan(args), &scope).await?;
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
                return Ok(ClosedView { closed: true, tag: task.tag.clone(), task_id: Some(task.task_id), ..ClosedView::default() });
            }
            return Err("agent close: tag or sessionId is required".into());
        }
        let task_id_out = task.as_ref().map(|t| t.task_id.clone());
        let Some(session_id) = registry
            .resolve_tag(&target, &scope, ResolveOptions { scan_sessions: wants_session_scan(args), exclude_terminal_traces: false, skip_released: false })
            .await?
        else {
            if !target.starts_with("sess_") && registry.has_tag_agent(&target) && self.tag_bound_by_caller(&target, &scope).await {
                registry.unbind_tag(&target);
                if let Some(id) = &task_id_out {
                    self.deps.tasks.cancel(id, CLOSE_REASON);
                }
                return Ok(ClosedView { closed: true, tag: Some(target), task_id: task_id_out, forgotten: true, ..ClosedView::default() });
            }
            return Err(format!("agent close: target \"{target}\" not found"));
        };
        close_resolved(
            CloseParts { registry: &*self.deps.registry, sessions: &*self.deps.sessions, tasks: &*self.deps.tasks },
            &session_id,
            &target,
            &scope,
            task_id_out,
            keep_row,
        )
        .await
    }

    /// `rehydrated`: the stored agent sessions were reloaded, so the refresh scans them as the call's preamble would.
    async fn cleanup(&self, args: &Value, scope: &Scope, rehydrated: bool, cancel: &CancellationToken) -> Result<AgentReply, String> {
        let registry = &self.deps.registry;
        let listed = registry.refresh_topology(rehydrated || wants_session_scan(args), scope).await?;
        let cleaned = self.deps.tasks.cleanup(scope, args.get("force") == Some(&Value::Bool(true)));
        let parts = CleanupParts { registry: Arc::clone(registry), sessions: Arc::clone(&self.deps.sessions), tasks: Arc::clone(&self.deps.tasks) };
        let report = cleanup_idle(parts, scope, listed, cancel.clone()).await?;
        let mut reply = serde_json::Map::new();
        reply.insert("tasksRemoved".into(), json!(cleaned.removed));
        reply.insert("tagsRemoved".into(), json!(report.tags_removed));
        reply.insert("agentsClosed".into(), json!(report.agents_closed));
        if report.gone_rows_cleared > 0 {
            reply.insert("goneRowsCleared".into(), json!(report.gone_rows_cleared));
        }
        reply.insert("leftoversHidden".into(), json!(report.leftovers_hidden));
        if !report.not_closed.is_empty() {
            reply.insert("notClosed".into(), Value::Array(report.not_closed));
        }
        if !report.not_hidden.is_empty() {
            reply.insert("notHidden".into(), Value::Array(report.not_hidden));
        }
        reply.insert("tasks".into(), json!(report.tasks));
        reply.insert("workers".into(), json!(report.workers));
        Ok(AgentReply::Json(Value::Object(reply)))
    }

    // ---- send ------------------------------------------------------------------------------

    async fn dispatch_prepared(&self, prepared: &super::host::Prepared, caller: &Caller, options: DispatchOptions) -> Result<AgentReply, String> {
        self.deps.sessions.reveal_session(&prepared.session_id).await;
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

    async fn inherited_tag_identity(&self, tag: &str, caller: &Caller, args: &Value, caller_cwd: &str) -> Option<Inherited> {
        let registry = &self.deps.registry;
        let row = registry.read_worker_rows(&caller.scope).ok().and_then(|rows| rows.into_iter().find(|r| clean_str(&r.tag) == tag));
        let tombstone = registry.tag_tombstone_for_tag(tag, &caller.scope);
        let record = if row.is_some() || tombstone.is_some() { None } else { registry.last_tag_session(tag, &caller.scope).await };
        if row.is_none() && tombstone.is_none() && record.is_none() {
            return None;
        }
        let pick = |from_args: String, fields: [Option<&str>; 3]| -> String {
            std::iter::once(from_args).chain(fields.into_iter().map(|f| clean_str(f.unwrap_or_default()))).find(|s| !s.is_empty()).unwrap_or_default()
        };
        let (r_agent, t_agent, c_agent) =
            (row.as_ref().map(|r| r.agent.as_str()), tombstone.as_ref().map(|r| r.agent.as_str()), record.as_ref().map(|r| r.agent.as_str()));
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
        let Some(inherited) = self.inherited_tag_identity(tag, caller, args, caller_cwd).await else {
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
            self.deps.sessions.reveal_session(&inherited.resume_session_id).await;
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

    async fn resolve_explicit_tag_spawn(&self, tag: &str, args: &Value, caller: &Caller, scope: &Scope) -> Result<SpawnPlan, String> {
        let registry = &self.deps.registry;
        let caller_cwd = caller.cwd.as_str();
        let live_session_id = registry
            .resolve_tag(tag, scope, ResolveOptions { scan_sessions: wants_session_scan(args), exclude_terminal_traces: true, skip_released: true })
            .await
            .ok()
            .flatten();
        let live = match &live_session_id {
            Some(id) => registry.live_session(id).await,
            None => None,
        };
        if let Some(live) = live {
            // A spawn reuses a session only when the request fits it, as a resume does (`request_fits`): the tag is
            // taken, so a spawn that asks for another agent or directory is refused, not answered by this session.
            if !self.resume.request_fits(&live.agent, &live.cwd, args, caller_cwd) {
                return Err(format!(
                    "agent spawn: tag \"{tag}\" is in use by agent \"{}\" in \"{}\"; use another tag for a different agent or directory, or close it first",
                    live.agent, live.cwd
                ));
            }
            let mut named = args.clone();
            named["tag"] = Value::String(tag.to_owned());
            let mut prepared = self.deps.send_flow.prepare_send(&named, scope).await?;
            self.deps.sessions.reveal_session(&prepared.session_id).await;
            self.deps.send_flow.adopt_caller(&prepared, caller).await?;
            prepared.route = requested_route(args);
            let reply =
                self.deps.send_flow.dispatch_to_existing_session(&prepared, caller, DispatchOptions { reused: true, ..DispatchOptions::default() }).await?;
            return Ok(SpawnPlan::Reused(Box::new(reply)));
        }
        if self.deps.terminal_trace.has_terminal_trace(tag, scope).await? {
            self.deps.terminal_trace.reap_terminal_trace_for_tag(tag, scope).await;
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
                self.deps.sessions.reveal_session(&tombstone.session_id).await;
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
        let foreign = registry.read_all_tag_tombstones().into_iter().any(|row| clean_str(&row.tag) == tag && !caller.scope.owns(&row.owner));
        if foreign {
            return Err(format!("agent spawn: tag \"{tag}\" belongs to another terminal"));
        }
        if let Some(record) = registry.last_tag_session(tag, &caller.scope).await {
            let resumed = self
                .resume
                .resume_tag(
                    tag,
                    &record.session_id,
                    ResumeRequest { operation: "spawn", args, caller_cwd, caller, notify: caller, tombstone: None, route: requested_route(args) },
                )
                .await?;
            if let Some(reply) = resumed {
                self.deps.sessions.reveal_session(&record.session_id).await;
                return Ok(SpawnPlan::Reused(Box::new(reply)));
            }
        }
        Ok(SpawnPlan::Fresh { args: args.clone(), respawned: false })
    }

    async fn spawn(&self, request_args: &Value, caller: &Caller, scope: &Scope) -> Result<AgentReply, String> {
        // Resolve a user-pinned model before deferring, so a miss or an ambiguous name answers
        // this call instead of failing the background job.
        let (args, route_note) = resolve_requested_model(request_args, self.deps.catalog.as_deref()).await?;
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
        let mut job = self.deps.spawn_flow.start_deferred_spawn_job(&spawn_args, &caller.cwd, caller, caller, SpawnOptions { respawned }).await?;
        if !route_note.is_empty() {
            job.view.note = Some(match job.view.note.take().filter(|n| !n.is_empty()) {
                Some(existing) => format!("{existing}; {route_note}"),
                None => route_note,
            });
        }
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
        let caller = Caller {
            scope: self.deps.scopes.scope_of(request.thread),
            cwd: request.cwd.as_path().to_string_lossy().into_owned(),
            tool_call_id: Some(request.call.as_str().to_owned()),
            hop: self.deps.scopes.turn_hop(request.thread),
        };
        // The resolved image, PDF and file parts ride in the call's arguments, where the spawn and
        // send flows read them for the worker's turn (and its queued follow-up).
        let mut args = request.args;
        if !request.attachment_parts.is_empty()
            && let Some(object) = args.as_object_mut()
        {
            object.insert("attachmentParts".into(), Value::Array(request.attachment_parts));
        }
        self.run(&args, &caller, request.cancel)
            .await
            .map_err(|message| PortError::Failed { capability: "agent".to_owned(), message: self.deps.errors.present(&message) })
    }
}
