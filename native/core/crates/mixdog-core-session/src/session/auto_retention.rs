use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::Domains;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::lead::LeadFilter;
use mixdog_store::sqlite::lead::LeadRow;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::archive_trees::AdmissionGate;
use super::archive_trees::Admit;
use super::archive_trees::ArchiveTrees;
use super::archive_trees::PolicyIdentity;
use super::archive_trees::TreeOutcome;
use super::thread_settings::ConfigArchiveRetention;
use super::thread_settings::RetentionRecord;
use super::thread_settings::settle_read_cursor;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `AWAITING_USER_GRACE_MS`: a session waiting on the user stays out of the archive this long.
const AWAITING_USER_GRACE_MS: f64 = DAY_MS;
/// `catalog` page size of the listing the pass reads.
const PAGE: usize = 500;
const CALLER: &str = "session-auto-retention";

/// `SessionRetentionPolicy`: days of no use before an archive, days archived before a delete; `0` turns the step off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub archive_days: i64,
    pub delete_days: i64,
}

/// What the rule reads of one listed session (Node's `DesktopSessionSummary` fields and `hasBackgroundJobs`, `isVisible`,
/// `hasScheduledResume` of its input). The live ones (`working`, `awaiting_approval`, `visible`) are the core's own state of the
/// session as the listing overlays it; the rest is the catalog row.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub id: String,
    /// `favoriteAt` of the row (`favorite`).
    pub favorite: bool,
    /// The id names an agent's home thread (`agentHome`).
    pub agent_home: bool,
    /// The id names a room's log (`agentRoom`).
    pub agent_room: bool,
    /// `sessionMode === 'agent'`.
    pub agent_mode: bool,
    /// `sourceType` is `schedule` or `webhook`.
    pub automation: bool,
    /// A task session a bot's run made (`taskFrom === 'run'`: `sourceType` `lead`, `sourceName` `agent:<id>@run`).
    pub task_run: bool,
    /// A sub-agent session (`agentSession`, or Node's `isAgentOnlySession`).
    pub agent_session: bool,
    /// Its own turn is in flight, or an agent's working for it (`working`, `leadWorking`, `agentWorking`).
    pub working: bool,
    /// A tool approval or question is showing (`awaitingApproval`).
    pub awaiting_approval: bool,
    /// A window (or phone) is subscribed to it: Node's `visibleSessionIds`.
    pub visible: bool,
    /// A quota resume is queued for it (`quota-resume.json`).
    pub scheduled_resume: bool,
    pub archived: bool,
    /// `positive(activityAt) || positive(updatedAt)`.
    pub activity_at: f64,
    /// `Number(messageCount) || 0`.
    pub message_count: f64,
    /// `readMessageCount`: the settled read cursor, none while the session was never read anywhere.
    pub read_message_count: Option<f64>,
    /// `incomingTail`: the places of the messages that arrived, when the row has one.
    pub incoming_tail: Option<Vec<f64>>,
    /// The row's own `lastUsedAt`: what the idle delete must still find on disk.
    pub last_used_at: f64,
    /// The activity stamp the session's actor compares (`sub_agent_retention::activity_at` of the row): what an archive or a
    /// delete states it judged.
    pub activity_stamp: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Archive,
    Delete,
}

/// The daemon's idle-only delete's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdleDelete {
    pub deleted: bool,
    pub reason: Option<String>,
}

