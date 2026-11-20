//! Archives of a session together with its sub-agent sessions, through the one archive authority
//! ([`mixdog_store::archive_state`]): Node's `setSessionArchived` changed the parent and its descendants in one operation of its
//! archive map, persisted by one atomic file replacement (`desktop-session-metadata.ts:133`, `session-metadata-file.ts:150`). Here a
//! tree is one transaction of the authority: a crash leaves it wholly archived or untouched, and no member is ever marked first and
//! taken back after.
//!
//! The user's own archive and restore ([`ArchiveTrees::set_manual`]) are always admitted. The session auto-retention's archive is
//! prepared first ([`ArchiveTrees::prepare`]): the exact tree is read from the parent/owner adjacency of the agent-only sessions, every
//! member is held by its own actor (a [`Reserved`] member: the idle deadline leaves it loaded, and every attach and every step that
//! moved what the archive judged moves its [`RetentionMark`]), and the caller judges the session again with the tree held. The
//! commit ([`ArchiveTrees::commit`]) is admitted on the state writer, after its queue and lock waits, only while every hold is
//! unmoved, no member's entry changed, no create could have joined the tree, no quota resume waits on a member, and the [`Admit`]
//! (the sweep's stop, its cancellation, the policy it judged under) still holds; the entries of every member and the op record of
//! the outcome are then one transaction. Nothing a foreground operation does waits for a preparation or is refused by one.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_app_protocol::v2::thread::ThreadIdParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::state::SectionFeedState;
use mixdog_rt::CancellationToken;
use mixdog_store::archive_state::ArchiveEntry;
use mixdog_store::archive_state::ArchiveStates;
use mixdog_store::archive_state::OP_SCOPE;
use mixdog_store::archive_state::Resolved;
use mixdog_store::schema::record::Header;
use mixdog_store::state::OpRow;
use mixdog_store::state::OpRowState;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::sub_agent_retention::AgentOnlyIndex;
use super::sub_agent_retention::parent_ids;
use super::thread_settings::ArchiveStamps;
use super::thread_settings::ArchivedWorktrees;
use super::thread_settings::RetentionRecord;

/// A thread's mark for the archive preparations that hold it ([`ControlCell::retention`](super::control::ControlCell)).
#[derive(Default)]
pub(crate) struct RetentionMark {
    epoch: AtomicU64,
    held: AtomicUsize,
}

impl RetentionMark {
    /// Something a preparation holding the thread judged moved: the preparation is void.
    pub(crate) fn moved(&self) {
        self.epoch.fetch_add(1, SeqCst);
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(SeqCst)
    }

    /// A preparation holds the thread: it stays loaded.
    pub(crate) fn held(&self) -> bool {
        self.held.load(SeqCst) > 0
    }
}

/// What the actor compares after each step ([`RetentionMark::moved`] when it differs): the activity, the favorite mark and the tree
/// links of its header, and its turn, queue and approvals.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RetentionFacts {
    pub activity: f64,
    pub favorite: Option<Value>,
    pub owner: Option<Value>,
    pub parent: Option<Value>,
    pub busy: bool,
    pub queued: bool,
    pub approvals: bool,
}

/// The parent/owner adjacency of the agent-only sessions (`agentDescendantIds`'s map), read once and asked for any root.
#[derive(Debug, Default)]
pub struct Adjacency {
    children: HashMap<String, Vec<String>>,
}

impl Adjacency {
    /// Over the agent-only rows (id and header or list row), following every owner and parent link a row names.
    pub fn of(rows: &[(String, Header)]) -> Self {
        let mut adjacency = Self::default();
        for (id, header) in rows {
            let id = mixdog_js::js_trim(id);
            let mut doc = header.clone();
            doc.insert("id".into(), json!(id));
            if id.is_empty() || mixdog_store::summary::session_visibility(&doc) != "agent-only" {
                continue;
            }
            for parent in parent_ids(&doc, id) {
                adjacency.link(parent, id.to_owned());
            }
        }
        adjacency
    }

    fn link(&mut self, parent: String, child: String) {
        let children = self.children.entry(parent).or_default();
        if !children.contains(&child) {
            children.push(child);
        }
    }

    /// Joins links the rows may not hold yet (the sessions this process created).
    pub fn join(&mut self, links: HashMap<String, Vec<String>>) {
        for (parent, children) in links {
            for child in children {
                self.link(parent.clone(), child);
            }
        }
    }

