//! The registry's reads of the worker index as shared views that follow each write
//! (`row-reads.mjs` keeps its projections on the store's arrays the same way).
//!
//! A status signal makes every loaded thread re-read its agents. Each re-read used to copy every
//! row and tombstone of the index, and to look every bound tag's session up again; here a read
//! hands out the views kept, and a write changes only what depends on the row it wrote:
//!
//! - each session's row and stored tombstone, as readers see them, are kept per session
//!   ([`Derived`]); a write recomputes the written session's alone;
//! - a scope's rows ([`ScopeView`]) are kept per scope key and take the written row out or in;
//! - the tombstone list, the owners recovered for legacy tombstones and the newest tombstone of
//!   each key ([`Tombs`]) are rebuilt when a tombstone changed (a reap, a consumed tag);
//! - what a refresh's unbinding pass and a listing's tag pass read of a tag's session
//!   ([`TagFacts`]) is kept while that session is not loaded and nothing it was read from changed;
//!   a loaded session is read again by every re-read, as its live state has no version.
//!
//! Every view belongs to one window of the clock (`State::window_at`): a release marker or a
//! tombstone that ends, or a tombstone stamped in the future, starts the views over.

use std::cell::RefMut;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::clean;
use serde_json::Value;

use super::State;
use super::Window;
use super::identity;
use super::is_legacy;
use super::rows::*;

/// A clock instant as a key.
#[derive(Clone, Copy, Debug)]
pub(super) struct Ms(pub(super) f64);

impl PartialEq for Ms {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Ms {}

impl PartialOrd for Ms {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Ms {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

// ---- the maps and the tags ------------------------------------------------------------------

/// The worker maps in index order (newest session first), each found by its session at once.
#[derive(Default)]
pub(super) struct Maps {
    by_id: HashMap<String, (i64, Row)>,
    order: BTreeMap<i64, String>,
    /// The order key of the next session added in front.
    front: i64,
}

impl Maps {
    /// The maps in the order given.
    pub(super) fn from_vec(maps: Vec<(String, Row)>) -> Self {
        let mut out = Maps { front: -1, ..Maps::default() };
        for (at, (id, map)) in maps.into_iter().enumerate() {
            if out.by_id.contains_key(&id) {
                continue;
            }
            out.order.insert(at as i64, id.clone());
            out.by_id.insert(id, (at as i64, map));
        }
        #[cfg(test)]
        work::note(|c| c.maps_rebuilt += out.len());
        out
    }

    pub(super) fn get(&self, id: &str) -> Option<&Row> {
        self.by_id.get(id).map(|(_, map)| map)
    }

    /// The session's place in the order.
    pub(super) fn key(&self, id: &str) -> Option<i64> {
        self.by_id.get(id).map(|(key, _)| *key)
    }

    pub(super) fn len(&self) -> usize {
        self.by_id.len()
    }

    /// `(session, map)` in index order.
    pub(super) fn iter(&self) -> impl Iterator<Item = (&String, &Row)> + '_ {
        self.order.values().map(move |id| (id, &self.by_id[id].1))
    }

    /// The session's map replaced in place, removed, or added in front.
    pub(super) fn set(&mut self, id: &str, map: Option<Row>) {
        match map {
            Some(map) => match self.by_id.get_mut(id) {
                Some(entry) => entry.1 = map,
                None => {
                    let key = self.front;
                    self.front -= 1;
                    self.order.insert(key, id.to_owned());
                    self.by_id.insert(id.to_owned(), (key, map));
                }
            },
            None => {
                if let Some((key, _)) = self.by_id.remove(id) {
                    self.order.remove(&key);
                }
            }
        }
    }

    /// The loaded maps that differ from the held ones when they list the same sessions in the same order (one pass);
    /// otherwise the loaded maps back.
    pub(super) fn differing(&self, loaded: Vec<(String, Row)>) -> Result<Vec<(String, Row)>, Vec<(String, Row)>> {
        if self.len() != loaded.len() {
            return Err(loaded);
        }
        let mut held = self.order.values();
        let mut differ = Vec::new();
        for (at, (id, map)) in loaded.iter().enumerate() {
            #[cfg(test)]
            work::note(|c| c.maps_compared += 1);
            if held.next() != Some(id) {
                return Err(loaded);
            }
            if self.get(id) != Some(map) {
                differ.push(at);
            }
        }
        Ok(loaded.into_iter().enumerate().filter(|(at, _)| differ.binary_search(at).is_ok()).map(|(_, entry)| entry).collect())
    }

    /// The same sessions in the same order with the same maps.
    pub(super) fn same_as(&self, other: &Maps) -> bool {
        self.len() == other.len()
            && self.iter().zip(other.iter()).all(|(a, b)| {
                #[cfg(test)]
                work::note(|c| c.maps_compared += 1);
                a == b
            })
    }

