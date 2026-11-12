//! The agent tool's tag registry and terminal traces over the worker index (1.4.5
//! `agent-tool/tag-registry.mjs`, `worker-index.mjs`, `terminal-reaper.mjs`,
//! `terminal-trace.mjs`).
//!
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
//! The registry is the one writer of that map. Its reads answer from memory (the tag maps and
//! the index as last loaded, with this process's writes applied), as Node's do from its
//! files; `refresh_tags_from_sessions` reloads the index.

mod rows;
pub mod flow;
mod lead_row;
pub mod sessions;
pub mod workers;
mod worker_view;
mod pool_docs;
mod world_rows;
pub mod restart;
pub mod signals;
pub mod status_rows;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod write_marks_tests;

pub use self::sessions::AgentOwnerTeardown;
pub use self::sessions::AgentSessions;
pub use self::sessions::CloseAllReport;
pub use self::sessions::AgentStatusline;
pub use self::flow::AgentTaskStarts;
pub use self::flow::RuntimeRelease;
pub use self::flow::SessionTurns;
pub use self::flow::SessionCompletions;
pub use self::workers::AgentWorkers;
pub use self::world_rows::CancelScope;

use std::cell::RefCell;
use std::cell::RefMut;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::ResolveOptions;
use mixdog_agent::agent_tool::host::Resumable;
use mixdog_agent::agent_tool::host::TerminalTrace;
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

pub use self::rows::Row;
use self::rows::*;
use super::Clock;
use mixdog_core_ports::ports::threads::ThreadState;

/// The stored side of the worker index.
#[async_trait]
pub trait WorkerStore: Send + Sync {
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
    /// Keeps the map of a session deleted while its rows still count: Node's index file keeps every row its forget does not take
    /// (`gone-rows.mjs:214-226`), and a restart reads it again. From now on [`worker_maps`](Self::worker_maps) lists it and
    /// [`write`](Self::write) writes it there.
    fn keep(&self, session: &str, worker: Option<Row>);
    /// Whether `session`'s map is a kept one (its session record is gone).
    fn kept(&self, session: &str) -> bool;
}

/// What this process knows of its loaded sessions now.
pub trait LiveSessions: Send + Sync {
    fn loaded(&self) -> Vec<String>;
    /// A loaded session's header.
    fn header(&self, session: &str) -> Option<Row>;
    /// A turn is running (`runtime.controller` not aborted).
    fn running(&self, session: &str) -> bool;
    /// `sessionHasLiveWork`: a running turn or queued input.
    fn has_live_work(&self, session: &str) -> bool;
    /// `runtime.stage`.
    fn runtime_stage(&self, session: &str) -> Option<String>;
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
}

#[derive(Default)]
struct State {
    /// `tags` (insertion order), `tagAgents`, `tagCwds`.
    tags: Vec<(String, String)>,
    tag_agents: HashMap<String, String>,
    tag_cwds: HashMap<String, String>,
    /// Every session's worker map: the index as last loaded, with this process's writes.
    maps: Vec<(String, Row)>,
    /// Writes the loaded index did not show yet.
    pending: HashMap<String, Option<Row>>,
    /// The agent-only sessions as last loaded.
    sessions: Vec<Row>,
    /// A legacy tombstone's resolved owner fields, by its identity (`row-reads.mjs` `owners`).
    owners: HashMap<String, Option<Row>>,
    /// A Lead pool row's worker map as this process last wrote it, until the stored header shows
    /// it (lead_row.rs).
    leads: HashMap<String, Row>,
    /// The sessions whose row this process wrote as active (`activeWorkerKeys`/`trackActiveRow`):
    /// settled as failed when the process exits (restart.rs).
    active: HashSet<String>,
    /// `cancellationCounts`: the cancellations in progress that cover a session.
    cancelling: HashMap<String, usize>,
    /// `cancellationEpochs`: how many cancellations have covered a session.
    epochs: HashMap<String, u64>,
    /// Bumped whenever `maps` or `owners` change; the reads kept in `kept` belong to one value of it.
    version: u64,
    kept: RefCell<Kept>,
}

/// The `now` values over which every read of the index answers the same: a read of an unchanged index at a
/// clock inside it is the read already made (`row-reads.mjs`). The clock matters to a read only where a
/// release marker or a tombstone ends (the TTL), and while a tombstone is stamped after `now` (it reads as
/// `now`).
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

#[derive(Default)]
struct Kept {
    window: Option<(u64, Window)>,
    all_rows: Option<Vec<Row>>,
    stored_tombstones: Option<Vec<Row>>,
    tombstones: Option<Vec<Row>>,
    unblocked_rows: Option<Vec<Row>>,
    index: Option<HashMap<String, Row>>,
    /// Every legacy tombstone of the index has its owner looked up (`resolve_owners`).
    owners_resolved: bool,
}