    /// The agent-only sessions under `root` at any depth, in the order `agentDescendantIds` finds them.
    pub fn descendants(&self, root: &str) -> Vec<String> {
        let root = mixdog_js::js_trim(root);
        let mut found: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue = vec![root.to_owned()];
        while let Some(next) = queue.pop() {
            for child in self.children.get(&next).into_iter().flatten() {
                if child == root || !seen.insert(child.clone()) {
                    continue;
                }
                found.push(child.clone());
                queue.push(child.clone());
            }
        }
        found
    }
}

/// The sweep's stop: closed before the sweep is cancelled and awaited, so a commit the writer reaches after it admits nothing,
/// and one admitted before it finishes whole.
#[derive(Debug, Default)]
pub struct AdmissionGate(AtomicBool);

impl AdmissionGate {
    pub fn close(&self) {
        self.0.store(true, SeqCst);
    }

    pub fn closed(&self) -> bool {
        self.0.load(SeqCst)
    }
}

/// The identity of the retention policy: moved, synchronously inside the config's install of a document, by every install that
/// changed the policy (off and on again with the same values included: each of the two installs moves it).
#[derive(Debug, Default)]
pub struct PolicyIdentity(AtomicU64);

impl PolicyIdentity {
    pub fn moved(&self) {
        self.0.fetch_add(1, SeqCst);
    }

    pub fn current(&self) -> u64 {
        self.0.load(SeqCst)
    }
}

/// What admits a prepared archive at its commit: the sweep's stop, the token of the pass that judged it, and the policy identity
/// it judged under.
#[derive(Clone, Debug)]
pub struct Admit {
    pub gate: Arc<AdmissionGate>,
    pub cancel: CancellationToken,
    pub policy: Arc<PolicyIdentity>,
    pub judged: u64,
}

impl Admit {
    /// Why nothing may be admitted now; none while it may.
    pub fn refusal(&self) -> Option<&'static str> {
        if self.gate.closed() || self.cancel.is_cancelled() {
            Some("stopped")
        } else if self.policy.current() != self.judged {
            Some("policy")
        } else {
            None
        }
    }
}

/// One member a preparation holds. Dropping it lets go of the hold (not of the thread: [`ArchiveTrees::commit`] releases what it
/// opened, acknowledged).
struct Reserved {
    id: String,
    handle: Arc<SessionHandle>,
    /// The thread's [`RetentionMark`] epoch when the hold was taken.
    epoch: u64,
    /// Its authority entry then.
    entry: Option<ArchiveEntry>,
    /// Archived then (an archived sub-agent session keeps its own stamp).
    archived: bool,
}

impl Drop for Reserved {
    fn drop(&mut self) {
        self.handle.cell.retention.held.fetch_sub(1, SeqCst);
    }
}

/// A prepared archive of one tree: its members held (the root first), or why it was refused. Whatever happens to it, what it
/// opened is released by [`ArchiveTrees::commit`] or [`ArchiveTrees::abandon`].
pub struct Preparation {
    root: String,
    members: Vec<Reserved>,
    /// The directory's create count before the tree was read.
    created: u64,
    opened: Vec<ThreadId>,
    refused: Option<String>,
}

impl Preparation {
    /// The sub-agent sessions it holds; none when it was refused.
    pub fn children(&self) -> Option<Vec<String>> {
        self.refused.is_none().then(|| self.members.iter().skip(1).map(|member| member.id.clone()).collect())
    }

    pub fn refused(&self) -> Option<&str> {
        self.refused.as_deref()
    }

    /// `record` with the exemptions as the entries this preparation holds state them: the judgment made with it reads the same
    /// entries the commit admits against (a restore committed since is a changed entry there, and refuses it).
    pub fn judged_record(&self, mut record: RetentionRecord) -> RetentionRecord {
        for member in &self.members {
            match member.entry {
                Some(ArchiveEntry::Restored(at)) => {
                    record.restored.insert(member.id.clone(), at);
                }
                Some(ArchiveEntry::Archived(_)) => {
                    record.restored.remove(&member.id);
                }
                None => {}
            }
        }
        record
    }