    /// The same sessions in the same order.
    pub(super) fn same_order(&self, other: &Maps) -> bool {
        self.len() == other.len() && self.order.values().zip(other.order.values()).all(|(a, b)| a == b)
    }

    #[cfg(test)]
    pub(super) fn to_vec(&self) -> Vec<(String, Row)> {
        self.iter().map(|(id, map)| (id.clone(), map.clone())).collect()
    }
}

/// `tags` (tag → session) in insertion order, with the tags each session holds.
#[derive(Default)]
pub(super) struct Tags {
    by_tag: HashMap<String, (u64, String)>,
    order: BTreeMap<u64, String>,
    next: u64,
    by_session: HashMap<String, BTreeSet<u64>>,
}

impl Tags {
    pub(super) fn get(&self, tag: &str) -> Option<&String> {
        self.by_tag.get(tag).map(|(_, session)| session)
    }

    pub(super) fn order_of(&self, tag: &str) -> Option<u64> {
        self.by_tag.get(tag).map(|(at, _)| *at)
    }

    pub(super) fn len(&self) -> usize {
        self.by_tag.len()
    }

    /// `(tag, session)` in insertion order.
    pub(super) fn iter(&self) -> impl Iterator<Item = (&String, &String)> + '_ {
        self.order.values().map(move |tag| (tag, &self.by_tag[tag].1))
    }

    /// The tags `session` holds, in insertion order.
    pub(super) fn of_session(&self, session: &str) -> Vec<String> {
        self.by_session.get(session).map(|at| at.iter().map(|at| self.order[at].clone()).collect()).unwrap_or_default()
    }

    /// The tag bound to `session` first.
    pub(super) fn first_of(&self, session: &str) -> Option<&String> {
        self.by_session.get(session)?.first().map(|at| &self.order[at])
    }

    /// The tag's session set (in place when bound); whether it changed.
    pub(super) fn set(&mut self, tag: &str, session: &str) -> bool {
        if let Some((at, bound)) = self.by_tag.get_mut(tag) {
            if *bound == session {
                return false;
            }
            let (at, old) = (*at, std::mem::replace(bound, session.to_owned()));
            self.unlink(&old, at);
            self.by_session.entry(session.to_owned()).or_default().insert(at);
            return true;
        }
        let at = self.next;
        self.next += 1;
        self.order.insert(at, tag.to_owned());
        self.by_tag.insert(tag.to_owned(), (at, session.to_owned()));
        self.by_session.entry(session.to_owned()).or_default().insert(at);
        true
    }

    /// The tag unbound; its session when it was bound.
    pub(super) fn remove(&mut self, tag: &str) -> Option<String> {
        let (at, session) = self.by_tag.remove(tag)?;
        self.order.remove(&at);
        self.unlink(&session, at);
        Some(session)
    }

    fn unlink(&mut self, session: &str, at: u64) {
        if let Some(held) = self.by_session.get_mut(session) {
            held.remove(&at);
            if held.is_empty() {
                self.by_session.remove(session);
            }
        }
    }
}

// ---- the views ------------------------------------------------------------------------------

/// A session's row and stored tombstone as readers see them in the views' window.
#[derive(Clone, Default, PartialEq)]
pub(super) struct Derived {
    /// The session's place in the index order.
    key: i64,
    row: Option<Arc<Row>>,
    tombstone: Option<Arc<Row>>,
}

/// The tombstone reads: the stored tombstones (newest first, capped), with the owners recovered so
/// far, and the newest of each key.
struct Tombs {
    stored: Arc<Vec<Row>>,
    tombstones: Arc<Vec<Row>>,
    index: Arc<HashMap<String, Row>>,
}

/// A scope's row as a listing reads it: the row, its tag and the session it stands for
/// (`workerRowToSession`).
#[derive(Clone)]
pub(super) struct Listed {
    pub(super) row: Arc<Row>,
    pub(super) tag: String,
    pub(super) session: Arc<Row>,
}

impl Listed {
    fn of(row: &Arc<Row>) -> Listed {
        #[cfg(test)]
        work::note(|c| c.rows_visited += 1);
        Listed { row: row.clone(), tag: clean(row.get("tag")), session: Arc::new(row_to_session(row)) }
    }
}

/// `readWorkerRows(context)`: the rows of one scope no tombstone blocks, in index order, shared by
/// every reader until a write changes them.
#[derive(Clone, Default)]
pub(super) struct RowsView(Arc<BTreeMap<i64, Listed>>);

impl RowsView {
    pub(super) fn iter(&self) -> impl Iterator<Item = &Row> + '_ {
        self.0.values().map(|listed| &*listed.row)
    }

    pub(super) fn listed(&self) -> impl Iterator<Item = &Listed> + '_ {
        self.0.values()
    }

    fn contains(&self, key: i64) -> bool {
        self.0.contains_key(&key)
    }
}

