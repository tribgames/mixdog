//! The store behind the worker registry: the writers that put each session's worker row (its header, the kept table or the
//! Lead table) in that session's own order, and the kept and Lead tables themselves.

use super::Bound;
use super::Index;
use super::ListRow;
use super::Place;
use super::Revision;
use super::Row;
use super::WorkerStore;
use super::signals;
use async_trait::async_trait;
use futures::StreamExt as _;
use mixdog_agent::agent_tool::host::ReleaseAnswer;
use mixdog_agent::agent_tool::host::ReleaseDone;
use mixdog_agent::agent_tool::host::ReleaseOutcome;
use mixdog_agent::agent_tool::host::ReleaseReceipt;
use mixdog_agent::agent_tool::host::ReleaseTarget;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::Attempt;
use mixdog_core_ports::ports::threads::HeaderStored;
use mixdog_core_ports::ports::threads::HeaderWrite;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::TaskClass;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::worker::WorkerScope;
use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

/// [`WorkerStore`] over the index and the threads' headers. Each row goes to its own session's record (a header patch,
/// through the session's actor), the kept table or the Lead table, so the writes are ordered per session and not across
/// sessions: one queue per session with work accepted ([`Writers`]), across its header, kept and Lead targets, retired
/// when it is empty. A put one session waits on holds no other session's write or answer; a put that is refused answers
/// that write as failed and is not made again by the writer.
pub struct StoreWorkers {
    index: SqliteStore,
    threads: Arc<dyn ThreadState>,
    pub(super) writers: Arc<Writers>,
    /// Where a session's first accepted write asks for its queue's task.
    dispatch: mpsc::UnboundedSender<Dispatch>,
    /// Each write numbered as it is accepted, reported once it is closed: progress, not outcomes.
    marks: Arc<mixdog_rt::WriteMarks>,
    io: InteractiveIo,
    /// `registry.onWorkerRowsChange` (`agent-tool.mjs`), bound once by the composition.
    signals: std::sync::OnceLock<Arc<dyn signals::StatusSignals>>,
    pub(super) kept: Arc<KeptRows>,
    /// The Lead index, in the same core state table as the kept maps.
    leads: Arc<LeadRows>,
    /// The journal identity the index listed each session with at the last load ([`Self::incarnation`]).
    logs: Mutex<HashMap<String, String>>,
}

/// What the one receiver of [`StoreWorkers::dispatch`] is asked. It starts tasks and waits for their ends; it awaits no put.
enum Dispatch {
    /// A session's queue was made: its task starts.
    Session(String),
    /// Told once every task started so far has ended.
    Joined(oneshot::Sender<()>),
}

/// The Lead index (1.4.5 `lead-workers.json`) in `state/core.sqlite`'s meta (`agent-lead-row:<session>`): a Lead's pool row
/// lives here, not in its session's header, so writing it is no change of the session's record.
pub struct LeadRows {
    state: mixdog_store::state::CoreState,
}

const LEAD_PREFIX: &str = "agent-lead-row:";

impl LeadRows {
    pub fn new(state: mixdog_store::state::CoreState) -> Self {
        Self { state }
    }

    /// Every stored Lead row, by session.
    pub async fn load(&self) -> Result<Vec<(String, Row)>, String> {
        let stored = self.state.meta_prefix(LEAD_PREFIX).await.map_err(|e| format!("lead rows: {e}"))?;
        let mut out = Vec::new();
        for (key, text) in stored {
            let session = key.trim_start_matches(LEAD_PREFIX).to_owned();
            let row: Row = serde_json::from_str(&text).map_err(|e| format!("lead row {session}: {e}"))?;
            out.push((session, row));
        }
        Ok(out)
    }

    /// Writes `session`'s Lead row (`None`: removes it).
    pub async fn put(&self, session: &str, row: Option<Row>) -> Result<(), String> {
        let key = format!("{LEAD_PREFIX}{session}");
        let written = match &row {
            Some(row) => {
                let text = serde_json::to_string(row).map_err(|e| e.to_string())?;
                self.state.write(move |tx| tx.put_meta(&key, &text)).await
            }
            None => self.state.write(move |tx| tx.delete_meta(&key).map(drop)).await,
        };
        written.map_err(|e| format!("lead row {session}: {e}"))
    }
}

/// Where a write goes: the session header's `worker` map, the kept maps' table or the Lead index.
type Target = ReleaseTarget;

/// The worker maps of sessions deleted while their rows still count (`WorkerStore::keep`), in `state/core.sqlite`'s meta
/// (`agent-kept-worker:<session>`): they outlive the session's header and a restart, as Node's index file rows do.
pub struct KeptRows {
    state: mixdog_store::state::CoreState,
    /// The kept sessions as last loaded, with this process's keeps.
    ids: Mutex<HashSet<String>>,
    /// The kept maps, read from the table once and kept current by every [`Self::put`]: a listing reads memory. The lock
    /// is held for memory alone, never across the table's read or write: one session's puts come one at a time
    /// (`StoreWorkers`' queue of that session), so its map in memory follows its row in the table.
    rows: Mutex<Option<KeptMemory>>,
}

/// The kept maps in memory, each with the revision of its last put (its keep order), and the revision of each session's
/// last change, so a load asks only for what changed since the revision it holds.
#[derive(Default)]
pub(super) struct KeptMemory {
    maps: HashMap<String, (u64, Row)>,
    /// Each kept row's identity, as the table holds it ([`KEPT_IDENTITY_PREFIX`]).
    identities: HashMap<String, String>,
    revision: u64,
    /// Highest revision whose removed-session change entry was pruned: any `since < floor` falls back to `All`.
    floor: u64,
    changed: BTreeMap<u64, String>,
    changed_at: HashMap<String, u64>,
}

impl KeptMemory {
    pub(super) fn set(&mut self, session: &str, worker: Option<Row>) {
        self.revision += 1;
        if let Some(at) = self.changed_at.insert(session.to_owned(), self.revision) {
            self.changed.remove(&at);
        }
        self.changed.insert(self.revision, session.to_owned());
        match worker {
            Some(map) => self.maps.insert(session.to_owned(), (self.revision, map)),
            None => self.maps.remove(session),
        };
    }

    pub(super) fn forget(&mut self, session: &str) {
        if !self.maps.contains_key(session)
            && let Some(at) = self.changed_at.remove(session)
        {
            self.changed.remove(&at);
            self.floor = self.floor.max(at);
        }
    }

    fn prune_removed_through(&mut self, through: u64) {
        let stale: Vec<(u64, String)> =
            self.changed.range(..=through).filter(|(_, id)| !self.maps.contains_key(id.as_str())).map(|(&at, id)| (at, id.clone())).collect();
        for (at, id) in stale {
            self.changed.remove(&at);
            if self.changed_at.get(&id) == Some(&at) {
                self.changed_at.remove(&id);
            }
            self.floor = self.floor.max(at);
        }
    }

    pub(super) fn since(&mut self, since: Option<u64>) -> (u64, KeptSince) {
        let answer = match since {
            Some(since) if since >= self.floor && since <= self.revision => {
                let changed = self.changed.range(since + 1..).map(|(_, id)| (id.clone(), self.maps.get(id).cloned())).collect();
                self.prune_removed_through(since);
                KeptSince::Changed(changed)
            }
            _ => {
                self.prune_removed_through(self.revision);
                KeptSince::All(self.all())
            }
        };
        (self.revision, answer)
    }

    #[cfg(test)]
    pub(super) fn changed_counts(&self) -> (usize, usize) {
        (self.changed.len(), self.changed_at.len())
    }

    fn all(&self) -> Vec<(String, u64, Row)> {
        let mut all: Vec<(String, u64, Row)> = self.maps.iter().map(|(id, (at, map))| (id.clone(), *at, map.clone())).collect();
        all.sort_by_key(|(_, at, _)| *at);
        all
    }
}

/// What a load of the kept maps hands over: every one, or each session changed since the revision asked about with its map
/// and keep order now (`None`: kept no more).
pub enum KeptSince {
    All(Vec<(String, u64, Row)>),
    Changed(Vec<(String, Option<(u64, Row)>)>),
}

