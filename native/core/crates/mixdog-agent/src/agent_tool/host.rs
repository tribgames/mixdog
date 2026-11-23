//! What the agent tool borrows from the rest of the runtime: the tag registry, the send
//! and spawn flows, the session manager, the background-task table, the views and the machine.

use std::collections::HashMap;
use std::collections::HashSet;

use async_trait::async_trait;
use mixdog_tools::orch::agent::HideFailed;
use mixdog_tools::orch::agent::JobRow;
use mixdog_tools::orch::agent::TaskView;
use mixdog_tools::orch::agent::WorkerRow;
use serde_json::Value;

use super::scope::Caller;
use super::scope::Owner;
use super::scope::Scope;
use super::scope::SessionFacts;
use super::scope::TagRecord;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct ResolveOptions {
    pub scan_sessions: bool,
    pub exclude_terminal_traces: bool,
    /// A spawn: a session its owner closed is not a binding of the tag (a scan does not bind it again), so the tag
    /// is free for a new session. A send or a read keeps finding it.
    pub skip_released: bool,
}

/// `resumableTagSession`: the saved session that can continue a tag, or the working directory
/// that is gone.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Resumable {
    pub session: Option<SessionFacts>,
    pub missing_cwd: Option<String>,
}

/// A send ready to dispatch: the arguments, the live session that gets them and the prompt.
#[derive(Clone, PartialEq, Debug)]
pub struct Prepared {
    pub args: Value,
    pub session: SessionFacts,
    pub session_id: String,
    pub prompt: Option<String>,
    /// A route change the send asks the session to make.
    pub route: Option<Value>,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct DispatchOptions {
    pub reused: bool,
    pub resumed: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct SpawnOptions {
    pub respawned: bool,
}

/// A background task or a worker as `getJobOrWorker`/`startDeferredSpawnJob` return it.
#[derive(Clone, PartialEq, Debug)]
pub struct Job {
    /// Absent for a worker that has no task.
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub view: TaskView,
}

/// A background task, as the close flow sees it.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct TaskFacts {
    pub task_id: String,
    pub session_id: Option<String>,
    pub tag: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct CloseOptions {
    pub tombstone: bool,
    /// An owner's close (not a process exit's), recorded on the session itself.
    pub owner_close: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct ListOptions {
    pub scan_sessions: bool,
    pub include_idle: bool,
    pub include_closed: bool,
    pub include_terminal: bool,
}

pub struct Cleaned {
    pub removed: u64,
}

/// A tag taken for a spawn ([`Registry::claim_tag`]): no other spawn is given it while this is held. Dropped once the
/// spawn bound the tag, or gave up.
pub struct TagClaim {
    pub tag: String,
    _held: Option<Box<dyn Send + Sync>>,
}

impl TagClaim {
    /// `tag`, reserved until `held` is dropped.
    pub fn new(tag: String, held: Option<Box<dyn Send + Sync>>) -> Self {
        Self { tag, _held: held }
    }
}

impl std::fmt::Debug for TagClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TagClaim").field("tag", &self.tag).finish()
    }
}

#[async_trait]
pub trait Registry: Send + Sync {
    async fn resolve_tombstone_owners(&self);
    /// `Err` when the stored worker rows could not be read whole: the tags then held in memory are no account of them,
    /// and nothing is to be decided from a tag they do not show.
    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, scope: &Scope) -> Result<(), String>;
    /// [`Self::refresh_tags_from_sessions`] and the agent sessions as the same listing holds them, for a cleanup. A
    /// surface that lists none answers an empty one.
    async fn refresh_topology(&self, scan_sessions: bool, scope: &Scope) -> Result<(Topology, Recovered), String> {
        self.refresh_tags_from_sessions(scan_sessions, scope).await?;
        Ok((Topology::default(), Recovered::default()))
    }
    /// The tag of a new worker, taken under the registry's admission of spawns: the stored worker rows are read whole
    /// first (`Err` when they cannot be, whatever tags are held in memory), then `explicit` is refused when it is bound,
    /// or, with none, `next` names the next free tag; the tag is reserved until the claim is dropped. Two spawns admitted
    /// together are never both given a tag neither saw bound.
    async fn claim_tag(&self, explicit: &str, scope: &Scope, options: ResolveOptions, next: &(dyn Fn() -> String + Sync)) -> Result<TagClaim, String> {
        self.refresh_tags_from_sessions(false, scope).await?;
        let tag = if explicit.is_empty() { next() } else { explicit.to_owned() };
        if self.resolve_tag(&tag, scope, options).await?.is_some() {
            return Err(format!("agent spawn: tag \"{tag}\" already exists"));
        }
        Ok(TagClaim::new(tag, None))
    }
    /// The turn the session's worker map is at; `None` while it has no map. A surface that counts no turns answers
    /// `None` for every session.
    fn turn_mark(&self, _session_id: &str) -> Option<TurnMark> {
        None
    }
    /// `Err` when a tag is ambiguous across terminals.
    async fn resolve_tag(&self, tag: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String>;
    async fn live_session(&self, session_id: &str) -> Option<SessionFacts>;
    /// The session id a tag is bound to.
    fn tag_session(&self, tag: &str) -> Option<String>;
    fn has_tag_agent(&self, tag: &str) -> bool;
    async fn tag_for_session(&self, session_id: &str) -> Option<String>;
    fn unbind_tag(&self, tag: &str);
    async fn bind_tag(&self, tag: &str, session: &SessionFacts, turn_started_at: &str);
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str);
    fn remove_worker_row(&self, session_id: &str);
    fn mark_released(&self, session_ids: &[String]);
    /// Whether the owner closed the session and no turn started on it since (`markReleased`'s marker, inside its TTL): a list leaves it out.
    fn is_released(&self, _session_id: &str) -> bool {
        false
    }
    fn read_worker_rows(&self, scope: &Scope) -> Result<Vec<TagRecord>, String>;
    /// The session's worker row as it stands now, in any scope.
    fn worker_row(&self, session_id: &str) -> Option<TagRecord> {
        self.read_worker_rows(&Scope::default()).ok()?.into_iter().find(|row| row.session_id == session_id)
    }
    /// The writes of [`Self::release_closed_at`] on a surface whose writes are its store (`close-flow.mjs`): the
    /// root's tag binding and row go, the rows below it go, and every member is released. It answers nothing: what
    /// became of each release is that surface's own word, in its `release_closed_at`.
    fn release_closed(&self, _scope: &Scope, tag: Option<&str>, root: &str, descendants: &[String]) {
        self.forget_terminal_session(tag, root);
        for descendant in descendants {
            self.remove_worker_row(descendant);
        }
        let mut released = vec![root.to_owned()];
        released.extend(descendants.iter().cloned());
        self.mark_released(&released);
    }
    /// What a landed close leaves of its tree's rows (`close-flow.mjs`): the root's tag binding and row go, the rows
    /// below it go, and every member is released. `scope` is the caller's, entitled to close the tree at its root: a
    /// surface that keeps a release it could not store keeps that scope with it ([`Self::recover_releases`]).
    ///
    /// `at`, a cleanup's: a member a turn started on since its close was decided (its turn is no longer the one `at`
    /// names for it) keeps its row and its tag. So does, with or without `at`, one whose identity its store cannot
    /// tell. No release is decided for a spared member, nothing of it changes, and it is answered with why. Answers
    /// the release of each member released: what was queued for it and the handle its store answers once. Every
    /// surface states its own answer: none is assumed stored, and only a stored release hides its session.
    fn release_closed_at(
        &self,
        scope: &Scope,
        tag: Option<&str>,
        root: &str,
        descendants: &[String],
        at: Option<&HashMap<String, Option<TurnMark>>>,
    ) -> Released;
    /// The releases made for `scope` (the scope its tree was closed under, whoever owns the member itself) whose receipt
    /// came back neither stored nor superseded and that no later write of the session replaced, each submitted again
    /// as the operation it was: the same identity, incarnation, precondition, map and release stamp. Its store answers
    /// it by its committed record when it has one, and writes it only when it is known not to have committed and its
    /// target, incarnation and precondition still hold. A surface that keeps none answers none.
    fn recover_releases(&self, _scope: &Scope) -> Vec<Release> {
        Vec::new()
    }
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord>;
    fn tag_tombstone_for_tag(&self, tag: &str, scope: &Scope) -> Option<TagRecord>;
    fn consume_tag_tombstone(&self, tombstone: &TagRecord);
    async fn last_tag_session(&self, tag: &str, scope: &Scope) -> Option<TagRecord>;
    /// `Ok(None)`: the session cannot be resumed, and the caller starts a fresh one. `Err`: whether it can is not known
    /// (its record could not be read), and nothing is started in its place.
    async fn resumable_tag_session(&self, tag: &str, session_id: &str, scope: &Scope) -> Result<Option<Resumable>, String>;
    /// `tags.values()`: every session a tag is bound to.
    fn bound_sessions(&self) -> Vec<String> {
        Vec::new()
    }
}

