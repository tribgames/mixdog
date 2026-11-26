//! A session's worker row, the tombstone its reap left and its owner's close marker live in
//! that session's header `worker` map:
//!
//! ```text
//! worker = { ...row (tag, sessionId, parentSessionId, ownerSessionId, clientHostPid, status, …),
//!            tombstone?: { tag, agent, cwd, clientHostPid, parentSessionId?, ownerSessionId?, reapedAt },
//!            releasedAt?: ISO }
//! ```
//!
//! The session has a row while the map carries `sessionId`. A map without a row but with a
//! tombstone carries the tombstone's `tag`, `parentSessionId`, `ownerSessionId` and
//! `clientHostPid` at its root, the keys the store indexes it by. `released` is never stored:
//! a row reads `released` while `releasedAt` is inside the tombstone TTL.
//!
//! The registry is the one writer of that map; `refresh_tags_from_sessions` reloads the index.

pub mod flow;
mod lead_row;
mod pool_docs;
pub mod restart;
mod rows;
pub mod sessions;
pub mod signals;
pub mod status_rows;
mod store_workers;
#[cfg(test)]
mod tests;
mod views;
mod worker_view;
pub mod workers;
mod world_rows;
#[cfg(test)]
mod write_marks_tests;

pub use self::flow::AgentTaskStarts;
pub use self::flow::RuntimeRelease;
pub use self::flow::SessionCompletions;
pub use self::flow::SessionTurns;
pub use self::lead_row::LeadTurn;
pub use self::sessions::AgentOwnerTeardown;
pub use self::sessions::AgentSessions;
pub use self::sessions::AgentStatusline;
pub use self::sessions::CloseAllReport;
pub use self::store_workers::FlushMark;
pub use self::store_workers::KeptRows;
pub use self::store_workers::KeptSince;
pub use self::store_workers::LeadRows;
pub use self::store_workers::StoreWorkers;
pub use self::workers::AgentWorkers;
pub use self::world_rows::CancelScope;

use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use mixdog_agent::agent_tool::host::Recovered;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::Release;
use mixdog_agent::agent_tool::host::ReleaseDone;
use mixdog_agent::agent_tool::host::ReleaseOutcome;
use mixdog_agent::agent_tool::host::ReleaseReceipt;
use mixdog_agent::agent_tool::host::ReleaseTarget;
use mixdog_agent::agent_tool::host::Released;
use mixdog_agent::agent_tool::host::ResolveOptions;
use mixdog_agent::agent_tool::host::Resumable;
use mixdog_agent::agent_tool::host::Spared;
use mixdog_agent::agent_tool::host::TagClaim;
use mixdog_agent::agent_tool::host::TerminalTrace;
use mixdog_agent::agent_tool::host::Topology;
use mixdog_agent::agent_tool::host::TurnMark;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_agent::agent_tool::scope::clean_str;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use tokio::sync::oneshot;

pub use self::rows::Row;
use self::rows::*;
use self::views::Maps;
pub use self::views::Place;
use self::views::Tags;
use self::views::Views;
use super::Clock;

/// What a load of the stored index hands over, relative to the revision the registry holds.
pub enum Index {
    /// Nothing was written since the revision asked about.
    Unchanged,
    /// What was written since it: each session whose `worker` map changed, with its place in the index order and its map
    /// now (`None`: the index lists none), and each agent-only session that changed, with its list row now (`None`: no
    /// longer listed).
    Delta { revision: Revision, maps: Vec<(String, Option<(Place, Row)>)>, sessions: Vec<(String, Option<ListRow>)> },
    /// Every map, each at its place, and every agent-only session's list row; `revision` is what a later load asks the
    /// changes since of (`None`: the store keeps none).
    Full { revision: Option<Revision>, maps: Vec<(String, Place, Row)>, sessions: Vec<(String, ListRow)> },
}

/// An agent-only session's list row as the index hands it over: its JSON text, read into a row only for a session the
/// registry holds the row of ([`State::held`]).
#[derive(Clone, PartialEq, Eq)]
pub struct ListRow(String);

impl ListRow {
    /// The JSON text of a list row.
    pub fn new(text: String) -> Self {
        Self(text)
    }

    /// The list row of a store that hands its rows parsed.
    pub fn of(row: &Row) -> Self {
        Self(serde_json::to_string(row).expect("a row serializes"))
    }

    /// The row; `None` when the text is not a JSON object, which no listing lists.
    fn row(&self) -> Option<Row> {
        serde_json::from_str(&self.0).ok()
    }
}

/// A store's revision of what it hands over: of the index, and of the kept maps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Revision {
    pub index: u64,
    /// The index's generation: `index` names a state only within one.
    pub generation: u64,
    pub kept: u64,
}

/// Where a release of a session would go now and the identity its store holds of that session ([`WorkerStore::bound`]).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Bound {
    pub target: ReleaseTarget,
    /// Never empty: a session record's journal identity, or the identity its kept row was given when it was kept.
    pub incarnation: String,
    /// What that target really holds of the session (inner `None`: no map), when the store has a record of it: only
    /// for a session whose last closed write there was not stored, so that the caller's own map is ahead of the
    /// target. `None`: the store has no such record, and the caller's map is what the target holds or, with writes of
    /// the session still queued, will hold when a release queued now is put.
    pub holds: Option<Option<Row>>,
}

/// The stored side of the worker index.
#[async_trait]
pub trait WorkerStore: Send + Sync {
    /// The index as it is now, in the least the store can tell from the revision the caller holds. A store that keeps no
    /// revision hands over everything, each map and session at its place in the listing.
    async fn index_since(&self, _since: Option<Revision>) -> Result<Index, String> {
        let maps = self.worker_maps().await?.into_iter().enumerate().map(|(at, (id, map))| (id, Place::At(at as i64), map)).collect();
        let sessions = self.agent_sessions().await?.iter().map(|session| (clean(session.get("id")), ListRow::of(session))).collect();
        Ok(Index::Full { revision: None, maps, sessions })
    }
    /// The sessions whose map is a kept one.
    fn kept_sessions(&self) -> Vec<String> {
        Vec::new()
    }
    /// Every session's `worker` map, newest session first.
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String>;
    /// The agent-only sessions' list rows, closed ones included, most recent activity first.
    async fn agent_sessions(&self) -> Result<Vec<Row>, String>;
    /// The list row of agent-only session `session`; `Ok(None)` when the index lists no agent-only session of that id.
    async fn agent_session(&self, session: &str) -> Result<Option<Row>, String> {
        Ok(self.agent_sessions().await?.into_iter().find(|row| clean(row.get("id")) == session))
    }
    /// The worker sessions held for a sensitive rewrite: the store answers their maps without their content, so a
    /// listing of the workers waits for each ([`Self::rewrite_settled`]). A store that never rewrites has none.
    async fn held_workers(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    /// Resolves once `session`'s sensitive rewrite ended; `Err` when it failed.
    async fn rewrite_settled(&self, _session: &str) -> Result<(), String> {
        Ok(())
    }
    /// A stored session's header; `Ok(None)` when it is not stored, `Err` when it could not be read, which says
    /// nothing of whether it is.
    async fn header(&self, session: &str) -> Result<Option<Row>, String>;
    /// Whether `path` is an existing directory.
    async fn is_directory(&self, path: &str) -> bool;
    /// Replaces the session's `worker` map (`None` removes it). One session's writes apply in
    /// call order. A kept session's map is written where it is kept.
    fn write(&self, session: &str, worker: Option<Row>);
    /// Every row of the Lead index (1.4.5 `lead-workers.json`): a Lead's pool row, kept apart from its session's header so a
    /// Lead's turn changes no session record. A store with no Lead index has none.
    async fn lead_rows(&self) -> Result<Vec<(String, Row)>, String> {
        Ok(Vec::new())
    }
    /// Replaces a Lead's row in the Lead index (`None` removes it); one session's writes apply in call order. Only the
    /// Agents pool lists these rows, so only the pool is told; a store with no Lead index keeps nothing.
    fn write_lead(&self, _session: &str, _row: Option<Row>) {}
    /// The session was deleted: what the store remembers of its incarnation goes.
    fn forget_session(&self, _session: &str) {}
    /// Keeps the map of a session deleted while its rows still count: Node's index file keeps every row its forget does not take
    /// (`gone-rows.mjs:214-226`), and a restart reads it again. From now on [`worker_maps`](Self::worker_maps) lists it and
    /// [`write`](Self::write) writes it there.
    fn keep(&self, session: &str, worker: Option<Row>);
    /// Whether `session`'s map is a kept one (its session record is gone).
    fn kept(&self, session: &str) -> bool;
    /// Where a release of `session` goes now and the identity the store holds of it, read without waiting. `None`: the
    /// store can tell no identity, and no release is decided for the session. Asked before anything of a release is
    /// decided, and again before one is submitted a second time: a release is only ever applied to what it names here.
    fn bound(&self, session: &str) -> Option<Bound>;
    /// [`write`](Self::write) of one release: an ordered write of its own in the session's order, merged with no other
    /// and answered through its handle by its own outcome alone. The receipt is the whole operation: its target, the
    /// incarnation it is applied to and no other, its identity, which its record carries, the map it stores, and the
    /// map it was decided on, which the caller fixed at the decision ([`Bound::holds`], else its own map) and nothing
    /// reads again: the target applies the release as a compare-and-set on it, and one that does not hold is
    /// superseded, never applied. An earlier release of the session whose outcome is unknown is settled first; only
    /// when it still cannot be told is this one answered, unsubmitted, as indeterminate on its own receipt. `again`:
    /// this same operation, with the same precondition, was submitted
    /// before and is not known stored. Its target then answers by the operation's own committed record when it has one,
    /// and writes it only when it is known not to have committed and its incarnation and precondition still hold; a
    /// fence, a conflict, a change that was dropped or a value that happens to match is no success. Every store states
    /// its own answer: none is assumed stored.
    fn release(&self, receipt: &ReleaseReceipt, again: bool) -> ReleaseDone;
    /// Resolves once every write made before the call was put or refused: `Err` when, for some session and target, the
    /// last of them was not stored. A write made after the call neither holds it, fails it nor repairs it.
    async fn settled(&self) -> Result<(), String> {
        Ok(())
    }
    /// While the guard lives, a [`write`](Self::write) of these sessions is not announced as it is made: what is owed is
    /// announced once the last hold over them ends. A store that announces nothing holds nothing.
    fn hold_signals(&self, _sessions: &[String]) -> Box<dyn Send> {
        Box::new(())
    }
}

/// What this process knows of its loaded sessions now.
pub trait LiveSessions: Send + Sync {
    fn loaded(&self) -> Vec<String>;
    /// A loaded session's header.
    fn header(&self, session: &str) -> Option<Row>;
    /// A loaded session's header as it is published, shared rather than copied: the registry's kept facts point at it
    /// instead of holding a copy of it (its tool list and prompt included) for every bound tag.
    fn shared_header(&self, session: &str) -> Option<Arc<Row>> {
        self.header(session).map(Arc::new)
    }
    /// A turn is running (`runtime.controller` not aborted).
    fn running(&self, session: &str) -> bool;
    /// A running turn or queued input (`sessionHasLiveWork` adds the runtime stage).
    fn has_live_work(&self, session: &str) -> bool;
    /// `runtime.stage`.
    fn runtime_stage(&self, session: &str) -> Option<String>;
    /// Runs `at` while no run of `session` is registered at its start gate, under the lock every start takes; `false`
    /// when a run is, and `at` did not run.
    fn while_idle(&self, session: &str, at: &mut dyn FnMut() -> bool) -> bool;
    /// What every read of a loaded session depends on, taken without copying it; `None`: the session is read again by every
    /// read that needs it.
    fn stamp(&self, _session: &str) -> Option<LiveStamp> {
        None
    }
}

/// A loaded session's stamp: its published header (compared by identity), whether a turn runs, and its stage. Two equal
/// stamps of a session mean its live reads answer the same; the registry's `cancelled` overlay, which its session reads add,
/// is not in the stamp, so `set_cancelled` touches the session's tag facts itself. The header is held weakly: that keeps its
/// allocation, so its address is not reused while the stamp lives, but not its contents, which go when the session publishes
/// a new header or leaves memory, whether or not a later pass of the registry drops the stamp.
pub struct LiveStamp {
    pub header: std::sync::Weak<dyn std::any::Any + Send + Sync>,
    pub running: bool,
    pub stage: Option<String>,
}

impl PartialEq for LiveStamp {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Weak::ptr_eq(&self.header, &other.header) && self.running == other.running && self.stage == other.stage
    }
}

/// `resolveAgentTerminalReapMs(config, provider)`.
pub trait ReapWindow: Send + Sync {
    fn terminal_reap_ms(&self, provider: &str) -> f64;
}

pub struct AgentRegistry {
    store: Arc<dyn WorkerStore>,
    live: Arc<dyn LiveSessions>,
    reap: Arc<dyn ReapWindow>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// Woken by every refresh and row write: the deadline timer ([`keep_deadlines`]) arms again.
    rearm: Arc<tokio::sync::Notify>,
    loads: Mutex<Loads>,
    /// The restart notices this process has begun to queue and not yet stamped (`restart::notify_restart_failures`).
    restart_notices: Mutex<HashMap<String, restart::RestartNotice>>,
    /// `descriptor.parked` (`agent-tree.mjs`): the idle agents the idle release parked, until a turn starts on them. Of
    /// this process only, as Node's descriptors are.
    parked: Mutex<HashSet<String>>,
    /// `descriptor.status = 'cancelled'` (`agent-cancel.mjs` `closeRuntime`): the agents whose running turn a close
    /// stopped, until a turn starts on them. Of this process only, as Node's descriptors are.
    cancelled: Mutex<HashSet<String>>,
    /// `sweepRestartFailures`, run by the maintenance pass ([`Self::keep_deadlines`]); unbound, the pass has no such step.
    sweeper: std::sync::OnceLock<Arc<dyn restart::RestartSweep>>,
    /// Where the restart's settlement of the stored worker rows stands ([`Self::hold_worker_rows`]): every read of them
    /// awaits it, and takes its failure as its own.
    rows_held: tokio::sync::watch::Sender<Settlement>,
    /// The tags reserved for spawns admitted and not yet bound ([`Registry::claim_tag`]).
    claimed: Arc<Mutex<HashSet<String>>>,
    /// One spawn takes its tag at a time.
    #[allow(clippy::disallowed_types, reason = "one spawn's tag admission at a time, across the reads of the tag it awaits")]
    spawn_admission: tokio::sync::Mutex<()>,
    /// The listings of every agent session made ([`Self::list_sessions`]).
    #[cfg(test)]
    walks: std::sync::atomic::AtomicUsize,
}