const KEPT_PREFIX: &str = "agent-kept-worker:";
/// A kept row's identity (`agent-kept-identity:<session>`): given in the transaction that makes the row, kept by every
/// later write of it, and removed with it. A row kept again under the same session id after it was removed has
/// another, so a release decided for the earlier row is not applied to the later one.
const KEPT_IDENTITY_PREFIX: &str = "agent-kept-identity:";
/// The operation of the last release a kept row's table transaction committed (`agent-kept-release:<session>`), written
/// in that transaction: what answers for that operation when it is submitted again.
const KEPT_RELEASE_PREFIX: &str = "agent-kept-release:";

/// One release of a kept row ([`KeptRows::release`]).
struct KeptRelease {
    identity: String,
    operation: String,
    prior: Option<Row>,
    again: bool,
}

/// What a kept row's transaction came to.
enum KeptPut {
    /// Committed: the row's identity now (`None`: the row is gone).
    Written(Option<String>),
    /// The release's own transaction had committed before: nothing was written.
    Committed,
    /// The row is not the one the release was decided for, or no longer holds what it was decided on: nothing was
    /// written.
    Superseded(&'static str),
}

impl KeptRows {
    pub fn new(state: mixdog_store::state::CoreState) -> Self {
        Self { state, ids: Mutex::default(), rows: Mutex::new(None) }
    }

    fn ids(&self) -> MutexGuard<'_, HashSet<String>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn rows(&self) -> MutexGuard<'_, Option<KeptMemory>> {
        self.rows.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reads the table into memory the first time. A read that finds memory filled meanwhile leaves it as it is: from then
    /// on only a put changes it, and a put fills memory before it writes, so a table read from before that write is never
    /// what memory ends with.
    async fn loaded(&self) -> Result<(), String> {
        let filled = self.rows().is_some();
        if filled {
            return Ok(());
        }
        let stored = self.state.meta_prefix(KEPT_PREFIX).await.map_err(|e| format!("kept worker rows: {e}"))?;
        let mut out = Vec::new();
        for (key, text) in stored {
            let session = key.trim_start_matches(KEPT_PREFIX).to_owned();
            let map: Row = serde_json::from_str(&text).map_err(|e| format!("kept worker row {session}: {e}"))?;
            out.push((session, map));
        }
        // A row kept before rows had identities is given one, in a transaction that reads what the table holds then.
        let held = self.state.meta_prefix(KEPT_IDENTITY_PREFIX).await.map_err(|e| format!("kept worker rows: {e}"))?;
        let mut identities: HashMap<String, String> =
            held.into_iter().map(|(key, identity)| (key.trim_start_matches(KEPT_IDENTITY_PREFIX).to_owned(), identity)).collect();
        identities.retain(|session, _| out.iter().any(|(kept, _)| kept == session));
        let lacking: Vec<String> = out.iter().map(|(session, _)| session.clone()).filter(|session| !identities.contains_key(session)).collect();
        if !lacking.is_empty() {
            let given = self
                .state
                .write(move |tx| {
                    let mut given = Vec::new();
                    for session in lacking {
                        if tx.meta(&format!("{KEPT_PREFIX}{session}"))?.is_none() {
                            continue;
                        }
                        let key = format!("{KEPT_IDENTITY_PREFIX}{session}");
                        let identity = match tx.meta(&key)? {
                            Some(identity) => identity,
                            None => {
                                let identity = uuid::Uuid::new_v4().simple().to_string();
                                tx.put_meta(&key, &identity)?;
                                identity
                            }
                        };
                        given.push((session, identity));
                    }
                    Ok(given)
                })
                .await
                .map_err(|e| format!("kept worker rows: {e}"))?;
            identities.extend(given);
        }
        let mut rows = self.rows();
        if rows.is_none() {
            self.ids().extend(out.iter().map(|(session, _)| session.clone()));
            let mut memory = KeptMemory::default();
            for (session, map) in out {
                memory.set(&session, Some(map));
            }
            memory.identities = identities;
            *rows = Some(memory);
        }
        Ok(())
    }

    /// The identity of `session`'s kept row as the table held it at its last committed write; `None` while the rows
    /// are not loaded or the session has no row there.
    fn identity(&self, session: &str) -> Option<String> {
        self.rows().as_ref()?.identities.get(session).cloned()
    }

    /// Every kept map, by session, in keep order.
    pub async fn load(&self) -> Result<Vec<(String, Row)>, String> {
        self.loaded().await?;
        Ok(self.rows().as_ref().map(KeptMemory::all).unwrap_or_default().into_iter().map(|(id, _, map)| (id, map)).collect())
    }

    /// The kept maps from the revision the caller holds (`None`: none yet): the revision now and what changed since, or
    /// every one when it holds none, or one memory never reached.
    pub async fn since(&self, since: Option<u64>) -> Result<(u64, KeptSince), String> {
        self.loaded().await?;
        let mut rows = self.rows();
        let memory = rows.as_mut().expect("loaded above");
        Ok(memory.since(since))
    }

    pub fn forget(&self, session: &str) {
        if let Some(memory) = self.rows().as_mut() {
            memory.forget(session);
        }
    }

    /// Every kept map with its keep order, in that order (once loaded).
    fn all(&self) -> Vec<(String, u64, Row)> {
        self.rows().as_ref().map(KeptMemory::all).unwrap_or_default()
    }

    /// The session's kept map now, with its keep order.
    fn get(&self, session: &str) -> Option<(u64, Row)> {
        self.rows().as_ref()?.maps.get(session).cloned()
    }

    pub fn holds(&self, session: &str) -> bool {
        self.ids().contains(session)
    }

    /// Writes `session`'s kept map (`None`: it is kept no more, and its row leaves the table). Memory follows the table: it
    /// changes only once the write is committed, so a failed write leaves every later listing as the table is, and `Ok`
    /// is the committed transaction of this put.
    pub async fn put(&self, session: &str, worker: Option<Row>) -> Result<(), String> {
        self.transact(session, worker, None).await.map(drop)
    }

    /// One release of `session`'s kept row, in one transaction with what it depends on. It is applied only to the row
    /// it was decided for (the row's identity) and only while that row holds the map it was decided on. Submitted
    /// `again`, it is answered by the table's own record of the operation when its transaction had committed.
    async fn release(&self, session: &str, worker: Row, release: KeptRelease) -> Result<KeptPut, String> {
        self.transact(session, Some(worker), Some(release)).await
    }

    async fn transact(&self, session: &str, worker: Option<Row>, release: Option<KeptRelease>) -> Result<KeptPut, String> {
        self.loaded().await?;
        let (key, identity_key, release_key) =
            (format!("{KEPT_PREFIX}{session}"), format!("{KEPT_IDENTITY_PREFIX}{session}"), format!("{KEPT_RELEASE_PREFIX}{session}"));
        let text = worker.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
        let written = self
            .state
            .write(move |tx| {
                let held = tx.meta(&identity_key)?;
                if let Some(release) = &release {
                    if held.as_deref() != Some(release.identity.as_str()) {
                        return Ok(KeptPut::Superseded("the kept row is not the one the release was decided for"));
                    }
                    if release.again && tx.meta(&release_key)?.as_deref() == Some(release.operation.as_str()) {
                        return Ok(KeptPut::Committed);
                    }
                    let current = tx.meta(&key)?.and_then(|text| serde_json::from_str::<Row>(&text).ok());
                    if current != release.prior {
                        return Ok(KeptPut::Superseded("the kept row no longer holds the map the release was decided on"));
                    }
                }
                let Some(text) = &text else {
                    tx.delete_meta(&key)?;
                    tx.delete_meta(&identity_key)?;
                    tx.delete_meta(&release_key)?;
                    return Ok(KeptPut::Written(None));
                };
                tx.put_meta(&key, text)?;
                let identity = held.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
                tx.put_meta(&identity_key, &identity)?;
                if let Some(release) = &release {
                    tx.put_meta(&release_key, &release.operation)?;
                }
                Ok(KeptPut::Written(Some(identity)))
            })
            .await
            .map_err(|e| format!("kept worker row {session}: {e}"))?;
        if let KeptPut::Written(identity) = &written {
            let mut rows = self.rows();
            if worker.is_some() {
                self.ids().insert(session.to_owned());
            } else {
                self.ids().remove(session);
            }
            let memory = rows.get_or_insert_with(KeptMemory::default);
            match identity {
                Some(identity) => memory.identities.insert(session.to_owned(), identity.clone()),
                None => memory.identities.remove(session),
            };
            memory.set(session, worker);
        }
        Ok(written)
    }
}

/// One write a session's queue has not put yet. Every accepted write is one of these, put in its session's order under
/// its own number: none is merged into another, so each keeps its own outcome.
struct Op {
    worker: Option<Row>,
    target: Target,
    mark: u64,
    /// A release: answered by this write's own outcome.
    release: Option<Receipted>,
}

/// The receipt side of a release's [`Op`]: the handle its outcome answers, and what its target applies it by.
struct Receipted {
    answer: ReleaseAnswer,
    order: Order,
}

/// What a release's target applies it by ([`ReleaseReceipt`]): the same whenever the operation is submitted.
struct Order {
    /// The operation was submitted before and is not known stored: its target answers by its committed record, and
    /// writes it only when it is known not to have committed.
    again: bool,
    /// The operation's identity, carried into the record that stores it.
    operation: String,
    /// The incarnation of the session the release was decided for: the target applies it to no other.
    incarnation: String,
    /// The map the release was decided on, the receipt's own, fixed at the decision: the target applies the release
    /// only while it holds that.
    prior: Option<Row>,
}

/// The write a session's task has at its put. It is held here, not by the task, so that the directory's cutoff can
/// answer it without waiting for the put to return ([`Writers::cut_headers`]): whoever takes it answers it, once.
struct Flight {
    target: Target,
    mark: u64,
    answer: Option<ReleaseAnswer>,
    /// A release's header write, from the moment it is submitted: what settles it should its outcome stay unknown
    /// ([`Lanes::unsettled`]), whoever takes the flight.
    write: Option<HeaderWrite>,
    /// The write was handed to its target ([`Writers::submit`]). Until then the flight is provably unsubmitted, and
    /// whoever takes it (the directory's cutoff) leaves nothing that can still be submitted.
    submitted: bool,
}

/// The admission of header-target writes as the session directory shuts down. A header write is put through its
/// session's actor, and opens the session when it is not loaded: from the point the directory drains its slots nothing
/// may do that. The kept and the Lead table take writes until [`StoreWorkers::shutdown`] seals.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Headers {
    #[default]
    Open,
    /// The directory's shutdown reached its flush (`RowWrites::drain`): no header write is accepted; the ones accepted
    /// before are put while the actors are there.
    Sealed,
    /// The directory drains its slots (`RowWrites::headers_closed`): the header writes still queued were answered
    /// refused there and those at their put indeterminate ([`Writers::cut_headers`]); none is left to put.
    Closed,
}

const HEADERS_CLOSED: &str = "the sessions are shutting down: no header is written";

/// Closed writes by number, in order, each with why it was not stored (`None`: stored).
type Closed = Vec<(u64, Option<String>)>;

/// The queues of the sessions with work accepted and not finished.
#[derive(Default)]
pub(super) struct Lanes {
    /// Set by [`StoreWorkers::shutdown`], under the lock a write is accepted under: nothing is accepted after it.
    sealed: bool,
    /// Whether a write bound for a session's header is still taken ([`Headers`]).
    headers: Headers,
    /// A session's writes not started yet, in the order they were accepted. The entry is the session's task: made with
    /// its first write, removed by the task when it finds the queue empty.
    active: HashMap<String, VecDeque<Op>>,
    /// The write each session's task has at its put ([`Flight`]).
    in_flight: HashMap<String, Flight>,
    /// The one record of outcomes, and all a flush answers from: per session and target, closed writes by number, in
    /// order, each with why it was not stored (`None`: stored). A flush selects the last entry at or below its
    /// watermark. Only what an answer can still depend on is held ([`Self::trim`]): the last write's outcome when it
    /// was not stored, and the earlier entries a watermark in `flushes` still selects. So with no flush outstanding
    /// there is at most one entry per session and target, however many of its writes were refused, and none once its
    /// last write is stored.
    closed: HashMap<(String, Target), Closed>,
    /// The sessions whose record went ([`WorkerStore::keep`]), each with the numbers, ascending, of the kept writes
    /// that took a record's place: one per record that went, since a session can be made again and deleted again. A
    /// retirement covers the header writes accepted before it: to a flush whose watermark is at or above it they are
    /// owed nothing, and a flush taken below it still selects among them what it would have selected.
    pub(super) retired: HashMap<String, Vec<u64>>,
    /// What a session's header or kept row really holds, for the sessions whose last closed write there was not
    /// stored, so that the registry's map is ahead of it: read from the target by the session's own task after that
    /// write ([`Writers::read_holds`]), and dropped once a stored write makes the target equal to the registry's map
    /// again. What the session's next release is decided on ([`Bound::holds`]).
    holds: HashMap<(String, Target), Option<Row>>,
    /// The watermarks of the flushes not answered yet ([`FlushMark`]), each with how many hold it.
    flushes: BTreeMap<u64, usize>,
    /// The sessions whose header holds a release of unknown outcome, each with that release's own write: the operation
    /// that settles it. It is here, not in the task that put it, so that the session's next header operation settles
    /// it first whichever task runs it, the first one's having retired or not, and with no other write in between
    /// ([`Writers::settle`]). No map is kept of any session: only this, for as long as the outcome is unknown.
    pub(super) unsettled: HashMap<String, HeaderWrite>,
}

impl Lanes {
    /// The record of what `target` really holds of `session`, for a release decided now ([`Bound::holds`]). It tells
    /// of the target as the session's last closed write left it: with a write of the session there still queued or at
    /// its put, the release queued now is put after that write, and the caller's own map, which counts it, is the
    /// better word; a mismatch either way is a superseded release, never a wrong write.
    fn holds_of(&self, session: &str, target: Target) -> Option<Option<Row>> {
        let open = self.in_flight.get(session).is_some_and(|flight| flight.target == target)
            || self.active.get(session).is_some_and(|queue| queue.iter().any(|op| op.target == target));
        if open { None } else { self.holds.get(&(session.to_owned(), target)).cloned() }
    }