#[async_trait]
pub trait SendFlow: Send + Sync {
    async fn prepare_send(&self, args: &Value, scope: &Scope) -> Result<Prepared, String>;
    async fn adopt_caller(&self, prepared: &Prepared, notify: &Caller) -> Result<(), String>;
    async fn dispatch_to_existing_session(
        &self,
        prepared: &Prepared,
        notify: &Caller,
        options: DispatchOptions,
    ) -> Result<mixdog_tools::orch::agent::AgentReply, String>;
}

#[async_trait]
pub trait SpawnFlow: Send + Sync {
    async fn start_deferred_spawn_job(&self, args: &Value, caller_cwd: &str, caller: &Caller, notify: &Caller, options: SpawnOptions) -> Result<Job, String>;
}

#[async_trait]
pub trait TerminalTrace: Send + Sync {
    /// `Err` when the tag is ambiguous across terminals (`resolveTag` throws).
    async fn has_terminal_trace(&self, tag: &str, scope: &Scope) -> Result<bool, String>;
    async fn reap_terminal_trace_for_tag(&self, tag: &str, scope: &Scope);
}

#[async_trait]
pub trait Sessions: Send + Sync {
    /// Reloads the stored agent sessions; `false` when this surface has none to reload.
    async fn rehydrate_agent_sessions(&self) -> bool;
    async fn read_session_handoff(&self, session_id: &str) -> Option<String>;
    /// `redactSensitiveText(sessionId, text)`: the session's sensitive values in `text` as the marker.
    fn redact_text(&self, _session_id: &str, text: String) -> String {
        text
    }
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool;
    /// The close a cancelled job makes of the turn it submitted (`job-start.mjs`): the session's durable stamp with
    /// `reason` and the stop of that turn's work, both only while `turn_id` is the turn the session runs. `false`:
    /// the session runs no such turn (it ended, or another runs) and nothing of the session was touched, or the stamp
    /// could not be written. Every surface states its own answer.
    async fn close_turn(&self, session_id: &str, turn_id: &str, reason: &str) -> bool;
    /// `closeRuntime`'s answer: `Ok(false)` when there is nothing to close, `Err` (the text Node
    /// throws, `agent session <id> could not be durably closed`) when the close did not land. A
    /// surface that cannot tell the two apart keeps this default.
    async fn try_close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
        Ok(self.close_session(session_id, reason, options).await)
    }
    /// A member's close inside a tree close that already holds the tree's admission: [`Self::try_close_session`]
    /// without reading the tree again, stamped only while the session is at the turn `member` names.
    async fn close_member(&self, session_id: &str, reason: &str, options: CloseOptions, _member: MemberClose) -> Result<MemberOutcome, String> {
        Ok(if self.try_close_session(session_id, reason, options).await? { MemberOutcome::Closed } else { MemberOutcome::Nothing })
    }
    /// A member's close inside a tree cancel that holds the admission of all of it ([`Self::cancel_tree`]):
    /// [`Self::try_close_session`] without reading the tree again.
    async fn try_close_covered(&self, session_id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
        self.try_close_session(session_id, reason, options).await
    }
    /// `agentDescendantSessionIds`: `Err` when the agent sessions could not be read.
    async fn descendant_session_ids(&self, session_id: &str) -> Result<Vec<String>, String>;
    /// `registry.childrenOf(id)`: the agent sessions linked directly below `session_id`, as the default
    /// [`Self::cancel_tree`] walks them.
    async fn child_session_ids(&self, _session_id: &str) -> Vec<String> {
        Vec::new()
    }
    /// The tree a cancel of `root` closes (`cancelAgentTree`): `root` and every session below it, each once, descendants
    /// first, with the guard that refuses admission under it while it lives, taken before the tree is read. `Err` when
    /// the tree could not be read.
    async fn cancel_tree(&self, root: &str) -> Result<(Vec<String>, Box<dyn Send>), String> {
        let first = self.begin_cancellation(&[root.to_owned()]);
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        let mut next = vec![root.to_owned()];
        while let Some(id) = next.pop() {
            if let std::collections::hash_map::Entry::Vacant(unread) = children.entry(id) {
                let below = self.child_session_ids(unread.key()).await;
                next.extend(below.iter().cloned());
                unread.insert(below);
            }
        }
        let mut ordered = Vec::new();
        super::dispatch::visit_descendants_first(&|id| children.get(id).cloned().unwrap_or_default(), root, &mut HashSet::new(), &mut ordered);
        let rest = self.begin_cancellation(&ordered[..ordered.len() - 1]);
        Ok((ordered, Box::new((first, rest))))
    }
    /// While the returned guard lives, the agent-status signals of these sessions are owed, not sent one by one;
    /// [`Self::publish_held`] (or its drop) announces what is owed once.
    fn hold_publication(&self, _ids: &[String]) -> Box<dyn Send> {
        Box::new(())
    }
    /// Ends a [`Self::hold_publication`] once the changes made under it have landed.
    async fn publish_held(&self, hold: Box<dyn Send>) {
        drop(hold);
    }
    /// `registry.beginCancellation(ids)`: while the returned guard lives, these sessions refuse
    /// admission (a spawn or send under them). A surface with no admission has nothing to hold.
    fn begin_cancellation(&self, _ids: &[String]) -> Box<dyn Send> {
        Box::new(())
    }
    /// The agent's statusline route, dropped when its session closes.
    fn clear_statusline_route(&self, session_id: &str);
    /// The sessions an owner closed leave every session list; the record stays, archived through the
    /// header's `archivedAt`. A session whose flag cannot be written stays listed.
    /// Answers the sessions that stay listed, each with the reason (`failed`). Each hide is written only while its
    /// condition holds ([`Hide`]): a session taken up again since stays listed, and is no failure. Every surface
    /// states its own answer: one that hides nothing is not counted as having hidden.
    async fn hide_sessions(&self, hides: &[Hide]) -> Vec<HideFailed>;
    /// `revealSession(id)`: a session that is used again is listed again.
    async fn reveal_session(&self, session_id: &str);
    /// Whether the session is hidden from the lists already (`archivedSessions()[id] !== undefined`).
    async fn is_hidden(&self, session_id: &str) -> bool;
    /// `mgr.sessionGone(id)`: the session's stored record is deleted. Only a record proven absent is gone: a session
    /// that is loaded, a record that is there but cannot be read, or a store that cannot be asked, is not.
    async fn session_gone(&self, _session_id: &str) -> bool {
        false
    }
    /// `mgr.isSessionTurnInFlight(id)`.
    fn turn_in_flight(&self, _session_id: &str) -> bool {
        false
    }
    /// `mgr.listSessions()`: the agent sessions that are not closed, as cleanup reads them.
    async fn open_sessions(&self) -> Vec<OpenSession> {
        Vec::new()
    }
    /// `mgr.parkSession(id)`: an idle agent's live runtime is released while the agent stays open; its next turn loads
    /// the session from disk. `false` when the session is closed, busy or watched; `true` when no runtime is left.
    async fn park_session(&self, _session_id: &str) -> bool {
        false
    }
}

