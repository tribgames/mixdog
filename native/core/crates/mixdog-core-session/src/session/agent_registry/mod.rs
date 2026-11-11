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
mod views;
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
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering as AtomicOrdering;

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
use self::views::Maps;
use self::views::Tags;
use self::views::Views;
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
    /// call order.
    fn write(&self, session: &str, worker: Option<Row>);
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
    /// Held while the index is loaded; `loads_started` counts the loads begun.
    loading: tokio::sync::Mutex<()>,
    loads_started: AtomicU64,
}

#[derive(Default)]
struct State {
    /// `tags` (insertion order), `tagAgents`, `tagCwds`.
    tags: Tags,
    tag_agents: HashMap<String, String>,
    tag_cwds: HashMap<String, String>,
    /// Bumped whenever `tags`, `tag_agents` or `tag_cwds` change.
    tag_generation: u64,
    /// Every session's worker map: the index as last loaded, with this process's writes.
    maps: Maps,
    /// Writes the loaded index did not show yet.
    pending: HashMap<String, Option<Row>>,
    /// The agent-only sessions as last loaded.
    sessions: Vec<Row>,
    /// The first of `sessions` with each id.
    session_at: HashMap<String, usize>,
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
    /// Bumped when the views must start over (the maps replaced, a legacy owner recovered).
    epoch: u64,
    /// The reads of the index as shared views, following each write (views.rs).
    views: RefCell<Views>,
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
fn sessions_by_id(sessions: &[Row]) -> HashMap<String, usize> {
    let mut at = HashMap::new();
    for (i, session) in sessions.iter().enumerate() {
        at.entry(clean(session.get("id"))).or_insert(i);
    }
    at
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
        Self { store, live, reap, clock, state: Mutex::new(State::default()), loading: tokio::sync::Mutex::new(()), loads_started: AtomicU64::new(0) }
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
    /// under way waits for the next one and shares it with the others that wait (it reads the store after the caller
    /// arrived), so the threads one status signal wakes load the index once or twice, not once each.
    async fn reload(&self) {
        let arrived = self.loads_started.load(AtomicOrdering::SeqCst);
        let _turn = self.loading.lock().await;
        if self.loads_started.load(AtomicOrdering::SeqCst) > arrived {
            return;
        }
        self.loads_started.fetch_add(1, AtomicOrdering::SeqCst);
        self.load().await;
    }

    async fn load(&self) {
        let (Ok(maps), Ok(sessions)) = (self.store.worker_maps().await, self.store.agent_sessions().await) else {
            return;
        };
        #[cfg(test)]
        work::note(|c| c.reloads += 1);
        let mut guard = self.lock();
        let st = &mut *guard;
        // The same sessions in the same order (the usual load): one pass over the maps finds those that differ. A session
        // this process wrote that the store does not show yet stays as written; one it shows now is no longer pending.
        let maps = match st.maps.differing(maps) {
            Ok(differ) => {
                let mut held = HashSet::new();
                for (id, map) in differ {
                    if st.pending.contains_key(&id) {
                        held.insert(id);
                        continue;
                    }
                    st.maps.set(&id, Some(map));
                    st.views.get_mut().touched(&id);
                }
                st.pending.retain(|id, _| held.contains(id));
                None
            }
            Err(maps) => Some(maps),
        };
        if let Some(maps) = maps {
            Self::rebuild(st, maps);
        }
        Self::load_sessions(st, sessions);
    }

    /// The maps of a load whose sessions or order differ from the held ones, with the pending writes applied on top.
    fn rebuild(st: &mut State, maps: Vec<(String, Row)>) {
        // The index as loaded, with this process's writes it does not show yet applied on top.
        let mut next = Maps::from_vec(maps);
        let pending: Vec<(String, Option<Row>)> = st.pending.drain().collect();
        for (session, map) in pending {
            if next.get(&session) == map.as_ref() {
                continue;
            }
            next.set(&session, map.clone());
            st.pending.insert(session, map);
        }
        if !st.maps.same_as(&next) {
            if st.maps.same_order(&next) {
                // The same sessions in the same order: only the maps that differ are read again.
                let differ: Vec<(String, Row)> = next
                    .iter()
                    .filter(|(id, map)| {
                        #[cfg(test)]
                        work::note(|c| c.maps_compared += 1);
                        st.maps.get(id) != Some(*map)
                    })
                    .map(|(id, map)| (id.clone(), map.clone()))
                    .collect();
                for (id, map) in differ {
                    st.maps.set(&id, Some(map));
                    st.views.get_mut().touched(&id);
                }
            } else {
                st.maps = next;
                st.changed();
            }
        }
    }

    fn load_sessions(st: &mut State, sessions: Vec<Row>) {
        let same_sessions = st.sessions.len() == sessions.len()
            && st.sessions.iter().zip(&sessions).all(|(a, b)| {
                #[cfg(test)]
                work::note(|c| c.sessions_compared += 1);
                a == b
            });
        if !same_sessions {
            let before = std::mem::take(&mut st.session_at);
            let old = std::mem::replace(&mut st.sessions, sessions);
            st.session_at = sessions_by_id(&st.sessions);
            // A tag's session read from the stored rows is read again when its row changed.
            let mut changed: HashSet<&String> = st.session_at.iter().filter(|(id, at)| before.get(*id).map(|was| &old[*was]) != Some(&st.sessions[**at])).map(|(id, _)| id).collect();
            changed.extend(before.keys().filter(|id| !st.session_at.contains_key(*id)));
            let views = st.views.get_mut();
            for id in changed {
                for tag in st.tags.of_session(id) {
                    views.facts.touch(&tag);
                }
            }
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
        #[cfg(test)]
        work::note(|c| c.sessions_visited += 1);
        self.loaded_session(id).or_else(|| {
            let at = *st.session_at.get(id)?;
            #[cfg(test)]
            work::note(|c| c.sessions_visited += 1);
            Some(st.sessions[at].clone())
        })
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

    /// `transitionStaleNonterminalRows`.
    fn transition_stale(&self, st: &mut State, scope: &Scope) {
        let stale = self.stale_rows(st, scope);
        self.tombstone_rows(st, &stale);
    }

    /// The scope's rows `transitionStaleNonterminalRows` turns into tombstones now.
    fn stale_rows(&self, st: &State, scope: &Scope) -> Vec<Row> {
        let now = self.now();
        let reap = self.reap_ms();
        // Only a row not settled, or settled a day ago, can be stale (`pastSettledRetention`).
        st
            .stale_candidates(scope, now)
            .into_iter()
            .filter(|row| {
                #[cfg(test)]
                work::note(|c| c.rows_visited += 1);
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
            .map(|row| (*row).clone())
            .collect()
    }

    /// `refreshTagsFromSessions` over the index as loaded.
    fn refresh(&self, st: &mut State, scan_sessions: bool, scope: &Scope) {
        self.resolve_owners(st);
        self.transition_stale(st, scope);
        let now = self.now();
        for row in st.rows_to_bind(scope, now) {
            #[cfg(test)]
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
        if !scan_sessions {
            return;
        }
        let by_key = st.tombstone_index(now);
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
            let listed_tag = Some(agent_tag_of(&session)).filter(|t| !t.is_empty()).unwrap_or_else(|| clean_str(&tag));
            let sid = clean(session.get("id"));
            if listed_tag.is_empty() || sid.is_empty() || session.get("closed") == Some(&Value::Bool(true)) {
                continue;
            }
            if is_lead_pool_agent(session.get("agent")) || !matches_scope(&session, scope) || st.lists_row(scope, &sid, now) || !added.insert(sid) {
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
                    #[cfg(test)]
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
        st.rows(scope, self.now())
            .iter()
            .find(|row| clean(row.get("tag")) == value && is_terminal_row(row) && self.live_session_row(st, &clean(row.get("sessionId"))).is_none())
            .cloned()
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
}

/// What the writer task is asked: one session's map, with its number in [`StoreWorkers::marks`].
struct WriteOp(String, Option<Row>, u64);

/// Whether `path` names a directory.
#[allow(clippy::disallowed_methods, reason = "runs on the interactive-io lane job (lane proof argument)")]
fn is_dir(_lane: &InLane<InteractiveIo>, path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

impl StoreWorkers {
    /// Call on the runtime the session tasks run on.
    pub fn new(index: SqliteStore, threads: Arc<dyn ThreadState>, io: InteractiveIo) -> Self {
        let (writes, mut rx) = mpsc::unbounded_channel::<WriteOp>();
        let patcher = threads.clone();
        let marks = Arc::new(mixdog_rt::WriteMarks::new("the agent index"));
        let reported = marks.clone();
        drop(mixdog_rt::spawn("agent-worker-writes", TaskClass::Work, async move {
            while let Some(WriteOp(session, worker, mark)) = rx.recv().await {
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
        Self { index, threads, writes, marks, io, signals: std::sync::OnceLock::new() }
    }
}

#[async_trait]
impl WorkerStore for StoreWorkers {
    async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
        let rows = self.index.worker_rows(None, WorkerScope::All).await.map_err(|e| format!("{e:?}"))?;
        Ok(rows.into_iter().map(|row| (row.session, row.worker)).collect())
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
        if self.writes.send(WriteOp(session.to_owned(), worker, mark)).is_err() {
            self.marks.withdrawn(mark);
        }
        // Node's registry announces a row change where it makes it, not when the file settles.
        if let Some(signals) = self.signals.get() {
            signals.worker_rows(session);
        }
    }
}

impl StoreWorkers {
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