    /// The flight of `session` is taken with its outcome unknown: a release that was submitted leaves its write to be
    /// settled.
    fn leave_unsettled(&mut self, session: &str, flight: &Flight) {
        if let Some(write) = &flight.write {
            self.unsettled.insert(session.to_owned(), write.clone());
        }
    }

    /// Records the outcome of the write numbered `mark` (`failure`: why it was not stored), and drops what it
    /// supersedes. `kept`: the session's map is a kept one now.
    ///
    /// A retirement covers what was accepted before it and nothing else. A header write numbered below one of the
    /// session's retirements belongs to the record that went then: it is recorded like any other, and held for as long
    /// as a flush taken before that retirement can select it, however late it closes, whether or not the session was
    /// made again and retired again since. One numbered above every retirement is the present record's; while the
    /// session is kept it has none, and that write is owed to no header.
    fn close(&mut self, session: &str, target: Target, mark: u64, failure: Option<String>, kept: bool) {
        let key = (session.to_owned(), target);
        let ends: &[u64] = if target == Target::Header { self.retired.get(session).map_or(&[][..], Vec::as_slice) } else { &[] };
        if kept && !ends.is_empty() && ends.iter().all(|at| *at <= mark) {
            return;
        }
        let closed = self.closed.entry(key.clone()).or_default();
        let before = closed.partition_point(|(closed, _)| *closed < mark);
        closed.insert(before, (mark, failure));
        Self::trim(closed, ends, &self.flushes);
        if closed.is_empty() {
            self.closed.remove(&key);
        }
    }