/// What the pass reads and does in the session runtime.
#[async_trait]
pub trait AutoRetentionHost: Send + Sync {
    /// The saved policy, read at each use; none when a stored value is invalid (`readSessionRetention() === null`).
    fn policy(&self) -> Option<Policy>;
    /// The policy's identity, moved by every install of a changed policy ([`PolicyIdentity`]): an archive judged under one
    /// identity is admitted only while it is current.
    fn identity(&self) -> Arc<PolicyIdentity>;
    /// `sessionRetention.load()`.
    async fn record(&self) -> Result<RetentionRecord, String>;
    /// Every listed session.
    async fn sessions(&self) -> Result<Vec<Session>, String>;
    /// One session as the listing has it now; none when it is gone.
    async fn session(&self, id: &str) -> Result<Option<Session>, String>;
    /// The stamp of its archive (`archivedAt`), none when it has none.
    async fn archived_stamp(&self, id: &str) -> Result<Option<f64>, String>;
    /// It holds background shell jobs (`shellJobsPoller.statusFor(..).count > 0`).
    async fn background_jobs(&self, id: &str) -> Result<bool, String>;
    /// `hasLiveSubSession`'s read: none when a sub-session of it is running, waiting on the user, or unarchived and active within
    /// `window_ms`; else every sub-session under it with its activity stamp. `fresh`: read now, never from the listing the plan was
    /// made on (the final judgment before an archive).
    async fn sub_sessions(&self, id: &str, now: f64, window_ms: f64, fresh: bool) -> Result<Option<Vec<(String, f64)>>, String>;
    async fn archive_tree(&self, id: &str, now: f64, policy: Policy, admit: Admit) -> Result<TreeOutcome, String>;
    /// The idle-only delete: refused (nothing closed or deleted) unless the session is still archived, idle, at `last_used_at`
    /// and `activity`, unwatched and without an approval showing, and `cancel` has not fired; decided by the session's own actor.
    async fn delete_if_idle(&self, id: &str, last_used_at: f64, activity: f64, cancel: &CancellationToken) -> Result<IdleDelete, String>;
    /// It owns a worktree with dirty or unmerged work.
    async fn worktree_work(&self, id: &str) -> Result<bool, String>;
    fn log(&self, line: &str);
}

fn unread_output(session: &Session) -> bool {
    let Some(read) = session.read_message_count else { return false };
    if session.message_count.max(0.0) <= read {
        return false;
    }
    session.incoming_tail.as_ref().is_none_or(|tail| tail.iter().any(|place| *place > read))
}

/// Never touched by either rule: bot chats and rooms, automations and their targets, favorites, and anything running, on screen,
/// holding a quota resume. (Background jobs are the live check, [`judge`].)
fn permanent_or_busy(session: &Session) -> bool {
    session.favorite
        || session.agent_home
        || session.agent_room
        || session.agent_mode
        || session.automation
        || session.task_run
        || session.working
        || session.visible
        || session.scheduled_resume
}

/// What [`judge`] decided: the action, the time it is ordered by (oldest first), and for an archive the sub-agent sessions the
/// judgment read, with the activity stamp of each (the archive holds exactly these).
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub action: Action,
    pub at: f64,
    pub children: Vec<(String, f64)>,
}

/// `retentionJudge`: what may happen to `session` now, or none. `fresh`: the facts outside the session actor that the judgment
/// reads (the sub-agent sessions) are read now, not from the listing the plan was made on: the final judgment before an action.
pub async fn judge(
    host: &dyn AutoRetentionHost,
    session: &Session,
    now: f64,
    policy: Policy,
    record: &RetentionRecord,
    fresh: bool,
) -> Result<Option<Verdict>, String> {
    let id = session.id.as_str();
    // Sub-agent sessions follow the runtime's own retention.
    if id.is_empty() || session.agent_session || permanent_or_busy(session) {
        return Ok(None);
    }
    let archive_window = policy.archive_days.max(0) as f64 * DAY_MS;
    let delete_window = policy.delete_days.max(0) as f64 * DAY_MS;
    if session.archived {
        if delete_window == 0.0 {
            return Ok(None);
        }
        let Some(stamp) = host.archived_stamp(id).await? else { return Ok(None) };
        // An archive from before this feature existed counts from its start.
        let since = stamp.max(record.enabled_at);
        if now - since < delete_window || host.background_jobs(id).await? {
            return Ok(None);
        }
        return Ok(Some(Verdict { action: Action::Delete, at: since, children: Vec::new() }));
    }
    if archive_window == 0.0 {
        return Ok(None);
    }
    let activity = session.activity_at;
    if activity <= 0.0 || now - activity < archive_window {
        return Ok(None);
    }
    // Restored from the archive: kept out until it is used again, and from then on it ages from that new activity.
    if record.restored.get(id).is_some_and(|restored| activity <= *restored) {
        return Ok(None);
    }
    if session.awaiting_approval && now - activity < AWAITING_USER_GRACE_MS {
        return Ok(None);
    }
    if unread_output(session) || host.background_jobs(id).await? {
        return Ok(None);
    }
    let Some(children) = host.sub_sessions(id, now, archive_window, fresh).await? else { return Ok(None) };
    Ok(Some(Verdict { action: Action::Archive, at: activity, children }))
}