/// The loads of the index: one runs at a time, and the callers that arrive meanwhile wait for its end. Bookkeeping only:
/// the lock is never held across a load.
#[derive(Default)]
struct Loads {
    running: bool,
    /// The loads begun, and the number of the latest one that completed (a failed or cancelled one never reached the index).
    started: u64,
    completed: u64,
    /// Told, or dropped, when the running load ends.
    waiting: Vec<oneshot::Sender<()>>,
}

/// The running load's turn: whatever becomes of the load (done, failed, its caller gone), the next caller may load.
struct LoadTurn<'a> {
    loads: &'a Mutex<Loads>,
    number: u64,
    completed: bool,
}

impl Drop for LoadTurn<'_> {
    fn drop(&mut self) {
        let mut loads = self.loads.lock().unwrap_or_else(|p| p.into_inner());
        loads.running = false;
        if self.completed {
            loads.completed = loads.completed.max(self.number);
        }
        for waiter in loads.waiting.drain(..) {
            let _ = waiter.send(());
        }
    }
}

/// Where the restart's settlement of the stored worker rows stands, for a start that held them
/// ([`AgentRegistry::hold_worker_rows`]).
#[derive(Clone, PartialEq)]
enum Settlement {
    /// Nothing holds the rows: each read takes the store's verdict.
    Open,
    /// The settlement has not ended: every read awaits it.
    Held,
    /// It failed, with this: so does every read of this start.
    Failed(String),
}

/// A tag reserved for a spawn ([`Registry::claim_tag`]), until dropped.
struct Claimed {
    claimed: Arc<Mutex<HashSet<String>>>,
    tag: String,
}

impl Drop for Claimed {
    fn drop(&mut self) {
        self.claimed.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.tag);
    }
}

/// A release not known to be stored: its receipt, the scope its tree was released under (which recovers it, whoever
/// owns the member itself), and the handle of its last attempt.
struct Unstored {
    receipt: ReleaseReceipt,
    scope: Scope,
    done: ReleaseDone,
}

/// Whether a recovery run for `recovering` takes up what was released under `held`: the same owner session, the same
/// host process when it names no session, everything when it names neither (`Scope::owns`'s order).
fn recovers(recovering: &Scope, held: &Scope) -> bool {
    match (&recovering.caller_session_id, recovering.host_pid) {
        (Some(session), _) => held.caller_session_id.as_ref() == Some(session),
        (None, Some(pid)) => held.host_pid == Some(pid),
        (None, None) => true,
    }
}

/// What [`State::holding`] holds, and the sessions it holds them for.
#[derive(Default)]
struct Holding {
    recovered: Recovered,
    sessions: HashSet<String>,
}

#[derive(Default)]
struct State {
    /// Set while a spawn resolves its tag ([`ResolveOptions::skip_released`]): a scan does not bind a session its owner closed.
    skip_released: bool,
    /// `tags` (insertion order), `tagAgents`, `tagCwds`.
    tags: Tags,
    tag_agents: HashMap<String, String>,
    tag_cwds: HashMap<String, String>,
    /// Bumped whenever `tags`, `tag_agents` or `tag_cwds` change.
    tag_generation: u64,
    /// Every session's worker map: the index as last loaded, with this process's writes.
    maps: Maps,
    /// The store's revision of the last load.
    revision: Option<Revision>,
    /// Writes the loaded index did not show yet.
    pending: HashMap<String, Option<Row>>,
    /// The writes of worker maps this process made: each one's number is its revision.
    writes: u64,
    /// Each session's last release, until its receipt comes back stored or a later write of the session replaces it: what
    /// [`Registry::recover_releases`] stores again.
    releases: HashMap<String, Unstored>,
    /// Set through a cleanup's refresh: each session a map is written for has its signals held here from before the write.
    holding: Option<Holding>,
    /// The list rows of the sessions live agents stand for, as the index last listed them: each session with a worker row
    /// or a bound tag ([`State::wanted`]), `None` when the index lists no agent-only session of that id. Any other agent-only
    /// session is read from the index by the operation that asks for it ([`Reads`]).
    held: HashMap<String, Option<Arc<Row>>>,
    /// What the operation under way read of the index besides; empty between operations ([`Operation`]).
    reads: Reads,
    /// The sessions a dispatch runs a turn on, each with the count of dispatches holding it ([`AgentRegistry::pin`]).
    pins: Arc<Mutex<HashMap<String, usize>>>,
    /// A legacy tombstone's resolved owner fields, by its identity (`row-reads.mjs` `owners`).
    owners: HashMap<String, Option<Row>>,
    /// A Lead pool row's worker map as this process last wrote it, until the stored header shows
    /// it (lead_row.rs).
    leads: HashMap<String, Row>,
    /// The Lead index (1.4.5 `lead-workers.json`, `lead_row.rs`): each Lead's pool row, `None` once removed. Read from the
    /// store once (`leads_loaded`); this process's writes are applied here as they are made.
    lead_rows: HashMap<String, Option<Row>>,
    leads_loaded: bool,
    /// The sessions whose row this process wrote as active (`activeWorkerKeys`/`trackActiveRow`):
    /// settled as failed when the process exits (restart.rs).
    active: HashSet<String>,
    /// `cancellationCounts`: the cancellations in progress that cover a session.
    cancelling: HashMap<String, usize>,
    /// `cancellationEpochs`: how many cancellations have covered a session.
    epochs: HashMap<String, u64>,
    /// Bumped when the views must start over (the maps replaced, a legacy owner recovered).
    epoch: u64,
    /// The reads of the index as shared views, following each write (views.rs).
    views: RefCell<Views>,
}

/// The agent-only sessions as one read of the index lists them, in its order.
struct Listing {
    rows: Vec<Arc<Row>>,
    /// The first of `rows` with each id.
    at: HashMap<String, usize>,
}

impl Listing {
    fn of(rows: Vec<Row>) -> Self {
        let rows: Vec<Arc<Row>> = rows.into_iter().map(Arc::new).collect();
        let mut at = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            at.entry(clean(row.get("id"))).or_insert(i);
        }
        Self { rows, at }
    }
}

/// What one operation read of the agent-only sessions from the index beyond the rows the registry holds: read before it
/// takes the state, and let go when it ends.
#[derive(Clone, Default)]
struct Reads {
    /// Every agent-only session, when the operation lists them.
    listing: Option<Arc<Listing>>,
    /// The sessions it looked up by id: each one's row, `None` when the index lists no agent-only session of that id.
    rows: HashMap<String, Option<Arc<Row>>>,
}

impl Reads {
    /// The row this operation read of session `id`; `None` when it read none of it.
    fn find(&self, id: &str) -> Option<Option<Arc<Row>>> {
        if let Some(row) = self.rows.get(id) {
            return Some(row.clone());
        }
        let listing = self.listing.as_ref()?;
        Some(listing.at.get(id).map(|at| listing.rows[*at].clone()))
    }
}

/// The state for one operation, with what it read of the index ([`Reads`]): when it ends, the rows it read of the sessions
/// live agents now stand for are held and the rest let go.
struct Operation<'a>(MutexGuard<'a, State>);

impl std::ops::Deref for Operation<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        &self.0
    }
}

impl std::ops::DerefMut for Operation<'_> {
    fn deref_mut(&mut self) -> &mut State {
        &mut self.0
    }
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        let reads = std::mem::take(&mut self.0.reads);
        if reads.listing.is_none() && reads.rows.is_empty() {
            return;
        }
        let st = &mut *self.0;
        let found: Vec<(String, Option<Arc<Row>>)> =
            st.wanted().into_iter().filter(|id| !st.held.contains_key(id)).filter_map(|id| reads.find(&id).map(|row| (id, row))).collect();
        st.hold(found);
    }
}

#[derive(Clone, Copy)]
struct Window {
    /// `now >= from`.
    from: f64,
    /// `now > after`.
    after: f64,
    /// `now <= upto`.
    upto: f64,
}

impl Window {
    fn holds(&self, now: f64) -> bool {
        now >= self.from && now > self.after && now <= self.upto
    }
}

impl State {
    /// The window `now` is in for the index as it is.
    fn window_at(&self, now: f64) -> Window {
        let mut w = Window { from: f64::NEG_INFINITY, after: f64::NEG_INFINITY, upto: f64::INFINITY };
        for (_, map) in self.maps.iter() {
            views::constrain(&mut w, map, now);
        }
        w
    }

    /// A change the views cannot follow one session at a time: they start over.
    fn changed(&mut self) {
        self.epoch += 1;
    }

    /// The sessions live agents stand for: each with a worker row in the index, a bound tag, or a dispatch running a turn.
    fn wanted(&self) -> HashSet<String> {
        let mut ids: HashSet<String> = self.maps.iter().filter(|(_, map)| !clean(map.get("sessionId")).is_empty()).map(|(id, _)| id.clone()).collect();
        ids.extend(self.tags.iter().map(|(_, id)| id.clone()));
        ids.extend(self.pins.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned());
        ids
    }

    /// Holds `rows`; each tag whose session's row changed is read again.
    fn hold(&mut self, rows: impl IntoIterator<Item = (String, Option<Arc<Row>>)>) {
        let mut changed = Vec::new();
        for (id, row) in rows {
            if self.held.get(&id) != Some(&row) {
                self.held.insert(id.clone(), row);
                changed.push(id);
            }
        }
        let views = self.views.get_mut();
        for id in changed {
            for tag in self.tags.of_session(&id) {
                views.facts.touch(&tag);
            }
        }
    }
}

impl State {
    fn tag(&self, tag: &str) -> Option<&String> {
        self.tags.get(tag)
    }

    /// `tagMaps.bind`.
    fn bind(&mut self, tag: &str, session: &str, agent: &str, cwd: &str) {
        let mut changed = self.tags.set(tag, session);
        if changed {
            self.views.get_mut().facts.touch(tag);
        }
        if !agent.is_empty() && self.tag_agents.get(tag).map(String::as_str) != Some(agent) {
            self.tag_agents.insert(tag.to_owned(), agent.to_owned());
            changed = true;
        }
        if !cwd.is_empty() && self.tag_cwds.get(tag).map(String::as_str) != Some(cwd) {
            self.tag_cwds.insert(tag.to_owned(), cwd.to_owned());
            changed = true;
        }
        if changed {
            self.tag_generation += 1;
        }
    }

    /// `tagMaps.unbind`.
    fn unbind(&mut self, tag: &str) {
        let bound = self.tags.remove(tag).is_some();
        if bound {
            self.views.get_mut().facts.drop_tag(tag);
        }
        let agent = self.tag_agents.remove(tag).is_some();
        let cwd = self.tag_cwds.remove(tag).is_some();
        if bound || agent || cwd {
            self.tag_generation += 1;
        }
    }

    /// `tagMaps.unbindIfOwned`.
    fn unbind_if_owned(&mut self, tag: &str, session: &str) {
        if !tag.is_empty() && !session.is_empty() && self.tag(tag).is_some_and(|id| id == session) {
            self.unbind(tag);
        }
    }

    fn map(&self, session: &str) -> Option<&Row> {
        self.maps.get(session)
    }

    fn put(&mut self, session: &str, map: Option<Row>) {
        // A later write of the session replaces a release that was not stored: the map it carries is the one owed now.
        self.releases.remove(session);
        self.maps.set(session, map.clone());
        self.pending.insert(session.to_owned(), map);
        self.views.get_mut().touched(session);
    }

    /// The session's row as readers see it.
    fn row(&self, session: &str, map: &Row, now: f64) -> Option<Row> {
        read_map(session, map, now).0
    }
}

/// What the index reads of `map`, the worker map of `session`, at `now`: its worker row as readers see it, and its
/// tombstone while that is in its lifetime.
fn read_map(session: &str, map: &Row, now: f64) -> (Option<Row>, Option<Row>) {
    let row = (!clean(map.get("sessionId")).is_empty())
        .then(|| {
            let mut row = map.clone();
            row.insert("sessionId".into(), Value::String(session.to_owned()));
            let mut row = normalize_row(&row)?;
            if released_at(map, now) {
                row.insert("released".into(), Value::Bool(true));
            }
            Some(row)
        })
        .flatten();
    (row, map.get("tombstone").and_then(Value::as_object).and_then(|t| normalize_tombstone(t, session, now)))
}

/// Whether the index reads anything of `map`, the worker map of `session`, at `now` ([`read_map`]): a worker row, settled
/// or not, a Lead's own row, or a tombstone still in its lifetime. A tombstone past its lifetime and a release mark with
/// no row behind it are nothing to the index, and nothing a delete of the session would act on.
pub fn map_is_live(session: &str, map: &Row, now: f64) -> bool {
    let (row, tombstone) = read_map(session, map, now);
    row.is_some() || tombstone.is_some() || lead_row::is_lead_map(map)
}

/// Whether a session's delete leaves its worker `row` in place ([`AgentRegistry::forget_deleted_session`]): a row that is
/// not settled, or one whose restart failure its owner has not been told of.
fn outlives_delete(row: &Row) -> bool {
    is_lead_pool_agent(row.get("agent")) || !is_terminal_row(row) || is_unnotified_restart_failure(row)
}

fn released_at(map: &Row, now: f64) -> bool {
    let at = stamp_ms(map.get("releasedAt"));
    at > 0.0 && at >= now - TAG_TOMBSTONE_TTL_MS
}

/// The key of a session's worker row that keeps a close's cancellation (`cancelledAt`, ms) across a restart, which Node's
/// descriptor, in memory only, loses (a scan then builds the closed agent an open idle row again).
const CANCELLED_KEY: &str = "cancelledAt";

/// `agentDescriptor`: a session whose running turn a close stopped reads `cancelled`, its stage too (`closeRuntime`,
/// `agent-cancel.mjs`), so a scan builds it no open idle row; a closed one keeps its own. The close is held by this
/// process and by the session's worker row, until a turn starts on it.
fn described(cancelled: &HashSet<String>, st: &State, mut session: Row) -> Row {
    if marks_cancelled(cancelled, st, &session) {
        for key in ["status", "stage"] {
            session.insert(key.into(), Value::String("cancelled".into()));
        }
    }
    session
}

/// [`described`] of a session that is held shared: it is copied only when a close cancelled it.
fn described_shared(cancelled: &HashSet<String>, st: &State, session: Arc<Row>) -> Arc<Row> {
    if marks_cancelled(cancelled, st, &session) { Arc::new(described(cancelled, st, Row::clone(&session))) } else { session }
}

/// A session as the tag facts read it: the row they answer with and, for a loaded session, the published header it was read
/// from.
struct SessionRead {
    row: Arc<Row>,
    published: Option<Published>,
}