    /// Drops the entries no flush can select: a later flush takes a watermark at or above every number closed so far,
    /// so it selects the last entry; an outstanding one selects the last entry at or below its own watermark. `ends`:
    /// the numbers the session's header was retired at, ascending. An entry below one of them is selected only by a
    /// flush taken below that one, so it is held only for the flushes between it and whichever comes first, the next
    /// entry or that retirement. A stored entry with nothing before it answers as no entry does, and goes too.
    fn trim(closed: &mut Vec<(u64, Option<String>)>, ends: &[u64], flushes: &BTreeMap<u64, usize>) {
        let marks: Vec<u64> = closed.iter().map(|(mark, _)| *mark).collect();
        let mut at = 0;
        closed.retain(|_| {
            let mark = marks[at];
            let next = [marks.get(at + 1).copied(), ends.iter().copied().find(|end| *end > mark)].into_iter().flatten().min();
            at += 1;
            next.is_none_or(|next| flushes.range(mark..next).next().is_some())
        });
        let stored = closed.iter().take_while(|(_, failure)| failure.is_none()).count();
        closed.drain(..stored);
    }

    /// Every entry trimmed again, and each retirement that nothing depends on any more forgotten: one is kept while
    /// an outcome below it is held, while the session's queue may still close a write accepted before it, and, the
    /// last one, while the session's record is still gone (`gone`).
    fn trim_all(&mut self, gone: impl Fn(&str) -> bool) {
        let Self { closed, flushes, retired, active, .. } = self;
        closed.retain(|(session, target), closed| {
            let ends: &[u64] = if *target == Target::Header { retired.get(session).map_or(&[][..], Vec::as_slice) } else { &[] };
            Self::trim(closed, ends, flushes);
            !closed.is_empty()
        });
        retired.retain(|session, ends| {
            let busy = active.contains_key(session);
            let entries = closed.get(&(session.clone(), Target::Header));
            let last = if gone(session) { ends.last().copied() } else { None };
            ends.retain(|end| busy || Some(*end) == last || entries.is_some_and(|entries| entries.iter().any(|(mark, _)| mark < end)));
            !ends.is_empty()
        });
    }

    /// The session's record is gone, its place taken by the kept write numbered `at`: the header outcomes of the
    /// writes accepted before it are held from here only for the flushes taken below that number. A session made again
    /// and retired again has a retirement for each record that went: none stands in for another.
    fn retire(&mut self, session: &str, at: u64) {
        let ends = self.retired.entry(session.to_owned()).or_default();
        if ends.last().is_none_or(|last| *last < at) {
            ends.push(at);
        }
        let key = (session.to_owned(), Target::Header);
        self.unsettled.remove(session);
        self.holds.remove(&key);
        if let Some(closed) = self.closed.get_mut(&key) {
            Self::trim(closed, ends, &self.flushes);
            if closed.is_empty() {
                self.closed.remove(&key);
            }
        }
    }

    /// A flush to `watermark` is outstanding from here: what it selects is held until [`Self::flush_answered`].
    fn flush_begun(&mut self, watermark: u64) {
        *self.flushes.entry(watermark).or_default() += 1;
    }

    /// The flush answered (or was given up): what only it could select is dropped.
    fn flush_answered(&mut self, watermark: u64, gone: impl Fn(&str) -> bool) {
        if let Some(holders) = self.flushes.get_mut(&watermark) {
            *holders -= 1;
            if *holders == 0 {
                self.flushes.remove(&watermark);
            }
        }
        self.trim_all(gone);
    }

    /// The lowest-numbered write that is, for its session and target, the last at or below `watermark` and was not
    /// stored. Writes above the watermark are not looked at: none fails this answer, and none repairs it. A header
    /// write whose record was retired at or below the watermark is owed nothing: a retirement between the write and
    /// the watermark.
    fn standing(&self, watermark: u64) -> Option<(u64, &str)> {
        self.closed
            .iter()
            .filter_map(|((session, target), closed)| {
                let (mark, failure) = closed.iter().rev().find(|(mark, _)| *mark <= watermark)?;
                let retired =
                    *target == Target::Header && self.retired.get(session).is_some_and(|ends| ends.iter().any(|end| *end > *mark && *end <= watermark));
                if retired { None } else { Some((*mark, failure.as_deref()?)) }
            })
            .min_by_key(|(mark, _)| *mark)
    }
}

/// A flush's watermark ([`StoreWorkers::flush_mark`]), outstanding while this lives: the outcomes it can still select
/// are held for it, and dropped with it when no other flush and no later one can select them.
pub struct FlushMark {
    writers: Arc<Writers>,
    watermark: u64,
}

impl FlushMark {
    /// The number of the last write the flush answers for.
    pub fn number(&self) -> u64 {
        self.watermark
    }
}

impl Drop for FlushMark {
    fn drop(&mut self) {
        let kept = &self.writers.kept;
        self.writers.lanes().flush_answered(self.watermark, |session| kept.holds(session));
    }
}

/// What the session tasks of a [`StoreWorkers`] share. The lock guards memory alone and is never held across a put.
pub(super) struct Writers {
    lanes: Mutex<Lanes>,
    /// Woken whenever a write is answered or a session's queue retires.
    moved: tokio::sync::Notify,
    threads: Arc<dyn ThreadState>,
    kept: Arc<KeptRows>,
    leads: Arc<LeadRows>,
    /// The writes' numbers and how far they are closed: progress alone. Every write is reported written here once it
    /// is closed, stored or not; what became of it is in the lanes' one ledger ([`Lanes::closed`]) and nowhere else.
    marks: Arc<mixdog_rt::WriteMarks>,
}

const WRITER_CLOSED: &str = "the worker writer is closed";

/// Ends a session's queue when its task ends any other way than by finding it empty: what it held is answered failed,
/// so no flush or shutdown waits on a write nothing will make.
struct Retiring<'a> {
    writers: &'a Writers,
    session: &'a str,
    retired: bool,
}

impl Drop for Retiring<'_> {
    fn drop(&mut self) {
        if !self.retired {
            // The write at its put, unless the cutoff answered it: its handle, dropped here, reads as indeterminate.
            let flight = {
                let mut lanes = self.writers.lanes();
                let flight = lanes.in_flight.remove(self.session);
                if let Some(flight) = &flight {
                    lanes.leave_unsettled(self.session, flight);
                }
                flight
            };
            if let Some(flight) = flight {
                self.writers.close(self.session, flight.target, flight.mark, Some("the session's row writer ended"));
            }
            self.writers.abandon(self.session, "the session's row writer ended");
            self.writers.moved.notify_waiters();
        }
    }
}

impl Writers {
    pub(super) fn lanes(&self) -> MutexGuard<'_, Lanes> {
        self.lanes.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Accepts one write behind the session's earlier ones and numbers it. `Ok(true)`: the session had no queue, and
    /// its task is to be started. `Err`: admission is sealed, for every target or for the headers once the session
    /// directory shuts down, and the release is handed back unanswered with why. No write is merged with another: each
    /// is put, in the order accepted, under its own number, so a write accepted after a flush's watermark cannot take
    /// the place, the number or the outcome of one accepted before it. `retire`: the write is the kept one that takes
    /// the place of the session's record ([`Lanes::retire`]), under the lock that numbers it; with a map, the session
    /// is marked kept in that same step, so that no write of it closes seeing it kept and that retirement not yet
    /// numbered ([`Self::close`]). A kept write that is not accepted marks nothing.
    fn accept(
        &self,
        session: &str,
        worker: Option<Row>,
        target: Target,
        release: Option<Receipted>,
        retire: bool,
    ) -> Result<bool, (&'static str, Option<Box<Receipted>>)> {
        let mut lanes = self.lanes();
        if lanes.sealed {
            return Err((WRITER_CLOSED, release.map(Box::new)));
        }
        if target == Target::Header && lanes.headers != Headers::Open {
            return Err((HEADERS_CLOSED, release.map(Box::new)));
        }
        let mark = self.marks.accept();
        if retire {
            if worker.is_some() {
                self.kept.ids().insert(session.to_owned());
            }
            lanes.retire(session, mark);
        }
        let first = !lanes.active.contains_key(session);
        lanes.active.entry(session.to_owned()).or_default().push_back(Op { worker, target, mark, release });
        Ok(first)
    }

    /// Ends `session`'s queue with nothing more put: each write it held is answered failed with `why`.
    fn abandon(&self, session: &str, why: &str) {
        let held = self.lanes().active.remove(session).unwrap_or_default();
        for op in held {
            self.answered(session, op.target, op.mark, op.release.map(|release| release.answer), ReleaseOutcome::Refused(why.to_owned()));
        }
        self.moved.notify_waiters();
    }