/// Candidates, oldest first and uncapped (the pass caps them).
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub archive: Vec<String>,
    pub delete: Vec<String>,
}

pub async fn plan(
    host: &dyn AutoRetentionHost,
    sessions: &[Session],
    now: f64,
    policy: Policy,
    record: &RetentionRecord,
    cancel: &CancellationToken,
) -> Result<Plan, String> {
    let (mut archive, mut delete): (AgedSessions, AgedSessions) = (Vec::new(), Vec::new());
    for session in sessions {
        // Stopped (shutdown, or superseded): what is planned so far is never acted on, the pass stops before its first action.
        if cancel.is_cancelled() {
            break;
        }
        match judge(host, session, now, policy, record, false).await? {
            Some(Verdict { action: Action::Archive, at, .. }) => archive.push((session.id.clone(), at)),
            Some(Verdict { action: Action::Delete, at, .. }) => delete.push((session.id.clone(), at)),
            None => {}
        }
    }
    let oldest_first = |mut entries: Vec<(String, f64)>| {
        entries.sort_by(|a, b| a.1.total_cmp(&b.1));
        entries.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
    };
    Ok(Plan { archive: oldest_first(archive), delete: oldest_first(delete) })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub archived: Vec<String>,
    pub deleted: Vec<String>,
    /// Due for deletion but kept archived: their worktree holds work.
    pub kept_for_worktree: Vec<String>,
    /// Planned, but no longer eligible when looked at again.
    pub skipped: Vec<String>,
    /// The session's own actor refused the archive or the delete (a subscriber attached, a turn, an approval, new activity, ...):
    /// the session is intact.
    pub refused: Vec<String>,
    /// Acting on them failed; each is logged with its error.
    pub failed: usize,
}

enum Outcome {
    Archived,
    Deleted,
    KeptForWorktree,
    Skipped,
    Refused,
}