/// The published header a loaded session's read came from, held weakly, and whether the row was that header with the
/// registry's overlay ([`AgentRegistry::overlaid`]) on a copy: a keeper derives the overlay again from the header instead of
/// keeping the copy.
#[derive(Clone)]
struct Published {
    header: std::sync::Weak<Row>,
    overlay: bool,
}

/// [`described`] changes `session`: a close cancelled it and it is not closed.
fn marks_cancelled(cancelled: &HashSet<String>, st: &State, session: &Row) -> bool {
    let id = clean(session.get("id"));
    let marked = cancelled.contains(&id) || st.map(&id).is_some_and(|map| map.contains_key(CANCELLED_KEY));
    marked && session.get("closed") != Some(&Value::Bool(true))
}

fn is_legacy(row: &Row) -> bool {
    clean(either(row, "parentSessionId", "ownerSessionId")).is_empty()
}

/// A tombstone's identity (`row-reads.mjs` `identityOf`).
fn identity(row: &Row) -> String {
    format!("{}\0{}\0{}", tombstone_key(row), clean(row.get("reapedAt")), clean(row.get("sessionId")))
}

/// A map without its row: the tombstone (with its index keys at the root) and the marker.
fn without_row(map: &Row) -> Option<Row> {
    let mut out = Row::new();
    if let Some(tombstone) = map.get("tombstone").and_then(Value::as_object) {
        for key in ["tag", "parentSessionId", "ownerSessionId", "clientHostPid"] {
            if let Some(value) = tombstone.get(key).filter(|v| !v.is_null()) {
                out.insert(key.into(), value.clone());
            }
        }
        out.insert("tombstone".into(), Value::Object(tombstone.clone()));
    }
    if let Some(at) = map.get("releasedAt") {
        out.insert("releasedAt".into(), at.clone());
    }
    (!out.is_empty()).then_some(out)
}

/// A map with its tombstone gone.
fn without_tombstone(map: &Row) -> Option<Row> {
    if clean(map.get("sessionId")).is_empty() {
        let mut rest = map.clone();
        rest.shift_remove("tombstone");
        return without_row(&rest);
    }
    let mut out = map.clone();
    out.shift_remove("tombstone");
    Some(out)
}

impl AgentRegistry {
    #[allow(clippy::disallowed_types, reason = "see `spawn_admission`")]
    pub fn new(store: Arc<dyn WorkerStore>, live: Arc<dyn LiveSessions>, reap: Arc<dyn ReapWindow>, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            live,
            reap,
            clock,
            state: Mutex::new(State::default()),
            rearm: Arc::default(),
            loads: Mutex::default(),
            restart_notices: Mutex::default(),
            parked: Mutex::default(),
            cancelled: Mutex::default(),
            sweeper: std::sync::OnceLock::new(),
            rows_held: tokio::sync::watch::Sender::new(Settlement::Open),
            claimed: Arc::default(),
            spawn_admission: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            walks: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// From now on every read of the store's worker rows waits, until [`Self::recover_held_worker_rows`] has settled them: a start
    /// whose index owes sessions their rows (a rebuild, or its repairs) holds them while those are projected, so no reader (the pool, a spawn's tags, the
    /// maintenance pass, the restart notices) sees a worker before the restart's settlement of it, or the rows of part of the index.
    pub fn hold_worker_rows(&self) {
        self.rows_held.send_replace(Settlement::Held);
    }

    /// Resolves once the restart's settlement of the held worker rows ended ([`Self::recover_held_worker_rows`]), with
    /// its result: a settlement that failed is the failure of every read that awaited it, and of every later one in this
    /// start. Its success opens the rows and says nothing of a later read, which takes the store's own verdict.
    async fn worker_rows_open(&self) -> Result<(), String> {
        let mut held = self.rows_held.subscribe();
        let settled = held.wait_for(|held| *held != Settlement::Held).await.map_err(|_| "the agent registry stopped".to_owned())?;
        match &*settled {
            Settlement::Failed(why) => Err(why.clone()),
            _ => Ok(()),
        }
    }

    /// `nextStaleRowDeadline({}, since)`: the next moment after `since` a row of any owner comes due by its stamps alone
    /// (ms); infinity when none will.
    pub fn next_stale_row_deadline(&self, since: f64) -> f64 {
        let st = self.lock();
        let reap = self.reap_ms();
        let mut next = f64::INFINITY;
        for row in st.rows(&Scope::default(), self.now()) {
            if is_lead_pool_agent(row.get("agent")) {
                continue;
            }
            let due = if is_terminal_row(&row) {
                if is_unnotified_restart_failure(&row) {
                    continue;
                }
                settled_retention_deadline(&reap, &row)
            } else {
                nonterminal_reap_deadline(&reap, &row)
            };
            if due > since && due < next {
                next = due;
            }
        }
        next
    }

    /// The deadline timer of the agent maintenance pass: a pass (`refresh_tags_from_sessions` over every owner's rows) runs at
    /// the earliest moment a row comes due by its stamps alone after the last pass began, so a row past its reap deadline leaves
    /// the index then, not at the next agent event. A deadline crossed while a pass ran starts the next pass at once. Every
    /// refresh and row write arms the timer again. Ends once the registry is gone. The start is the moment of this call, not of
    /// the future's first poll.
    pub fn keep_deadlines(registry: std::sync::Weak<Self>) -> impl std::future::Future<Output = ()> + Send + 'static {
        let started = registry.upgrade().map_or(0.0, |first| first.now());
        Self::deadline_timer(registry, started)
    }

    async fn deadline_timer(registry: std::sync::Weak<Self>, started: f64) {
        // Node re-arms a deadline past setTimeout's largest delay when it fires; this looks at the registry again.
        const LONGEST_WAIT_MS: f64 = 3_600_000.0;
        // Node's `MAINTENANCE_EVENT_DELAY_MS` (maintenance-pass.mjs): the delay of the first pass after the start, and of the pass an
        // agent event asks for however many events arrive meanwhile.
        const MAINTENANCE_EVENT_DELAY_MS: f64 = 1_000.0;
        let Some(first) = registry.upgrade() else { return };
        let rearm = first.rearm.clone();
        let clock = first.clock.clone();
        drop(first);
        // Node arms no deadline before a pass has run, and the first pass is the event pass one `MAINTENANCE_EVENT_DELAY_MS`
        // after the first status read (maintenance-pass.mjs:23,129). It then looks at every deadline after 0
        // (`lastPassStart` starts at 0): a row that came due while the core was down is reaped by it.
        clock.until_ms((started + MAINTENANCE_EVENT_DELAY_MS) as i64).await;
        let mut since = 0.0;
        loop {
            let rearmed = rearm.notified();
            tokio::pin!(rearmed);
            rearmed.as_mut().enable();
            let Some(this) = registry.upgrade() else { return };
            let (next, now) = (this.next_stale_row_deadline(since), this.now());
            // A settled Lead row leaves at its own deadline (1.4.5's per-row reap timers, `reap-timers.mjs`).
            this.leads_loaded().await;
            if this.next_lead_reap_deadline() <= now {
                this.reap_lead_rows();
            }
            let next_lead = this.next_lead_reap_deadline();
            if next <= now {
                since = now;
                // A pass starts with `sweepRestartFailures`, then the tags of every owner's rows.
                if let Some(sweeper) = this.sweeper.get().cloned() {
                    sweeper.sweep().await;
                }
                // A pass whose rows could not be read reaps nothing: the next one reads them again.
                if let Err(error) = this.refresh_tags_from_sessions(false, &Scope::default()).await {
                    tracing::warn!("[agent] the maintenance pass could not read the worker rows: {error}");
                }
                continue;
            }
            let sweeper = this.sweeper.get().cloned();
            drop(this);
            let at = next.min(next_lead).min(now + LONGEST_WAIT_MS).ceil() as i64;
            let woken = tokio::select! {
                () = clock.until_ms(at) => false,
                () = &mut rearmed => true,
            };
            if woken && let Some(sweeper) = sweeper {
                clock.until_ms(clock.now_ms() + MAINTENANCE_EVENT_DELAY_MS as i64).await;
                sweeper.sweep().await;
            }
        }
    }

    /// Binds the host's `sweepRestartFailures`; a second bind is refused.
    pub fn bind_sweeper(&self, sweeper: Arc<dyn restart::RestartSweep>) -> Result<(), Arc<dyn restart::RestartSweep>> {
        self.sweeper.set(sweeper)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn now(&self) -> f64 {
        self.clock.now_ms() as f64
    }

    fn reap_ms(&self) -> impl Fn(&str) -> f64 + '_ {
        |provider| self.reap.terminal_reap_ms(provider)
    }

    /// Reloads the index; this process's writes it does not show yet stay applied. A caller that arrives while a load is
    /// under way waits for the next one and shares it with the others that wait, when that load read the store after the
    /// caller arrived and completed, so the threads one status signal wakes load the index once or twice, not once each.
    /// `Err` when the index could not be read whole: what the registry holds in memory is then no account of the stored
    /// rows, and a caller that would decide from a row it does not show reports this instead.
    async fn reload(&self) -> Result<(), String> {
        let arrived = self.loads().started;
        let number = loop {
            let ended = {
                let mut loads = self.loads();
                if loads.completed > arrived {
                    return Ok(());
                }
                if !loads.running {
                    loads.running = true;
                    loads.started += 1;
                    break loads.started;
                }
                let (told, ended) = oneshot::channel();
                loads.waiting.push(told);
                ended
            };
            // Told or dropped when the running load ends, however it ends.
            let _ = ended.await;
        };
        let mut turn = LoadTurn { loads: &self.loads, number, completed: false };
        let loaded = self.load().await;
        turn.completed = loaded.is_ok();
        loaded
    }

    fn loads(&self) -> MutexGuard<'_, Loads> {
        self.loads.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reads the Lead index into memory the first time; a row this process wrote before that stays as written. A read that
    /// fails is tried again by the next caller.
    async fn leads_loaded(&self) {
        if self.lock().leads_loaded {
            return;
        }
        let Ok(rows) = self.store.lead_rows().await else { return };
        let mut st = self.lock();
        if st.leads_loaded {
            return;
        }
        for (id, row) in rows {
            st.lead_rows.entry(id).or_insert(Some(row));
        }
        st.leads_loaded = true;
    }