    /// Reports the write numbered `mark` closed (`failure`: why it was not stored): to the ledger, then to the marks
    /// as progress, so a flush that finds the number closed finds its outcome.
    fn close(&self, session: &str, target: Target, mark: u64, failure: Option<&str>) {
        {
            // Whether the session is kept is read under the lock its retirement is numbered under ([`Self::accept`]).
            let mut lanes = self.lanes();
            let kept = target == Target::Header && self.kept.holds(session);
            lanes.close(session, target, mark, failure.map(str::to_owned), kept);
        }
        self.marks.written(mark);
    }

    /// The directory's cutoff ([`RowWrites::headers_closed`]): the header writes are settled here and now, and none
    /// waits for a put that may never return. What was provably not submitted is told apart from what was.
    ///
    /// A header write still queued was not submitted: it is answered refused. So is one its session's task has taken
    /// and not yet handed to its target (the task is settling an earlier release, say): the cutoff takes that flight,
    /// and the task, finding it gone, submits nothing ([`Self::submit`]). One that was handed over may have reached
    /// its session's journal, and that the time ran out says nothing of whether it did: it is answered indeterminate,
    /// a release leaves its write to be settled, and whatever its put returns later answers nothing. The table writes
    /// queued behind them stay queued for their session's task. Other sessions are not touched.
    fn cut_headers(&self) {
        let (flights, queued) = {
            let mut lanes = self.lanes();
            lanes.headers = Headers::Closed;
            let at_put: Vec<String> =
                lanes.in_flight.iter().filter(|(_, flight)| flight.target == Target::Header).map(|(session, _)| session.clone()).collect();
            let flights: Vec<(String, Flight)> =
                at_put.into_iter().filter_map(|session| lanes.in_flight.remove(&session).map(|flight| (session, flight))).collect();
            for (session, flight) in &flights {
                lanes.leave_unsettled(session, flight);
            }
            let mut queued = Vec::new();
            for (session, queue) in lanes.active.iter_mut() {
                let (cut, left): (VecDeque<Op>, VecDeque<Op>) = std::mem::take(queue).into_iter().partition(|op| op.target == Target::Header);
                *queue = left;
                queued.extend(cut.into_iter().map(|op| (session.clone(), op)));
            }
            (flights, queued)
        };
        for (session, flight) in flights {
            let outcome = if flight.submitted {
                let why = format!("the worker row of {session}: it was at its put when the sessions stopped, and whether it is stored is not known");
                ReleaseOutcome::Indeterminate(why)
            } else {
                ReleaseOutcome::Refused(format!("the worker row of {session}: {HEADERS_CLOSED}"))
            };
            self.answered(&session, flight.target, flight.mark, flight.answer, outcome);
        }
        for (session, op) in queued {
            let why = format!("the worker row of {session}: {HEADERS_CLOSED}");
            self.answered(&session, op.target, op.mark, op.release.map(|release| release.answer), ReleaseOutcome::Refused(why));
        }
    }

    /// Hands the session's flight to its target: from here it is submitted, and a release's `write` is what settles it
    /// should its outcome stay unknown. `false`: the cutoff took the flight while it was unsubmitted and answered it
    /// refused, and it must not be submitted now. Decided under the lock the cutoff takes flights under.
    fn submit(&self, session: &str, write: Option<&HeaderWrite>) -> bool {
        let mut lanes = self.lanes();
        let Some(flight) = lanes.in_flight.get_mut(session) else { return false };
        flight.submitted = true;
        flight.write = write.cloned();
        true
    }

    /// One session's task: its writes one at a time, in the order they were accepted; it ends, and the queue with it,
    /// when it finds none left.
    ///
    /// A header operation is not started over a release of the session whose outcome is unknown: that release is
    /// settled first ([`Self::settle`]), once, by whichever task this is. Nothing waits, nothing is tried again on a
    /// timer, and no other session is held by it.
    async fn run_session(self: Arc<Self>, session: String) {
        let mut retiring = Retiring { writers: &self, session: &session, retired: false };
        loop {
            let (worker, target, order) = {
                let mut lanes = self.lanes();
                match lanes.active.get_mut(&session).and_then(VecDeque::pop_front) {
                    Some(Op { worker, target, mark, release }) => {
                        let (answer, order) = release.map(|release| (release.answer, release.order)).unzip();
                        lanes.in_flight.insert(session.clone(), Flight { target, mark, answer, write: None, submitted: false });
                        (worker, target, order)
                    }
                    None => {
                        lanes.active.remove(&session);
                        let kept = &self.kept;
                        lanes.trim_all(|session| kept.holds(session));
                        retiring.retired = true;
                        drop(lanes);
                        self.moved.notify_waiters();
                        return;
                    }
                }
            };
            let unsettled = if target == Target::Header { self.settle(&session).await } else { Ok(()) };
            let outcome = match (unsettled, &order) {
                (Ok(()), _) => self.put(&session, target, worker, order.as_ref()).await,
                // Not submitted: what the session holds cannot be told. A release says so on its own receipt as what
                // it is, an outcome that is not known; it is held for recovery like any other.
                (Err(error), Some(_)) => ReleaseOutcome::Indeterminate(format!(
                    "the release of {session}: an earlier release of the session cannot be settled, so nothing is written over it: {error}"
                )),
                (Err(error), None) => {
                    ReleaseOutcome::Refused(format!("the worker row of {session}: an earlier release of the session cannot be settled: {error}"))
                }
            };
            // The flight ends here, with the target's answer: the outcome is recorded and the receipt answered before
            // anything else is asked of the session, so nothing that comes later (the cutoff least of all) can put
            // another outcome in the place of one the target established. The cutoff may have answered it before:
            // then this outcome answers nothing, except that a put which came back with a known outcome leaves
            // nothing of its own to settle.
            let unapplied = matches!(outcome, ReleaseOutcome::Refused(_) | ReleaseOutcome::Superseded(_));
            let (flight, open) = {
                let mut lanes = self.lanes();
                // A stored write makes the target the registry's map again.
                if outcome == ReleaseOutcome::Stored {
                    lanes.holds.remove(&(session.clone(), target));
                }
                let flight = lanes.in_flight.remove(&session);
                if flight.is_none()
                    && !matches!(outcome, ReleaseOutcome::Indeterminate(_))
                    && let Some(order) = &order
                    && lanes.unsettled.get(&session).is_some_and(|write| write.operation == order.operation)
                {
                    lanes.unsettled.remove(&session);
                }
                (flight, target != Target::Header || lanes.headers != Headers::Closed)
            };
            let Some(flight) = flight else {
                tracing::warn!(session = session.as_str(), ?outcome, "[agent] a worker row's put returned after the sessions' cutoff had answered it");
                continue;
            };
            self.answered(&session, flight.target, flight.mark, flight.answer, outcome);
            // A write that was not applied leaves the registry's map ahead of the target: what the target holds is
            // read, by this task, with no write of the session between the read and what it records. It is no part of
            // the flight, which is answered. Not once the sessions' cutoff has come: nothing asks a session anything
            // from there.
            if unapplied
                && open
                && let Some(holds) = self.read_holds(&session, target).await
            {
                self.lanes().holds.insert((session.clone(), target), holds);
            }
        }
    }

    /// Settles the release of `session` whose outcome is unknown, if there is one, before the session's next header
    /// operation: that same operation is asked for (`Attempt::Settle`: the log's unknown outcome first, then the
    /// journal's record of it), and nothing is appended. Told (committed, known not to be, or superseded), the mark is
    /// lifted; when it turns out not applied, what the header holds is read for the next decision. `Err`: it could
    /// not be answered, whatever the reason (the log cannot tell, the actor refused before it looked): the mark stays
    /// for the next operation to ask again.
    async fn settle(&self, session: &str) -> Result<(), String> {
        let Some(write) = self.lanes().unsettled.get(session).cloned() else { return Ok(()) };
        let told = match self.threads.store_header(&ThreadId::from(session), HeaderWrite { attempt: Attempt::Settle, ..write.clone() }).await {
            HeaderStored::Indeterminate(error) => return Err(error),
            told => told,
        };
        let holds = if told == HeaderStored::Stored { None } else { self.read_holds(session, Target::Header).await };
        let mut lanes = self.lanes();
        if lanes.unsettled.get(session).is_some_and(|held| held.operation == write.operation) {
            lanes.unsettled.remove(session);
        }
        match holds {
            Some(holds) => drop(lanes.holds.insert((session.to_owned(), Target::Header), holds)),
            None => drop(lanes.holds.remove(&(session.to_owned(), Target::Header))),
        }
        Ok(())
    }