impl State {
    /// The window `now` is in for the index as it is.
    fn window_at(&self, now: f64) -> Window {
        let mut w = Window { from: f64::NEG_INFINITY, after: f64::NEG_INFINITY, upto: f64::INFINITY };
        let ends = |end: f64, w: &mut Window, from: Option<f64>| {
            if now <= end {
                w.upto = w.upto.min(end);
                if let Some(from) = from {
                    w.from = w.from.max(from);
                }
            } else {
                w.after = w.after.max(end);
            }
        };
        for (_, map) in &self.maps {
            let released = stamp_ms(map.get("releasedAt"));
            if released > 0.0 {
                ends(released + TAG_TOMBSTONE_TTL_MS, &mut w, None);
            }
            let Some(tombstone) = map.get("tombstone").and_then(Value::as_object) else { continue };
            let reaped = mixdog_js::time::date_parse(&clean(tombstone.get("reapedAt")));
            if reaped.is_nan() || reaped == 0.0 || clean(tombstone.get("tag")).is_empty() {
                continue;
            }
            if reaped > now {
                (w.from, w.upto) = (now, now);
            } else {
                ends(reaped + TAG_TOMBSTONE_TTL_MS, &mut w, Some(reaped));
            }
        }
        w
    }

    /// Any change of what the reads are built from.
    fn changed(&mut self) {
        self.version += 1;
    }

    /// The reads kept for `now`, emptied first when the index changed or `now` left their window.
    fn kept(&self, now: f64) -> RefMut<'_, Kept> {
        let mut kept = self.kept.borrow_mut();
        if !kept.window.is_some_and(|(version, window)| version == self.version && window.holds(now)) {
            *kept = Kept { window: Some((self.version, self.window_at(now))), ..Kept::default() };
        }
        kept
    }
}

impl State {
    fn tag(&self, tag: &str) -> Option<&String> {
        self.tags.iter().find(|(t, _)| t == tag).map(|(_, id)| id)
    }

    fn set_tag(&mut self, tag: &str, session: &str) {
        match self.tags.iter_mut().find(|(t, _)| t == tag) {
            Some(entry) => entry.1 = session.to_owned(),
            None => self.tags.push((tag.to_owned(), session.to_owned())),
        }
    }

    /// `tagMaps.bind`.
    fn bind(&mut self, tag: &str, session: &str, agent: &str, cwd: &str) {
        self.set_tag(tag, session);
        if !agent.is_empty() {
            self.tag_agents.insert(tag.to_owned(), agent.to_owned());
        }
        if !cwd.is_empty() {
            self.tag_cwds.insert(tag.to_owned(), cwd.to_owned());
        }
    }

    /// `tagMaps.unbind`.
    fn unbind(&mut self, tag: &str) {
        self.tags.retain(|(t, _)| t != tag);
        self.tag_agents.remove(tag);
        self.tag_cwds.remove(tag);
    }

    /// `tagMaps.unbindIfOwned`.
    fn unbind_if_owned(&mut self, tag: &str, session: &str) {
        if !tag.is_empty() && !session.is_empty() && self.tag(tag).is_some_and(|id| id == session) {
            self.unbind(tag);
        }
    }

    fn map(&self, session: &str) -> Option<&Row> {
        self.maps.iter().find(|(id, _)| id == session).map(|(_, m)| m)
    }