/// The agent sessions as one listing holds them.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Topology {
    /// Each session's children (linked by `parentSessionId || ownerSessionId`), in listing order.
    pub children: HashMap<String, Vec<String>>,
    /// Every listed session: present without asking the store.
    pub present: HashSet<String>,
    /// The open Lead sessions.
    pub leads: HashSet<String>,
    /// The sessions that are not closed, as [`Sessions::open_sessions`] lists them.
    pub open: Vec<OpenSession>,
}

/// The sessions whose rows the scan of [`Registry::refresh_topology`] wrote, with the holds on their signals: a
/// cleanup takes its own hold over them before these end, so they are announced with what it changes.
#[derive(Default)]
pub struct Recovered {
    pub sessions: Vec<String>,
    pub holds: Vec<Box<dyn Send>>,
}

/// Which turn a worker is at: how many turns its worker map counted as started, and the id of the last.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct TurnMark {
    pub started: u64,
    pub last: Option<String>,
}

/// Where a release's map is stored.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ReleaseTarget {
    /// The session record's header.
    Header,
    /// The table of the maps kept past their session's record.
    Kept,
    /// The Lead index.
    Lead,
}

/// One release as it was queued: the operation its handle answers for, and no other write of the session.
#[derive(Clone, PartialEq, Debug)]
pub struct ReleaseReceipt {
    pub session_id: String,
    /// The identity its store holds of the session the release was decided for (a session record's journal identity):
    /// a session deleted, kept or made again under the same id since is another incarnation, and the release is
    /// applied to none but its own. A session whose store can tell none is not released at all.
    pub incarnation: String,
    /// The map the release was decided on (`None`: the session had none), fixed where the release was decided and
    /// never read again: the release is a compare-and-set on it, applied only while its store still holds that, and it
    /// is the same whenever the operation is submitted.
    pub prior: Option<serde_json::Map<String, Value>>,
    /// The operation's own identity, carried into the record that stores it: what a reconciliation asks its store for.
    pub operation: String,
    /// The tag the release unbound (the tree's root, while the tag was its own).
    pub tag: Option<String>,
    /// The turn the release was decided at.
    pub turn: Option<TurnMark>,
    /// The registry's number of this write: later writes of any session have a higher one.
    pub revision: u64,
    pub target: ReleaseTarget,
    /// The map the release stores.
    pub released: serde_json::Map<String, Value>,
}