    /// What `target` holds of `session` now, read from the target itself after a write of the session there was not
    /// applied: a header's map is asked of the session's actor ([`ThreadState::held_fields`]), a kept row's is the
    /// table's. Never a precondition for a write already decided: only what the next release is decided on. `None`:
    /// it could not be read, and nothing is recorded.
    async fn read_holds(&self, session: &str, target: Target) -> Option<Option<Row>> {
        match target {
            Target::Lead => None,
            Target::Kept => Some(self.kept.get(session).map(|(_, map)| map)),
            Target::Header => {
                let held = self.threads.held_fields(&ThreadId::from(session), &["worker"]).await.ok()?;
                Some(held.get("worker").and_then(Value::as_object).cloned())
            }
        }
    }

    /// Puts one write where it goes. The kept and the Lead table answer their own committed transaction; a header
    /// write goes through the session's actor, and only while the cutoff has not taken its flight ([`Self::submit`]).
    async fn put(&self, session: &str, target: Target, worker: Option<Row>, order: Option<&Order>) -> ReleaseOutcome {
        let refused = |error: String| ReleaseOutcome::Refused(error);
        let cut = || ReleaseOutcome::Refused(format!("the worker row of {session}: {HEADERS_CLOSED}"));
        match (target, order) {
            // Answered by the release's own table transaction, which reads the row's identity and the map it holds.
            (Target::Kept, Some(order)) => {
                let release =
                    KeptRelease { identity: order.incarnation.clone(), operation: order.operation.clone(), prior: order.prior.clone(), again: order.again };
                match self.kept.release(session, worker.unwrap_or_default(), release).await {
                    Ok(KeptPut::Written(_) | KeptPut::Committed) => ReleaseOutcome::Stored,
                    Ok(KeptPut::Superseded(why)) => ReleaseOutcome::Superseded(format!("the release of {session}: {why}")),
                    Err(error) => refused(format!("the kept worker row of {session}: {error}")),
                }
            }
            (Target::Kept, None) => match self.kept.put(session, worker).await {
                Ok(()) => ReleaseOutcome::Stored,
                Err(error) => refused(format!("the kept worker row of {session}: {error}")),
            },
            (Target::Lead, _) => match self.leads.put(session, worker).await {
                Ok(()) => ReleaseOutcome::Stored,
                Err(error) => refused(format!("the Lead row of {session}: {error}")),
            },
            (Target::Header, order) => {
                let thread = ThreadId::from(session);
                let (set, unset) = match worker {
                    Some(map) => (Map::from_iter([("worker".to_owned(), Value::Object(map))]), Vec::new()),
                    None => (Map::new(), vec!["worker".to_owned()]),
                };
                match order {
                    None if !self.submit(session, None) => cut(),
                    // A row write Node keeps in memory when its save fails: the session saves it again with its next record.
                    None => match self.threads.patch_header(&thread, set, unset).await {
                        Ok(()) => ReleaseOutcome::Stored,
                        Err(error) => refused(format!("the worker row of {session}: {error:?}")),
                    },
                    Some(order) => self.put_release(session, &thread, set, unset, order).await,
                }
            }
        }
    }

    /// A release's header write, answered by the barrier of its own journal record ([`ThreadState::store_header`]):
    /// under the operation's own identity, for the journal it was decided for and as a compare-and-set on the map it
    /// was decided on, which is the receipt's and is the same whenever the operation is submitted. The rule of the
    /// operation is the actor's; nothing is inferred here, and nothing is read to decide it.
    ///
    /// An append whose outcome is unknown is no success and is not made again as a new write: that same operation is
    /// asked for once (`Attempt::Settle`), which settles the log first and answers by whether the journal holds its
    /// record. When that cannot be told either, the release stays indeterminate and its write is left with the
    /// session ([`Lanes::unsettled`]): the session's next header operation settles it first ([`Self::settle`]).
    async fn put_release(&self, session: &str, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>, order: &Order) -> ReleaseOutcome {
        let expect = Map::from_iter([("worker".to_owned(), order.prior.clone().map_or(Value::Null, Value::Object))]);
        let attempt = if order.again { Attempt::Replay } else { Attempt::First };
        let write = HeaderWrite { operation: order.operation.clone(), incarnation: order.incarnation.clone(), expect, set, unset, attempt };
        if !self.submit(session, Some(&write)) {
            return ReleaseOutcome::Refused(format!("the worker row of {session}: {HEADERS_CLOSED}"));
        }
        let named = |error: String| format!("the release of {session}: {error}");
        match self.threads.store_header(thread, write.clone()).await {
            HeaderStored::Stored => ReleaseOutcome::Stored,
            HeaderStored::Refused(error) => ReleaseOutcome::Refused(named(error)),
            HeaderStored::Superseded(error) => ReleaseOutcome::Superseded(named(error)),
            HeaderStored::Indeterminate(error) => match self.threads.store_header(thread, HeaderWrite { attempt: Attempt::Settle, ..write.clone() }).await {
                HeaderStored::Stored => ReleaseOutcome::Stored,
                HeaderStored::Refused(_) => ReleaseOutcome::Refused(named(format!("{error}; settled as not stored"))),
                HeaderStored::Superseded(superseded) => ReleaseOutcome::Superseded(named(superseded)),
                HeaderStored::Indeterminate(unknown) => {
                    self.lanes().unsettled.insert(session.to_owned(), write);
                    ReleaseOutcome::Indeterminate(named(format!("{error}; not settled: {unknown}")))
                }
            },
        }
    }

    /// Reports one write's outcome, its own: to the ledger, and to its release's handle. It changes the outcome of no
    /// other write, before or after it.
    fn answered(&self, session: &str, target: Target, mark: u64, answer: Option<ReleaseAnswer>, outcome: ReleaseOutcome) {
        let failure = match &outcome {
            ReleaseOutcome::Stored => None,
            ReleaseOutcome::Refused(error) | ReleaseOutcome::Superseded(error) | ReleaseOutcome::Indeterminate(error) => {
                tracing::warn!(%error, "[agent] a worker row was not saved");
                Some(error.as_str())
            }
        };
        self.close(session, target, mark, failure);
        if let Some(answer) = answer {
            answer.answer(outcome);
        }
        self.moved.notify_waiters();
    }

    /// What a flush to `watermark` answers once every write up to it was put or refused: an error when, for some
    /// session and target, the last write at or below it was not stored.
    fn standing(&self, watermark: u64) -> Result<(), String> {
        match self.lanes().standing(watermark) {
            Some((mark, error)) => Err(format!("{}: write {mark}, accepted before the barrier, failed: {error}", self.marks.store())),
            None => Ok(()),
        }
    }

    /// Takes the number of the last write accepted so far as a flush's watermark, outstanding from here, under the
    /// lock a write is accepted and closed under.
    fn flush_mark(self: &Arc<Self>) -> FlushMark {
        let mut lanes = self.lanes();
        let watermark = self.marks.accepted();
        lanes.flush_begun(watermark);
        FlushMark { writers: self.clone(), watermark }
    }

    /// Resolves once every write numbered up to `mark` was put or refused, then answers from those alone
    /// ([`Self::standing`]). Nothing accepted above the watermark holds it, fails it or repairs it: such a write is put
    /// after every one of its session at or below the watermark, under a number of its own.
    async fn flushed(&self, mark: &FlushMark) -> Result<(), String> {
        let watermark = mark.watermark;
        loop {
            let moved = self.moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            if self.marks.committed() >= watermark {
                return self.standing(watermark);
            }
            moved.await;
        }
    }
}