/// A copy of every row, for a reader that keeps them.
impl IntoIterator for RowsView {
    type Item = Row;
    type IntoIter = std::vec::IntoIter<Row>;

    fn into_iter(self) -> Self::IntoIter {
        #[cfg(test)]
        work::note(|c| c.rows_copied += self.0.len());
        self.0.values().map(|listed| (*listed.row).clone()).collect::<Vec<_>>().into_iter()
    }
}

/// What the agent status lists of a row by itself: `isActiveWorkerRow` over the `rowState` of the
/// session the row stands for. That session always has a stage of its own, so the live runtime's
/// never decides.
fn listed_active(session: &Row) -> bool {
    let text = |key: &str| session.get(key).filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string);
    match text("stage") {
        Some(stage) => {
            let status = text("status").unwrap_or_else(|| "idle".to_owned());
            mixdog_agent::agent_tool::views::is_active_worker(&status, &stage)
        }
        None => true,
    }
}

/// The instant a settled row can first be past its retention (`pastSettledRetention` needs a day
/// since it settled), a millisecond early so rounding never hides one.
fn settling_from(row: &Row) -> Option<Ms> {
    let settled = session_activity_at(row);
    (settled > 0.0).then(|| Ms(settled + SETTLED_ROW_RETENTION_MS - 1.0))
}

/// One scope's rows, with what a refresh and the status read look at in them kept apart.
struct ScopeView {
    scope: Scope,
    rows: RowsView,
    /// The rows not settled: a refresh checks each for staleness.
    working: BTreeSet<i64>,
    /// The settled rows, by the instant each can first be stale.
    settling: BTreeSet<(Ms, i64)>,
    /// The rows the agent status lists.
    active: BTreeSet<i64>,
    /// The tags whose rows changed since the scope's rows were last bound.
    rebind: BTreeSet<String>,
    /// The scope's rows of each tag, so a bind finds the rows of the tags that changed without a walk of the rest.
    by_tag: HashMap<String, BTreeSet<i64>>,
    /// The tag generation right after the scope's rows were last bound.
    bound: Option<u64>,
}

impl ScopeView {
    fn new(scope: Scope) -> Self {
        ScopeView {
            scope,
            rows: RowsView::default(),
            working: BTreeSet::new(),
            settling: BTreeSet::new(),
            active: BTreeSet::new(),
            rebind: BTreeSet::new(),
            by_tag: HashMap::new(),
            bound: None,
        }
    }

    fn insert(&mut self, key: i64, listed: Listed) {
        if is_terminal_row(&listed.row) {
            if let Some(from) = settling_from(&listed.row) {
                self.settling.insert((from, key));
            }
        } else {
            self.working.insert(key);
        }
        if listed_active(&listed.session) {
            self.active.insert(key);
        }
        self.rebind.insert(listed.tag.clone());
        self.by_tag.entry(listed.tag.clone()).or_default().insert(key);
        Arc::make_mut(&mut self.rows.0).insert(key, listed);
    }

    fn remove(&mut self, key: i64) {
        if !self.rows.0.contains_key(&key) {
            return;
        }
        let Some(listed) = Arc::make_mut(&mut self.rows.0).remove(&key) else { return };
        self.working.remove(&key);
        if let Some(from) = settling_from(&listed.row) {
            self.settling.remove(&(from, key));
        }
        self.active.remove(&key);
        if let Some(keys) = self.by_tag.get_mut(&listed.tag) {
            keys.remove(&key);
            if keys.is_empty() {
                self.by_tag.remove(&listed.tag);
            }
        }
        self.rebind.insert(listed.tag);
    }
}

/// The scope key: what `rowMatchesContext` reads of a scope.
fn scope_key(scope: &Scope) -> String {
    match (&scope.caller_session_id, scope.host_pid) {
        (Some(caller), _) => format!("s\0{caller}"),
        (None, Some(pid)) => format!("p\0{pid}"),
        (None, None) => "*".to_owned(),
    }
}

/// A scope view is rebuilt when a reader meets a new scope; past this many the kept ones go.
const SCOPED_VIEWS_MAX: usize = 256;

/// `tombstoneBlocksWork(row, findTagTombstone(row, index, tag))`.
pub(super) fn blocked(row: &Row, index: &HashMap<String, Row>) -> bool {
    let tag = clean(either(row, "tag", "agentTag"));
    blocks_work(row, find_tombstone(row, index, &tag))
}

/// The owner a caller scope must name to see a row or a session (`Scope::owns`).
pub(super) fn owner_key(row: &Row) -> String {
    let owner = owner_of(row);
    let held = if clean_str(&owner.parent_session_id).is_empty() { owner.owner_session_id } else { owner.parent_session_id };
    clean_str(&held)
}