    /// The index read and applied: after the restart's settlement of a start that held the rows, whose failure is this
    /// read's, and from the store's read of every session that could hold a worker row, whose failure is this read's too.
    async fn load(&self) -> Result<(), String> {
        self.worker_rows_open().await?;
        self.leads_loaded().await;
        let since = self.lock().revision;
        let index = self.store.index_since(since).await?;
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.reloads += 1);
        let missing: Vec<String> = {
            let mut guard = self.lock();
            let st = &mut *guard;
            match index {
                Index::Unchanged => {}
                Index::Delta { revision, maps, sessions } => {
                    self.apply_delta(st, maps);
                    Self::hold_listed(st, sessions, false);
                    st.revision = Some(revision);
                }
                Index::Full { revision, maps, sessions } => {
                    self.load_maps(st, maps);
                    Self::hold_listed(st, sessions.into_iter().map(|(id, row)| (id, Some(row))).collect(), true);
                    st.revision = revision;
                }
            }
            let wanted = st.wanted();
            st.held.retain(|id, _| wanted.contains(id));
            wanted.into_iter().filter(|id| !st.held.contains_key(id)).collect()
        };
        // The sessions that came to stand for a live agent since the last load, whose rows this one did not hand over.
        let mut found = Vec::with_capacity(missing.len());
        for id in missing {
            let row = self.store.agent_session(&id).await?;
            found.push((id, row.map(Arc::new)));
        }
        if !found.is_empty() {
            let mut st = self.lock();
            let wanted = st.wanted();
            let found: Vec<(String, Option<Arc<Row>>)> = found.into_iter().filter(|(id, _)| wanted.contains(id) && !st.held.contains_key(id)).collect();
            st.hold(found);
        }
        Ok(())
    }

    /// Node's index file keeps a deleted session's rows until its forget takes them (`gone-rows.mjs:214`) and every listing
    /// shows them with no header; the core's index drops them with the session, so a map it stops listing that this
    /// registry did not remove is kept by the store, durably, and lives on as Node's does.
    fn keep_gone(&self, st: &mut State, id: &str, map: Row) {
        self.store.keep(id, Some(map.clone()));
        st.put(id, Some(map));
    }

    /// The maps the store wrote since the held revision, each compared with the one held; a map this process wrote that the
    /// store does not show yet stays as written.
    fn apply_delta(&self, st: &mut State, maps: Vec<(String, Option<(Place, Row)>)>) {
        for (id, entry) in maps {
            #[cfg(any(test, feature = "test-support"))]
            work::note(|c| c.maps_compared += 1);
            if let Some(held) = st.pending.get(&id) {
                if held.as_ref() != entry.as_ref().map(|(_, map)| map) {
                    continue;
                }
                st.pending.remove(&id);
            }
            match entry {
                Some((place, map)) => {
                    if st.maps.entry(&id) != Some((&place, &map)) {
                        st.maps.place(&id, place, map);
                        st.views.get_mut().touched(&id);
                    }
                }
                None => {
                    if let Some(map) = st.maps.get(&id).cloned() {
                        self.keep_gone(st, &id, map);
                    }
                }
            }
        }
    }

    /// Every map the store lists, with this process's writes it does not show yet applied on top.
    fn load_maps(&self, st: &mut State, maps: Vec<(String, Place, Row)>) {
        let mut next = Maps::from_entries(maps, st.maps.front());
        // A map the store does not list stays where it is held, when that place is free.
        let held_place = |next: &mut Maps, id: &str, map: Option<Row>| match (st.maps.key(id).filter(|place| !next.holds(place)), map) {
            (Some(place), Some(map)) if next.get(id).is_none() => next.place(id, place.clone(), map),
            (_, map) => next.set(id, map),
        };
        let pending: Vec<(String, Option<Row>)> = st.pending.drain().collect();
        let mut still = Vec::new();
        for (session, map) in pending {
            if next.get(&session) == map.as_ref() {
                continue;
            }
            held_place(&mut next, &session, map.clone());
            still.push((session, map));
        }
        let gone: Vec<(String, Row)> = st.maps.iter().filter(|(id, _)| next.get(id).is_none()).map(|(id, map)| (id.clone(), map.clone())).collect();
        for (id, map) in gone {
            self.store.keep(&id, Some(map.clone()));
            held_place(&mut next, &id, Some(map.clone()));
            still.push((id, Some(map)));
        }
        st.pending.extend(still);
        if st.maps.same_as(&next) {
            return;
        }
        if st.maps.same_order(&next) {
            // The same sessions at the same places: only the maps that differ are read again.
            let differ: Vec<(String, Place, Row)> = next
                .iter()
                .filter(|(id, map)| st.maps.get(id) != Some(*map))
                .map(|(id, map)| (id.clone(), next.key(id).cloned().expect("listed"), map.clone()))
                .collect();
            for (id, place, map) in differ {
                st.maps.place(&id, place, map);
                st.views.get_mut().touched(&id);
            }
        } else {
            st.maps = next;
            st.changed();
        }
    }

    /// The list rows a load handed over, read only for the sessions live agents stand for ([`State::wanted`]); `whole`:
    /// `listed` is every agent-only session, so one of those sessions it does not name is listed no longer.
    fn hold_listed(st: &mut State, listed: Vec<(String, Option<ListRow>)>, whole: bool) {
        let wanted = st.wanted();
        let mut rows: HashMap<String, Option<Arc<Row>>> = HashMap::new();
        for (id, row) in listed {
            if wanted.contains(&id) {
                #[cfg(any(test, feature = "test-support"))]
                work::note(|c| c.sessions_compared += 1);
                rows.insert(id, row.and_then(|row| row.row()).map(Arc::new));
            }
        }
        if whole {
            for id in wanted {
                rows.entry(id).or_insert(None);
            }
        }
        st.hold(rows);
    }

    fn persist(&self, st: &mut State, session: &str, map: Option<Row>) {
        self.persisted(st, session, &map);
        self.store.write(session, map);
        self.rearm.notify_waiters();
    }

    /// What every write of a session's map changes here before the store is asked; answers the write's revision.
    fn persisted(&self, st: &mut State, session: &str, map: &Option<Row>) -> u64 {
        if map.as_ref().is_some_and(restart::is_active_worker_row) {
            st.active.insert(session.to_owned());
        } else {
            st.active.remove(session);
        }
        st.put(session, map.clone());
        if let Some(held) = st.holding.as_mut()
            && held.sessions.insert(session.to_owned())
        {
            let session = session.to_owned();
            held.recovered.holds.push(self.store.hold_signals(std::slice::from_ref(&session)));
            held.recovered.sessions.push(session);
        }
        st.writes += 1;
        st.writes
    }

    /// Resolves once every worker-map write made so far is applied to its header ([`WorkerStore::settled`]).
    pub(crate) async fn rows_settled(&self) -> Result<(), String> {
        self.store.settled().await
    }

    /// What an operation reads of the index before it takes the state: every agent-only session when `listing`, and the
    /// row of each of `ids` that is not loaded and whose row the registry does not hold.
    async fn read_index(&self, listing: bool, ids: &[&str]) -> Result<Reads, String> {
        let mut reads = Reads::default();
        if listing {
            reads.listing = Some(Arc::new(Listing::of(self.store.agent_sessions().await?)));
        }
        let unread: Vec<String> = {
            let st = self.lock();
            ids.iter()
                .map(|id| clean_str(id))
                .filter(|id| !id.is_empty() && !st.held.contains_key(id) && reads.find(id).is_none() && self.live.shared_header(id).is_none())
                .collect()
        };
        for id in unread {
            let row = self.store.agent_session(&id).await?;
            reads.rows.insert(id, row.map(Arc::new));
        }
        Ok(reads)
    }

    /// [`Self::read_index`] for an answer that has no failure to give: a read that failed is logged, and the operation
    /// answers from the sessions loaded and the rows the registry holds.
    async fn read_index_or_held(&self, listing: bool, ids: &[&str]) -> Reads {
        self.read_index(listing, ids).await.unwrap_or_else(|error| {
            tracing::warn!("[agent] the agent sessions could not be read from the index: {error}");
            Reads { listing: listing.then(|| Arc::new(Listing::of(Vec::new()))), rows: HashMap::new() }
        })
    }

    /// The state for an operation that read `reads` ([`Operation`]).
    fn op(&self, reads: Reads) -> Operation<'_> {
        let mut st = self.lock();
        st.reads = reads;
        Operation(st)
    }

    /// Whether a refresh resolves legacy tombstones' owners now, which reads every agent-only session.
    fn owners_owed(&self) -> bool {
        let st = self.lock();
        let now = self.now();
        let resolved = st.views(now).owners_resolved;
        if resolved {
            return false;
        }
        let tombstones = st.stored_tombstones(now);
        tombstones.iter().any(|row| is_legacy(row) && !st.owners.contains_key(&identity(row)))
    }

    /// `mgr.listSessions({includeClosed})`: the loaded sessions as they are now, then the
    /// stored ones as the operation read them.
    fn list_sessions(&self, st: &State, include_closed: bool) -> Vec<Arc<Row>> {
        debug_assert!(st.reads.listing.is_some(), "an operation that lists the agent sessions reads them first");
        #[cfg(test)]
        self.walks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut out: Vec<Arc<Row>> = Vec::new();
        let mut seen = HashSet::new();
        for id in self.live.loaded() {
            if let Some(header) = self.loaded_session(&id) {
                seen.insert(id);
                out.push(header);
            }
        }
        for session in st.reads.listing.iter().flat_map(|listing| listing.rows.iter()) {
            if !seen.contains(&clean(session.get("id"))) {
                out.push(session.clone());
            }
        }
        if !include_closed {
            out.retain(|s| s.get("closed") != Some(&Value::Bool(true)));
        }
        let cancelled = self.cancelled.lock().unwrap_or_else(|p| p.into_inner());
        out.into_iter().map(|session| described_shared(&cancelled, st, session)).collect()
    }

    /// A loaded session's published header, which carries its tool list and prompt: read where it is, and copied only
    /// when it does not name the session as `id`.
    fn loaded_session(&self, id: &str) -> Option<Arc<Row>> {
        let header = self.live.shared_header(id)?;
        if header.get("id").and_then(Value::as_str) == Some(id) {
            return Some(header);
        }
        let mut row = Row::clone(&header);
        row.insert("id".into(), Value::String(id.to_owned()));
        Some(Arc::new(row))
    }

    /// `mgr.getSession`.
    fn session(&self, st: &State, id: &str) -> Option<Arc<Row>> {
        if id.is_empty() {
            return None;
        }
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        let session = self.loaded_session(id).or_else(|| Self::indexed_session(st, id))?;
        Some(described_shared(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, session))
    }

    /// The session as the index lists it, for a session not loaded: its held row, else the one the operation read.
    fn indexed_session(st: &State, id: &str) -> Option<Arc<Row>> {
        let row = match st.held.get(id) {
            Some(row) => row.clone(),
            None => st.reads.find(id).flatten(),
        }?;
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        Some(row)
    }

    /// `mgr.getSession(id)` (`sessionOf`), read from the index when the session is neither loaded nor held.
    pub(super) async fn session_of(&self, id: &str) -> Option<Arc<Row>> {
        let id = clean_str(id);
        let reads = self.read_index_or_held(false, &[&id]).await;
        let st = self.op(reads);
        self.session(&st, &id)
    }

    /// [`Self::session_of`] of a session that is loaded or whose row is held: a worker's own, from its turn.
    pub(super) fn held_session_of(&self, id: &str) -> Option<Arc<Row>> {
        let st = self.lock();
        self.session(&st, &clean_str(id))
    }

    /// [`Registry::tag_for_session`] of a session that is loaded or whose row is held: a worker's own, from its turn.
    pub(super) fn held_tag_for_session(&self, session_id: &str) -> Option<String> {
        let st = self.lock();
        self.tag_of(&st, session_id)
    }

    /// The session's own `agentTag`, else the first tag bound to it.
    fn tag_of(&self, st: &State, session_id: &str) -> Option<String> {
        let persisted = self.live_session_row(st, session_id).map(|s| agent_tag_of(&s)).unwrap_or_default();
        if !persisted.is_empty() {
            return Some(persisted);
        }
        st.tags.first_of(session_id).cloned()
    }

    /// Whether [`Self::session_of`] finds the session, without copying it. One whose row could not be read is not known
    /// to be gone.
    pub(super) async fn knows_session(&self, id: &str) -> bool {
        let id = clean_str(id);
        if id.is_empty() {
            return false;
        }
        if self.live.shared_header(&id).is_some() {
            return true;
        }
        let held = self.lock().held.get(&id).map(Option::is_some);
        if let Some(known) = held {
            return known;
        }
        !matches!(self.store.agent_session(&id).await, Ok(None))
    }

    /// `upsertWorkerSessionDeferred(session, tag, extra)` from the worker's turn.
    pub(super) fn upsert_session_row(&self, session: &Row, tag: &str, extra: &Row) {
        let mut st = self.lock();
        self.upsert_session(&mut st, session, tag, extra);
    }

    /// `getLiveSession`.
    fn live_session_row(&self, st: &State, id: &str) -> Option<Arc<Row>> {
        self.session(st, id).filter(|s| s.get("closed") != Some(&Value::Bool(true)))
    }

    fn shared_live_session(&self, st: &State, id: &str) -> Option<SessionRead> {
        if id.is_empty() {
            return None;
        }
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        let Some(header) = self.live.shared_header(id) else {
            let row = described_shared(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, Self::indexed_session(st, id)?);
            return (row.get("closed") != Some(&Value::Bool(true))).then_some(SessionRead { row, published: None });
        };
        let overlay =
            header.get("id").and_then(Value::as_str) != Some(id) || marks_cancelled(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, &header);
        let row = if overlay { Arc::new(self.overlaid(st, id, &header)) } else { header.clone() };
        let published = Some(Published { header: Arc::downgrade(&header), overlay });
        (row.get("closed") != Some(&Value::Bool(true))).then_some(SessionRead { row, published })
    }

    /// A loaded session's header as [`Self::session`] reads it: with the session's `id` and, when a close cancelled it, its
    /// cancellation ([`described`]).
    fn overlaid(&self, st: &State, id: &str, header: &Row) -> Row {
        let mut row = header.clone();
        row.insert("id".into(), Value::String(id.to_owned()));
        described(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, row)
    }

    // ---- writes ------------------------------------------------------------------------

    /// `upsertWorkerRow`: the row joins the tag maps and replaces the session's row.
    fn upsert_row(&self, st: &mut State, row: &Row) {
        let Some(normalized) = normalize_row(row) else { return };
        let session = clean(normalized.get("sessionId"));
        st.bind(&clean(normalized.get("tag")), &session, &clean(normalized.get("agent")), &clean(normalized.get("cwd")));
        let prev = st.map(&session).cloned().unwrap_or_default();
        let prev_row = (!clean(prev.get("sessionId")).is_empty()).then_some(&prev);
        let mut map = apply_upsert(prev_row, normalized, &iso(self.now()));
        map.shift_remove("released");
        for key in ["tombstone", "releasedAt"] {
            match prev.get(key) {
                Some(value) => map.insert(key.into(), value.clone()),
                None => map.shift_remove(key),
            };
        }
        self.persist(st, &session, Some(map));
    }

    /// `upsertWorkerSessionDeferred(session, tag, extra)`.
    fn upsert_session(&self, st: &mut State, session: &Row, tag: &str, extra: &Row) {
        let id = clean(session.get("id"));
        let stage = self.live.runtime_stage(&id);
        if let Some(row) = row_from_session(session, tag, extra, stage.as_deref(), &iso(self.now())) {
            self.upsert_row(st, &row);
        }
    }

    /// The `releasedAt` stamp the session's map holds now: the release its owner's last close made, until a turn or a
    /// send takes the session up again.
    pub(crate) fn released_stamp(&self, session: &str) -> Option<String> {
        self.lock().map(session).and_then(|map| map.get("releasedAt")).and_then(Value::as_str).map(str::to_owned)
    }

    /// The session is used again: its owner's release ends, as a turn's start ends it.
    pub(crate) fn clear_released(&self, session: &str) {
        let mut st = self.lock();
        if let Some(mut map) = st.map(session).cloned()
            && map.shift_remove("releasedAt").is_some()
        {
            self.persist(&mut st, session, (!map.is_empty()).then_some(map));
        }
    }

    /// `descriptor.parked = on`.
    pub(crate) fn set_parked(&self, session: &str, on: bool) {
        let mut parked = self.parked.lock().unwrap_or_else(|p| p.into_inner());
        if on {
            parked.insert(session.to_owned());
        } else {
            parked.remove(session);
        }
    }

    /// Whether the idle release parked the session and no turn started on it since.
    pub(crate) fn is_parked(&self, session: &str) -> bool {
        self.parked.lock().unwrap_or_else(|p| p.into_inner()).contains(session)
    }

    /// `descriptor.status = 'cancelled'` when `on` (`closeRuntime`: the close stopped a running turn), `'running'` when not
    /// (`runAgentTurn`: a turn started on it). The mark is also kept on the session's worker row, so a restart does not lose it.
    pub(crate) fn set_cancelled(&self, session: &str, on: bool) {
        let changed = {
            let mut cancelled = self.cancelled.lock().unwrap_or_else(|p| p.into_inner());
            if on { cancelled.insert(session.to_owned()) } else { cancelled.remove(session) }
        };
        let mut guard = self.lock();
        let st = &mut *guard;
        let kept = st.map(session).is_some_and(|map| map.contains_key(CANCELLED_KEY));
        if kept != on
            && let Some(mut map) = st.map(session).cloned()
        {
            if on {
                map.insert(CANCELLED_KEY.into(), Value::from(self.clock.now_ms()));
            } else {
                map.shift_remove(CANCELLED_KEY);
            }
            self.persist(st, session, Some(map));
        }
        if changed || kept != on {
            // The session's tags read it again.
            let views = st.views.get_mut();
            for tag in st.tags.of_session(session) {
                views.facts.touch(&tag);
            }
        }
    }

    /// `idleRows()` (`close-flow/idle-release.mjs`): every owner's open idle worker row, by session. A Lead's own row,
    /// which Node's index does not list, is no agent to park.
    pub(crate) fn idle_rows(&self) -> HashMap<String, TagRecord> {
        let st = self.lock();
        st.rows(&Scope::default(), self.now())
            .iter()
            .filter(|row| !is_lead_pool_agent(row.get("agent")))
            .map(|row| tag_record(row, "tag", "sessionId"))
            .filter(|row| !row.session_id.is_empty() && mixdog_agent::agent_tool::views::is_open_idle(&row.status, &row.stage))
            .map(|row| (row.session_id.clone(), row))
            .collect()
    }

    /// Woken by every refresh and row write (`registry.onWorkerRowsChange`, and more often).
    pub(crate) fn rows_changed(&self) -> Arc<tokio::sync::Notify> {
        self.rearm.clone()
    }

    /// `mgr.listSessions()`: the agent sessions that are not closed.
    pub(crate) async fn open_sessions(&self) -> Vec<Arc<Row>> {
        let reads = self.read_index_or_held(true, &[]).await;
        let st = self.op(reads);
        self.list_sessions(&st, false)
    }

    /// `forgetDeletedSession` (`gone-rows.mjs`): a deleted session's settled row goes, as a
    /// tombstone; a running one or an owed restart failure stays. A deleted Lead's own pool row
    /// goes at once, without a tombstone (`forgetLeadSession`): from the Lead index, and a migrated
    /// header row, which the index keeps past the session (`keep_gone`). Whether one went. Reads the
    /// index as it is now (`readAllWorkerRows`).
    pub async fn forget_deleted_session(&self, session_id: &str) -> bool {
        let id = clean_str(session_id);
        if id.is_empty() {
            return false;
        }
        // Whatever the registry holds for the deleted session itself goes whether or not its row can be read now.
        self.parked.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        self.cancelled.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        self.lock().epochs.remove(&id);
        self.forget_scope(&id);
        // Rows that could not be read are not forgotten from memory alone: the row stays for a later forget,
        // and restart-notice dedup entries stay while an unnotified failure row may still sit in storage.
        if let Err(error) = self.reload().await {
            self.store.forget_session(&id);
            tracing::warn!(thread = %id, "[agent] a deleted session's worker row is not forgotten yet: {error}");
            return false;
        }
        let had_kept = self.store.kept(&id);
        let (forgot, unwritten) = self.forget_row(&id);
        self.forget_restart_notices(&id);
        // Wait for a kept-row removal or Lead tombstone write before forgetting the session in the store so
        // `KeptMemory::forget` sees the removed row gone and prunes its `changed`/`changed_at` entry; until the
        // Lead index is read, the Lead tombstone also stays until the removal is written.
        let removed_kept = had_kept && forgot && self.lock().map(&id).is_none();
        if (unwritten || removed_kept) && self.store.settled().await.is_ok() && unwritten {
            let mut st = self.lock();
            if st.lead_rows.get(&id).is_some_and(Option::is_none) {
                st.lead_rows.remove(&id);
            }
        }
        self.store.forget_session(&id);
        forgot
    }

    fn forget_restart_notices(&self, id: &str) {
        let owed = self.lock().map(id).is_some_and(restart::is_unnotified_restart_failure);
        self.restart_notices.lock().unwrap_or_else(|p| p.into_inner()).retain(|_, notice| notice.owner != id && (owed || notice.session != id));
    }

    /// The row of a deleted session as the registry holds it now: whether one went, and whether a removed Lead's tombstone
    /// waits for its write.
    fn forget_row(&self, id: &str) -> (bool, bool) {
        let id = id.to_owned();
        let now = self.now();
        let mut st = self.lock();
        let indexed = st.lead_rows.get(&id).is_some_and(Option::is_some);
        if indexed || st.map(&id).is_some_and(|map| lead_row::is_lead_map(map) && clean(map.get("sessionId")) == id) {
            self.remove_lead(&mut st, &id);
            let read = st.leads_loaded;
            if read {
                st.lead_rows.remove(&id);
            }
            return (true, !read);
        }
        if st.leads_loaded && st.lead_rows.get(&id).is_some_and(Option::is_none) {
            st.lead_rows.remove(&id);
        }
        let Some(row) = st.map(&id).cloned().and_then(|map| st.row(&id, &map, now)) else {
            return (false, false);
        };
        if clean(row.get("sessionId")) != id || outlives_delete(&row) {
            return (false, false);
        }
        self.tombstone_rows(&mut st, &[row]);
        (true, false)
    }

    /// A Lead that unloads, closes or is deleted lets go of the view of its own agents; the next read of them makes it again.
    pub fn forget_scope(&self, session_id: &str) {
        let scope = Scope { caller_session_id: Some(session_id.to_owned()), host_pid: None };
        self.lock().views.get_mut().forget_scope(&scope);
    }

    /// `removeWorkerRow({sessionId})`: an owed restart failure stays.
    fn remove_row(&self, st: &mut State, session: &str) {
        let now = self.now();
        let Some(map) = st.map(session).cloned() else { return };
        let Some(row) = st.row(session, &map, now) else { return };
        if is_unnotified_restart_failure(&row) {
            return;
        }
        self.persist(st, session, without_row(&map));
    }

    /// Removes every stored tombstone `pick` selects.
    fn drop_tombstones(&self, st: &mut State, pick: impl Fn(&str, &Row) -> bool) {
        let now = self.now();
        let hits: Vec<(String, Row)> = st
            .maps
            .iter()
            .filter(|(id, map)| map.get("tombstone").and_then(Value::as_object).and_then(|t| normalize_tombstone(t, id, now)).is_some_and(|t| pick(id, &t)))
            .map(|(id, map)| (id.clone(), map.clone()))
            .collect();
        for (id, map) in hits {
            self.persist(st, &id, without_tombstone(&map));
        }
    }

    /// `tombstoneRows`: each row's session loses its row and keeps a tombstone; a tombstone of
    /// the same key elsewhere goes (`insertTombstone`).
    fn tombstone_rows(&self, st: &mut State, rows: &[Row]) {
        let reaped_at = iso(self.now());
        for row in rows {
            let session = clean(row.get("sessionId"));
            let mut tombstone = Row::new();
            tombstone.insert("tag".into(), Value::String(clean(row.get("tag"))));
            for key in ["agent", "cwd"] {
                let value = clean(row.get(key));
                tombstone.insert(key.into(), if value.is_empty() { Value::Null } else { Value::String(value) });
            }
            tombstone.insert("clientHostPid".into(), mixdog_agent::agent_tool::scope::positive_int(row.get("clientHostPid")).map_or(Value::Null, Value::from));
            for key in ["parentSessionId", "ownerSessionId"] {
                let value = clean(row.get(key));
                if !value.is_empty() {
                    tombstone.insert(key.into(), Value::String(value));
                }
            }
            tombstone.insert("reapedAt".into(), Value::String(reaped_at.clone()));
            let key = tombstone_key(&tombstone);
            self.drop_tombstones(st, |id, t| id != session && tombstone_key(t) == key);
            let mut map = st.map(&session).cloned().unwrap_or_default();
            map.insert("tombstone".into(), Value::Object(tombstone));
            self.persist(st, &session, without_row(&map));
            st.unbind_if_owned(&clean(row.get("tag")), &session);
        }
    }

    // ---- refresh -----------------------------------------------------------------------

    /// `resolveTombstoneOwners`.
    fn resolve_owners(&self, st: &mut State) {
        let now = self.now();
        if st.views(now).owners_resolved {
            return;
        }
        let legacy: Vec<Row> = st.stored_tombstones(now).iter().filter(|row| is_legacy(row)).cloned().collect();
        let unresolved: Vec<&Row> = legacy.iter().filter(|row| !st.owners.contains_key(&identity(row))).collect();
        if unresolved.is_empty() {
            st.views(now).owners_resolved = true;
            return;
        }
        // Over the listing the operation read: one that read none leaves them to a later refresh.
        if st.reads.listing.is_none() {
            return;
        }
        let sessions = self.list_sessions(st, true);
        let current: HashSet<String> = legacy.iter().map(identity).collect();
        let found: Vec<(String, Option<Row>)> = unresolved
            .iter()
            .map(|row| {
                let fields = recover_owner(row, &sessions).map(|owner| {
                    ["sessionId", "parentSessionId", "ownerSessionId"].into_iter().filter_map(|k| Some((k.to_owned(), owner.get(k)?.clone()))).collect()
                });
                (identity(row), fields)
            })
            .collect();
        st.owners.retain(|id, _| current.contains(id));
        st.owners.extend(found);
        st.changed();
        st.views(now).owners_resolved = true;
    }

    /// `scanSessionIsTerminal`.
    fn scan_is_terminal(&self, session: &Row) -> bool {
        if session.get("closed") == Some(&Value::Bool(true)) {
            return true;
        }
        let status = clean(session.get("status"));
        if !is_terminal_worker_status(if status.is_empty() { "idle" } else { &status }) {
            return false;
        }
        let id = clean(session.get("id"));
        if self.live.running(&id) {
            return false;
        }
        !self.live.runtime_stage(&id).is_some_and(|s| ACTIVE_STAGES.contains(&clean_str(&s).as_str()))
    }

    /// The scan guard of a tombstone (`tombstones.mjs` `tombstoneBlocksScan`): only a worker
    /// row admitted by the same reap rule proves a later real turn.
    fn tombstone_blocks_scan(&self, st: &State, session: &Row, tag: &str, by_key: &HashMap<String, Row>) -> bool {
        let tag = clean_str(tag);
        let id = clean(session.get("id"));
        if tag.is_empty() || id.is_empty() || !blocks_work(session, find_tombstone(session, by_key, &tag)) {
            return false;
        }
        let now = self.now();
        !st.indexed_row(&id, now).is_some_and(|row| clean(row.get("sessionId")) == id && clean(row.get("tag")) == tag)
    }

    /// `terminal-reaper.mjs` `tombstoneBlocksScan`: aged out, or a tombstone blocks it.
    fn blocks_scan(&self, st: &State, session: &Row, tag: &str, by_key: &HashMap<String, Row>) -> bool {
        // A session its owner closed is bound again by a scan so a send reaches it (Node's behavior, kept), but not while a
        // spawn resolves the tag: the spawn is for a new session. (A listing keeps listing it; a resolve prefers the owner's
        // open session, `resolve_bound`.)
        if st.skip_released && st.map(&clean(session.get("id"))).is_some_and(|map| released_at(map, self.now())) {
            return true;
        }
        let aged_out = self.scan_is_terminal(session) && past_settled_retention(&self.reap_ms(), session, self.now());
        aged_out || self.tombstone_blocks_scan(st, session, tag, by_key)
    }

    /// `scanUpsertSession`.
    fn scan_upsert(&self, st: &mut State, session: &Row, tag: &str, by_key: &HashMap<String, Row>) -> bool {
        if self.tombstone_blocks_scan(st, session, tag, by_key) {
            return false;
        }
        let now = self.now();
        // An idle session header is not a new task outcome. Only an actual turn's row
        // update can replace the durable failure left by restart recovery. The row of a session its owner closed holds
        // nothing a scan could bring up to date either: no turn ran on it since.
        let settled = |map: &Row| restart::is_restart_failure(map) || (released_at(map, now) && normalize_row(map).is_some());
        if st.map(&clean(session.get("id"))).is_some_and(settled) {
            return true;
        }
        let extra = self.terminal_scan_extra(st, session).unwrap_or_default();
        self.upsert_session(st, session, tag, &extra);
        true
    }

    /// `terminalScanExtra`: a terminal session keeps its own frozen stamps.
    fn terminal_scan_extra(&self, st: &State, session: &Row) -> Option<Row> {
        if !self.scan_is_terminal(session) {
            return None;
        }
        let at = session_activity_at(session);
        if at <= 0.0 {
            return None;
        }
        let stamp = iso(at);
        let id = clean(session.get("id"));
        let existing = st.indexed_row(&id, self.now()).filter(|row| clean(row.get("sessionId")) == id);
        let mut finished = stamp_ms(session.get("finishedAt"));
        if finished == 0.0 {
            finished = stamp_ms(existing.as_ref().and_then(|r| r.get("finishedAt")));
        }
        let mut extra = Row::new();
        extra.insert("updatedAt".into(), Value::String(stamp.clone()));
        extra.insert("finishedAt".into(), Value::String(if finished > 0.0 { iso(finished) } else { stamp }));
        extra.insert("reapAt".into(), Value::Null);
        Some(extra)
    }

    /// `sessionHasLiveWork`: a running turn, queued input, or a runtime stage still doing work.
    fn session_has_live_work(&self, id: &str) -> bool {
        self.live.has_live_work(id) || self.live.runtime_stage(id).is_some_and(|stage| ACTIVE_STAGES.contains(&stage.as_str()))
    }

    /// `transitionStaleNonterminalRows`.
    fn transition_stale(&self, st: &mut State, scope: &Scope) {
        let stale = self.stale_rows(st, scope);
        let gone = self.gone_rows(st, &stale);
        self.tombstone_rows(st, &[stale, gone].concat());
    }

    /// The scope's rows `transitionStaleNonterminalRows` turns into tombstones now.
    fn stale_rows(&self, st: &State, scope: &Scope) -> Vec<Row> {
        let now = self.now();
        let reap = self.reap_ms();
        // Only a row not settled, or settled a day ago, can be stale (`pastSettledRetention`).
        st.stale_candidates(scope, now)
            .into_iter()
            .filter(|row| {
                #[cfg(any(test, feature = "test-support"))]
                work::note(|c| c.rows_visited += 1);
                if is_lead_pool_agent(row.get("agent")) {
                    return false;
                }
                let id = clean(row.get("sessionId"));
                if is_terminal_row(row) {
                    return !is_unnotified_restart_failure(row) && past_settled_retention(&reap, row, now) && !self.session_has_live_work(&id);
                }
                if self.live_session_row(st, &id).is_some() {
                    return false;
                }
                now >= nonterminal_reap_deadline(&reap, row)
            })
            .map(|row| (*row).clone())
            .collect()
    }

    /// The kept maps (deleted sessions'), in index order, with their maps.
    fn kept_maps(&self, st: &State) -> Vec<(String, Row)> {
        let mut kept: Vec<(&Place, String)> = self.store.kept_sessions().into_iter().filter_map(|id| Some((st.maps.key(&id)?, id))).collect();
        kept.sort();
        kept.into_iter().filter_map(|(_, id)| Some((id.clone(), st.map(&id)?.clone()))).collect()
    }

    /// `sweepGoneRows` (`gone-rows.mjs:107-115`, `:162-200`, a maintenance step of `agent-tool.mjs:207`): a kept row of a
    /// deleted session, whoever owns it, leaves once settled: terminal, no restart failure still owed, past the settled
    /// retention, no live work.
    fn gone_rows(&self, st: &State, stale: &[Row]) -> Vec<Row> {
        let now = self.now();
        let reap = self.reap_ms();
        self.kept_maps(st)
            .into_iter()
            .filter_map(|(id, map)| st.row(&id, &map, now))
            .filter(|row| {
                !is_lead_pool_agent(row.get("agent"))
                    && is_terminal_row(row)
                    && !is_unnotified_restart_failure(row)
                    && past_settled_retention(&reap, row, now)
                    && !self.live.has_live_work(&clean(row.get("sessionId")))
                    && !stale.iter().any(|kept| kept.get("sessionId") == row.get("sessionId"))
            })
            .collect()
    }

    /// A kept map (a deleted session's) that holds no row and no live release any more, only a tombstone past the TTL or beyond
    /// the newest `MAX_TAG_TOMBSTONES`, leaves the kept table: Node rewrites its index file with only those tombstones
    /// (`worker-rows.mjs:7`, `:96-102`).
    fn drop_expired_kept(&self, st: &mut State) {
        let now = self.now();
        let candidates: Vec<String> =
            self.kept_maps(st).into_iter().filter(|(_, map)| clean(map.get("sessionId")).is_empty() && !released_at(map, now)).map(|(id, _)| id).collect();
        if candidates.is_empty() {
            return;
        }
        let live: HashSet<String> = st.stored_tombstones(now).iter().map(|t| clean(t.get("sessionId"))).collect();
        for id in candidates.into_iter().filter(|id| !live.contains(id)) {
            self.persist(st, &id, None);
        }
    }

    /// `refreshTagsFromSessions` over the index as loaded.
    fn refresh(&self, st: &mut State, scan_sessions: bool, scope: &Scope) {
        self.rearm.notify_waiters();
        self.resolve_owners(st);
        self.transition_stale(st, scope);
        self.drop_expired_kept(st);
        let now = self.now();
        for row in st.rows_to_bind(scope, now) {
            #[cfg(any(test, feature = "test-support"))]
            work::note(|c| c.rows_visited += 1);
            st.bind(&clean(row.get("tag")), &clean(row.get("sessionId")), &clean(row.get("agent")), &clean(row.get("cwd")));
        }
        st.bound(scope, now);
        // The unbinding pass: a tag the scope's rows do not hold goes when its session is gone or
        // the scan guard blocks it. Only a tag whose kept facts say so, or whose session is
        // loaded, can.
        let pass = self.tag_pass(st, now);
        for tag in self.unbind_candidates(st, &pass, scope, now) {
            let Some(id) = st.tag(&tag).cloned() else { continue };
            if st.holds_key(scope, &tag, &id, now) {
                continue;
            }
            if self.facts_of(st, &pass, &tag, &id, now).unbinds() {
                st.unbind(&tag);
            }
        }
        if scan_sessions {
            let open = self.list_sessions(st, false);
            self.scan_listed(st, open.iter().map(|session| &**session), scope);
        }
    }

    /// The scan of [`Self::refresh`] over `open`, the agent sessions not closed as one listing holds them: each in the
    /// scope whose tag nothing binds is bound, unless a tombstone blocks it.
    fn scan_listed<'a>(&self, st: &mut State, open: impl IntoIterator<Item = &'a Row>, scope: &Scope) {
        let by_key = st.tombstone_index(self.now());
        for session in open {
            if is_lead_pool_agent(session.get("agent")) {
                continue;
            }
            let tag = agent_tag_of(session);
            if tag.is_empty() || st.tag(&tag).is_some() || !matches_scope(session, scope) || self.blocks_scan(st, session, &tag, &by_key) {
                continue;
            }
            let id = clean(session.get("id"));
            st.bind(&tag, &id, &clean(session.get("agent")), &clean(session.get("cwd")));
            self.scan_upsert(st, session, &tag, &by_key);
        }
    }

    /// `refreshTagsFromSessions({ memoryOnly: true })` (the status pulse, tag-refresh.mjs:19-22): the index is read and its rows bind
    /// their tags; nothing is reaped, unbound or scanned, which the maintenance pass and the tool calls do.
    pub async fn refresh_tags_from_index(&self, scope: &Scope) -> Result<(), String> {
        self.reload().await?;
        let mut st = self.lock();
        let now = self.now();
        for row in st.rows(scope, now) {
            st.bind(&clean(row.get("tag")), &clean(row.get("sessionId")), &clean(row.get("agent")), &clean(row.get("cwd")));
        }
        Ok(())
    }

    /// `agentSessionEntries` for the views (list and status keep terminal traces), over the
    /// index as last refreshed.
    pub async fn session_entries(&self, scan_sessions: bool, scope: &Scope) -> Vec<(String, Arc<Row>)> {
        let reads = self.read_index_or_held(scan_sessions, &[]).await;
        let mut st = self.op(reads);
        self.entries(&mut st, scan_sessions, scope, false)
    }

    /// What the agent status lists for `scope` (`agentSessionEntries` as `statusFor` reads it, after
    /// `refresh_tags_from_sessions`): the entries of [`Self::session_entries`] in their order, less
    /// the rows whose own state is not active (`isActiveWorkerRow`, which the status applies to
    /// every entry). A caller scope reads only the rows a write changed and the tags that can list
    /// a session for it.
    pub fn status_entries(&self, scope: &Scope) -> Vec<(String, Arc<Row>)> {
        let Some(caller) = scope.caller_session_id.clone() else {
            let mut st = self.lock();
            return self.entries(&mut st, false, scope, false);
        };
        let st = self.lock();
        let now = self.now();
        let mut out: Vec<(String, Arc<Row>)> = st.active_listed(scope, now).into_iter().map(|listed| (listed.tag, listed.session)).collect();
        let pass = self.tag_pass(&st, now);
        let mut added: HashSet<String> = HashSet::new();
        for tag in self.listing_candidates(&st, &pass, &caller, now) {
            let Some(id) = st.tag(&tag).cloned() else { continue };
            if added.contains(&id) || st.lists_row(scope, &id, now) {
                continue;
            }
            let Some(session) = self.listing_session(&st, &pass, &tag, &id, scope, now) else { continue };
            let Some((listed_tag, sid)) = listable(&session, &tag, scope) else { continue };
            if st.lists_row(scope, &sid, now) || !added.insert(sid) {
                continue;
            }
            out.push((listed_tag, session));
        }
        out
    }

    /// `agentSessionEntries`: the tag-bound sessions visible in `scope`, as `(tag, session)`.
    fn entries(&self, st: &mut State, scan_sessions: bool, scope: &Scope, exclude_terminal_traces: bool) -> Vec<(String, Arc<Row>)> {
        let now = self.now();
        let by_key = st.tombstone_index(now);
        let mut out: Vec<(String, Arc<Row>)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let add = |out: &mut Vec<(String, Arc<Row>)>, seen: &mut HashSet<String>, session: &Arc<Row>, fallback: &str| {
            let Some((tag, id)) = listable(session, fallback, scope) else { return };
            if seen.insert(id) {
                out.push((tag, session.clone()));
            }
        };
        let rows = st.rows(scope, now);
        for listed in rows.listed() {
            let row = &listed.row;
            let id = clean(row.get("sessionId"));
            if listed.tag.is_empty() || id.is_empty() || is_lead_pool_agent(row.get("agent")) || seen.contains(&id) {
                continue;
            }
            if exclude_terminal_traces && is_terminal_row(row) && self.live_session_row(st, &id).is_none() {
                continue;
            }
            seen.insert(id);
            out.push((listed.tag.clone(), listed.session.clone()));
        }
        if scan_sessions {
            for session in self.list_sessions(st, false) {
                let tag = agent_tag_of(&session);
                if !tag.is_empty() && self.blocks_scan(st, &session, &tag, &by_key) {
                    continue;
                }
                add(&mut out, &mut seen, &session, &tag);
                if !tag.is_empty() {
                    self.scan_upsert(st, &session, &tag, &by_key);
                }
            }
        }
        match scope.caller_session_id.as_deref().filter(|_| !scan_sessions) {
            // Only a tag whose kept facts list a session for the caller, or whose session is
            // loaded, can add one.
            Some(caller) => {
                let pass = self.tag_pass(st, now);
                for tag in self.listing_candidates(st, &pass, caller, now) {
                    let Some(id) = st.tag(&tag).cloned() else { continue };
                    if seen.contains(&id) {
                        continue;
                    }
                    let Some(session) = self.listing_session(st, &pass, &tag, &id, scope, now) else { continue };
                    add(&mut out, &mut seen, &session, &tag);
                }
            }
            None => {
                let tags: Vec<(String, String)> = st.tags.iter().map(|(tag, id)| (tag.clone(), id.clone())).collect();
                for (tag, id) in tags {
                    #[cfg(any(test, feature = "test-support"))]
                    work::note(|c| c.tags_visited += 1);
                    if seen.contains(&id) {
                        continue;
                    }
                    let Some(session) = self.live_session_row(st, &id) else { continue };
                    if self.blocks_scan(st, &session, &tag, &by_key) {
                        continue;
                    }
                    add(&mut out, &mut seen, &session, &tag);
                }
            }
        }
        out
    }

    fn resolve(&self, st: &mut State, target: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        let value = clean_str(target);
        if options.skip_released
            && let Some(id) = st.tag(&value).cloned()
            && st.map(&id).is_some_and(|map| released_at(map, self.now()))
        {
            // Bound again by an earlier scan: the closed session gives the tag up (its release marker stays).
            st.unbind_if_owned(&value, &id);
            self.remove_row(st, &id);
        }
        st.skip_released = options.skip_released;
        let outcome = self.resolve_bound(st, target, scope, options);
        st.skip_released = false;
        outcome
    }

    fn resolve_bound(&self, st: &mut State, target: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        self.refresh(st, options.scan_sessions, scope);
        let value = clean_str(target);
        if value.is_empty() {
            return Ok(None);
        }
        if value.starts_with("sess_") {
            if self.live_session_row(st, &value).is_some_and(|s| matches_scope(&s, scope)) {
                return Ok(Some(value));
            }
            let indexed = st.rows(scope, self.now()).iter().any(|row| clean(row.get("sessionId")) == value);
            return Ok(indexed.then_some(value));
        }
        let found: Vec<Arc<Row>> = self
            .entries(st, options.scan_sessions, scope, options.exclude_terminal_traces)
            .into_iter()
            .filter(|(tag, _)| *tag == value)
            .map(|(_, session)| session)
            .collect();
        // A session its owner closed yields the tag to an open session of the same owner (the owner's new agent under
        // it); another owner's session never does.
        let released = |session: &Row| st.map(&clean(session.get("id"))).is_some_and(|map| released_at(map, self.now()));
        let matches: Vec<String> = found
            .iter()
            .filter(|session| !released(session) || !found.iter().any(|other| !released(other) && same_owner(other, session)))
            .map(|session| clean(session.get("id")))
            .collect();
        match matches.as_slice() {
            [one] => return Ok(Some(one.clone())),
            [] => {}
            _ => return Err(format!("agent: tag \"{value}\" is ambiguous across terminals; use sessionId")),
        }
        let Some(id) = st.tag(&value).cloned() else { return Ok(None) };
        Ok(self.live_session_row(st, &id).filter(|s| matches_scope(s, scope)).map(|_| id))
    }

    /// `ownedTagSession`.
    fn owned_tag_session(session: &Row, tag: &str, scope: &Scope) -> bool {
        !clean(session.get("id")).is_empty() && agent_tag_of(session) == tag && !is_lead_pool_agent(session.get("agent")) && matches_scope(session, scope)
    }

    /// `agentDescendantSessionIds`: every agent session below `session`, depth first, each once, over one listing of the
    /// index; `Err` when it could not be read.
    pub(crate) async fn descendants(&self, session: &str) -> Result<Vec<String>, String> {
        let reads = self.read_index(true, &[]).await?;
        let st = self.op(reads);
        Ok(Tree::of(self.list_sessions(&st, true).iter().map(|s| &**s)).below(&clean_str(session)))
    }

    /// A cancel of the tree under `root` (`cancelAgentTree`): `root` and every agent session the loaded sessions and the held
    /// rows link below it refuse admission before the index is read, and the rest of the tree once one listing of it is.
    /// The guard, with the tree or why the index could not be read.
    pub(crate) async fn cancel_tree(self: &Arc<Self>, root: &str) -> (CancelScope, Result<Tree, String>) {
        let root = clean_str(root);
        let known: HashSet<String> = {
            let st = self.lock();
            let loaded: Vec<Arc<Row>> = self.live.loaded().iter().filter_map(|id| self.loaded_session(id)).collect();
            let tree = Tree::of(loaded.iter().map(|s| &**s).chain(st.held.values().flatten().map(|s| &**s)));
            std::iter::once(root.clone()).chain(tree.below(&root)).collect()
        };
        let mut guard = self.begin_cancellation(&known.iter().cloned().collect::<Vec<_>>());
        let tree = match self.read_index(true, &[]).await {
            Ok(reads) => {
                let st = self.op(reads);
                Tree::of(self.list_sessions(&st, true).iter().map(|s| &**s))
            }
            Err(error) => return (guard, Err(error)),
        };
        let rest: Vec<String> = tree.below(&root).into_iter().filter(|id| !known.contains(id)).collect();
        guard.extend(&rest);
        (guard, Ok(tree))
    }

    /// The session a dispatch runs a turn on stands for a live agent while the dispatch lasts: its list row is read now
    /// when the registry does not hold it, so the turn's row writes, which its events make with nothing to await, find the
    /// session loaded or held ([`Self::held_session_of`]).
    pub(super) async fn pin(&self, id: &str) -> Pinned {
        let id = clean_str(id);
        let pins = self.lock().pins.clone();
        if !id.is_empty() {
            *pins.lock().unwrap_or_else(|p| p.into_inner()).entry(id.clone()).or_insert(0) += 1;
        }
        let pinned = Pinned { pins, id: id.clone() };
        if id.is_empty() || self.lock().held.contains_key(&id) {
            return pinned;
        }
        match self.store.agent_session(&id).await {
            Ok(row) => {
                let mut st = self.lock();
                if !st.held.contains_key(&id) {
                    st.hold([(id, row.map(Arc::new))]);
                }
            }
            Err(error) => tracing::warn!("[agent] the agent session {id} could not be read from the index: {error}"),
        }
        pinned
    }

    /// A cleanup's reading of `listed`, every agent session as one listing holds them: the links [`Self::descendants`]
    /// follows, the sessions listed (those [`Self::session_of`] finds), the open Lead sessions and the open sessions.
    fn topology_of(listed: &[Arc<Row>]) -> Topology {
        let mut topology = Topology::default();
        for session in listed {
            let id = clean(session.get("id"));
            if id.is_empty() {
                continue;
            }
            if let Some((parent, child)) = parent_link(session) {
                topology.children.entry(parent).or_default().push(child);
            }
            if session.get("closed") != Some(&Value::Bool(true)) {
                if is_lead_pool_agent(session.get("agent")) {
                    topology.leads.insert(id.clone());
                }
                topology.open.push(sessions::open_session(session));
            }
            topology.present.insert(id);
        }
        topology
    }

    /// `terminalWorkerRowForTag`.
    fn terminal_row_for_tag(&self, st: &State, tag: &str, scope: &Scope) -> Option<Row> {
        let value = clean_str(tag);
        if value.is_empty() {
            return None;
        }
        st.rows(scope, self.now())
            .iter()
            .find(|row| clean(row.get("tag")) == value && is_terminal_row(row) && self.live_session_row(st, &clean(row.get("sessionId"))).is_none())
            .cloned()
    }
}