/// Starts each session's task as its queue is made, and never awaits a put: a session whose put waits holds no other
/// session's start. Ends, once the tasks it started have, when its [`StoreWorkers`] is gone.
async fn dispatch_sessions(writers: Arc<Writers>, mut asked: mpsc::UnboundedReceiver<Dispatch>) {
    let mut running = futures::stream::FuturesUnordered::new();
    loop {
        tokio::select! {
            next = asked.recv() => match next {
                Some(Dispatch::Session(session)) => {
                    running.push(mixdog_rt::spawn("agent-worker-rows", TaskClass::Work, writers.clone().run_session(session)));
                }
                Some(Dispatch::Joined(told)) => {
                    while running.next().await.is_some() {}
                    let _ = told.send(());
                }
                None => break,
            },
            Some(_) = running.next(), if !running.is_empty() => {}
        }
    }
    while running.next().await.is_some() {}
}

/// Whether `path` names a directory.
#[allow(clippy::disallowed_methods, reason = "runs on the interactive-io lane job (lane proof argument)")]
fn is_dir(_lane: &InLane<InteractiveIo>, path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

#[async_trait]
impl WorkerStore for StoreWorkers {
    /// The index's revision (FORMAT.md §8.2 worker index revision) tells what any connection committed since the one held,
    /// read in one transaction with the rows; the kept maps' revision tells what this process kept since. A session's map is
    /// the index's while the index lists it, else its kept one.
    async fn index_since(&self, since: Option<Revision>) -> Result<Index, String> {
        let (kept_revision, kept) = self.kept.since(since.map(|r| r.kept)).await?;
        let also: Vec<String> = match &kept {
            KeptSince::Changed(changed) => changed.iter().map(|(id, _)| id.clone()).collect(),
            KeptSince::All(_) => Vec::new(),
        };
        let mut read = self.index.worker_index_since(since.map(|r| (r.generation, r.index)), also).await.map_err(|e| format!("{e:?}"))?;
        {
            let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
            if read.full {
                logs.clear();
            }
            for s in &read.sessions {
                match &s.log_id {
                    Some(log) => logs.insert(s.session.clone(), log.clone()),
                    None => logs.remove(&s.session),
                };
            }
        }
        let revision = Revision { index: read.revision, generation: read.generation, kept: kept_revision };
        // Handed over as read, unparsed: the registry reads only the rows of the sessions live agents stand for.
        let list_row = |s: &mut mixdog_store::worker::IndexedSession| s.agent.take().map(|(_, summary)| ListRow::new(summary));
        let kept = match kept {
            KeptSince::Changed(changed) if !read.full => changed,
            _ => {
                let kept = self.kept.all();
                let listed: HashSet<&str> = read.sessions.iter().filter(|s| s.worker.is_some()).map(|s| s.session.as_str()).collect();
                let mut maps: Vec<(String, Place, Row)> = Vec::new();
                for s in &read.sessions {
                    if let Some(map) = &s.worker {
                        maps.push((s.session.clone(), Place::stamped(s.created_at, &s.session), map.clone()));
                    }
                }
                maps.extend(kept.into_iter().filter(|(id, _, _)| !listed.contains(id.as_str())).map(|(id, at, map)| (id, Place::Kept(at), map)));
                let sessions = read.sessions.iter_mut().filter_map(|s| Some((s.session.clone(), list_row(s)?))).collect();
                return Ok(Index::Full { revision: Some(revision), maps, sessions });
            }
        };
        if since == Some(revision) && read.sessions.is_empty() && kept.is_empty() {
            return Ok(Index::Unchanged);
        }
        let mut maps: Vec<(String, Option<(Place, Row)>)> = Vec::new();
        let mut sessions: Vec<(String, Option<ListRow>)> = Vec::new();
        for s in &mut read.sessions {
            let map = match &s.worker {
                Some(map) => Some((Place::stamped(s.created_at, &s.session), map.clone())),
                None => self.kept.get(&s.session).map(|(at, map)| (Place::Kept(at), map)),
            };
            maps.push((s.session.clone(), map));
            sessions.push((s.session.clone(), list_row(s)));
        }
        Ok(Index::Delta { revision, maps, sessions })
    }

    fn kept_sessions(&self) -> Vec<String> {
        self.kept.ids().iter().cloned().collect()
    }

    /// The index's maps, then the kept maps of sessions the index no longer lists.
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        let rows = self.index.worker_rows(None, WorkerScope::All).await.map_err(|e| format!("{e:?}"))?;
        let mut maps: Vec<(String, Row)> = rows.into_iter().map(|row| (row.session, row.worker)).collect();
        let kept = self.kept.load().await?;
        let listed: HashSet<String> = maps.iter().map(|(id, _)| id.clone()).collect();
        maps.extend(kept.into_iter().filter(|(id, _)| !listed.contains(id)));
        Ok(maps)
    }

    /// The session's record is gone, and the kept write accepted here takes its place: what its header is owed is
    /// retired at that write's number, for the flushes from there on. A flush taken before keeps what it selected,
    /// whether that failure is recorded already or closes later ([`Lanes::retire`], [`Lanes::close`]).
    fn keep(&self, session: &str, worker: Option<Row>) {
        self.submit(session, worker, Target::Kept, None, true);
    }

    /// A session record's identity is its journal's own (`log_id`): of a loaded session its actor's, else the one the
    /// index listed it with at the last load. A kept row's is the one the table gave it when it was kept, known once
    /// that write is committed. Neither is ever made up: a session of which neither is known has none. One the index
    /// listed before the session was deleted and made again is still what the release is bound to, and the target
    /// that applies the release refuses it there.
    fn bound(&self, session: &str) -> Option<Bound> {
        let holds = |target| self.writers.lanes().holds_of(session, target);
        if self.kept.holds(session) {
            return self.kept.identity(session).map(|incarnation| Bound { target: Target::Kept, incarnation, holds: holds(Target::Kept) });
        }
        let incarnation = self
            .threads
            .log_identity(&ThreadId::from(session))
            .or_else(|| self.logs.lock().unwrap_or_else(|e| e.into_inner()).get(session).cloned())
            .filter(|incarnation| !incarnation.is_empty())?;
        Some(Bound { target: Target::Header, incarnation, holds: holds(Target::Header) })
    }

    /// The release goes to the target and for the incarnation its receipt names, whatever the store would name for
    /// the session now: neither is looked up again here.
    fn release(&self, receipt: &ReleaseReceipt, again: bool) -> ReleaseDone {
        let (answer, done) = ReleaseDone::pending();
        let order = Order { again, operation: receipt.operation.clone(), incarnation: receipt.incarnation.clone(), prior: receipt.prior.clone() };
        self.submit(&receipt.session_id, Some(receipt.released.clone()), receipt.target, Some(Receipted { answer, order }), false);
        if let Some(signals) = self.signals.get() {
            signals.worker_rows(&receipt.session_id);
        }
        done
    }

    fn kept(&self, session: &str) -> bool {
        self.kept.holds(session)
    }

    async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
        let rows = self.index.agent_only_sessions().await.map_err(|e| format!("{e:?}"))?;
        Ok(rows.iter().filter_map(|summary| serde_json::from_str::<Row>(summary).ok()).collect())
    }

    async fn open_agent_sessions(&self) -> Result<Vec<Row>, String> {
        let rows = self.index.open_agent_only_sessions().await.map_err(|e| format!("{e:?}"))?;
        Ok(rows.iter().filter_map(|summary| serde_json::from_str::<Row>(summary).ok()).collect())
    }

    /// The session's list row, when the index lists it as an agent-only session (the row's `visibility`, which the index's
    /// own is projected from).
    async fn agent_session(&self, session: &str) -> Result<Option<Row>, String> {
        let summary = self.index.summary(session).await.map_err(|e| format!("{e:?}"))?;
        Ok(summary.and_then(|summary| serde_json::from_str::<Row>(&summary).ok()).filter(|row| clean(row.get("visibility")) == "agent-only"))
    }

    async fn held_workers(&self) -> Result<Vec<String>, String> {
        self.index.withheld_workers().await.map_err(|e| e.to_string())
    }

    async fn rewrite_settled(&self, session: &str) -> Result<(), String> {
        self.index.rewrite_settled(session).await.map_err(|e| e.to_string())
    }

    async fn header(&self, session: &str) -> Result<Option<Row>, String> {
        match self.threads.header(&ThreadId::from(session)).await {
            Ok(header) => Ok(Some(header)),
            Err(mixdog_tools::orch::util::PortError::NotFound { .. }) => Ok(None),
            Err(error) => Err(format!("the header of session {session} could not be read: {error:?}")),
        }
    }

    async fn is_directory(&self, path: &str) -> bool {
        if path.is_empty() {
            return false;
        }
        let path = path.to_owned();
        mixdog_core_base::support::on_lane_wait(self.io, &mixdog_rt::CancellationToken::new(), move |lane| is_dir(lane, &path)).await.unwrap_or(false)
    }

    fn write(&self, session: &str, worker: Option<Row>) {
        self.queue_write(session, worker);
        // Node's registry announces a row change where it makes it, not when the file settles.
        if let Some(signals) = self.signals.get() {
            signals.worker_rows(session);
        }
    }

    async fn lead_rows(&self) -> Result<Vec<(String, Row)>, String> {
        self.leads.load().await
    }

    fn forget_session(&self, session: &str) {
        self.logs.lock().unwrap_or_else(|e| e.into_inner()).remove(session);
        self.kept.forget(session);
    }

    fn write_lead(&self, session: &str, row: Option<Row>) {
        self.submit(session, row, Target::Lead, None, false);
        if let Some(signals) = self.signals.get() {
            signals.lead_rows(session);
        }
    }

    async fn settled(&self) -> Result<(), String> {
        StoreWorkers::settled(self).await
    }

    fn hold_signals(&self, sessions: &[String]) -> Box<dyn Send> {
        self.signals.get().map_or_else(|| Box::new(()) as Box<dyn Send>, |signals| signals.hold(sessions))
    }
}