async fn act(
    host: &dyn AutoRetentionHost,
    id: &str,
    action: Action,
    now: &(dyn Fn() -> f64 + Send + Sync),
    cancel: &CancellationToken,
    gate: &Arc<AdmissionGate>,
) -> Result<Outcome, String> {
    macro_rules! read {
        ($work:expr) => {{
            let result = $work.await?;
            if cancel.is_cancelled() {
                return Ok(Outcome::Skipped);
            }
            result
        }};
    }
    let identity = host.identity();
    let admit = Admit { gate: gate.clone(), cancel: cancel.clone(), policy: identity.clone(), judged: identity.current() };
    let Some(policy) = host.policy() else { return Ok(Outcome::Skipped) };
    let record = read!(host.record());
    let Some(fresh) = read!(host.session(id)) else { return Ok(Outcome::Skipped) };
    let verdict = read!(judge(host, &fresh, now(), policy, &record, true));
    if verdict.filter(|verdict| verdict.action == action).is_none() {
        return Ok(Outcome::Skipped);
    }
    if action == Action::Archive {
        return Ok(match host.archive_tree(id, now(), policy, admit).await? {
            TreeOutcome::Archived(_) => Outcome::Archived,
            // Stopped, or the policy it was judged under is gone: nothing was admitted.
            TreeOutcome::Refused(reason) if reason == "stopped" || reason == "policy" => Outcome::Skipped,
            TreeOutcome::Refused(_) => Outcome::Refused,
            TreeOutcome::Failed(error) => return Err(error),
        });
    }
    if read!(host.worktree_work(id)) {
        return Ok(Outcome::KeptForWorktree);
    }
    // The slow check ran: the session is looked at again.
    let Some(judged) = read!(host.session(id)) else { return Ok(Outcome::Skipped) };
    if read!(judge(host, &judged, now(), policy, &record, true)).filter(|verdict| verdict.action == action).is_none() {
        return Ok(Outcome::Skipped);
    }
    if cancel.is_cancelled() || host.policy() != Some(policy) {
        return Ok(Outcome::Skipped);
    }
    Ok(if host.delete_if_idle(id, judged.last_used_at, judged.activity_stamp, cancel).await?.deleted { Outcome::Deleted } else { Outcome::Refused })
}
/// One complete pass: every session is judged and every due one acted on, archives first (they can be undone), each judged again
/// from a fresh read right before it is acted on. Stops between sessions when `cancel` fires (shutdown, or the options changed and
/// a new pass takes over). One log line with the counts. None when the policy is invalid or turned off.
pub async fn run_pass(
    host: &dyn AutoRetentionHost,
    now: &(dyn Fn() -> f64 + Send + Sync),
    cancel: &CancellationToken,
    gate: &Arc<AdmissionGate>,
) -> Result<Option<Report>, String> {
    let Some(policy) = host.policy() else { return Ok(None) };
    if policy.archive_days <= 0 && policy.delete_days <= 0 {
        return Ok(None);
    }
    let record = host.record().await?;
    let sessions = host.sessions().await?;
    let plan = plan(host, &sessions, now(), policy, &record, cancel).await?;
    let candidates = plan.archive.into_iter().map(|id| (id, Action::Archive)).chain(plan.delete.into_iter().map(|id| (id, Action::Delete)));
    let mut report = Report::default();
    for (id, action) in candidates {
        if cancel.is_cancelled() {
            break;
        }
        match act(host, &id, action, now, cancel, gate).await {
            Ok(Outcome::Archived) => report.archived.push(id),
            Ok(Outcome::Deleted) => report.deleted.push(id),
            Ok(Outcome::KeptForWorktree) => report.kept_for_worktree.push(id),
            Ok(Outcome::Skipped) => report.skipped.push(id),
            Ok(Outcome::Refused) => report.refused.push(id),
            Err(error) => {
                report.failed += 1;
                host.log(&format!("[mixdog-session] auto-retention failed: {} {id}: {error}", if action == Action::Archive { "archive" } else { "delete" }));
            }
        }
    }
    host.log(&format!(
        "[mixdog-session] auto-retention: archived {}, deleted {}, kept {}, refused {}",
        report.archived.len(),
        report.deleted.len(),
        report.kept_for_worktree.len(),
        report.refused.len(),
    ));
    Ok(Some(report))
}

/// Resolves once the options differ from `was` (a config write that left them alone is not a change).
async fn policy_changed(host: &dyn AutoRetentionHost, changes: &mut tokio::sync::watch::Receiver<u64>, was: Option<Policy>) {
    loop {
        if changes.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        if host.policy() != was {
            return;
        }
    }
}

/// The cycle: one complete pass at once (the task is spawned, so it never delays startup or a request), then one more each time
/// an option changes. A pass under way when the options change is told to stop between sessions and replaced by one with the
/// new values, so two never run together. The record is read first (Node did at service start: "recording the start date now
/// dates archives from before this feature"). `cancel` stops a pass between sessions; a delete already begun finishes, an
/// archive admitted before `gate` closed (or `cancel` fired) commits whole and one not yet admitted commits nothing, and the
/// returned task ends after that.
pub fn start(
    host: Arc<dyn AutoRetentionHost>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    cancel: CancellationToken,
    gate: Arc<AdmissionGate>,
    mut changes: tokio::sync::watch::Receiver<u64>,
) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn("session.auto-retention", TaskClass::Work, async move {
        if let Err(error) = host.record().await {
            host.log(&format!("[mixdog-session] Could not read the auto-retention record: {error}"));
        }
        loop {
            let policy = host.policy();
            let pass_cancel = cancel.child_token();
            let mut pass = std::pin::pin!(run_pass(host.as_ref(), now.as_ref(), &pass_cancel, &gate));
            let finished = tokio::select! {
                result = &mut pass => Some(result),
                () = policy_changed(host.as_ref(), &mut changes, policy) => None,
            };
            let superseded = finished.is_none();
            let result = match finished {
                Some(result) => result,
                None => {
                    pass_cancel.cancel();
                    pass.await
                }
            };
            if let Err(error) = result {
                host.log(&format!("[mixdog-session] auto-retention pass failed: {error}"));
            }
            if cancel.is_cancelled() {
                return;
            }
            if superseded {
                continue;
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                () = policy_changed(host.as_ref(), &mut changes, policy) => {}
            }
        }
    })
}