/// The agent sessions as one listing links them: each session's children by their `parentSessionId || ownerSessionId`, in
/// the listing's order.
pub(crate) struct Tree(HashMap<String, Vec<String>>);

impl Tree {
    fn of<'a>(sessions: impl IntoIterator<Item = &'a Row>) -> Self {
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        for session in sessions {
            if let Some((parent, id)) = parent_link(session) {
                children.entry(parent).or_default().push(id);
            }
        }
        Self(children)
    }

    /// The sessions linked directly below `parent` (`registry.childrenOf`).
    pub(crate) fn children(&self, parent: &str) -> &[String] {
        self.0.get(parent).map_or(&[], Vec::as_slice)
    }

    /// Every session below `root`, depth first, each once (`agentDescendantSessionIds`).
    fn below(&self, root: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack = vec![(root.to_owned(), 0usize)];
        while let Some((parent, at)) = stack.pop() {
            let Some(next) = self.0.get(&parent).and_then(|c| c.get(at)) else { continue };
            stack.push((parent, at + 1));
            if seen.insert(next.clone()) {
                out.push(next.clone());
                stack.push((next.clone(), 0));
            }
        }
        out
    }

    /// `root` and every session below it, each once, descendants first (`cancelAgentTree`'s order).
    pub(crate) fn descendants_first(&self, root: &str) -> Vec<String> {
        let mut ordered = Vec::new();
        mixdog_agent::agent_tool::dispatch::visit_descendants_first(&|id| self.children(id).to_vec(), root, &mut HashSet::new(), &mut ordered);
        ordered
    }
}