fn clean_str(value: &str) -> String {
    mixdog_agent::agent_tool::scope::clean_str(value)
}

/// What a refresh's unbinding pass and a listing's tag pass read of a bound tag's session:
/// `getLiveSession` (`None`: none, or closed) and the scan guard (`tombstoneBlocksScan`).
#[derive(Clone)]
pub(super) struct Facts {
    pub(super) session: Option<Arc<Row>>,
    pub(super) blocks: bool,
}

impl Facts {
    /// The unbinding pass lets the tag go.
    pub(super) fn unbinds(&self) -> bool {
        self.session.is_none() || self.blocks
    }
}

/// The facts of a tag whose session is not loaded, while nothing they were read from changed.
struct Memo {
    session_id: String,
    facts: Facts,
    /// The clock instants the facts hold for: `from <= now < until`.
    from: f64,
    until: f64,
    /// The owner of the unblocked row `(tag, session)`, when there is one: a refresh of that
    /// owner keeps the tag bound whatever its session reads (`indexedKeys`).
    guard: Option<String>,
    /// The owner whose listing may add the session (`agentSessionEntries` `add`), when its row
    /// does not list it already.
    lists_for: Option<String>,
}

/// The kept facts of the bound tags whose sessions are not loaded.
#[derive(Default)]
pub(super) struct TagFacts {
    /// Every bound tag was looked at once since the views were made.
    ready: bool,
    memo: HashMap<String, Memo>,
    /// Tags to look at again: no memo, or an input of theirs changed.
    stale: HashSet<String>,
    /// Memos that end with the clock: their `until`, with the tag.
    ends: BTreeSet<(Ms, String)>,
    /// The tags whose memo unbinds, by the owner whose refresh keeps them (`None`: none does).
    unbind: HashMap<Option<String>, BTreeSet<String>>,
    /// The tags a listing of an owner may add.
    lists: HashMap<String, BTreeSet<String>>,
    /// The sessions loaded at the last pass, and its clock.
    loaded: HashSet<String>,
    last_now: f64,
}

impl TagFacts {
    fn forget(&mut self, tag: &str) {
        let Some(memo) = self.memo.remove(tag) else { return };
        if memo.until.is_finite() {
            self.ends.remove(&(Ms(memo.until), tag.to_owned()));
        }
        if memo.facts.unbinds()
            && let Some(set) = self.unbind.get_mut(&memo.guard)
        {
            set.remove(tag);
            if set.is_empty() {
                self.unbind.remove(&memo.guard);
            }
        }
        if let Some(owner) = &memo.lists_for
            && let Some(set) = self.lists.get_mut(owner)
        {
            set.remove(tag);
            if set.is_empty() {
                self.lists.remove(owner);
            }
        }
    }

    /// The tag is read again at the next pass.
    pub(super) fn touch(&mut self, tag: &str) {
        self.forget(tag);
        if self.ready {
            self.stale.insert(tag.to_owned());
        }
    }

    /// The tag is no longer bound.
    pub(super) fn drop_tag(&mut self, tag: &str) {
        self.forget(tag);
        self.stale.remove(tag);
    }

    fn keep(&mut self, tag: &str, memo: Memo) {
        if memo.until.is_finite() {
            self.ends.insert((Ms(memo.until), tag.to_owned()));
        }
        if memo.facts.unbinds() {
            self.unbind.entry(memo.guard.clone()).or_default().insert(tag.to_owned());
        }
        if let Some(owner) = &memo.lists_for {
            self.lists.entry(owner.clone()).or_default().insert(tag.to_owned());
        }
        self.memo.insert(tag.to_owned(), memo);
    }
}

/// The views of the index the reads hand out, for one window of the clock.
#[derive(Default)]
pub(super) struct Views {
    /// The epoch and the window the views belong to; `None`: none made yet.
    window: Option<(u64, Window)>,
    /// Sessions written since the views were brought up to date, in write order.
    dirty: Vec<String>,
    dirty_set: HashSet<String>,
    derived: HashMap<String, Derived>,
    all_rows: Option<Arc<Vec<Row>>>,
    tombs: Option<Tombs>,
    scoped: HashMap<String, ScopeView>,
    /// Every legacy tombstone of the index has its owner looked up (`resolve_owners`).
    pub(super) owners_resolved: bool,
    pub(super) facts: TagFacts,
}

impl Views {
    /// A session was written: its row and tombstone are read again before the next read.
    pub(super) fn touched(&mut self, session: &str) {
        if self.dirty_set.insert(session.to_owned()) {
            self.dirty.push(session.to_owned());
        }
    }
}