    /// The caller's own judgment does not hold: nothing will be committed.
    pub fn refuse(&mut self, reason: impl Into<String>) {
        self.refused.get_or_insert(reason.into());
    }
}

/// How a prepared archive ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeOutcome {
    /// Committed: these sessions took the tree's stamp (the root first).
    Archived(Vec<String>),
    /// Nothing changed.
    Refused(String),
    /// Nothing committed: the write failed.
    Failed(String),
}

/// The steps a test holds a tree operation at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TreeStep {
    /// The tree is about to be read.
    Descendants,
    /// The root is held, the sub-agent sessions are about to be.
    Reserving,
    /// The commit is about to be handed to the state writer.
    Commit,
}

#[cfg(any(test, feature = "test-support"))]
type Hold = (TreeStep, tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>);

/// The archive and restore of trees, over the session directory and the archive authority.
pub struct ArchiveTrees {
    directory: Arc<SessionDirectory>,
    index: Arc<dyn AgentOnlyIndex>,
    /// The app feed: `thread/archived`, `thread/unarchived`.
    app: Arc<SectionFeedState>,
    worktrees: Arc<dyn ArchivedWorktrees>,
    /// The core's one archive stamp counter (`lastArchiveStamp`).
    stamps: Arc<ArchiveStamps>,
    #[cfg(any(test, feature = "test-support"))]
    hold: std::sync::Mutex<Option<Hold>>,
}

fn failed(error: impl std::fmt::Display) -> CoreError {
    mixdog_core_base::support::failed("thread", error.to_string())
}

impl ArchiveTrees {
    pub fn new(
        directory: Arc<SessionDirectory>,
        index: Arc<dyn AgentOnlyIndex>,
        app: Arc<SectionFeedState>,
        worktrees: Arc<dyn ArchivedWorktrees>,
        stamps: Arc<ArchiveStamps>,
    ) -> Self {
        Self {
            directory,
            index,
            app,
            worktrees,
            stamps,
            #[cfg(any(test, feature = "test-support"))]
            hold: std::sync::Mutex::new(None),
        }
    }

    fn authority(&self) -> &Arc<ArchiveStates> {
        &self.directory.deps().archive
    }

    /// The archive authority the trees commit to.
    pub fn archive_states(&self) -> &Arc<ArchiveStates> {
        self.authority()
    }