// ---- the host over the session runtime ---------------------------------------------------------------------------------

fn positive(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).filter(|at| at.is_finite() && *at > 0.0).unwrap_or(0.0)
}

fn text(value: Option<&Value>) -> String {
    mixdog_js::js_trim(value.and_then(Value::as_str).unwrap_or_default()).to_owned()
}

/// `taskAgentSource(row)`'s `from` (`desktop-state.ts`): a task row (`sourceType` `lead`, not an agent's own) a bot made names
/// `agent:<id>@<from>` in `sourceName`.
fn task_from(row: &Map<String, Value>) -> (String, String) {
    let task_row = text(row.get("sourceType")).to_lowercase() == "lead"
        && row.get("owner").and_then(Value::as_str) != Some("agent")
        && row.get("visibility").and_then(Value::as_str) != Some("agent-only");
    let name = text(row.get("sourceName"));
    match (task_row, name.strip_prefix("agent:")) {
        (true, Some(rest)) => {
            let mut parts = rest.split('@');
            (parts.next().unwrap_or_default().to_owned(), parts.next().unwrap_or_default().to_owned())
        }
        _ => (String::new(), String::new()),
    }
}

fn is_agent_session(row: &Map<String, Value>) -> bool {
    text(row.get("visibility")) == "agent-only"
        || (text(row.get("owner")) == "agent" && text(row.get("agent")) != "lead")
        || mixdog_core_base::quota_resume::is_agent_only_session(&Value::Object(row.clone()))
}

/// The pass's host over the session directory, the catalog index, the archive trees and the registered domain services.
pub struct DirectoryAutoRetention {
    directory: Arc<SessionDirectory>,
    store: Arc<SqliteStore>,
    config: Config,
    record: Arc<ConfigArchiveRetention>,
    domains: Arc<Domains>,
    trees: Arc<ArchiveTrees>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    /// Moved inside the config's install of every document that changed the policy ([`PolicyIdentity`]).
    identity: Arc<PolicyIdentity>,
    _adoption: mixdog_core_config::config::AdoptionGuard,
    /// The agent-only rows as the plan's listing read them: the sub-session walk of the PLAN uses them (a listing of a thousand
    /// sessions is not read again for each). The final judgment before an action reads them afresh, never from here.
    agent_rows: Mutex<Arc<AgentRows>>,
    /// Itself: an archive runs as a task this host owns to its end.
    me: std::sync::Weak<Self>,
}

type InFlight = (Vec<ThreadId>, Vec<String>);

impl DirectoryAutoRetention {
    pub fn new(
        directory: Arc<SessionDirectory>,
        store: Arc<SqliteStore>,
        config: Config,
        record: Arc<ConfigArchiveRetention>,
        domains: Arc<Domains>,
        trees: Arc<ArchiveTrees>,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        let identity = Arc::new(PolicyIdentity::default());
        let adoption = {
            let (identity, watched, seen) = (identity.clone(), config.clone(), Mutex::new(config.session_retention()));
            // Inside every install of a document, before its write is acknowledged: a changed policy voids every archive
            // prepared under the one before, off and on again with the same values included (two installs, two moves).
            config.on_adoption(move || {
                let now = watched.session_retention();
                let mut last = seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if *last != now {
                    *last = now;
                    identity.moved();
                }
            })
        };
        Arc::new_cyclic(|me| Self {
            directory,
            store,
            config,
            record,
            domains,
            trees,
            log,
            identity,
            _adoption: adoption,
            agent_rows: Mutex::new(Arc::default()),
            me: me.clone(),
        })
    }

    /// The threads among `ids` that are not loaded now: what a read loads for itself, and so lets go of afterwards.
    fn unloaded(&self, ids: &[String]) -> Vec<ThreadId> {
        ids.iter().map(|id| ThreadId::from(id.as_str())).filter(|id| self.directory.handle(id).is_none()).collect()
    }

    /// Lets go of what a read loaded (a read opens the session; a thousand of them must not stay resident until their idle
    /// deadline), each release acknowledged by the thread's actor before the next step. A thread that is watched, working or busy
    /// by now stays: the unload is the idle deadline's decision.
    async fn release(&self, loaded: Vec<ThreadId>) {
        for id in loaded {
            self.directory.release(&id).await;
        }
    }