impl State {
    /// The views for `now`: started over when the epoch moved or `now` left their window, else
    /// brought up to date with the sessions written since.
    pub(super) fn views(&self, now: f64) -> RefMut<'_, Views> {
        let mut views = self.views.borrow_mut();
        if !views.window.is_some_and(|(epoch, window)| epoch == self.epoch && window.holds(now)) {
            *views = Views { window: Some((self.epoch, self.window_at(now))), ..Views::default() };
            for (id, map) in self.maps.iter() {
                let derived = self.derive(id, map, now);
                views.derived.insert(id.clone(), derived);
            }
        } else if !views.dirty.is_empty() {
            self.catch_up(&mut views, now);
        }
        views
    }

    fn derive(&self, id: &str, map: &Row, now: f64) -> Derived {
        Derived {
            key: self.maps.key(id).unwrap_or_default(),
            row: self.row(id, map, now).map(Arc::new),
            tombstone: map.get("tombstone").and_then(Value::as_object).and_then(|t| normalize_tombstone(t, id, now)).map(Arc::new),
        }
    }

    /// The written sessions read again: a changed tombstone rebuilds the tombstone reads (and the
    /// scope views, whose rows it may block), a changed row moves in or out of each scope view.
    fn catch_up(&self, views: &mut Views, now: f64) {
        let dirty = std::mem::take(&mut views.dirty);
        views.dirty_set.clear();
        let Some((epoch, mut window)) = views.window else { return };
        let mut tombstones_changed = false;
        let mut moved: Vec<(String, Option<Derived>, Option<Derived>)> = Vec::new();
        for id in dirty {
            let next = self.maps.get(&id).map(|map| {
                constrain(&mut window, map, now);
                self.derive(&id, map, now)
            });
            let prev = views.derived.remove(&id);
            if let Some(next) = &next {
                views.derived.insert(id.clone(), next.clone());
            }
            let tombstone = |d: &Option<Derived>| d.as_ref().and_then(|d| d.tombstone.clone());
            tombstones_changed |= tombstone(&prev) != tombstone(&next);
            let row = |d: &Option<Derived>| d.as_ref().and_then(|d| d.row.clone().map(|row| (d.key, row)));
            if row(&prev) != row(&next) {
                moved.push((id, prev, next));
            }
        }
        views.window = Some((epoch, window));
        if !moved.is_empty() {
            views.all_rows = None;
        }
        if tombstones_changed {
            views.tombs = None;
            views.scoped.clear();
            views.owners_resolved = false;
            views.facts.ready = false;
            return;
        }
        for (id, _, _) in &moved {
            for tag in self.tags.of_session(id) {
                views.facts.touch(&tag);
            }
        }
        // With no tombstone reads made there is no scope view either.
        let Some(index) = views.tombs.as_ref().map(|t| t.index.clone()) else { return };
        for (_, prev, next) in moved {
            let row = next.as_ref().and_then(|d| d.row.clone().map(|row| (d.key, row)));
            let listed = row.as_ref().filter(|(_, row)| !blocked(row, &index)).map(|(key, row)| (*key, Listed::of(row)));
            for view in views.scoped.values_mut() {
                if let Some(prev) = &prev {
                    view.remove(prev.key);
                }
                if let Some((key, listed)) = &listed {
                    #[cfg(test)]
                    work::note(|c| c.rows_scoped += 1);
                    if matches_scope(&listed.row, &view.scope) {
                        view.insert(*key, listed.clone());
                    }
                }
            }
        }
    }

    fn tombs<'a>(&self, views: &'a mut Views) -> &'a Tombs {
        if views.tombs.is_none() {
            let rows: Vec<Row> = self
                .maps
                .iter()
                .filter_map(|(id, _)| views.derived.get(id).and_then(|d| d.tombstone.as_deref()).cloned())
                .collect();
            let stored = order_tombstones(rows);
            let tombstones: Vec<Row> = stored
                .iter()
                .map(|row| match self.owners.get(&identity(row)) {
                    Some(Some(fields)) if is_legacy(row) => {
                        let mut out = row.clone();
                        out.extend(fields.clone());
                        out
                    }
                    _ => row.clone(),
                })
                .collect();
            let mut index = HashMap::new();
            for row in &tombstones {
                index.entry(tombstone_key(row)).or_insert_with(|| row.clone());
            }
            #[cfg(test)]
            work::note(|c| c.tombstones_copied += stored.len() + tombstones.len() + index.len());
            views.tombs = Some(Tombs { stored: Arc::new(stored), tombstones: Arc::new(tombstones), index: Arc::new(index) });
        }
        views.tombs.as_ref().expect("built above")
    }

    /// `readAllWorkerRows`.
    pub(super) fn all_rows(&self, now: f64) -> Arc<Vec<Row>> {
        let mut views = self.views(now);
        if views.all_rows.is_none() {
            let rows: Vec<Row> = self.maps.iter().filter_map(|(id, _)| views.derived.get(id).and_then(|d| d.row.as_deref()).cloned()).collect();
            #[cfg(test)]
            work::note(|c| c.rows_copied += rows.len());
            views.all_rows = Some(Arc::new(rows));
        }
        views.all_rows.clone().expect("built above")
    }

    /// The stored tombstones, newest first and capped (`store.readTombstones`).
    pub(super) fn stored_tombstones(&self, now: f64) -> Arc<Vec<Row>> {
        let mut views = self.views(now);
        self.tombs(&mut views).stored.clone()
    }

    /// `readAllTagTombstones`: legacy tombstones with the owner resolved so far.
    pub(super) fn tombstones(&self, now: f64) -> Arc<Vec<Row>> {
        let mut views = self.views(now);
        self.tombs(&mut views).tombstones.clone()
    }

    /// `tagTombstoneIndex`: the newest tombstone of each key.
    pub(super) fn tombstone_index(&self, now: f64) -> Arc<HashMap<String, Row>> {
        let mut views = self.views(now);
        self.tombs(&mut views).index.clone()
    }

    /// The scope's view, made when a reader first meets the scope.
    fn scope_view<'a>(&self, views: &'a mut Views, scope: &Scope) -> &'a mut ScopeView {
        let key = scope_key(scope);
        if !views.scoped.contains_key(&key) {
            let index = self.tombs(views).index.clone();
            let mut view = ScopeView::new(scope.clone());
            for (id, _) in self.maps.iter() {
                let Some(derived) = views.derived.get(id) else { continue };
                let Some(row) = &derived.row else { continue };
                #[cfg(test)]
                work::note(|c| c.rows_scoped += 1);
                if matches_scope(row, scope) && !blocked(row, &index) {
                    view.insert(derived.key, Listed::of(row));
                }
            }
            if views.scoped.len() >= SCOPED_VIEWS_MAX {
                views.scoped.clear();
            }
            views.scoped.insert(key.clone(), view);
        }
        views.scoped.get_mut(&key).expect("made above")
    }

    /// `readWorkerRows(context)`: a row a tombstone still blocks never reads as work.
    pub(super) fn rows(&self, scope: &Scope, now: f64) -> RowsView {
        let mut views = self.views(now);
        self.scope_view(&mut views, scope).rows.clone()
    }

    /// The session's row, when no tombstone blocks it (the one row of `rows(all)` it can have).
    pub(super) fn indexed_row(&self, session: &str, now: f64) -> Option<Arc<Row>> {
        let mut views = self.views(now);
        let row = views.derived.get(session)?.row.clone()?;
        let index = self.tombs(&mut views).index.clone();
        (!blocked(&row, &index)).then_some(row)
    }

    /// The rows of the scope a refresh checks for staleness (`transitionStaleNonterminalRows`):
    /// every row not settled, and every settled row a day past its settling; in index order.
    pub(super) fn stale_candidates(&self, scope: &Scope, now: f64) -> Vec<Arc<Row>> {
        let mut views = self.views(now);
        let view = self.scope_view(&mut views, scope);
        let mut keys: Vec<i64> = view.working.iter().copied().collect();
        keys.extend(view.settling.range(..=(Ms(now), i64::MAX)).map(|(_, key)| *key));
        keys.sort_unstable();
        keys.iter().filter_map(|key| view.rows.0.get(key)).map(|listed| listed.row.clone()).collect()
    }

    /// The scope's rows a refresh binds (`refreshTagsFromIndex`): all of them the first time, and
    /// while no tag changed since, only those whose tag had a row change (binding the rest again
    /// changes nothing).
    pub(super) fn rows_to_bind(&self, scope: &Scope, now: f64) -> Vec<Arc<Row>> {
        let mut views = self.views(now);
        let generation = self.tag_generation;
        let view = self.scope_view(&mut views, scope);
        let all = view.bound != Some(generation);
        let rebind = std::mem::take(&mut view.rebind);
        let visit = |listed: &Listed| {
            #[cfg(test)]
            work::note(|c| c.rows_visited += 1);
            listed.row.clone()
        };
        if all {
            return view.rows.listed().map(visit).collect();
        }
        // The rows of different tags are different rows: sorting the keys gives index order.
        let mut keys: Vec<i64> = rebind.iter().filter_map(|tag| view.by_tag.get(tag)).flatten().copied().collect();
        keys.sort_unstable();
        keys.iter().filter_map(|key| view.rows.0.get(key)).map(visit).collect()
    }

    /// The scope's rows were bound: the tags stand as they did after it.
    pub(super) fn bound(&self, scope: &Scope, now: f64) {
        let mut views = self.views(now);
        let generation = self.tag_generation;
        self.scope_view(&mut views, scope).bound = Some(generation);
    }

    /// Whether the scope's rows hold `(tag, session)` (`indexedKeys`).
    pub(super) fn holds_key(&self, scope: &Scope, tag: &str, session: &str, now: f64) -> bool {
        let Some(key) = self.maps.key(session) else { return false };
        let mut views = self.views(now);
        let view = self.scope_view(&mut views, scope);
        view.rows.0.get(&key).is_some_and(|listed| listed.tag == tag && clean(listed.row.get("sessionId")) == session)
    }

    /// Whether the scope lists `session` from its rows (`agentSessionEntries` `seen`).
    pub(super) fn lists_row(&self, scope: &Scope, session: &str, now: f64) -> bool {
        let Some(key) = self.maps.key(session) else { return false };
        let mut views = self.views(now);
        self.scope_view(&mut views, scope).rows.contains(key)
    }

    /// The scope's rows the agent status lists, in index order.
    pub(super) fn active_listed(&self, scope: &Scope, now: f64) -> Vec<Listed> {
        let mut views = self.views(now);
        let view = self.scope_view(&mut views, scope);
        view.active.iter().filter_map(|key| view.rows.0.get(key)).cloned().collect()
    }
}

