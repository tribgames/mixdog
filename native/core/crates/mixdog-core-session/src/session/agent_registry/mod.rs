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
pub use self::workers::AgentWorkers;
pub use self::world_rows::CancelScope;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use futures::StreamExt as _;
use mixdog_agent::agent_tool::host::Recovered;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::Release;
use mixdog_agent::agent_tool::host::ReleaseAnswer;
use mixdog_agent::agent_tool::host::ReleaseDone;
use mixdog_agent::agent_tool::host::ReleaseOutcome;
use mixdog_agent::agent_tool::host::ReleaseReceipt;
use mixdog_agent::agent_tool::host::ReleaseTarget;
use mixdog_agent::agent_tool::host::Released;
use mixdog_agent::agent_tool::host::ResolveOptions;
use mixdog_agent::agent_tool::host::Resumable;
use mixdog_agent::agent_tool::host::Spared;
use mixdog_agent::agent_tool::host::TerminalTrace;
use mixdog_agent::agent_tool::host::Topology;
use mixdog_agent::agent_tool::host::TurnMark;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_agent::agent_tool::scope::clean_str;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::TaskClass;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::worker::WorkerScope;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

pub use self::rows::Row;
use self::rows::*;
use self::views::Maps;
pub use self::views::Place;
use self::views::Tags;
use self::views::Views;
use super::Clock;
use mixdog_core_ports::ports::threads::Attempt;
use mixdog_core_ports::ports::threads::HeaderStored;
use mixdog_core_ports::ports::threads::HeaderWrite;
use mixdog_core_ports::ports::threads::ThreadState;

/// What a load of the stored index hands over, relative to the revision the registry holds.
pub enum Index {
    /// Nothing was written since the revision asked about.
    Unchanged,
    /// What was written since it: each session whose `worker` map changed, with its place in the index order and its map
    /// now (`None`: the index lists none), and each agent-only session that changed, with its place among them and its list
    /// row now (`None`: no longer listed).
    Delta { revision: Revision, maps: Vec<(String, Option<(Place, Row)>)>, sessions: Vec<(String, Option<(Place, Row)>)> },
    /// Every map and every agent-only session, each at its place; `revision` is what a later load asks the changes since of
    /// (`None`: the store keeps none).
    Full { revision: Option<Revision>, maps: Vec<(String, Place, Row)>, sessions: Vec<(Place, Row)> },
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
        let sessions = self.agent_sessions().await?.into_iter().enumerate().map(|(at, session)| (Place::At(at as i64), session)).collect();
        Ok(Index::Full { revision: None, maps, sessions })
    }
    /// The sessions whose map is a kept one.
    fn kept_sessions(&self) -> Vec<String> {
        Vec::new()
    }
    /// Every session's `worker` map, newest session first.
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String>;
    /// The agent-only sessions' list rows, closed ones included.
    async fn agent_sessions(&self) -> Result<Vec<Row>, String>;
    /// A stored session's header; `None` when it is not stored.
    async fn header(&self, session: &str) -> Option<Row>;
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
    restart_notices: Mutex<HashMap<String, restart::NoticeStage>>,
    /// `descriptor.parked` (`agent-tree.mjs`): the idle agents the idle release parked, until a turn starts on them. Of
    /// this process only, as Node's descriptors are.
    parked: Mutex<HashSet<String>>,
    /// `descriptor.status = 'cancelled'` (`agent-cancel.mjs` `closeRuntime`): the agents whose running turn a close
    /// stopped, until a turn starts on them. Of this process only, as Node's descriptors are.
    cancelled: Mutex<HashSet<String>>,
    /// `sweepRestartFailures`, run by the maintenance pass ([`Self::keep_deadlines`]); unbound, the pass has no such step.
    sweeper: std::sync::OnceLock<Arc<dyn restart::RestartSweep>>,
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
    /// The agent-only sessions as last loaded, in their order.
    sessions: BTreeMap<Place, Row>,
    /// The first of `sessions` with each id.
    session_at: HashMap<String, Place>,
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
        if clean(map.get("sessionId")).is_empty() {
            return None;
        }
        let mut row = map.clone();
        row.insert("sessionId".into(), Value::String(session.to_owned()));
        let mut row = normalize_row(&row)?;
        if released_at(map, now) {
            row.insert("released".into(), Value::Bool(true));
        }
        Some(row)
    }
}