/// What became of one release in its store.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReleaseOutcome {
    /// Its own record is committed where it goes: the journal record of a header release, the table transaction of a
    /// kept row's. A barrier receipt, not a publication receipt: a reader of a catalog built from the journal may
    /// still see what was there before for a while.
    Stored,
    /// Nothing of it is stored.
    Refused(String),
    /// Nothing of it is stored and nothing will be: the session is no longer the one it was decided for, or no longer
    /// holds the binding it was decided on. It is not made again.
    Superseded(String),
    /// Whether it is stored could not be told: not a success, and not a write to make again as a new one.
    Indeterminate(String),
}

/// The completion of one release: answered once, by the write that carried it.
#[derive(Clone)]
pub struct ReleaseDone(tokio::sync::watch::Receiver<Option<ReleaseOutcome>>);

/// The writer's end of a [`ReleaseDone`].
pub struct ReleaseAnswer(tokio::sync::watch::Sender<Option<ReleaseOutcome>>);

const RELEASE_UNANSWERED: &str = "the release's writer ended before it answered";

impl ReleaseDone {
    pub fn pending() -> (ReleaseAnswer, Self) {
        let (answer, done) = tokio::sync::watch::channel(None);
        (ReleaseAnswer(answer), Self(done))
    }

    /// A release answered where it was made.
    pub fn settled(outcome: ReleaseOutcome) -> Self {
        Self(tokio::sync::watch::channel(Some(outcome)).1)
    }