/// The window narrowed by one session's map: its release marker, and its tombstone (`window_at`).
pub(super) fn constrain(w: &mut Window, map: &Row, now: f64) {
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
    let released = stamp_ms(map.get("releasedAt"));
    if released > 0.0 {
        ends(released + TAG_TOMBSTONE_TTL_MS, w, None);
    }
    let Some(tombstone) = map.get("tombstone").and_then(Value::as_object) else { return };
    let reaped = mixdog_js::time::date_parse(&clean(tombstone.get("reapedAt")));
    if reaped.is_nan() || reaped == 0.0 || clean(tombstone.get("tag")).is_empty() {
        return;
    }
    if reaped > now {
        (w.from, w.upto) = (now, now);
    } else {
        ends(reaped + TAG_TOMBSTONE_TTL_MS, w, Some(reaped));
    }
}

// ---- the tag facts --------------------------------------------------------------------------

/// What the two tag passes of a read need: the loaded sessions now, every stale memo of the
/// others read again.
pub(super) struct TagPass {
    pub(super) loaded: HashSet<String>,
}

impl super::AgentRegistry {
    /// `getLiveSession` and the scan guard for a bound tag, read now.
    pub(super) fn tag_facts(&self, st: &State, tag: &str, session: &str, now: f64) -> Facts {
        #[cfg(test)]
        work::note(|c| c.tags_visited += 1);
        let found = self.live_session_row(st, session);
        let blocks = found.as_ref().is_some_and(|s| {
            let index = st.tombstone_index(now);
            self.blocks_scan(st, s, tag, &index)
        });
        Facts { session: found.map(Arc::new), blocks }
    }