/// A dispatch's hold on the session it runs a turn on ([`AgentRegistry::pin`]): the registry holds the session's row until
/// it drops.
pub struct Pinned {
    pins: Arc<Mutex<HashMap<String, usize>>>,
    id: String,
}

impl Drop for Pinned {
    fn drop(&mut self) {
        let mut pins = self.pins.lock().unwrap_or_else(|p| p.into_inner());
        let left = pins.get(&self.id).map_or(0, |count| count.saturating_sub(1));
        if left > 0 {
            pins.insert(self.id.clone(), left);
        } else {
            pins.remove(&self.id);
        }
    }
}

/// `(parent, id)` of a session linked below another by its `parentSessionId || ownerSessionId`.
fn parent_link(session: &Row) -> Option<(String, String)> {
    let id = clean(session.get("id"));
    let parent = clean(either(session, "parentSessionId", "ownerSessionId"));
    (!id.is_empty() && !parent.is_empty() && parent != id).then_some((parent, id))
}

/// Whether two sessions have the same owner, by the identity the scope rules use (`Scope::owns`): the owner session where
/// one is named, else the host process. Sessions with no owner identity at all are never the same owner, and a
/// session-owned one is never the same owner as one only a host process owns.
fn same_owner(a: &Row, b: &Row) -> bool {
    let (a, b) = (owner_of(a), owner_of(b));
    let held = |o: &mixdog_agent::agent_tool::scope::Owner| {
        clean_str(if clean_str(&o.parent_session_id).is_empty() { &o.owner_session_id } else { &o.parent_session_id })
    };
    let (held_a, held_b) = (held(&a), held(&b));
    if !held_a.is_empty() || !held_b.is_empty() {
        return held_a == held_b;
    }
    matches!((a.client_host_pid, b.client_host_pid), (Some(x), Some(y)) if x == y)
}