    /// The next tree operation that reaches `step` tells `arrived` and waits for `go`.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "armed by this crate's unit tests; compiled for test-support so the steps behave as in a test build"))]
    pub(crate) fn hold_at(&self, step: TreeStep) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
        let (go, go_rx) = tokio::sync::oneshot::channel();
        *self.hold.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((step, arrived_tx, go_rx));
        (arrived, go)
    }

    async fn at(&self, step: TreeStep) {
        #[cfg(not(any(test, feature = "test-support")))]
        let _ = step;
        #[cfg(any(test, feature = "test-support"))]
        {
            let taken = {
                let mut slot = self.hold.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if slot.as_ref().is_some_and(|(at, _, _)| *at == step) { slot.take() } else { None }
            };
            if let Some((_, arrived, go)) = taken {
                let _ = arrived.send(());
                let _ = go.await;
            }
        }
    }

    /// The adjacency of the agent-only sessions now: the catalog's rows joined with the sessions this process created.
    pub async fn adjacency(&self) -> Result<Adjacency, CoreError> {
        let mut adjacency = Adjacency::of(&self.index.agent_only_rows().await?);
        adjacency.join(self.directory.created_links());
        Ok(adjacency)
    }

    /// `setSessionArchived(id, archived)`: the session with its sub-agent sessions, in one commit of the authority. An archive
    /// stamps the ones not archived yet with the session's own stamp; a restore brings back exactly the ones carrying it and records
    /// the session's restore (its auto-archive exemption) in the same transaction. A session already in the asked state changes
    /// nothing. Whether the session's own state changed.
    pub async fn set_manual(&self, root: &ThreadId, archived: bool) -> Result<bool, CoreError> {
        let handle = self.directory.open_handle(root, &CallContext::internal("thread-settings")).await?;
        let root_stamp = handle.cell.header.load().get("archivedAt").cloned();
        // Node's `agentDescendantIds` over the rows the session list holds: the user's archive takes the tree as listed.
        let descendants = Adjacency::of(&self.index.agent_only_rows().await?).descendants(root.as_str());
        let mut children = Vec::new();
        for id in &descendants {
            // A sub-agent session deleted meanwhile has nothing left to change.
            if let Some(header) = self.directory.try_stored_header(&ThreadId::from(id.as_str())).await? {
                children.push((id.clone(), header.get("archivedAt").cloned()));
            }
        }
        let (id, stamps, clock) = (root.as_str().to_owned(), self.stamps.clone(), self.directory.deps().clock.clone());
        let committed = self
            .authority()
            .commit(move |snapshot, _| {
                let own = snapshot.resolve(&id, root_stamp.as_ref());
                if own.archived() == archived {
                    return Ok((false, Vec::new()));
                }
                let now = clock.now_ms();
                let mut changes = Vec::new();
                if archived {
                    let stamp = stamps.take(now) as f64;
                    changes.push((id.clone(), ArchiveEntry::Archived(stamp)));
                    for (child, header) in &children {
                        if !snapshot.resolve(child, header.as_ref()).archived() {
                            changes.push((child.clone(), ArchiveEntry::Archived(stamp)));
                        }
                    }
                } else {
                    changes.push((id.clone(), ArchiveEntry::Restored(now as f64)));
                    for (child, header) in &children {
                        if snapshot.resolve(child, header.as_ref()).archived_at == own.archived_at {
                            changes.push((child.clone(), ArchiveEntry::Restored(now as f64)));
                        }
                    }
                }
                Ok((true, changes))
            })
            .await
            .map_err(failed)?;
        if let Err(error) = &committed.indexed {
            tracing::warn!("[mixdog-session] The catalog did not take the archive change of {root} yet: {error}");
        }
        if committed.answer {
            let ids: Vec<String> = std::iter::once(root.as_str().to_owned()).chain(descendants).collect();
            let worktrees = self.worktrees.clone();
            let shown = root.clone();
            // The user's own archive answers before the worktree cleanup, which never fails it.
            tokio::spawn(async move {
                if let Err(error) = worktrees.set_archived(&ids, archived).await {
                    tracing::warn!("[mixdog-session] Could not update the worktrees of {shown}: {error}");
                }
            });
            self.notify(root, archived);
        }
        Ok(committed.answer)
    }

    fn notify(&self, root: &ThreadId, archived: bool) {
        let method = if archived { "thread/archived" } else { "thread/unarchived" };
        self.app.notify(method, &ThreadIdParams { thread_id: root.clone() });
    }

    /// Prepares the archive of `root` with every sub-agent session under it: the tree read, every member held by its actor, each
    /// with its entry and archive state then. `admit` is asked between steps; a refusal holds nothing more.
    pub async fn prepare(&self, root: &str, admit: &Admit) -> Preparation {
        let mut prep = Preparation { root: root.to_owned(), members: Vec::new(), created: 0, opened: Vec::new(), refused: None };
        if let Err(error) = self.reserve(&mut prep, admit).await {
            prep.refuse(format!("{error:?}"));
        }
        prep
    }

    async fn reserve(&self, prep: &mut Preparation, admit: &Admit) -> Result<(), CoreError> {
        if let Some(reason) = admit.refusal() {
            prep.refuse(reason);
            return Ok(());
        }
        // The count first: a create after it is seen at the commit, one before it is in the tree read below.
        prep.created = self.directory.created_count();
        self.at(TreeStep::Descendants).await;
        let descendants = self.adjacency().await?.descendants(&prep.root);
        let snapshot = self.authority().snapshot();
        for (at, id) in std::iter::once(prep.root.clone()).chain(descendants).enumerate() {
            if at == 1 {
                self.at(TreeStep::Reserving).await;
            }
            if let Some(reason) = admit.refusal() {
                prep.refuse(reason);
                return Ok(());
            }
            let thread = ThreadId::from(id.as_str());
            let Some((handle, opened)) = self.directory.retain(&thread).await? else {
                // A sub-agent session deleted meanwhile is not part of the tree.
                if at == 0 {
                    prep.refuse("missing");
                    return Ok(());
                }
                continue;
            };
            if opened {
                prep.opened.push(thread);
            }
            handle.cell.retention.held.fetch_add(1, SeqCst);
            let epoch = handle.cell.retention.epoch();
            let closed = handle.cell.closed.load(SeqCst);
            let state = snapshot.resolve(&id, handle.cell.header.load().get("archivedAt"));
            prep.members.push(Reserved { id, handle, epoch, entry: state.entry, archived: state.archived() });
            if closed {
                prep.refuse("changed");
                return Ok(());
            }
            // After the entries were lost, a state with no entry may hide a restore (an exemption) the user made: never acted on.
            if !state.trusted() {
                prep.refuse(LOST);
                return Ok(());
            }
        }
        if prep.members.first().is_some_and(|root| root.archived) {
            prep.refuse("changed");
        }
        Ok(())
    }

    /// Commits a preparation, or nothing when it was refused, then lets go of every hold and releases what it opened (each release
    /// acknowledged by the thread's actor). An admitted archive is announced and its worktrees handed over here, awaited: a failure
    /// there is logged and never turns the committed archive into a failure.
    pub async fn commit(&self, mut prep: Preparation, admit: &Admit) -> TreeOutcome {
        let outcome = match prep.refused.clone() {
            Some(reason) => TreeOutcome::Refused(reason),
            None => self.commit_held(&prep, admit).await,
        };
        let opened = std::mem::take(&mut prep.opened);
        let root = ThreadId::from(prep.root.as_str());
        drop(prep);
        if let TreeOutcome::Archived(ids) = &outcome {
            self.notify(&root, true);
            if let Err(error) = self.worktrees.set_archived(ids, true).await {
                tracing::warn!("[mixdog-session] Could not update the worktrees of {root}: {error}");
            }
        }
        for thread in opened {
            self.directory.release(&thread).await;
        }
        outcome
    }

    /// Lets go of a preparation the caller does not commit.
    pub async fn abandon(&self, mut prep: Preparation) {
        prep.refuse("abandoned");
        self.commit(prep, &Admit { gate: Arc::default(), cancel: CancellationToken::new(), policy: Arc::default(), judged: 0 }).await;
    }

    async fn commit_held(&self, prep: &Preparation, admit: &Admit) -> TreeOutcome {
        self.at(TreeStep::Commit).await;
        let op_id = uuid::Uuid::now_v7().to_string();
        let members: Vec<ArchiveMember> =
            prep.members.iter().map(|member| (member.id.clone(), member.handle.clone(), member.epoch, member.entry, member.archived)).collect();
        let (directory, stamps, admit, created, op) = (self.directory.clone(), self.stamps.clone(), admit.clone(), prep.created, op_id.clone());
        let committed = self
            .authority()
            .commit(move |snapshot, tx| {
                if let Some(reason) = admit.refusal() {
                    return Ok((Err(reason), Vec::new()));
                }
                let moved = directory.created_count() != created
                    || members.iter().any(|(id, handle, epoch, entry, _)| {
                        handle.cell.closed.load(SeqCst)
                            || handle.cell.retention.epoch() != *epoch
                            || snapshot.entry(id) != *entry
                            || directory.deps().quota.goals.entry(id).is_some()
                    });
                if moved {
                    return Ok((Err("changed"), Vec::new()));
                }
                let now = directory.deps().clock.now_ms();
                let stamp = stamps.take(now) as f64;
                let changes: Vec<(String, ArchiveEntry)> =
                    members.iter().filter(|(_, _, _, _, archived)| !archived).map(|(id, ..)| (id.clone(), ArchiveEntry::Archived(stamp))).collect();
                let ids: Vec<String> = changes.iter().map(|(id, _)| id.clone()).collect();
                let outcome = json!({ "root": members[0].0, "archived": ids, "stamp": stamp }).to_string();
                let row = OpRow {
                    method: "session/autoArchive".into(),
                    payload_digest: members[0].0.clone(),
                    state: OpRowState::Applied,
                    outcome: Some(outcome),
                    created_at: now,
                    completed_at: Some(now),
                };
                tx.put_op(OP_SCOPE, &op, &row)?;
                Ok((Ok(ids), changes))
            })
            .await;
        match committed {
            Ok(committed) => {
                if let Err(error) = &committed.indexed {
                    tracing::warn!("[mixdog-session] The catalog did not take the archive of {} yet: {error}", prep.root);
                }
                match committed.answer {
                    Ok(ids) => TreeOutcome::Archived(ids),
                    Err(reason) => TreeOutcome::Refused(reason.to_owned()),
                }
            }
            // No answer: the committed outcome says whether it was admitted, never a compensation.
            Err(error) => match self.authority().outcome(&op_id).await {
                Ok(Some(row)) => TreeOutcome::Archived(archived_of(&row)),
                Ok(None) => TreeOutcome::Failed(error.to_string()),
                Err(read) => TreeOutcome::Failed(format!("{error}; its outcome could not be read: {read}")),
            },
        }
    }
}