    /// Brings the kept facts up to date for a read at `now`: the loaded sessions are listed, and
    /// every tag whose memo an input of has changed (or that has none) is read again, unless its
    /// session is loaded (a loaded session is read by each pass that needs it).
    pub(super) fn tag_pass(&self, st: &State, now: f64) -> TagPass {
        let loaded: HashSet<String> = self.live.loaded().into_iter().collect();
        let mut views = st.views(now);
        let facts = &mut views.facts;
        if !facts.ready || now < facts.last_now {
            let stale: Vec<String> = st.tags.iter().map(|(tag, _)| tag.clone()).collect();
            *facts = TagFacts { ready: true, ..TagFacts::default() };
            facts.stale.extend(stale);
        }
        facts.last_now = now;
        while facts.ends.first().is_some_and(|(until, _)| until.0 <= now) {
            let (_, tag) = facts.ends.pop_first().expect("checked above");
            facts.forget(&tag);
            facts.stale.insert(tag);
        }
        let unloaded: Vec<String> = facts.loaded.difference(&loaded).cloned().collect();
        for session in unloaded {
            for tag in st.tags.of_session(&session) {
                facts.touch(&tag);
            }
        }
        facts.loaded.clone_from(&loaded);
        let mut stale: Vec<String> = facts.stale.drain().collect();
        stale.retain(|tag| st.tags.get(tag).is_some_and(|session| !loaded.contains(session)));
        drop(views);
        let memos: Vec<(String, Memo)> = stale
            .into_iter()
            .map(|tag| {
                let session = st.tags.get(&tag).cloned().unwrap_or_default();
                let memo = self.memo(st, &tag, &session, now);
                (tag, memo)
            })
            .collect();
        let mut views = st.views(now);
        for (tag, memo) in memos {
            views.facts.forget(&tag);
            views.facts.keep(&tag, memo);
        }
        TagPass { loaded }
    }