    /// The outcome when it is known already; a writer that ended without answering left it indeterminate.
    pub fn now(&self) -> Option<ReleaseOutcome> {
        // Read first: a writer gone by then leaves what is borrowed after it final.
        let ended = self.0.has_changed().is_err();
        let known = self.0.borrow().clone();
        known.or_else(|| ended.then(|| ReleaseOutcome::Indeterminate(RELEASE_UNANSWERED.to_owned())))
    }

    pub async fn outcome(mut self) -> ReleaseOutcome {
        match self.0.wait_for(Option::is_some).await {
            Ok(outcome) => outcome.clone().expect("waited for an outcome"),
            Err(_) => ReleaseOutcome::Indeterminate(RELEASE_UNANSWERED.to_owned()),
        }
    }
}

impl ReleaseAnswer {
    pub fn answer(self, outcome: ReleaseOutcome) {
        self.0.send_replace(Some(outcome));
    }
}

/// One member's release: what was queued and its completion.
pub struct Release {
    pub receipt: ReleaseReceipt,
    pub done: ReleaseDone,
}

impl Release {
    /// A release answered where it was made, by a surface that queues nothing: `outcome` is that surface's own word.
    pub fn answered(session_id: String, tag: Option<String>, turn: Option<TurnMark>, outcome: ReleaseOutcome) -> Self {
        let receipt = ReleaseReceipt {
            session_id,
            incarnation: String::new(),
            prior: None,
            operation: String::new(),
            tag,
            turn,
            revision: 0,
            target: ReleaseTarget::Header,
            released: serde_json::Map::new(),
        };
        Self { receipt, done: ReleaseDone::settled(outcome) }
    }
}

/// A member a release left as it was, and why: no release was decided for it, so nothing of it changed.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Spared {
    pub session_id: String,
    pub reason: String,
}

/// What [`Registry::release_closed_at`] came to: the release of each member released, and each member spared.
#[derive(Default)]
pub struct Released {
    pub releases: Vec<Release>,
    pub spared: Vec<Spared>,
}