    /// The agent-only rows as the index holds them now.
    async fn read_agent_rows(&self) -> Result<Arc<Vec<(String, Map<String, Value>)>>, String> {
        let rows = self.store.agent_only_sessions().await.map_err(|error| error.to_string())?;
        let parsed: Vec<(String, Map<String, Value>)> = rows
            .iter()
            .filter_map(|row| match serde_json::from_str::<Value>(row).ok()? {
                Value::Object(map) => Some((text(map.get("id")), map)),
                _ => None,
            })
            .filter(|(id, _)| !id.is_empty())
            .collect();
        Ok(Arc::new(parsed))
    }

    /// `working`: the session's own turn, or an agent's working for it (`inFlightSessionActivity`).
    fn working(flight: &InFlight, id: &str) -> bool {
        flight.0.iter().any(|working| working.as_str() == id) || flight.1.iter().any(|owner| owner == id)
    }

    fn awaiting_approval(&self, id: &str) -> bool {
        self.directory.handle(&ThreadId::from(id)).is_some_and(|handle| handle.cell.shown_approval.load().as_ref().is_some())
    }

    fn facts(&self, listed: &LeadRow, flight: &InFlight) -> Session {
        let row = &listed.row;
        let id = text(row.get("id"));
        let activity = positive(row.get("lastUsedAt"));
        let activity_at = if activity > 0.0 { activity } else { positive(row.get("updatedAt")) };
        let (task_agent, from) = task_from(row);
        let kind = text(row.get("sourceType")).to_lowercase();
        let cursor = settle_read_cursor(row.get("readState").and_then(Value::as_object), row.get("compactCount"), row.get("messageCount"));
        // `cleanIncomingTail`: whole places, at most the last hundred.
        let incoming_tail = row.get("incomingTail").and_then(Value::as_array).map(|tail| {
            let places: Vec<f64> = tail.iter().filter_map(|place| place.as_i64().filter(|place| *place > 0)).map(|place| place as f64).collect();
            places[places.len().saturating_sub(100)..].to_vec()
        });
        Session {
            favorite: positive(row.get("favoriteAt")) > 0.0,
            agent_home: !mixdog_store::agent_mode::agent_id_of_home_session(&id).is_empty(),
            agent_room: mixdog_core_base::rooms::ids::is_room_thread_session_id(&id),
            agent_mode: row.get("sessionMode").and_then(Value::as_str) == Some("agent"),
            automation: kind == "schedule" || kind == "webhook",
            task_run: !task_agent.is_empty() && from == "run",
            agent_session: is_agent_session(row),
            working: Self::working(flight, &id),
            awaiting_approval: self.awaiting_approval(&id),
            visible: self.directory.handle(&ThreadId::from(id.as_str())).is_some_and(|handle| handle.cell.attached() > 0),
            scheduled_resume: self.directory.deps().quota.goals.entry(&id).is_some(),
            // The index's flag, resolved through the archive authority by the listing.
            archived: listed.archived,
            activity_at,
            message_count: row.get("messageCount").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0),
            read_message_count: cursor.map(|cursor| cursor.get("messageCount").and_then(Value::as_f64).unwrap_or(0.0)),
            incoming_tail,
            last_used_at: positive(row.get("lastUsedAt")),
            activity_stamp: super::sub_agent_retention::activity_at(row),
            id,
        }
    }

    async fn call(&self, method: &'static str, params: Value) -> Result<Value, String> {
        let service = self.domains.get(method).ok_or_else(|| format!("{method} is not served"))?;
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let request = CoreRequest { method: Method(method), params, op: Some(op), ctx: CallContext::internal(CALLER) };
        match service.call(request).await.map_err(|error| format!("{error:?}"))? {
            Reply::Value(value) => Ok(value),
            _ => Err(format!("{method} answered no value")),
        }
    }

    /// The archive of one tree, owned by this host's task: prepared, judged again with every member held and the record read
    /// after the hold (its exemptions as the held entries state them), committed, and what it opened released.
    async fn archive_held(&self, id: &str, now: f64, policy: Policy, admit: &Admit) -> Result<TreeOutcome, String> {
        let mut prep = self.trees.prepare(id, admit).await;
        let mut failure = None;
        if let Some(held) = prep.children() {
            let judged = match self.record().await {
                Ok(record) => self.judged_whole(id, now, policy, &prep.judged_record(record), &held).await,
                Err(error) => Err(error),
            };
            match judged {
                Ok(None) => {}
                Ok(Some(reason)) => prep.refuse(reason),
                Err(error) => {
                    prep.refuse("unread");
                    failure = Some(error);
                }
            }
        }
        let outcome = self.trees.commit(prep, admit).await;
        match failure {
            Some(error) => Err(error),
            None => Ok(outcome),
        }
    }

    /// The session's whole retention judgment again, from fresh reads with its tree held: still due for an archive, and judged
    /// over exactly the sub-agent sessions held. `Some(reason)` when it no longer holds.
    async fn judged_whole(&self, id: &str, now: f64, policy: Policy, record: &RetentionRecord, held: &[String]) -> Result<Option<String>, String> {
        let Some(fresh) = self.session(id).await? else { return Ok(Some("missing".to_owned())) };
        let Some(verdict) = judge(self, &fresh, now, policy, record, true).await?.filter(|verdict| verdict.action == Action::Archive) else {
            return Ok(Some("changed".to_owned()));
        };
        let mut judged: Vec<&str> = verdict.children.iter().map(|(child, _)| child.as_str()).collect();
        let mut holding: Vec<&str> = held.iter().map(String::as_str).collect();
        judged.sort_unstable();
        holding.sort_unstable();
        // A sub-agent session that joined or left the tree since it was read is a tree nobody judged.
        Ok((judged != holding).then(|| "changed".to_owned()))
    }
}