    fn put(&mut self, session: &str, map: Option<Row>) {
        let at = self.maps.iter().position(|(id, _)| id == session);
        match (at, map.clone()) {
            (Some(i), Some(m)) => self.maps[i].1 = m,
            (Some(i), None) => {
                self.maps.remove(i);
            }
            (None, Some(m)) => self.maps.insert(0, (session.to_owned(), m)),
            (None, None) => {}
        }
        self.pending.insert(session.to_owned(), map);
        self.changed();
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

    /// `readAllWorkerRows`.
    fn all_rows(&self, now: f64) -> Vec<Row> {
        let mut kept = self.kept(now);
        kept.all_rows.get_or_insert_with(|| self.maps.iter().filter_map(|(id, map)| self.row(id, map, now)).collect()).clone()
    }

    /// The stored tombstones, newest first and capped (`store.readTombstones`).
    fn stored_tombstones(&self, now: f64) -> Vec<Row> {
        let mut kept = self.kept(now);
        kept.stored_tombstones
            .get_or_insert_with(|| {
                let rows = self
                    .maps
                    .iter()
                    .filter_map(|(id, map)| normalize_tombstone(map.get("tombstone")?.as_object()?, id, now))
                    .collect();
                order_tombstones(rows)
            })
            .clone()
    }

    /// `readAllTagTombstones`: legacy tombstones with the owner resolved so far.
    fn tombstones(&self, now: f64) -> Vec<Row> {
        let stored = self.stored_tombstones(now);
        let mut kept = self.kept(now);
        kept.tombstones
            .get_or_insert_with(|| {
                stored
                    .into_iter()
                    .map(|row| match self.owners.get(&identity(&row)) {
                        Some(Some(fields)) if is_legacy(&row) => {
                            let mut out = row;
                            out.extend(fields.clone());
                            out
                        }
                        _ => row,
                    })
                    .collect()
            })
            .clone()
    }

    /// `tagTombstoneIndex`: the newest tombstone of each key.
    fn tombstone_index(&self, now: f64) -> HashMap<String, Row> {
        let have = self.kept(now).index.clone();
        if let Some(index) = have {
            return index;
        }
        let mut by_key = HashMap::new();
        for row in self.tombstones(now) {
            by_key.entry(tombstone_key(&row)).or_insert(row);
        }
        self.kept(now).index = Some(by_key.clone());
        by_key
    }

    /// `readWorkerRows(context)`: a row a tombstone still blocks never reads as work.
    fn rows(&self, scope: &Scope, now: f64) -> Vec<Row> {
        let unblocked = {
            let have = self.kept(now).unblocked_rows.clone();
            match have {
                Some(rows) => rows,
                None => {
                    let by_key = self.tombstone_index(now);
                    let rows: Vec<Row> = self
                        .all_rows(now)
                        .into_iter()
                        .filter(|row| {
                            let tag = clean(either(row, "tag", "agentTag"));
                            !blocks_work(row, find_tombstone(row, &by_key, &tag))
                        })
                        .collect();
                    self.kept(now).unblocked_rows = Some(rows.clone());
                    rows
                }
            }
        };
        unblocked.into_iter().filter(|row| matches_scope(row, scope)).collect()
    }
}

fn released_at(map: &Row, now: f64) -> bool {
    let at = stamp_ms(map.get("releasedAt"));
    at > 0.0 && at >= now - TAG_TOMBSTONE_TTL_MS
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
        Self { store, live, reap, clock, state: Mutex::new(State::default()), rearm: Arc::default() }
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

    /// The deadline timer of the agent maintenance pass (`armDeadline`, maintenance-pass.mjs): a pass
    /// (`refreshTagsFromSessions` over every owner's rows) runs at the earliest moment a row comes due by its stamps
    /// alone after the last pass began, so a row past its reap deadline leaves the index then, not at the next agent
    /// event. A deadline crossed while a pass ran starts the next pass at once; one due before the pass began was looked at
    /// by it. Every refresh and row write arms the timer again. Ends once the registry is gone.
    /// The timer waits on the registry's own clock (`Clock::until_ms`), the clock the rows' deadlines are read on.
    /// The start is the moment of this call, not of the future's first poll.
    pub fn keep_deadlines(registry: std::sync::Weak<Self>) -> impl std::future::Future<Output = ()> + Send + 'static {
        let started = registry.upgrade().map_or(0.0, |first| first.now());
        Self::deadline_timer(registry, started)
    }