impl StoreWorkers {
    /// Queues one session's map in that session's order, numbered in [`Self::marks`]: where it is kept when its record
    /// is gone, else its header.
    fn queue_write(&self, session: &str, worker: Option<Row>) {
        let target = if self.kept.holds(session) { Target::Kept } else { Target::Header };
        self.submit(session, worker, target, None, false);
    }

    /// Accepts one write into its session's queue and has the queue's task started when this write made it. A write
    /// refused because admission is sealed is not numbered; its release, if it is one, is answered refused.
    fn submit(&self, session: &str, worker: Option<Row>, target: Target, release: Option<Receipted>, retire: bool) {
        match self.writers.accept(session, worker, target, release, retire) {
            Ok(false) => {}
            Ok(true) => {
                if self.dispatch.send(Dispatch::Session(session.to_owned())).is_err() {
                    self.writers.abandon(session, WRITER_CLOSED);
                }
            }
            Err((why, release)) => {
                tracing::warn!(session, why, "[agent] a worker row was written during the shutdown; it is not saved");
                if let Some(release) = release {
                    release.answer.answer(ReleaseOutcome::Refused(why.to_owned()));
                }
            }
        }
    }

    /// A flush: takes the number of the last write accepted so far and resolves once every write up to it was put or
    /// refused, with an error when, for some session and target, the last of them was not stored. A write accepted
    /// after the call neither holds it, fails it nor repairs it, whatever its session.
    pub fn settled(&self) -> impl std::future::Future<Output = Result<(), String>> + Send + '_ {
        let mark = self.flush_mark();
        async move { self.writers.flushed(&mark).await }
    }

    /// A flush's watermark, taken now: for a caller that takes it with those of other stores and waits later
    /// ([`Self::settled_to`]). The flush is outstanding until the mark is dropped.
    pub fn flush_mark(&self) -> FlushMark {
        self.writers.flush_mark()
    }

    /// [`Self::settled`] to a watermark taken earlier. The marks' own `reached` is not this answer and is no other
    /// one: it tells that the writes up to a number are closed, never what became of them.
    pub fn settled_to<'a>(&'a self, mark: &'a FlushMark) -> impl std::future::Future<Output = Result<(), String>> + Send + 'a {
        self.writers.flushed(mark)
    }

    /// Resolves once no session has a task: every write accepted so far is answered and what follows an answer (the
    /// read of what a target holds after a write that was not applied) is recorded.
    #[cfg(test)]
    pub(crate) async fn idle(&self) {
        loop {
            let moved = self.writers.moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            if self.writers.lanes().active.is_empty() {
                return;
            }
            moved.await;
        }
    }

    /// How many outcomes the flushes' ledger holds.
    #[cfg(test)]
    pub(crate) fn ledger_len(&self) -> usize {
        self.writers.lanes().closed.values().map(Vec::len).sum()
    }

    /// The stop of the writer, once its producers have stopped: admission is sealed under the lock a write is accepted
    /// under, then every queue is waited empty and every task it started is joined. What was accepted and not started
    /// is put, not dropped: the queues are waited on, not the tasks that happen to run now. The answer is the flush's,
    /// over everything accepted before the seal.
    pub async fn shutdown(&self) -> Result<(), String> {
        let mark = {
            let mut lanes = self.writers.lanes();
            lanes.sealed = true;
            let watermark = self.marks.accepted();
            lanes.flush_begun(watermark);
            FlushMark { writers: self.writers.clone(), watermark }
        };
        // Every session's task is waited for, the one whose put the directory's cutoff already answered included: the
        // receipts and the flush are settled by then, but the task still holds its put, and the stores it writes to
        // are not given up under it. It ends when that put returns, which the stop of its session's actor brings.
        loop {
            let moved = self.writers.moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            if self.writers.lanes().active.is_empty() {
                break;
            }
            moved.await;
        }
        let (told, joined) = oneshot::channel();
        if self.dispatch.send(Dispatch::Joined(told)).is_ok() {
            let _ = joined.await;
        }
        self.writers.standing(mark.watermark)
    }

    /// The writes' numbers and how far they are closed: progress alone, with no record of a failure. A barrier that
    /// asks what became of the writes takes a [`Self::flush_mark`] and waits on [`Self::settled_to`].
    pub fn marks(&self) -> &mixdog_rt::WriteMarks {
        &self.marks
    }

    /// Binds the status signals; a second bind is refused.
    pub fn bind_signals(&self, signals: Arc<dyn signals::StatusSignals>) -> Result<(), Arc<dyn signals::StatusSignals>> {
        self.signals.set(signals)
    }
}

#[async_trait]
impl super::super::directory::RowWrites for StoreWorkers {
    /// Header admission is sealed under the lock a write is accepted under, then what was accepted is flushed: no
    /// header write joins the queues while they drain.
    async fn drain(&self) {
        let mark = {
            let mut lanes = self.writers.lanes();
            if lanes.headers == Headers::Open {
                lanes.headers = Headers::Sealed;
            }
            let watermark = self.marks.accepted();
            lanes.flush_begun(watermark);
            FlushMark { writers: self.writers.clone(), watermark }
        };
        if let Err(error) = self.writers.flushed(&mark).await {
            tracing::warn!(%error, "[agent] a worker row was not saved before the sessions stopped");
        }
    }

    fn headers_closed(&self) {
        self.writers.cut_headers();
    }
}

impl StoreWorkers {
    /// Call on the runtime the session tasks run on.
    pub fn new(index: SqliteStore, threads: Arc<dyn ThreadState>, io: InteractiveIo, kept: Arc<KeptRows>) -> Self {
        let (dispatch, asked) = mpsc::unbounded_channel::<Dispatch>();
        let leads = Arc::new(LeadRows::new(kept.state.clone()));
        let marks = Arc::new(mixdog_rt::WriteMarks::new("the agent index"));
        let writers = Arc::new(Writers {
            lanes: Mutex::default(),
            moved: tokio::sync::Notify::new(),
            threads: threads.clone(),
            kept: kept.clone(),
            leads: leads.clone(),
            marks: marks.clone(),
        });
        drop(mixdog_rt::spawn("agent-worker-writes", TaskClass::Work, dispatch_sessions(writers.clone(), asked)));
        Self { index, threads, writers, dispatch, marks, io, signals: std::sync::OnceLock::new(), kept, leads, logs: Mutex::default() }
    }
}