#[async_trait]
impl AutoRetentionHost for DirectoryAutoRetention {
    fn policy(&self) -> Option<Policy> {
        self.config.session_retention().map(|policy| Policy { archive_days: policy.auto_archive_days, delete_days: policy.auto_delete_days })
    }

    fn identity(&self) -> Arc<PolicyIdentity> {
        self.identity.clone()
    }

    /// `sessionRetention.load()`, with the restores the archive authority recorded since: a restore there is the session's
    /// exemption, an archive there ends the one an earlier version recorded.
    async fn record(&self) -> Result<RetentionRecord, String> {
        let mut record = self.record.load().await?;
        for (id, entry) in self.directory.deps().archive.snapshot().entries() {
            match entry {
                mixdog_store::archive_state::ArchiveEntry::Restored(at) => record.restored.insert(id.clone(), at),
                mixdog_store::archive_state::ArchiveEntry::Archived(_) => record.restored.remove(id),
            };
        }
        Ok(record)
    }

    async fn sessions(&self) -> Result<Vec<Session>, String> {
        *self.agent_rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = self.read_agent_rows().await?;
        let flight = self.directory.in_flight();
        let mut out = Vec::new();
        let mut after = None;
        loop {
            let page = self.store.lead_page(after, LeadFilter::default(), PAGE).await.map_err(|error| error.to_string())?;
            out.extend(page.rows.iter().map(|listed| self.facts(listed, &flight)));
            let Some(last) = page.rows.last().filter(|_| page.more) else { break };
            let encoded = encode_catalog_cursor(&last.row);
            after = decode_catalog_cursor(Some(encoded.as_str())).map_err(|error| error.to_string())?;
        }
        Ok(out)
    }

    async fn session(&self, id: &str) -> Result<Option<Session>, String> {
        let listed = self.store.lead_row(id).await.map_err(|error| error.to_string())?;
        Ok(listed.map(|listed| self.facts(&listed, &self.directory.in_flight())))
    }

    /// The archive's stamp as the archive authority resolves it; none for a state only a header holds after the entries were lost
    /// (a restore the user made may be among them).
    async fn archived_stamp(&self, id: &str) -> Result<Option<f64>, String> {
        let header = self.directory.try_stored_header(&ThreadId::from(id)).await.map_err(|error| format!("{error:?}"))?;
        Ok(header.map(|header| self.directory.archive_state(id, &header)).filter(|state| state.trusted()).and_then(|state| state.archived_at))
    }