    async fn deadline_timer(registry: std::sync::Weak<Self>, started: f64) {
        // Node re-arms a deadline past setTimeout's largest delay when it fires; this looks at the registry again.
        const LONGEST_WAIT_MS: f64 = 3_600_000.0;
        let Some(first) = registry.upgrade() else { return };
        let rearm = first.rearm.clone();
        let clock = first.clock.clone();
        drop(first);
        // Node arms no deadline before a pass has run, and the first pass is the event pass one `MAINTENANCE_EVENT_DELAY_MS`
        // after the first status read (maintenance-pass.mjs:23,129). It then looks at every deadline after 0
        // (`lastPassStart` starts at 0): a row that came due while the core was down is reaped by it.
        clock.until_ms((started + 1_000.0) as i64).await;
        let mut since = 0.0;
        loop {
            let rearmed = rearm.notified();
            tokio::pin!(rearmed);
            rearmed.as_mut().enable();
            let Some(this) = registry.upgrade() else { return };
            let (next, now) = (this.next_stale_row_deadline(since), this.now());
            if next <= now {
                since = now;
                this.refresh_tags_from_sessions(false, &Scope::default()).await;
                continue;
            }
            drop(this);
            let at = next.min(now + LONGEST_WAIT_MS).ceil() as i64;
            tokio::select! {
                () = clock.until_ms(at) => {}
                () = &mut rearmed => {}
            }
        }
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

    /// Reloads the index; this process's writes it does not show yet stay applied.
    async fn reload(&self) {
        let (Ok(maps), Ok(sessions)) = (self.store.worker_maps().await, self.store.agent_sessions().await) else {
            return;
        };
        let mut st = self.lock();
        if st.maps != maps {
            // Node's index file keeps a deleted session's rows until its forget takes them (`gone-rows.mjs:214`) and every
            // listing shows them with no header; the core's index drops them at the purge, so a row it stops listing is kept
            // by the store, durably, and lives on as Node's does (a row this registry removed is no longer in `st.maps`).
            let gone: Vec<(String, Row)> = st.maps.iter().filter(|(id, _)| !maps.iter().any(|(m, _)| m == id)).cloned().collect();
            st.maps = maps;
            for (id, map) in gone {
                self.store.keep(&id, Some(map.clone()));
                st.put(&id, Some(map));
            }
            st.changed();
        }
        st.sessions = sessions;
        let pending: Vec<(String, Option<Row>)> = st.pending.drain().collect();
        for (session, map) in pending {
            if st.map(&session) == map.as_ref() {
                continue;
            }
            st.put(&session, map);
        }
    }

    fn persist(&self, st: &mut State, session: &str, map: Option<Row>) {
        if map.as_ref().is_some_and(restart::is_active_worker_row) {
            st.active.insert(session.to_owned());
        } else {
            st.active.remove(session);
        }
        st.put(session, map.clone());
        self.store.write(session, map);
        self.rearm.notify_waiters();
    }

    /// `mgr.listSessions({includeClosed})`: the loaded sessions as they are now, then the
    /// stored ones.
    fn list_sessions(&self, st: &State, include_closed: bool) -> Vec<Row> {
        let mut out: Vec<Row> = Vec::new();
        let mut seen = HashSet::new();
        for id in self.live.loaded() {
            if let Some(header) = self.loaded_session(&id) {
                seen.insert(id);
                out.push(header);
            }
        }
        for session in &st.sessions {
            if !seen.contains(&clean(session.get("id"))) {
                out.push(session.clone());
            }
        }
        if !include_closed {
            out.retain(|s| s.get("closed") != Some(&Value::Bool(true)));
        }
        out
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
        self.loaded_session(id).or_else(|| st.sessions.iter().find(|s| clean(s.get("id")) == id).cloned())
    }

    /// `mgr.getSession(id)` for a worker's turn (`sessionOf`).
    pub(super) fn session_of(&self, id: &str) -> Option<Row> {
        let st = self.lock();
        self.session(&st, &clean_str(id))
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

    /// `forgetDeletedSession` (`gone-rows.mjs`): a deleted session's settled row goes, as a
    /// tombstone; a Lead pool row, a running one or an owed restart failure stays. Whether one
    /// went. Reads the index as it is now (`readAllWorkerRows`).
    pub async fn forget_deleted_session(&self, session_id: &str) -> bool {
        let id = clean_str(session_id);
        if id.is_empty() {
            return false;
        }
        self.reload().await;
        let now = self.now();
        let mut st = self.lock();
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
            .filter(|(id, map)| {
                map.get("tombstone").and_then(Value::as_object).and_then(|t| normalize_tombstone(t, id, now)).is_some_and(|t| pick(id, &t))
            })
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
        if st.kept(now).owners_resolved {
            return;
        }
        let legacy: Vec<Row> = st.stored_tombstones(now).into_iter().filter(is_legacy).collect();
        let unresolved: Vec<&Row> = legacy.iter().filter(|row| !st.owners.contains_key(&identity(row))).collect();
        if unresolved.is_empty() {
            st.kept(now).owners_resolved = true;
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
        st.kept(now).owners_resolved = true;
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
        !st.rows(&Scope::default(), now).iter().any(|row| clean(row.get("sessionId")) == id && clean(row.get("tag")) == tag)
    }

    /// `terminal-reaper.mjs` `tombstoneBlocksScan`: aged out, or a tombstone blocks it.
    fn blocks_scan(&self, st: &State, session: &Row, tag: &str, by_key: &HashMap<String, Row>) -> bool {
        let aged_out = self.scan_is_terminal(session) && past_settled_retention(&self.reap_ms(), session, self.now());
        aged_out || self.tombstone_blocks_scan(st, session, tag, by_key)
    }

    /// `scanUpsertSession`.
    fn scan_upsert(&self, st: &mut State, session: &Row, tag: &str, by_key: &HashMap<String, Row>) -> bool {
        if self.tombstone_blocks_scan(st, session, tag, by_key) {
            return false;
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
        let existing = st.rows(&Scope::default(), self.now()).into_iter().find(|row| clean(row.get("sessionId")) == id);
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

    /// `transitionStaleNonterminalRows`.
    fn transition_stale(&self, st: &mut State, scope: &Scope) {
        let now = self.now();
        let reap = self.reap_ms();
        let stale: Vec<Row> = st
            .rows(scope, now)
            .into_iter()
            .filter(|row| {
                if is_lead_pool_agent(row.get("agent")) {
                    return false;
                }
                let id = clean(row.get("sessionId"));
                if is_terminal_row(row) {
                    return !is_unnotified_restart_failure(row)
                        && past_settled_retention(&reap, row, now)
                        && !self.live.has_live_work(&id);
                }
                if self.live_session_row(st, &id).is_some() {
                    return false;
                }
                now >= nonterminal_reap_deadline(&reap, row)
            })
            .collect();
        // `sweepGoneRows` (`gone-rows.mjs:107-115`, `:162-200`, a maintenance step of `agent-tool.mjs:207`): a kept row of a
        // deleted session, whoever owns it, leaves once settled: terminal, no restart failure still owed, past the settled
        // retention, no live work.
        let gone: Vec<Row> = st
            .maps
            .iter()
            .filter(|(id, _)| self.store.kept(id))
            .filter_map(|(id, map)| st.row(id, map, now))
            .filter(|row| {
                !is_lead_pool_agent(row.get("agent"))
                    && is_terminal_row(row)
                    && !is_unnotified_restart_failure(row)
                    && past_settled_retention(&reap, row, now)
                    && !self.live.has_live_work(&clean(row.get("sessionId")))
                    && !stale.iter().any(|kept| kept.get("sessionId") == row.get("sessionId"))
            })
            .collect();
        self.tombstone_rows(st, &[stale, gone].concat());
    }

    /// A kept map (a deleted session's) that holds no row and no live release any more, only a tombstone past the TTL or beyond
    /// the newest `MAX_TAG_TOMBSTONES`, leaves the kept table: Node rewrites its index file with only those tombstones
    /// (`worker-rows.mjs:7`, `:96-102`).
    fn drop_expired_kept(&self, st: &mut State) {
        let now = self.now();
        let live: HashSet<String> = st.stored_tombstones(now).iter().map(|t| clean(t.get("sessionId"))).collect();
        let gone: Vec<String> = st
            .maps
            .iter()
            .filter(|(id, map)| self.store.kept(id) && clean(map.get("sessionId")).is_empty() && !released_at(map, now) && !live.contains(id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
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
        let indexed = st.rows(scope, now);
        for row in &indexed {
            st.bind(&clean(row.get("tag")), &clean(row.get("sessionId")), &clean(row.get("agent")), &clean(row.get("cwd")));
        }
        let keys: HashSet<String> = indexed.iter().map(|r| format!("{}\0{}", clean(r.get("tag")), clean(r.get("sessionId")))).collect();
        let by_key = st.tombstone_index(now);
        for (tag, id) in st.tags.clone() {
            if keys.contains(&format!("{tag}\0{id}")) {
                continue;
            }
            let session = self.live_session_row(st, &id);
            if session.as_ref().is_none_or(|s| self.blocks_scan(st, s, &tag, &by_key)) {
                st.unbind(&tag);
            }
        }
        if !scan_sessions {
            return;
        }
        for session in self.list_sessions(st, false) {
            if is_lead_pool_agent(session.get("agent")) {
                continue;
            }
            let tag = agent_tag_of(&session);
            if tag.is_empty() || st.tag(&tag).is_some() || !matches_scope(&session, scope) || self.blocks_scan(st, &session, &tag, &by_key) {
                continue;
            }
            st.bind(&tag, &clean(session.get("id")), &clean(session.get("agent")), &clean(session.get("cwd")));
            self.scan_upsert(st, &session, &tag, &by_key);
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
    pub fn session_entries(&self, scan_sessions: bool, scope: &Scope) -> Vec<(String, Row)> {
        let mut st = self.lock();
        self.entries(&mut st, scan_sessions, scope, false)
    }

    /// `agentSessionEntries`: the tag-bound sessions visible in `scope`, as `(tag, session)`.
    fn entries(&self, st: &mut State, scan_sessions: bool, scope: &Scope, exclude_terminal_traces: bool) -> Vec<(String, Row)> {
        let now = self.now();
        let by_key = st.tombstone_index(now);
        let mut out: Vec<(String, Row)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let add = |out: &mut Vec<(String, Row)>, seen: &mut HashSet<String>, session: &Row, fallback: &str| {
            let tag = Some(agent_tag_of(session)).filter(|t| !t.is_empty()).unwrap_or_else(|| clean_str(fallback));
            let id = clean(session.get("id"));
            if tag.is_empty() || id.is_empty() || session.get("closed") == Some(&Value::Bool(true)) {
                return;
            }
            if is_lead_pool_agent(session.get("agent")) || !matches_scope(session, scope) || !seen.insert(id) {
                return;
            }
            out.push((tag, session.clone()));
        };
        for row in st.rows(scope, now) {
            let tag = clean(row.get("tag"));
            let id = clean(row.get("sessionId"));
            if tag.is_empty() || id.is_empty() || is_lead_pool_agent(row.get("agent")) || seen.contains(&id) {
                continue;
            }
            if exclude_terminal_traces && is_terminal_row(&row) && self.live_session_row(st, &id).is_none() {
                continue;
            }
            seen.insert(id);
            out.push((tag, row_to_session(&row)));
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
        for (tag, id) in st.tags.clone() {
            if seen.contains(&id) {
                continue;
            }
            let Some(session) = self.live_session_row(st, &id) else { continue };
            if self.blocks_scan(st, &session, &tag, &by_key) {
                continue;
            }
            add(&mut out, &mut seen, &session, &tag);
        }
        out
    }

    fn resolve(&self, st: &mut State, target: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
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
        let matches: Vec<String> = self
            .entries(st, options.scan_sessions, scope, options.exclude_terminal_traces)
            .into_iter()
            .filter(|(tag, _)| *tag == value)
            .map(|(_, session)| clean(session.get("id")))
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
        !clean(session.get("id")).is_empty()
            && agent_tag_of(session) == tag
            && !is_lead_pool_agent(session.get("agent"))
            && matches_scope(session, scope)
    }

    /// `agentDescendantSessionIds`: every agent session below `session`, depth first, each
    /// once; a child is linked by its `parentSessionId || ownerSessionId`.
    pub(crate) fn descendants(&self, session: &str) -> Vec<String> {
        let st = self.lock();
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        for s in self.list_sessions(&st, true) {
            let id = clean(s.get("id"));
            let parent = clean(either(&s, "parentSessionId", "ownerSessionId"));
            if !id.is_empty() && !parent.is_empty() && parent != id {
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

    /// `terminalWorkerRowForTag`.
    fn terminal_row_for_tag(&self, st: &State, tag: &str, scope: &Scope) -> Option<Row> {
        let value = clean_str(tag);
        if value.is_empty() {
            return None;
        }
        st.rows(scope, self.now()).into_iter().find(|row| {
            clean(row.get("tag")) == value && is_terminal_row(row) && self.live_session_row(st, &clean(row.get("sessionId"))).is_none()
        })
    }
}

#[async_trait]
impl Registry for AgentRegistry {
    fn resolve_tombstone_owners(&self) {
        let mut st = self.lock();
        self.resolve_owners(&mut st);
    }

    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, scope: &Scope) {
        self.reload().await;        let mut st = self.lock();
        self.refresh(&mut st, scan_sessions, scope);
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

    fn tag_count(&self) -> usize {
        self.lock().tags.len()
    }

    fn tag_for_session(&self, session_id: &str) -> Option<String> {
        let st = self.lock();
        let persisted = self.live_session_row(&st, session_id).map(|s| agent_tag_of(&s)).unwrap_or_default();
        if !persisted.is_empty() {
            return Some(persisted);
        }
        st.tags.iter().find(|(_, id)| id == session_id).map(|(tag, _)| tag.clone())
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

    fn read_worker_rows(&self, scope: &Scope) -> Result<Vec<TagRecord>, String> {
        let st = self.lock();
        Ok(st.rows(scope, self.now()).iter().map(|row| tag_record(row, "tag", "sessionId")).collect())
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
        st.tombstones(self.now())
            .iter()
            .find(|row| matches_scope(row, scope) && clean(row.get("tag")) == value)
            .map(|row| tag_record(row, "tag", "sessionId"))
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
            .into_iter()
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
        let options = ResolveOptions { exclude_terminal_traces: true, ..ResolveOptions::default() };
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

/// `onSessionTurnStart(store.clearReleased)`: a turn of any origin ends the owner's release.
impl super::TurnStarts for AgentRegistry {
    fn turn_started(&self, thread: &ThreadId) {
        let id = thread.as_str();
        let mut st = self.lock();
        let Some(map) = st.map(id).filter(|m| m.contains_key("releasedAt")).cloned() else { return };
        let mut map = map;
        map.shift_remove("releasedAt");
        self.persist(&mut st, id, (!map.is_empty()).then_some(map));
    }
}

// ---- the store and the directory ------------------------------------------------------

/// [`WorkerStore`] over the index and the threads' headers. Writes are header patches, applied
/// in order by one task.
pub struct StoreWorkers {
    index: SqliteStore,
    threads: Arc<dyn ThreadState>,
    writes: mpsc::UnboundedSender<WriteOp>,
    /// Each write numbered as it is queued, reported once its patch was applied or failed.
    marks: Arc<mixdog_rt::WriteMarks>,
    io: InteractiveIo,
    /// `registry.onWorkerRowsChange` (`agent-tool.mjs`), bound once by the composition.
    signals: std::sync::OnceLock<Arc<dyn signals::StatusSignals>>,
    kept: Arc<KeptRows>,
}

/// What the writer task is asked: one session's map, a kept session's map, or to say when everything before it was applied.
/// A map from `WorkerStore::write` carries its number in [`StoreWorkers::marks`].
enum WriteOp {
    Write(String, Option<Row>, u64),
    Keep(String, Option<Row>, Option<u64>),
    Barrier(tokio::sync::oneshot::Sender<Result<(), String>>),
}

/// The worker maps of sessions deleted while their rows still count (`WorkerStore::keep`), in `state/core.sqlite`'s meta
/// (`agent-kept-worker:<session>`): they outlive the session's header and a restart, as Node's index file rows do.
pub struct KeptRows {
    state: mixdog_store::state::CoreState,
    /// The kept sessions as last loaded, with this process's keeps.
    ids: Mutex<HashSet<String>>,
    /// The kept maps, read from the table once and kept current by every [`Self::put`]: a listing reads memory. The lock
    /// is held for memory alone, never across the table's read or write: the puts come one at a time (`StoreWorkers`'
    /// one writer task), so memory follows the table in the table's order.
    rows: Mutex<Option<Vec<(String, Row)>>>,
}

const KEPT_PREFIX: &str = "agent-kept-worker:";

impl KeptRows {
    pub fn new(state: mixdog_store::state::CoreState) -> Self {
        Self { state, ids: Mutex::default(), rows: Mutex::new(None) }
    }

    fn ids(&self) -> MutexGuard<'_, HashSet<String>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn rows(&self) -> MutexGuard<'_, Option<Vec<(String, Row)>>> {
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
        let mut rows = self.rows();
        if rows.is_none() {
            self.ids().extend(out.iter().map(|(session, _)| session.clone()));
            *rows = Some(out);
        }
        Ok(())
    }

    /// Every kept map, by session.
    pub async fn load(&self) -> Result<Vec<(String, Row)>, String> {
        self.loaded().await?;
        Ok(self.rows().clone().unwrap_or_default())
    }

    pub fn holds(&self, session: &str) -> bool {
        self.ids().contains(session)
    }

    /// Writes `session`'s kept map (`None`: it is kept no more, and its row leaves the table). Memory follows the table: it
    /// changes only once the write is committed, so a failed write leaves every later listing as the table is. (Node's index
    /// queue keeps a failed write queued and retries it, `index-write-queue.mjs:231-245`; `StoreWorkers`' writer does the same.)
    pub async fn put(&self, session: &str, worker: Option<Row>) -> Result<(), String> {
        self.loaded().await?;
        let key = format!("{KEPT_PREFIX}{session}");
        let written = match &worker {
            Some(map) => {
                let text = serde_json::to_string(map).map_err(|e| e.to_string())?;
                self.state.write(move |tx| tx.put_meta(&key, &text)).await
            }
            None => self.state.write(move |tx| tx.delete_meta(&key).map(drop)).await,
        };
        written.map_err(|e| format!("kept worker row {session}: {e}"))?;
        let mut rows = self.rows();
        let kept = rows.get_or_insert_with(Vec::new);
        kept.retain(|(id, _)| id != session);
        match worker {
            Some(map) => {
                self.ids().insert(session.to_owned());
                kept.push((session.to_owned(), map));
            }
            None => {
                self.ids().remove(session);
            }
        }
        Ok(())
    }
}

/// Node's `RETRY_AFTER_FAILURE_MS`: how long a failed kept write waits for a retry when nothing else writes.
const KEPT_RETRY_AFTER: std::time::Duration = std::time::Duration::from_millis(15_000);

/// Puts the owed kept writes again, in order; those the table refuses again stay owed. The last refusal, if any.
async fn retry_owed(keeper: &KeptRows, owed: &mut Vec<(String, Option<Row>)>) -> Option<String> {
    let mut refused = None;
    for (session, worker) in std::mem::take(owed) {
        if let Err(error) = keeper.put(&session, worker.clone()).await {
            tracing::warn!(%error, "[agent] a kept worker row was not saved; it stays queued");
            refused = Some(error);
            owed.push((session, worker));
        }
    }
    refused
}

/// Whether `path` names a directory.
#[allow(clippy::disallowed_methods, reason = "runs on the interactive-io lane job (lane proof argument)")]
fn is_dir(_lane: &InLane<InteractiveIo>, path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

impl StoreWorkers {
    /// Call on the runtime the session tasks run on.
    pub fn new(index: SqliteStore, threads: Arc<dyn ThreadState>, io: InteractiveIo, kept: Arc<KeptRows>) -> Self {
        let (writes, mut rx) = mpsc::unbounded_channel::<WriteOp>();
        let (patcher, keeper) = (threads.clone(), kept.clone());
        let marks = Arc::new(mixdog_rt::WriteMarks::new("the agent index"));
        let reported = marks.clone();
        drop(mixdog_rt::spawn("agent-worker-writes", TaskClass::Work, async move {
            // Kept writes the table refused, in order, each session's newest only: they stay queued ahead of newer writes and
            // are retried by the next write, a flush (`settled`) or the retry timer, as Node's index queue requeues a failed
            // batch (`index-write-queue.mjs:231-245`).
            let mut owed: Vec<(String, Option<Row>)> = Vec::new();
            loop {
                let op = if owed.is_empty() {
                    rx.recv().await
                } else {
                    tokio::select! {
                        op = rx.recv() => op,
                        () = mixdog_rt::time::sleep(KEPT_RETRY_AFTER) => {
                            retry_owed(&keeper, &mut owed).await;
                            continue;
                        }
                    }
                };
                let Some(op) = op else { break };
                if let WriteOp::Keep(session, ..) = &op {
                    owed.retain(|(id, _)| id != session);
                }
                let refused = retry_owed(&keeper, &mut owed).await;
                let (session, worker, mark) = match op {
                    WriteOp::Write(session, worker, mark) => (session, worker, mark),
                    WriteOp::Keep(session, worker, mark) => {
                        match keeper.put(&session, worker.clone()).await {
                            Ok(()) => {
                                if let Some(mark) = mark {
                                    reported.written(mark);
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "[agent] a kept worker row was not saved; it stays queued");
                                if let Some(mark) = mark {
                                    reported.failed(mark, format!("the kept worker row of {session}: {error}"));
                                }
                                owed.push((session, worker));
                            }
                        }
                        continue;
                    }
                    WriteOp::Barrier(done) => {
                        // Node's `flush` rejects with the persist's error while a batch is unpersisted
                        // (`index-write-queue.mjs:203,259-265`); the writes stay queued for a later flush.
                        let _ = done.send(match refused {
                            Some(error) => Err(format!("{} unpersisted write(s) kept queued after retries: {error}", owed.len())),
                            None => Ok(()),
                        });
                        continue;
                    }
                };
                let thread = ThreadId::from(session.as_str());
                // A failed patch leaves the registry's own copy in force; it is retried by the
                // next write of the session.
                let patched = match worker {
                    Some(map) => {
                        let mut set = Map::new();
                        set.insert("worker".into(), Value::Object(map));
                        patcher.patch_header(&thread, set, Vec::new()).await
                    }
                    None => patcher.patch_header(&thread, Map::new(), vec!["worker".into()]).await,
                };
                match patched {
                    Ok(()) => reported.written(mark),
                    Err(error) => reported.failed(mark, format!("the worker row of {session}: {error:?}")),
                }
            }
        }));
        Self { index, threads, writes, marks, io, signals: std::sync::OnceLock::new(), kept }
    }
}

#[async_trait]
impl WorkerStore for StoreWorkers {
    /// The index's maps, then the kept maps of sessions the index no longer lists.
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        let rows = self.index.worker_rows(None, WorkerScope::All).await.map_err(|e| format!("{e:?}"))?;
        let mut maps: Vec<(String, Row)> = rows.into_iter().map(|row| (row.session, row.worker)).collect();
        let kept = self.kept.load().await?;
        let listed: HashSet<String> = maps.iter().map(|(id, _)| id.clone()).collect();
        maps.extend(kept.into_iter().filter(|(id, _)| !listed.contains(id)));
        Ok(maps)
    }

    fn keep(&self, session: &str, worker: Option<Row>) {
        if worker.is_some() {
            self.kept.ids().insert(session.to_owned());
        }
        let _ = self.writes.send(WriteOp::Keep(session.to_owned(), worker, None));
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
        mixdog_core_base::support::on_lane(self.io, &mixdog_rt::CancellationToken::new(), move |lane| is_dir(lane, &path))
            .await
            .unwrap_or(false)
    }

    fn write(&self, session: &str, worker: Option<Row>) {
        let mark = self.marks.accept();
        let op = if self.kept.holds(session) {
            WriteOp::Keep(session.to_owned(), worker, Some(mark))
        } else {
            WriteOp::Write(session.to_owned(), worker, mark)
        };
        if self.writes.send(op).is_err() {
            self.marks.withdrawn(mark);
        }
        // Node's registry announces a row change where it makes it, not when the file settles.
        if let Some(signals) = self.signals.get() {
            signals.worker_rows(session);
        }
    }
}

impl StoreWorkers {
    /// Resolves once every write made before the call is applied to the headers: the exit path awaits
    /// it after `AgentRegistry::flush_active_worker_rows` (Node's `store.flushSync()`). As Node's `flush` rejects when a
    /// batch could not be persisted, this is `Err` while a kept write is still owed; the write stays queued.
    pub async fn settled(&self) -> Result<(), String> {
        let (done, applied) = tokio::sync::oneshot::channel();
        self.writes.send(WriteOp::Barrier(done)).map_err(|_| "the worker writer is closed".to_owned())?;
        applied.await.map_err(|_| "the worker writer ended before the flush".to_owned())?
    }

    /// The writes' numbers: a barrier takes `accepted()` when it arrives and waits for `reached` of it, every write made
    /// before it applied to the headers (after `AgentRegistry::flush_active_worker_rows`, Node's `store.flushSync()`).
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

    fn running(&self, session: &str) -> bool {
        self.handle(&ThreadId::from(session)).is_some_and(|h| h.cell.run.load().as_ref().is_some_and(|run| !run.cancel.is_aborted()))
    }

    fn has_live_work(&self, session: &str) -> bool {
        self.running(session) || self.handle(&ThreadId::from(session)).is_some_and(|h| !h.cell.queued.load().is_empty())
    }

    fn runtime_stage(&self, session: &str) -> Option<String> {
        self.handle(&ThreadId::from(session))?.cell.progress.borrow().stage()
    }
}