/// The first stored session of each id (`sessions.find(s => clean(s.id) === id)`).
fn sessions_by_id(sessions: &BTreeMap<Place, Row>) -> HashMap<String, Place> {
    let mut at = HashMap::new();
    for (place, session) in sessions {
        at.entry(clean(session.get("id"))).or_insert_with(|| place.clone());
    }
    at
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
            #[cfg(test)]
            walks: std::sync::atomic::AtomicUsize::new(0),
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
                this.refresh_tags_from_sessions(false, &Scope::default()).await;
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
    async fn reload(&self) {
        let arrived = self.loads().started;
        let number = loop {
            let ended = {
                let mut loads = self.loads();
                if loads.completed > arrived {
                    return;
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
        turn.completed = self.load().await;
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

    /// Whether the index was read and applied.
    async fn load(&self) -> bool {
        self.leads_loaded().await;
        let since = self.lock().revision;
        let Ok(index) = self.store.index_since(since).await else {
            return false;
        };
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.reloads += 1);
        let mut guard = self.lock();
        let st = &mut *guard;
        match index {
            Index::Unchanged => {}
            Index::Delta { revision, maps, sessions } => {
                self.apply_delta(st, maps);
                Self::apply_sessions(st, sessions);
                st.revision = Some(revision);
            }
            Index::Full { revision, maps, sessions } => {
                self.load_maps(st, maps);
                Self::load_sessions(st, sessions);
                st.revision = revision;
            }
        }
        true
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

    /// Every agent-only session the store lists, compared with those held.
    fn load_sessions(st: &mut State, sessions: Vec<(Place, Row)>) {
        let mut next: BTreeMap<Place, Row> = BTreeMap::new();
        for (place, session) in sessions {
            next.entry(place).or_insert(session);
        }
        let same_sessions = st.sessions.len() == next.len()
            && st.sessions.iter().zip(&next).all(|(a, b)| {
                #[cfg(any(test, feature = "test-support"))]
                work::note(|c| c.sessions_compared += 1);
                a == b
            });
        if !same_sessions {
            let before = std::mem::take(&mut st.session_at);
            let old = std::mem::replace(&mut st.sessions, next);
            st.session_at = sessions_by_id(&st.sessions);
            // A tag's session read from the stored rows is read again when its row changed.
            let mut changed: HashSet<&String> =
                st.session_at.iter().filter(|(id, at)| before.get(*id).map(|was| &old[was]) != Some(&st.sessions[*at])).map(|(id, _)| id).collect();
            changed.extend(before.keys().filter(|id| !st.session_at.contains_key(*id)));
            let views = st.views.get_mut();
            for id in changed {
                for tag in st.tags.of_session(id) {
                    views.facts.touch(&tag);
                }
            }
        }
    }

    /// The agent-only sessions the store wrote since the held revision.
    fn apply_sessions(st: &mut State, sessions: Vec<(String, Option<(Place, Row)>)>) {
        for (id, entry) in sessions {
            #[cfg(any(test, feature = "test-support"))]
            work::note(|c| c.sessions_compared += 1);
            let held = st.session_at.get(&id).map(|at| (at, &st.sessions[at]));
            if held == entry.as_ref().map(|(place, row)| (place, row)) {
                continue;
            }
            if let Some(at) = st.session_at.remove(&id) {
                st.sessions.remove(&at);
            }
            if let Some((place, row)) = entry {
                st.session_at.insert(id.clone(), place.clone());
                st.sessions.insert(place, row);
            }
            // A tag's session read from the stored rows is read again.
            let views = st.views.get_mut();
            for tag in st.tags.of_session(&id) {
                views.facts.touch(&tag);
            }
        }
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

    /// `mgr.listSessions({includeClosed})`: the loaded sessions as they are now, then the
    /// stored ones.
    fn list_sessions(&self, st: &State, include_closed: bool) -> Vec<Row> {
        #[cfg(test)]
        self.walks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut out: Vec<Row> = Vec::new();
        let mut seen = HashSet::new();
        for id in self.live.loaded() {
            if let Some(header) = self.loaded_session(&id) {
                seen.insert(id);
                out.push(header);
            }
        }
        for session in st.sessions.values() {
            if !seen.contains(&clean(session.get("id"))) {
                out.push(session.clone());
            }
        }
        if !include_closed {
            out.retain(|s| s.get("closed") != Some(&Value::Bool(true)));
        }
        let cancelled = self.cancelled.lock().unwrap_or_else(|p| p.into_inner());
        out.into_iter().map(|session| described(&cancelled, st, session)).collect()
    }

    fn loaded_session(&self, id: &str) -> Option<Row> {
        let mut header = self.live.header(id)?;
        header.insert("id".into(), Value::String(id.to_owned()));
        Some(header)
    }

    /// `mgr.getSession`.
    fn session(&self, st: &State, id: &str) -> Option<Row> {
        if id.is_empty() {
            return None;
        }
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        let session = self.loaded_session(id).or_else(|| Self::indexed_session(st, id))?;
        Some(described(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, session))
    }

    /// The session as the index stored it, for a session not loaded.
    fn indexed_session(st: &State, id: &str) -> Option<Row> {
        let at = st.session_at.get(id)?;
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        Some(st.sessions[at].clone())
    }

    /// `mgr.getSession(id)` for a worker's turn (`sessionOf`).
    pub(super) fn session_of(&self, id: &str) -> Option<Row> {
        let st = self.lock();
        self.session(&st, &clean_str(id))
    }

    /// Whether [`Self::session_of`] finds the session, without copying it.
    pub(super) fn knows_session(&self, id: &str) -> bool {
        let id = clean_str(id);
        !id.is_empty() && (self.live.shared_header(&id).is_some() || self.lock().session_at.contains_key(&id))
    }

    /// `upsertWorkerSessionDeferred(session, tag, extra)` from the worker's turn.
    pub(super) fn upsert_session_row(&self, session: &Row, tag: &str, extra: &Row) {
        let mut st = self.lock();
        self.upsert_session(&mut st, session, tag, extra);
    }

    /// `getLiveSession`.
    fn live_session_row(&self, st: &State, id: &str) -> Option<Row> {
        self.session(st, id).filter(|s| s.get("closed") != Some(&Value::Bool(true)))
    }

    fn shared_live_session(&self, st: &State, id: &str) -> Option<SessionRead> {
        if id.is_empty() {
            return None;
        }
        #[cfg(any(test, feature = "test-support"))]
        work::note(|c| c.sessions_visited += 1);
        let Some(header) = self.live.shared_header(id) else {
            let row = described(&self.cancelled.lock().unwrap_or_else(|p| p.into_inner()), st, Self::indexed_session(st, id)?);
            return (row.get("closed") != Some(&Value::Bool(true))).then(|| SessionRead { row: Arc::new(row), published: None });
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
    pub(crate) fn open_sessions(&self) -> Vec<Row> {
        let st = self.lock();
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
        self.reload().await;
        let now = self.now();
        let mut st = self.lock();
        let indexed = st.lead_rows.get(&id).is_some_and(Option::is_some);
        if indexed || st.map(&id).is_some_and(|map| lead_row::is_lead_map(map) && clean(map.get("sessionId")) == id) {
            self.remove_lead(&mut st, &id);
            return true;
        }
        let Some(row) = st.map(&id).cloned().and_then(|map| st.row(&id, &map, now)) else {
            return false;
        };
        if clean(row.get("sessionId")) != id || is_lead_pool_agent(row.get("agent")) || !is_terminal_row(&row) || is_unnotified_restart_failure(&row) {
            return false;
        }
        self.tombstone_rows(&mut st, &[row]);
        true
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
            self.scan_listed(st, &open, scope);
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
    pub async fn refresh_tags_from_index(&self, scope: &Scope) {
        self.reload().await;
        let mut st = self.lock();
        let now = self.now();
        for row in st.rows(scope, now) {
            st.bind(&clean(row.get("tag")), &clean(row.get("sessionId")), &clean(row.get("agent")), &clean(row.get("cwd")));
        }
    }

    /// `agentSessionEntries` for the views (list and status keep terminal traces), over the
    /// index as last refreshed.
    pub fn session_entries(&self, scan_sessions: bool, scope: &Scope) -> Vec<(String, Arc<Row>)> {
        let mut st = self.lock();
        self.entries(&mut st, scan_sessions, scope, false)
    }

    /// What the agent status lists for `scope` (`agentSessionEntries` as `statusFor` reads it, after
    /// `refresh_tags_from_sessions`): the entries of [`Self::session_entries`] in their order, less
    /// the rows whose own state is not active (`isActiveWorkerRow`, which the status applies to
    /// every entry). A caller scope reads only the rows a write changed and the tags that can list
    /// a session for it.
    pub fn status_entries(&self, scope: &Scope) -> Vec<(String, Arc<Row>)> {
        let Some(caller) = scope.caller_session_id.clone() else {
            return self.session_entries(false, scope);
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
                add(&mut out, &mut seen, &Arc::new(session.clone()), &tag);
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
                    add(&mut out, &mut seen, &Arc::new(session), &tag);
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

    /// `agentDescendantSessionIds`: every agent session below `session`, depth first, each
    /// once; a child is linked by its `parentSessionId || ownerSessionId`.
    pub(crate) fn descendants(&self, session: &str) -> Vec<String> {
        let st = self.lock();
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        for s in self.list_sessions(&st, true) {
            if let Some((parent, id)) = parent_link(&s) {
                children.entry(parent).or_default().push(id);
            }
        }
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack = vec![(clean_str(session), 0usize)];
        while let Some((parent, at)) = stack.pop() {
            let Some(next) = children.get(&parent).and_then(|c| c.get(at)) else { continue };
            stack.push((parent, at + 1));
            if seen.insert(next.clone()) {
                out.push(next.clone());
                stack.push((next.clone(), 0));
            }
        }
        out
    }

    /// A cleanup's reading of `listed`, every agent session as one listing holds them: the links [`Self::descendants`]
    /// follows, the sessions listed (those [`Self::session_of`] finds), the open Lead sessions and the open sessions.
    fn topology_of(listed: &[Row]) -> Topology {
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
    fn resolve_tombstone_owners(&self) {
        let mut st = self.lock();
        self.resolve_owners(&mut st);
    }

    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, scope: &Scope) {
        self.reload().await;
        let mut st = self.lock();
        self.refresh(&mut st, scan_sessions, scope);
    }

    /// The refresh and the cleanup's reading from one listing of the sessions: its scan reads the open ones of it. The
    /// signals of every session it writes (a stale row's tombstone, a recovered row) are held in what it answers.
    async fn refresh_topology(&self, scan_sessions: bool, scope: &Scope) -> (Topology, Recovered) {
        self.reload().await;
        let mut st = self.lock();
        st.holding = Some(Holding::default());
        self.refresh(&mut st, false, scope);
        let listed = self.list_sessions(&st, true);
        if scan_sessions {
            let open = listed.iter().filter(|session| session.get("closed") != Some(&Value::Bool(true)));
            self.scan_listed(&mut st, open, scope);
        }
        (Self::topology_of(&listed), st.holding.take().unwrap_or_default().recovered)
    }

    /// The count `pool_docs` keeps on the worker map of each turn started on it, and the id of the last it counted.
    fn turn_mark(&self, session_id: &str) -> Option<TurnMark> {
        self.lock().map(&clean_str(session_id)).map(mark_of)
    }

    fn resolve_tag(&self, tag: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        let mut st = self.lock();
        self.resolve(&mut st, tag, scope, options)
    }

    fn live_session(&self, session_id: &str) -> Option<SessionFacts> {
        let st = self.lock();
        self.live_session_row(&st, session_id).map(|s| session_facts(&s))
    }

    fn tag_session(&self, tag: &str) -> Option<String> {
        self.lock().tag(tag).cloned()
    }

    fn has_tag_agent(&self, tag: &str) -> bool {
        self.lock().tag_agents.contains_key(tag)
    }

    fn tag_for_session(&self, session_id: &str) -> Option<String> {
        let st = self.lock();
        let persisted = self.live_session_row(&st, session_id).map(|s| agent_tag_of(&s)).unwrap_or_default();
        if !persisted.is_empty() {
            return Some(persisted);
        }
        st.tags.first_of(session_id).cloned()
    }

    fn unbind_tag(&self, tag: &str) {
        self.lock().unbind(tag);
    }

    /// `bindTag(tag, session, {turnStartedAt})`.
    fn bind_tag(&self, tag: &str, session: &SessionFacts, turn_started_at: &str) {
        if tag.is_empty() || session.id.is_empty() {
            return;
        }
        let mut st = self.lock();
        st.bind(tag, &session.id, &session.agent, &session.cwd);
        let mut row = self.session(&st, &session.id).unwrap_or_default();
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

    fn last_tag_session(&self, tag: &str, scope: &Scope) -> Option<TagRecord> {
        let value = clean_str(tag);
        let caller = scope.caller_session_id.as_deref().map(clean_str).unwrap_or_default();
        if value.is_empty() || value.starts_with("sess_") || caller.is_empty() {
            return None;
        }
        let st = self.lock();
        let mut newest: Option<Row> = None;
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

    async fn resumable_tag_session(&self, tag: &str, session_id: &str, scope: &Scope) -> Option<Resumable> {
        let value = clean_str(tag);
        let id = clean_str(session_id);
        if value.is_empty() || id.is_empty() {
            return None;
        }
        {
            let st = self.lock();
            if st.map(&id).is_some_and(|m| released_at(m, self.now())) {
                return None;
            }
        }
        let mut record = match self.loaded_session(&id) {
            Some(header) => header,
            None => self.store.header(&id).await?,
        };
        record.insert("id".into(), Value::String(id.clone()));
        let closed = record.get("closed") == Some(&Value::Bool(true)) || record.get("status").and_then(Value::as_str) == Some("closed");
        if closed || !resumable_after_reap(&record) || !Self::owned_tag_session(&record, &value, scope) {
            return None;
        }
        let session = {
            let st = self.lock();
            self.live_session_row(&st, &id).map(|s| session_facts(&s))?
        };
        let cwd = clean(record.get("cwd"));
        if self.store.is_directory(&cwd).await {
            Some(Resumable { session: Some(session), missing_cwd: None })
        } else {
            Some(Resumable { session: None, missing_cwd: Some(cwd) })
        }
    }
}

impl TerminalTrace for AgentRegistry {
    /// `hasTerminalTrace`: a tag that resolves to a live session is reused, not a trace; an
    /// ambiguous tag is the resolver's error.
    fn has_terminal_trace(&self, tag: &str, scope: &Scope) -> Result<bool, String> {
        let value = clean_str(tag);
        if value.is_empty() || value.starts_with("sess_") {
            return Ok(false);
        }
        let mut st = self.lock();
        let options = ResolveOptions { exclude_terminal_traces: true, skip_released: true, ..ResolveOptions::default() };
        if self.resolve(&mut st, &value, scope, options)?.is_some() {
            return Ok(false);
        }
        Ok(self.terminal_row_for_tag(&st, &value, scope).is_some())
    }

    fn reap_terminal_trace_for_tag(&self, tag: &str, scope: &Scope) {
        let value = clean_str(tag);
        if value.is_empty() || value.starts_with("sess_") {
            return;
        }
        let mut st = self.lock();
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

// ---- the store and the directory ------------------------------------------------------

/// [`WorkerStore`] over the index and the threads' headers. Each row goes to its own session's record (a header patch,
/// through the session's actor), the kept table or the Lead table, so the writes are ordered per session and not across
/// sessions: one queue per session with work accepted ([`Writers`]), across its header, kept and Lead targets, retired
/// when it is empty. A put one session waits on holds no other session's write or answer; a put that is refused answers
/// that write as failed and is not made again by the writer.
pub struct StoreWorkers {
    index: SqliteStore,
    threads: Arc<dyn ThreadState>,
    writers: Arc<Writers>,
    /// Where a session's first accepted write asks for its queue's task.
    dispatch: mpsc::UnboundedSender<Dispatch>,
    /// Each write numbered as it is accepted, reported once it is closed: progress, not outcomes.
    marks: Arc<mixdog_rt::WriteMarks>,
    io: InteractiveIo,
    /// `registry.onWorkerRowsChange` (`agent-tool.mjs`), bound once by the composition.
    signals: std::sync::OnceLock<Arc<dyn signals::StatusSignals>>,
    kept: Arc<KeptRows>,
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
struct KeptMemory {
    maps: HashMap<String, (u64, Row)>,
    /// Each kept row's identity, as the table holds it ([`KEPT_IDENTITY_PREFIX`]).
    identities: HashMap<String, String>,
    revision: u64,
    changed: BTreeMap<u64, String>,
    changed_at: HashMap<String, u64>,
}

impl KeptMemory {
    fn set(&mut self, session: &str, worker: Option<Row>) {
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
        let rows = self.rows();
        let memory = rows.as_ref().expect("loaded above");
        let answer = match since {
            Some(since) if since <= memory.revision => {
                KeptSince::Changed(memory.changed.range(since + 1..).map(|(_, id)| (id.clone(), memory.maps.get(id).cloned())).collect())
            }
            _ => KeptSince::All(memory.all()),
        };
        Ok((memory.revision, answer))
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

/// The queues of the sessions with work accepted and not finished.
#[derive(Default)]
struct Lanes {
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
    closed: HashMap<(String, Target), Vec<(u64, Option<String>)>>,
    /// The sessions whose record went ([`WorkerStore::keep`]), each with the numbers, ascending, of the kept writes
    /// that took a record's place: one per record that went, since a session can be made again and deleted again. A
    /// retirement covers the header writes accepted before it: to a flush whose watermark is at or above it they are
    /// owed nothing, and a flush taken below it still selects among them what it would have selected.
    retired: HashMap<String, Vec<u64>>,
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
    unsettled: HashMap<String, HeaderWrite>,
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
struct Writers {
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
    fn lanes(&self) -> MutexGuard<'_, Lanes> {
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
    ) -> Result<bool, (&'static str, Option<Receipted>)> {
        let mut lanes = self.lanes();
        if lanes.sealed {
            return Err((WRITER_CLOSED, release));
        }
        if target == Target::Header && lanes.headers != Headers::Open {
            return Err((HEADERS_CLOSED, release));
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
        let mut retiring = Retiring { writers: &*self, session: &session, retired: false };
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
        let read = self.index.worker_index_since(since.map(|r| (r.generation, r.index)), also).await.map_err(|e| format!("{e:?}"))?;
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
        let session_of = |s: &mixdog_store::worker::IndexedSession| {
            let (activity, summary) = s.agent.as_ref()?;
            Some((Place::stamped(Some(*activity), &s.session), serde_json::from_str::<Row>(summary).ok()?))
        };
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
                let sessions = read.sessions.iter().filter_map(session_of).collect();
                return Ok(Index::Full { revision: Some(revision), maps, sessions });
            }
        };
        if since == Some(revision) && read.sessions.is_empty() && kept.is_empty() {
            return Ok(Index::Unchanged);
        }
        let mut maps: Vec<(String, Option<(Place, Row)>)> = Vec::new();
        let mut sessions: Vec<(String, Option<(Place, Row)>)> = Vec::new();
        for s in &read.sessions {
            let map = match &s.worker {
                Some(map) => Some((Place::stamped(s.created_at, &s.session), map.clone())),
                None => self.kept.get(&s.session).map(|(at, map)| (Place::Kept(at), map)),
            };
            maps.push((s.session.clone(), map));
            sessions.push((s.session.clone(), session_of(s)));
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

    async fn header(&self, session: &str) -> Option<Row> {
        self.threads.header(&ThreadId::from(session)).await.ok()
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

#[async_trait]
impl super::directory::RowWrites for StoreWorkers {
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