/// The sessions a committed tree operation archived, from its op record.
fn archived_of(row: &OpRow) -> Vec<String> {
    let outcome: Value = row.outcome.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or(Value::Null);
    outcome.get("archived").and_then(Value::as_array).into_iter().flatten().filter_map(|id| id.as_str().map(str::to_owned)).collect()
}

/// `header` with its `archivedAt` as `archive` resolves it: what a summary or a judgment built from a header reads.
/// The header itself when it already states what rchive resolves (nearly always): a view is rebuilt on every published
/// note, and a copy of the header there was megabytes a second for a session at work.
pub fn resolved_header<'a>(archive: &ArchiveStates, id: &str, header: &'a Header) -> std::borrow::Cow<'a, Header> {
    let held = header.get("archivedAt");
    let at = archive.resolve(id, held).archived_at.map(mixdog_js::json_number);
    if at.as_ref() == held {
        return std::borrow::Cow::Borrowed(header);
    }
    let mut resolved = header.clone();
    match at {
        Some(at) => resolved.insert("archivedAt".into(), at),
        None => resolved.shift_remove("archivedAt"),
    };
    std::borrow::Cow::Owned(resolved)
}

/// Why an automatic decision refused a session whose state may depend on a lost entry.
pub const LOST: &str = "archive-state-lost";