fn mark_of(map: &Row) -> TurnMark {
    TurnMark { started: map.get("startedTurns").and_then(Value::as_u64).unwrap_or(0), last: map.get("countedTurn").and_then(Value::as_str).map(str::to_owned) }
}

impl AgentRegistry {
    /// `forget_terminal_session` of `root`, `remove_worker_row` of each descendant and `mark_released` of them all, each
    /// map written once. With `at`, a member is released at its start gate and only while its turn is still the one `at`
    /// names: a turn either started first and the member keeps its row, or starts on a released session. Answers those
    /// released, each with the receipt of its own write, and those spared, each with why.
    fn release(&self, scope: &Scope, tag: Option<&str>, root: &str, descendants: &[String], at: Option<&HashMap<String, Option<TurnMark>>>) -> Released {
        let (root, tag) = (clean_str(root), clean_str(tag.unwrap_or_default()));
        let now = self.now();
        let stamp = Value::String(iso(now));
        let mut released = Released::default();
        for id in std::iter::once(root.clone()).chain(descendants.iter().map(|id| clean_str(id))).filter(|id| !id.is_empty()) {
            let mut decided = None;
            let mut one = || {
                let one = self.release_one(scope, &id, &root, &tag, &stamp, now, at.and_then(|at| at.get(&id)));
                let done = one.is_ok();
                decided = Some(one);
                done
            };
            if at.is_some() {
                self.live.while_idle(&id, &mut one);
            } else {
                one();
            }
            match decided {
                Some(Ok(release)) => released.releases.push(release),
                Some(Err(reason)) => released.spared.push(Spared { session_id: id, reason: reason.to_owned() }),
                // A run stood at the member's start gate: nothing was asked of it.
                None => released.spared.push(Spared { session_id: id, reason: SPARED_TURN.to_owned() }),
            }
        }
        released
    }

    /// One member's release, under the one lock. What may spare it is asked first, before anything of it changes: its
    /// turn, and the identity its store holds of it ([`WorkerStore::bound`]); a member spared keeps its tag, its map,
    /// its revision and its held release as they were, and is answered with why. Then its revision is assigned and
    /// the exact write queued: bound to that incarnation and under an identity of its own, so the handle answers for
    /// this write and no other of the session. The map it is decided on is fixed here, under this lock, and never read
    /// again: the map this registry holds of the session, which already counts the writes queued ahead of the release
    /// (so the row written just before a close's release is what the release expects when it is put), unless the
    /// store has a record of what the target really holds because the session's last write was not stored
    /// ([`Bound::holds`]). The release is then a compare-and-set on it. It is held, until stored,
    /// superseded or replaced, with `scope`: the scope entitled to release the tree at its root, which is what recovers
    /// it, not the member's own owner.
    #[allow(clippy::too_many_arguments)]
    fn release_one(
        &self,
        scope: &Scope,
        id: &str,
        root: &str,
        tag: &str,
        stamp: &Value,
        now: f64,
        mark: Option<&Option<TurnMark>>,
    ) -> Result<Release, &'static str> {
        let mut st = self.lock();
        let turn = st.map(id).map(mark_of);
        if mark.is_some_and(|mark| turn != *mark) {
            return Err(SPARED_TURN);
        }
        let Some(Bound { target, incarnation, holds }) = self.store.bound(id).filter(|bound| !bound.incarnation.is_empty()) else {
            return Err(SPARED_IDENTITY);
        };
        let prior = holds.unwrap_or_else(|| st.map(id).cloned());
        let unbound = id == root && !tag.is_empty() && st.tag(tag).is_some_and(|bound| bound == root);
        if id == root {
            st.unbind_if_owned(tag, root);
        }
        // The write's base is the map it expects, whichever that is: what the release leaves is that map released, so
        // nothing the target holds and this registry's map lacks (a newer tombstone) is written away.
        let map = prior.clone();
        let row = map.as_ref().and_then(|map| st.row(id, map, now));
        let removable = row.as_ref().is_some_and(|row| !is_unnotified_restart_failure(row));
        let mut left = match map {
            Some(map) if removable => without_row(&map).unwrap_or_default(),
            other => other.unwrap_or_default(),
        };
        left.insert("releasedAt".into(), stamp.clone());
        let revision = self.persisted(&mut st, id, &Some(left.clone()));
        let receipt = ReleaseReceipt {
            session_id: id.to_owned(),
            incarnation,
            prior,
            operation: format!("worker-release:{}", uuid::Uuid::new_v4().simple()),
            tag: unbound.then(|| tag.to_owned()),
            turn,
            revision,
            target,
            released: left,
        };
        let done = self.store.release(&receipt, false);
        st.releases.retain(|_, held| !settled(&held.done));
        st.releases.insert(id.to_owned(), Unstored { receipt: receipt.clone(), scope: scope.clone(), done: done.clone() });
        drop(st);
        self.rearm.notify_waiters();
        Ok(Release { receipt, done })
    }
}

/// Why a member was spared: a turn started on it since its close was decided.
const SPARED_TURN: &str = "started another turn during the cleanup";
/// Why a member was spared: its store can tell no identity of its session, so no release could be bound to it.
const SPARED_IDENTITY: &str = "was not released: the identity of its session is not known";

/// Whether a release needs nothing more: it is stored, or it is superseded and never will be.
fn settled(done: &ReleaseDone) -> bool {
    matches!(done.now(), Some(ReleaseOutcome::Stored | ReleaseOutcome::Superseded(_)))
}