    async fn background_jobs(&self, id: &str) -> Result<bool, String> {
        let loaded = self.unloaded(&[id.to_owned()]);
        let list = self.call("thread/listShellJobs", json!({ "threadId": id })).await;
        self.release(loaded).await;
        let list = list?;
        // A list that could not be completed is not "no jobs".
        Ok(list.get("error").is_some() || list.get("jobs").and_then(Value::as_array).is_none_or(|jobs| !jobs.is_empty()))
    }

    async fn sub_sessions(&self, id: &str, now: f64, window_ms: f64, fresh: bool) -> Result<Option<Vec<(String, f64)>>, String> {
        let rows = if fresh { self.read_agent_rows().await? } else { self.agent_rows.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() };
        // The parent/owner adjacency, with the sessions this process created that the index may not list yet.
        let mut adjacency = super::archive_trees::Adjacency::of(&rows);
        adjacency.join(self.directory.created_links());
        let by_id: std::collections::HashMap<&str, &Map<String, Value>> = rows.iter().map(|(row_id, row)| (row_id.as_str(), row)).collect();
        let flight = self.directory.in_flight();
        let mut members = Vec::new();
        for child in adjacency.descendants(id) {
            let Some(row) = by_id.get(child.as_str()) else { continue };
            if Self::working(&flight, &child) || self.awaiting_approval(&child) {
                return Ok(None);
            }
            let used = positive(row.get("lastUsedAt"));
            let activity = if used > 0.0 { used } else { positive(row.get("updatedAt")) };
            if activity > now - window_ms && self.archived_stamp(&child).await?.is_none() {
                return Ok(None);
            }
            members.push((child, super::sub_agent_retention::activity_at(row)));
        }
        Ok(Some(members))
    }

    async fn archive_tree(&self, id: &str, now: f64, policy: Policy, admit: Admit) -> Result<TreeOutcome, String> {
        let me = self.me.upgrade().ok_or("the retention host is gone")?;
        let id = id.to_owned();
        // Owned to its end: a caller that goes away leaves no hold and nothing it opened behind.
        let task = mixdog_rt::spawn("session.archive-tree", TaskClass::Work, async move { me.archive_held(&id, now, policy, &admit).await });
        task.await.map_err(|error| error.to_string())?
    }

    async fn delete_if_idle(&self, id: &str, last_used_at: f64, activity: f64, cancel: &CancellationToken) -> Result<IdleDelete, String> {
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let params = json!({ "threadId": id, "opId": op.as_str(), "ifIdle": { "lastUsedAt": last_used_at, "activity": activity } });
        let mut ctx = CallContext::internal(CALLER);
        // The session's actor asks it again, at the moment it admits the delete.
        ctx.cancel = cancel.clone();
        let request = CoreRequest { method: Method("thread/delete"), params, op: Some(op), ctx };
        let loaded = self.unloaded(&[id.to_owned()]);
        let answer = self.directory.request(request).await;
        // A refused delete leaves the session as it was, loaded by the check or not: it goes back to where it was.
        self.release(loaded).await;
        let Reply::Value(answer) = answer.map_err(|error| format!("{error:?}"))? else {
            return Err("thread/delete answered no value".to_owned());
        };
        Ok(IdleDelete { deleted: answer.get("deleted") == Some(&Value::Bool(true)), reason: answer.get("reason").and_then(Value::as_str).map(str::to_owned) })
    }
    async fn worktree_work(&self, id: &str) -> Result<bool, String> {
        let loaded = self.unloaded(&[id.to_owned()]);
        let work = self.call("thread/getSessionWorktreeWork", json!({ "input": { "sessionIds": [id] } })).await;
        self.release(loaded).await;
        let work = work?;
        let ids = work.get("sessionIds").and_then(Value::as_array).ok_or("Worktree work check returned no result.")?;
        Ok(ids.iter().any(|held| held.as_str() == Some(id)))
    }

    fn log(&self, line: &str) {
        (self.log)(line);
    }
}

#[cfg(test)]
#[path = "auto_retention_tests.rs"]
mod tests;

/// Sessions with the time each was last active.
type AgedSessions = Vec<(String, f64)>;

/// The agent-only rows of a listing, by session id.
type AgentRows = Vec<(String, Map<String, Value>)>;