    /// The facts of a tag whose session is not loaded, and how long they hold.
    fn memo(&self, st: &State, tag: &str, session: &str, now: f64) -> Memo {
        let facts = self.tag_facts(st, tag, session, now);
        let (from, until) = match facts.session.as_deref() {
            // A settled session ages out a day after it settled at the earliest (the configured
            // reap window can only make it later); one not settled only when its record changes.
            Some(found) if !facts.blocks => (f64::NEG_INFINITY, settling_from(found).map_or(f64::INFINITY, |from| from.0)),
            // An aged-out session is read again at every pass: the reap window is configuration.
            Some(found) if self.scan_is_terminal(found) && past_settled_retention(&self.reap_ms(), found, now) => (now, now),
            // A tombstone's guard, or a missing session, holds until what it was read from changes.
            _ => (f64::NEG_INFINITY, f64::INFINITY),
        };
        let row = st.indexed_row(session, now);
        let guard = row.as_ref().filter(|row| clean(row.get("tag")) == tag && clean(row.get("sessionId")) == session).map(|row| owner_key(row));
        let lists_for = facts.session.as_ref().filter(|_| !facts.blocks).and_then(|found| {
            let listed_tag = Some(agent_tag_of(found)).filter(|t| !t.is_empty()).unwrap_or_else(|| clean_str(tag));
            if listed_tag.is_empty() || clean(found.get("id")).is_empty() || is_lead_pool_agent(found.get("agent")) {
                return None;
            }
            let owner = owner_key(found);
            // The owner's listing already lists the session from its row.
            let hidden = row.as_ref().is_some_and(|row| owner_key(row) == owner);
            (!hidden).then_some(owner)
        });
        Memo { session_id: session.to_owned(), facts, from, until, guard, lists_for }
    }

    /// The facts of a bound tag at `now`: kept, or read now for a loaded session.
    pub(super) fn facts_of(&self, st: &State, pass: &TagPass, tag: &str, session: &str, now: f64) -> Facts {
        if !pass.loaded.contains(session) {
            let views = st.views(now);
            if let Some(memo) = views.facts.memo.get(tag).filter(|m| m.session_id == session && m.from <= now && now < m.until) {
                return memo.facts.clone();
            }
        }
        self.tag_facts(st, tag, session, now)
    }

    /// The session a listing of `scope` may add for a bound tag (`agentSessionEntries`' tag pass): the
    /// tag's live session when the scan guard lets it through. A loaded session the scope does not
    /// list is not guarded (`add` would drop it anyway).
    pub(super) fn listing_session(&self, st: &State, pass: &TagPass, tag: &str, session: &str, scope: &Scope, now: f64) -> Option<Arc<Row>> {
        if pass.loaded.contains(session) {
            #[cfg(test)]
            work::note(|c| c.tags_visited += 1);
            let found = self.live_session_row(st, session)?;
            if !matches_scope(&found, scope) {
                return None;
            }
            let index = st.tombstone_index(now);
            return (!self.blocks_scan(st, &found, tag, &index)).then(|| Arc::new(found));
        }
        let facts = self.facts_of(st, pass, tag, session, now);
        facts.session.filter(|_| !facts.blocks)
    }

    /// The tags a refresh of `scope` may unbind, in tag order: those whose kept facts unbind and no
    /// row of the scope keeps, and the loaded sessions' tags.
    pub(super) fn unbind_candidates(&self, st: &State, pass: &TagPass, scope: &Scope, now: f64) -> Vec<String> {
        let mut out: BTreeMap<u64, String> = BTreeMap::new();
        {
            let views = st.views(now);
            for (guard, tags) in &views.facts.unbind {
                // A caller scope keeps the tags its own rows hold; every other scope reads its keys.
                if scope.caller_session_id.is_some() && guard.is_some() && guard.as_deref() == scope.caller_session_id.as_deref() {
                    continue;
                }
                for tag in tags {
                    if let Some(at) = st.tags.order_of(tag) {
                        out.insert(at, tag.clone());
                    }
                }
            }
        }
        for session in &pass.loaded {
            for tag in st.tags.of_session(session) {
                if let Some(at) = st.tags.order_of(&tag) {
                    out.insert(at, tag);
                }
            }
        }
        out.into_values().collect()
    }

    /// The tags a listing of a caller scope may add from the tag maps, in tag order: those whose
    /// kept facts list them for the caller, and the loaded sessions' tags.
    pub(super) fn listing_candidates(&self, st: &State, pass: &TagPass, caller: &str, now: f64) -> Vec<String> {
        let mut out: BTreeMap<u64, String> = BTreeMap::new();
        {
            let views = st.views(now);
            for tag in views.facts.lists.get(caller).into_iter().flatten() {
                if let Some(at) = st.tags.order_of(tag) {
                    out.insert(at, tag.clone());
                }
            }
        }
        for session in &pass.loaded {
            for tag in st.tags.of_session(session) {
                if let Some(at) = st.tags.order_of(&tag) {
                    out.insert(at, tag);
                }
            }
        }
        out.into_values().collect()
    }
}