#[async_trait]
impl Registry for AgentRegistry {
    async fn resolve_tombstone_owners(&self) {
        // A listing that could not be read resolves nothing: the next refresh reads it again.
        let reads = match self.read_index(self.owners_owed(), &[]).await {
            Ok(reads) => reads,
            Err(error) => {
                tracing::warn!("[agent] the agent sessions could not be read from the index: {error}");
                return;
            }
        };
        let mut st = self.op(reads);
        self.resolve_owners(&mut st);
    }

    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, scope: &Scope) -> Result<(), String> {
        self.reload().await?;
        let reads = self.read_index(scan_sessions || self.owners_owed(), &[]).await?;
        let mut st = self.op(reads);
        self.refresh(&mut st, scan_sessions, scope);
        Ok(())
    }

    /// The registry's admission of a spawn: one at a time, the index read whole for it (a failed read ends it), the tag
    /// judged against that view and the tags reserved by spawns not yet bound, and reserved in turn.
    async fn claim_tag(&self, explicit: &str, scope: &Scope, options: ResolveOptions, next: &(dyn Fn() -> String + Sync)) -> Result<TagClaim, String> {
        let _admitted = self.spawn_admission.lock().await;
        self.reload().await?;
        let explicit_id = clean_str(explicit);
        let ids: Vec<&str> = if explicit_id.starts_with("sess_") { vec![explicit_id.as_str()] } else { Vec::new() };
        let reads = self.read_index(options.scan_sessions || self.owners_owed(), &ids).await?;
        {
            let mut st = self.op(reads.clone());
            self.refresh(&mut st, false, scope);
        }
        // A tag another path bound since `next` named it is passed over; an explicit one is refused.
        for _ in 0..8 {
            let tag = if explicit.is_empty() { next() } else { explicit.to_owned() };
            let mut st = self.op(reads.clone());
            let bound = self.resolve(&mut st, &tag, scope, options)?.is_some();
            let mut claimed = self.claimed.lock().unwrap_or_else(|p| p.into_inner());
            if !bound && claimed.insert(tag.clone()) {
                let held = Claimed { claimed: self.claimed.clone(), tag: tag.clone() };
                return Ok(TagClaim::new(tag, Some(Box::new(held))));
            }
            if !explicit.is_empty() {
                return Err(format!("agent spawn: tag \"{tag}\" already exists"));
            }
        }
        Err("agent spawn: no free tag could be taken".to_owned())
    }

    /// The refresh and the cleanup's reading from one listing of the sessions: its scan reads the open ones of it. The
    /// signals of every session it writes (a stale row's tombstone, a recovered row) are held in what it answers.
    async fn refresh_topology(&self, scan_sessions: bool, scope: &Scope) -> Result<(Topology, Recovered), String> {
        self.reload().await?;
        let reads = self.read_index(true, &[]).await?;
        let mut st = self.op(reads);
        st.holding = Some(Holding::default());
        self.refresh(&mut st, false, scope);
        let listed = self.list_sessions(&st, true);
        if scan_sessions {
            let open = listed.iter().map(|session| &**session).filter(|session| session.get("closed") != Some(&Value::Bool(true)));
            self.scan_listed(&mut st, open, scope);
        }
        Ok((Self::topology_of(&listed), st.holding.take().unwrap_or_default().recovered))
    }

    /// The count `pool_docs` keeps on the worker map of each turn started on it, and the id of the last it counted.
    fn turn_mark(&self, session_id: &str) -> Option<TurnMark> {
        self.lock().map(&clean_str(session_id)).map(mark_of)
    }

    async fn resolve_tag(&self, tag: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        let value = clean_str(tag);
        let ids: Vec<&str> = if value.starts_with("sess_") { vec![value.as_str()] } else { Vec::new() };
        let reads = self.read_index(options.scan_sessions || self.owners_owed(), &ids).await?;
        let mut st = self.op(reads);
        self.resolve(&mut st, tag, scope, options)
    }

    async fn live_session(&self, session_id: &str) -> Option<SessionFacts> {
        let reads = self.read_index_or_held(false, &[session_id]).await;
        let st = self.op(reads);
        self.live_session_row(&st, session_id).map(|s| session_facts(&s))
    }

    fn tag_session(&self, tag: &str) -> Option<String> {
        self.lock().tag(tag).cloned()
    }

    fn has_tag_agent(&self, tag: &str) -> bool {
        self.lock().tag_agents.contains_key(tag)
    }

    async fn tag_for_session(&self, session_id: &str) -> Option<String> {
        let reads = self.read_index_or_held(false, &[session_id]).await;
        let st = self.op(reads);
        self.tag_of(&st, session_id)
    }

    fn unbind_tag(&self, tag: &str) {
        self.lock().unbind(tag);
    }

    /// `bindTag(tag, session, {turnStartedAt})`.
    async fn bind_tag(&self, tag: &str, session: &SessionFacts, turn_started_at: &str) {
        if tag.is_empty() || session.id.is_empty() {
            return;
        }
        let reads = self.read_index_or_held(false, &[&session.id]).await;
        let mut st = self.op(reads);
        st.bind(tag, &session.id, &session.agent, &session.cwd);
        let mut row = self.session(&st, &session.id).map(|row| Row::clone(&row)).unwrap_or_default();
        row.insert("id".into(), Value::String(session.id.clone()));
        let set = |row: &mut Row, key: &str, value: &str| {
            if !value.is_empty() {
                row.insert(key.into(), Value::String(value.to_owned()));
            }
        };
        set(&mut row, "agent", &session.agent);
        set(&mut row, "cwd", &session.cwd);
        set(&mut row, "parentSessionId", &session.owner.parent_session_id);
        set(&mut row, "ownerSessionId", &session.owner.owner_session_id);
        if let Some(pid) = session.owner.client_host_pid {
            row.insert("clientHostPid".into(), Value::from(pid));
        }
        let mut extra = Row::new();
        extra.insert("turnStartedAt".into(), Value::String(turn_started_at.to_owned()));
        self.upsert_session(&mut st, &row, tag, &extra);
    }

    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str) {
        let id = clean_str(session_id);
        let mut st = self.lock();
        st.unbind_if_owned(&clean_str(tag.unwrap_or_default()), &id);
        if !id.is_empty() {
            self.remove_row(&mut st, &id);
        }
    }

    fn remove_worker_row(&self, session_id: &str) {
        let id = clean_str(session_id);
        if id.is_empty() {
            return;
        }
        let mut st = self.lock();
        self.remove_row(&mut st, &id);
    }

    /// `markReleased`: `releasedAt` on each session; a turn starting on it removes it.
    fn mark_released(&self, session_ids: &[String]) {
        let at = Value::String(iso(self.now()));
        let mut st = self.lock();
        for id in session_ids.iter().map(|id| clean_str(id)).filter(|id| !id.is_empty()) {
            let mut map = st.map(&id).cloned().unwrap_or_default();
            map.insert("releasedAt".into(), at.clone());
            self.persist(&mut st, &id, Some(map));
        }
    }

    fn is_released(&self, session_id: &str) -> bool {
        let st = self.lock();
        st.map(&clean_str(session_id)).is_some_and(|map| released_at(map, self.now()))
    }

    fn worker_row(&self, session_id: &str) -> Option<TagRecord> {
        let st = self.lock();
        st.indexed_row(&clean_str(session_id), self.now()).map(|row| tag_record(&row, "tag", "sessionId"))
    }

    /// `forget_terminal_session`, `remove_worker_row` of each descendant and `mark_released` of them all, each map
    /// written once. With `at`, decided under the lock a turn's start counts itself under: a member's turn either
    /// started first and it is kept, or starts on a released session, which a start on any closed agent resumes.
    fn release_closed_at(
        &self,
        scope: &Scope,
        tag: Option<&str>,
        root: &str,
        descendants: &[String],
        at: Option<&HashMap<String, Option<TurnMark>>>,
    ) -> Released {
        self.release(scope, tag, root, descendants, at)
    }

    /// Each release made under `scope` that was answered neither stored nor superseded is submitted again as the
    /// operation it was: the receipt it was decided with goes back unchanged (its identity, incarnation, precondition,
    /// map and release stamp), and its target answers by that operation's own committed record or, when it is known
    /// not to have committed and its incarnation and precondition still hold, writes it.
    ///
    /// Nothing is rebound. A session whose store now names another target or another identity than the receipt's is
    /// not the one the release was decided for: the release is dropped unsuccessful, and is neither sent to the
    /// session's present journal nor turned into a kept row's. One whose map was written since is dropped too: the
    /// session's newer state is what its own writes store. One whose store can tell no identity now is left held. An
    /// unanswered one is left to its handle.
    fn recover_releases(&self, scope: &Scope) -> Vec<Release> {
        let mut st = self.lock();
        st.releases.retain(|_, held| !settled(&held.done));
        let due: Vec<String> =
            st.releases.iter().filter(|(_, held)| held.done.now().is_some() && recovers(scope, &held.scope)).map(|(id, _)| id.clone()).collect();
        let mut again = Vec::new();
        for id in due {
            let Some(receipt) = st.releases.get(&id).map(|held| held.receipt.clone()) else { continue };
            let Some(bound) = self.store.bound(&id) else { continue };
            if st.map(&id) != Some(&receipt.released) || bound.target != receipt.target || bound.incarnation != receipt.incarnation {
                st.releases.remove(&id);
                continue;
            }
            let done = self.store.release(&receipt, true);
            if let Some(held) = st.releases.get_mut(&id) {
                held.done = done.clone();
            }
            again.push(Release { receipt, done });
        }
        again
    }

    fn read_worker_rows(&self, scope: &Scope) -> Result<Vec<TagRecord>, String> {
        let st = self.lock();
        Ok(st.rows(scope, self.now()).iter().map(|row| tag_record(row, "tag", "sessionId")).collect())
    }

    fn bound_sessions(&self) -> Vec<String> {
        self.lock().tags.iter().map(|(_, session)| session.clone()).collect()
    }

    fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
        let st = self.lock();
        st.tombstones(self.now()).iter().map(|row| tag_record(row, "tag", "sessionId")).collect()
    }

    fn tag_tombstone_for_tag(&self, tag: &str, scope: &Scope) -> Option<TagRecord> {
        let value = clean_str(tag);
        if value.is_empty() || value.starts_with("sess_") {
            return None;
        }
        let st = self.lock();
        st.tombstones(self.now()).iter().find(|row| matches_scope(row, scope) && clean(row.get("tag")) == value).map(|row| tag_record(row, "tag", "sessionId"))
    }

    /// `consumeTagTombstone`: the tombstone of the record's key goes, and an owner-less twin of
    /// it that was not replaced since.
    fn consume_tag_tombstone(&self, tombstone: &TagRecord) {
        if tombstone.tag.is_empty() {
            return;
        }
        let mut record = Row::new();
        record.insert("tag".into(), Value::String(tombstone.tag.clone()));
        record.insert("parentSessionId".into(), Value::String(tombstone.owner.parent_session_id.clone()));
        record.insert("ownerSessionId".into(), Value::String(tombstone.owner.owner_session_id.clone()));
        record.insert("clientHostPid".into(), tombstone.owner.client_host_pid.map_or(Value::Null, Value::from));
        let key = tombstone_key(&record);
        let mut st = self.lock();
        let now = self.now();
        let reaped_at = st
            .tombstones(now)
            .iter()
            .find(|t| tombstone_key(t) == key && clean(t.get("sessionId")) == tombstone.session_id)
            .and_then(|t| t.get("reapedAt").cloned());
        let mut legacy = Row::new();
        legacy.insert("tag".into(), record["tag"].clone());
        legacy.insert("clientHostPid".into(), record["clientHostPid"].clone());
        let legacy_key = tombstone_key(&legacy);
        let session = tombstone.session_id.clone();
        self.drop_tombstones(&mut st, |_, t| {
            if tombstone_key(t) == key {
                return true;
            }
            legacy_key != key
                && tombstone_key(t) == legacy_key
                && is_legacy(t)
                && t.get("reapedAt") == reaped_at.as_ref()
                && (clean(t.get("sessionId")).is_empty() || clean(t.get("sessionId")) == session)
        });
    }

    async fn last_tag_session(&self, tag: &str, scope: &Scope) -> Option<TagRecord> {
        let value = clean_str(tag);
        let caller = scope.caller_session_id.as_deref().map(clean_str).unwrap_or_default();
        if value.is_empty() || value.starts_with("sess_") || caller.is_empty() {
            return None;
        }
        let reads = self.read_index_or_held(true, &[]).await;
        let st = self.op(reads);
        let mut newest: Option<Arc<Row>> = None;
        for session in self.list_sessions(&st, true) {
            if !Self::owned_tag_session(&session, &value, scope) {
                continue;
            }
            if newest.as_ref().is_none_or(|n| stamp_ms(session.get("createdAt")) > stamp_ms(n.get("createdAt"))) {
                newest = Some(session);
            }
        }
        newest.map(|s| tag_record(&s, "agentTag", "id"))
    }

    async fn resumable_tag_session(&self, tag: &str, session_id: &str, scope: &Scope) -> Result<Option<Resumable>, String> {
        let value = clean_str(tag);
        let id = clean_str(session_id);
        if value.is_empty() || id.is_empty() {
            return Ok(None);
        }
        {
            let st = self.lock();
            if st.map(&id).is_some_and(|m| released_at(m, self.now())) {
                return Ok(None);
            }
        }
        // A header that could not be read is not a session that cannot be resumed: the caller would start a fresh one
        // under the tag of a session that is there.
        let record = match self.loaded_session(&id) {
            Some(header) => header,
            None => match self.store.header(&id).await? {
                Some(mut header) => {
                    header.insert("id".into(), Value::String(id.clone()));
                    Arc::new(header)
                }
                None => return Ok(None),
            },
        };
        let closed = record.get("closed") == Some(&Value::Bool(true)) || record.get("status").and_then(Value::as_str) == Some("closed");
        if closed || !resumable_after_reap(&record) || !Self::owned_tag_session(&record, &value, scope) {
            return Ok(None);
        }
        let session = {
            let reads = self.read_index(false, &[&id]).await?;
            let st = self.op(reads);
            match self.live_session_row(&st, &id).map(|s| session_facts(&s)) {
                Some(session) => session,
                None => return Ok(None),
            }
        };
        let cwd = clean(record.get("cwd"));
        Ok(Some(if self.store.is_directory(&cwd).await {
            Resumable { session: Some(session), missing_cwd: None }
        } else {
            Resumable { session: None, missing_cwd: Some(cwd) }
        }))
    }
}

#[async_trait]
impl TerminalTrace for AgentRegistry {
    /// `hasTerminalTrace`: a tag that resolves to a live session is reused, not a trace; an
    /// ambiguous tag is the resolver's error.
    async fn has_terminal_trace(&self, tag: &str, scope: &Scope) -> Result<bool, String> {
        let value = clean_str(tag);
        if value.is_empty() || value.starts_with("sess_") {
            return Ok(false);
        }
        let reads = self.read_index(self.owners_owed(), &[]).await?;
        let mut st = self.op(reads);
        let options = ResolveOptions { exclude_terminal_traces: true, skip_released: true, ..ResolveOptions::default() };
        if self.resolve(&mut st, &value, scope, options)?.is_some() {
            return Ok(false);
        }
        Ok(self.terminal_row_for_tag(&st, &value, scope).is_some())
    }

    async fn reap_terminal_trace_for_tag(&self, tag: &str, scope: &Scope) {
        let value = clean_str(tag);
        if value.is_empty() || value.starts_with("sess_") {
            return;
        }
        // A listing that could not be read leaves the legacy owners to a later refresh.
        let reads = self.read_index(self.owners_owed(), &[]).await.unwrap_or_else(|error| {
            tracing::warn!("[agent] the agent sessions could not be read from the index: {error}");
            Reads::default()
        });
        let mut st = self.op(reads);
        let Some(row) = self.terminal_row_for_tag(&st, &value, scope) else { return };
        self.refresh(&mut st, false, scope);
        let id = clean(row.get("sessionId"));
        st.unbind_if_owned(&value, &id);
        if !id.is_empty() {
            self.remove_row(&mut st, &id);
        }
    }
}

/// `onSessionTurnStart(store.clearReleased)`: a turn of any origin ends the owner's release. A worker's row counts the
/// turn here, where the session itself starts it: whether anything observes the session's turns does not matter.
impl super::TurnStarts for AgentRegistry {
    fn turn_started(&self, thread: &ThreadId, turn: &mixdog_core_api::ids::TurnId) {
        let id = thread.as_str();
        // `descriptor.parked = false`, `descriptor.status = 'running'` (`agent-tree/agent-turns.mjs`).
        self.set_parked(id, false);
        self.set_cancelled(id, false);
        {
            let mut st = self.lock();
            if let Some(mut map) = st.map(id).cloned() {
                let released = map.shift_remove("releasedAt").is_some();
                let counted = normalize_row(&map).is_some() && pool_docs::count_turn_start(&mut map, turn.as_str());
                if released || counted {
                    self.persist(&mut st, id, (!map.is_empty()).then_some(map));
                }
            }
        }
        // `turn-prepare.mjs:174`: a Lead's turn marks its pool row running (an agent's session writes none).
        self.upsert_lead_session(id, LeadTurn::Running);
    }

    /// `turn-settle.mjs:105`: a Lead's settled turn marks its pool row idle. A worker's row takes the turn's end here,
    /// where the session itself ends it: the pool lists an outcome by its row's finish, whether or not a listener that
    /// saw the turn start settles the row after it.
    fn turn_settled(&self, thread: &ThreadId) {
        let id = thread.as_str();
        {
            let mut st = self.lock();
            if let Some(mut map) = st.map(id).filter(|map| normalize_row(map).is_some()).cloned() {
                let ended = Value::String(iso(self.now()));
                map.insert("finishedAt".into(), ended.clone());
                map.insert("updatedAt".into(), ended);
                self.persist(&mut st, id, Some(map));
            }
        }
        self.upsert_lead_session(id, LeadTurn::Idle);
    }
}

impl LiveSessions for super::SessionDirectory {
    fn loaded(&self) -> Vec<String> {
        self.loaded_ids().into_iter().map(|id| id.as_str().to_owned()).collect()
    }

    fn header(&self, session: &str) -> Option<Row> {
        Some((**self.handle(&ThreadId::from(session))?.cell.header.load()).clone())
    }

    fn shared_header(&self, session: &str) -> Option<Arc<Row>> {
        Some(self.handle(&ThreadId::from(session))?.cell.header.load_full())
    }

    fn running(&self, session: &str) -> bool {
        self.handle(&ThreadId::from(session)).is_some_and(|h| h.cell.run.load().as_ref().is_some_and(|run| !run.cancel.is_aborted()))
    }

    fn while_idle(&self, session: &str, at: &mut dyn FnMut() -> bool) -> bool {
        super::SessionDirectory::while_idle(self, &ThreadId::from(session), || Some(at())).unwrap_or(false)
    }

    fn has_live_work(&self, session: &str) -> bool {
        self.running(session) || self.handle(&ThreadId::from(session)).is_some_and(|h| !h.cell.queued.load().is_empty())
    }

    fn runtime_stage(&self, session: &str) -> Option<String> {
        self.handle(&ThreadId::from(session))?.cell.progress.borrow().stage()
    }

    /// The registry reads a loaded session through `header`, `running` and `runtime_stage` alone; the header is published
    /// as a new `Arc` whenever it changes.
    fn stamp(&self, session: &str) -> Option<LiveStamp> {
        let handle = self.handle(&ThreadId::from(session))?;
        let header: Arc<dyn std::any::Any + Send + Sync> = handle.cell.header.load_full();
        Some(LiveStamp { header: Arc::downgrade(&header), running: self.running(session), stage: self.runtime_stage(session) })
    }
}

/// The tag and id a session lists under in `scope`: a tag-bound, open, non-Lead-pool agent session the scope matches; `fallback` is
/// the tag when the session names none.
fn listable(session: &Arc<Row>, fallback: &str, scope: &Scope) -> Option<(String, String)> {
    let tag = Some(agent_tag_of(session)).filter(|tag| !tag.is_empty()).unwrap_or_else(|| clean_str(fallback));
    let id = clean(session.get("id"));
    let open = session.get("closed") != Some(&Value::Bool(true));
    (!tag.is_empty() && !id.is_empty() && open && !is_lead_pool_agent(session.get("agent")) && matches_scope(session, scope)).then_some((tag, id))
}