/// One session alone, no cascade (the sub-agent retention, a closed agent's hide and reveal, the rooms' marks, the import of Node's
/// hidden set), through the authority.
pub enum Mark {
    /// Archived, at the stamp this gives (asked only when the session is not archived).
    Archive(Box<dyn FnOnce() -> f64 + Send>),
    /// The automatic retention's archive: as [`Mark::Archive`], but nothing when the state is not [`Resolved::trusted`] (a lost
    /// entry may have been the user's restore).
    Automatic(Box<dyn FnOnce() -> f64 + Send>),
    /// Brought back now.
    Restore,
}

impl SessionDirectory {
    /// `id`'s archive state, its header being `header`.
    pub fn archive_state(&self, id: &str, header: &Header) -> Resolved {
        self.deps().archive.resolve(id, header.get("archivedAt"))
    }

    /// `header` with its `archivedAt` as the authority resolves it ([`resolved_header`]).
    pub fn archive_resolved(&self, id: &str, header: &Header) -> Header {
        resolved_header(&self.deps().archive, id, header).into_owned()
    }

    /// Marks `id` alone, its header being `header`: one commit of the authority, nothing when it is in that state already. Whether
    /// it changed.
    pub async fn mark_archived(&self, id: &str, header: &Header, mark: Mark) -> Result<bool, CoreError> {
        let stamp = header.get("archivedAt").cloned();
        let (id, clock) = (id.to_owned(), self.deps().clock.clone());
        let committed = self
            .deps()
            .archive
            .commit(move |snapshot, _| {
                let state = snapshot.resolve(&id, stamp.as_ref());
                let archived = state.archived();
                let entry = match mark {
                    Mark::Archive(stamp) if !archived => ArchiveEntry::Archived(stamp()),
                    Mark::Automatic(stamp) if !archived && state.trusted() => ArchiveEntry::Archived(stamp()),
                    Mark::Restore if archived => ArchiveEntry::Restored(clock.now_ms() as f64),
                    _ => return Ok((false, Vec::new())),
                };
                Ok((true, vec![(id, entry)]))
            })
            .await
            .map_err(failed)?;
        if let Err(error) = &committed.indexed {
            tracing::warn!("[mixdog-session] The catalog did not take an archive change yet: {error}");
        }
        Ok(committed.answer)
    }
}

#[cfg(test)]
#[path = "archive_trees_tests.rs"]
mod tests;

/// One member of an archive tree: its id, handle, epoch, archive entry and whether it was archived already.
type ArchiveMember = (String, Arc<SessionHandle>, u64, Option<ArchiveEntry>, bool);