/// One session a close hides ([`Sessions::hide_sessions`]), and what the hide is conditional on: it is written only
/// while the condition holds where the hides and the reveals are ordered, so a session taken up again is never left
/// hidden.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Hide {
    pub session_id: String,
    /// The stored release the hide belongs to (its `releasedAt` stamp): written only while the session still holds
    /// that release. `None`, a leftover no release was made for: written only while no turn runs on the session.
    pub released_at: Option<String>,
}

impl ReleaseReceipt {
    /// The hide a stored release of this receipt authorises.
    pub fn hide(&self) -> Hide {
        let released_at = self.released.get("releasedAt").and_then(Value::as_str).map(str::to_owned);
        Hide { session_id: self.session_id.clone(), released_at }
    }
}

/// How a member's close is fenced ([`Sessions::close_member`]).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct MemberClose {
    /// The turn the close was decided at ([`Registry::turn_mark`]): a session at any other turn is left as it is.
    pub turn: Option<TurnMark>,
    /// Its owner's close stamped it already and no turn started on it since: no second stamp.
    pub stamped: bool,
}

/// What [`Sessions::close_member`] came to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemberOutcome {
    Closed,
    /// There was nothing to close.
    Nothing,
    /// The session is at another turn, or running, since the close was decided: nothing was done to it.
    Moved,
    /// The close was stamped while the session was idle and a turn started on it since: the stamp reads as a close
    /// the session was resumed after, and its work is its own.
    Resumed,
}

/// An agent session as `mgr.listSessions()` lists it.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct OpenSession {
    pub id: String,
    /// `agentTag`.
    pub tag: String,
    pub agent: String,
    pub owner: Owner,
    pub status: String,
}

/// The process-wide background-task table, `surface: 'agent'` only.
pub trait Tasks: Send + Sync {
    fn list(&self, scope: &Scope) -> Vec<TaskFacts>;
    fn get(&self, task_id: &str, scope: &Scope) -> Option<TaskFacts>;
    fn cancel(&self, task_id: &str, reason: &str);
    /// `cancelBackgroundTasks({ surface: 'agent', callerSessionId, reason })`: every running job
    /// this session started (a job with no owner is never claimed).
    fn cancel_owned(&self, session_id: &str, reason: &str);
    fn cleanup(&self, scope: &Scope, force: bool) -> Cleaned;
    /// `resultDelivered(row, scopedContext)` (`close-flow.mjs`): the newest job of the session or the tag was cancelled,
    /// or its completion went out with the body or was read. With no job left, delivered unless one was pruned
    /// undelivered. `owner`: the session the row's tag belongs to.
    fn result_delivered(&self, _session_id: &str, _tag: &str, _owner: &str, _scope: &Scope) -> bool {
        true
    }
    /// A dropped row's session no longer counts as holding a lost result (`lostResults.delete(sessionId)`).
    fn forget_lost(&self, _session_id: &str) {}
}

/// The readers over the job board and the tag registry. Listing and lookup refresh the
/// registry from the stored sessions first, as Node does, so they are async.
#[async_trait]
pub trait Views: Send + Sync {
    /// A job by `task_id`, else the newest for `tag`/`sessionId`, else a synthetic job built
    /// from the worker session. `include_result`: `read` shows the result, `status` does not.
    async fn get_job_or_worker(&self, args: &Value, scope: &Scope, include_result: bool) -> Result<Job, String>;
    /// `Err` when the worker rows the listing is made from could not be read whole: never a list short of a worker.
    async fn list(&self, scope: &Scope, options: ListOptions) -> Result<Vec<WorkerRow>, String>;
    async fn list_jobs(&self, scope: &Scope) -> Vec<JobRow>;
}

/// Who a call's thread is: the owner session id and the host process it runs under.
pub trait CallerScopes: Send + Sync {
    fn scope_of(&self, thread: &mixdog_protocol::ThreadId) -> Scope;

    /// `turnHopOf(session)`: the bot-chain hop of the turn the thread is in (0: none).
    fn turn_hop(&self, _thread: &mixdog_protocol::ThreadId) -> u32 {
        0
    }
}

/// The machine: files, the working directory and the clock.
#[async_trait]
pub trait Environment: Send + Sync {
    async fn is_directory(&self, path: &str) -> bool;
    async fn read_text(&self, path: &str) -> Result<String, String>;
    fn current_dir(&self) -> String;
    /// `new Date().toISOString()`.
    fn now_iso(&self) -> String;
}
