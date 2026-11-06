//! The turn-review component: per-turn file-change collection, the turn lifecycle, worker
//! attribution, the seal that freezes a turn's change record, and the reads and undo that work from
//! them (Node `turn-snapshot.mjs`). Reads live in `reads`, undo in `undo`; this file owns the state.
//!
//! Locks: `reg` (the maps) is never taken while a tracker's own lock is held; a tracker's locks are
//! only taken one tracker at a time, except a worker joining its owner (owner first). A tracker's
//! heavy work (diff rendering) runs under that tracker's lock alone, so unrelated sessions never
//! wait on each other.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use futures::FutureExt;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use indexmap::IndexSet;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;
use serde_json::Value;

use super::call_diff::CardDiffs;
use super::call_diff::TrackedChange;
use super::call_diff::measure_call_changes;
use super::call_diff::patch_header_path_for_resolved;
use super::freeze::edit_change_file;
use super::freeze::invalid_tracker_files;
use super::freeze::needs_object_format;
use super::freeze::tracker_edits;
use super::freeze::with_own_counts_raw;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::nodepath;
use super::patch::RawFile;
use super::patch::clean;
use super::patch::stored_change_file;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::ports::ReviewWorktrees;
use super::ports::WorktreeBase;
use super::review_diff::Obj;
use super::review_diff::bound_review_patch;
use super::store::Store;
use super::tracker::PatchRoot;
use super::tracker::TrackerMeta;
use super::tracker::TrackerState;
use super::tracker::View;
use super::tracker::fold_tracked_changes;
use super::tracker::merge_own_stats;
use super::tracker::merge_tracked_content;
use super::tracker::own_count_index;
use super::tracker::owned_paths_under;
use super::tracker::patch_root;
use super::tracker::path_key;
use super::tracker::tracker_view;

const TURN_CACHE_MAX: usize = 32;
pub(super) const MAX_PATCH_BYTES: usize = super::tracker::MAX_PATCH_BYTES;
const MAX_AGENT_REVIEWS_PER_TURN: usize = 32;
const MAX_AGENT_REVIEW_BYTES_PER_TURN: usize = 4 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Config {
    /// `MIXDOG_TURN_SNAPSHOT=0|false|off`: the whole review is off.
    pub disabled: bool,
}

/// A seal in flight: `true` once it landed.
pub(super) type Done = tokio::sync::watch::Receiver<bool>;

/// Waits for a seal to land (or for its task to be gone, which lands nothing more).
pub(super) async fn wait_done(mut done: Done) {
    let _ = done.wait_for(|landed| *landed).await;
}

#[derive(Clone)]
pub(super) struct Freezing {
    id: u64,
    pub(super) done: Done,
}

/// One session's tracker.
pub struct Tracker {
    pub(super) meta: TrackerMeta,
    sealed: AtomicBool,
    discarded: AtomicBool,
    contended: AtomicBool,
    // Bumped when a completion wake reopens the sealed turn, so a seal that started before the
    // reopen cannot mark the reopened turn sealed.
    seal_epoch: AtomicU64,
    snapshot: Mutex<Option<Arc<dyn WorktreeBase>>>,
    freezing: Mutex<Option<Freezing>>,
    pub(super) state: Mutex<TrackerState>,
}

impl Tracker {
    pub(super) fn new(meta: TrackerMeta) -> Arc<Self> {
        Arc::new(Self {
            meta,
            sealed: AtomicBool::new(false),
            discarded: AtomicBool::new(false),
            contended: AtomicBool::new(false),
            seal_epoch: AtomicU64::new(0),
            snapshot: Mutex::new(None),
            freezing: Mutex::new(None),
            state: Mutex::new(TrackerState::new()),
        })
    }

    pub(super) fn sealed(&self) -> bool {
        self.sealed.load(Ordering::SeqCst)
    }
    pub(super) fn set_sealed(&self, value: bool) {
        self.sealed.store(value, Ordering::SeqCst);
    }
    pub(super) fn discarded(&self) -> bool {
        self.discarded.load(Ordering::SeqCst)
    }
    pub(super) fn contended(&self) -> bool {
        self.contended.load(Ordering::SeqCst)
    }
    pub(super) fn seal_epoch(&self) -> u64 {
        self.seal_epoch.load(Ordering::SeqCst)
    }
    pub(super) fn snapshot(&self) -> Option<Arc<dyn WorktreeBase>> {
        self.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(super) fn freezing(&self) -> Option<Freezing> {
        self.freezing.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, TrackerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(super) fn patch_root(&self, fallback: &str) -> PatchRoot {
        patch_root(&self.meta, self.snapshot().as_ref(), fallback)
    }
    pub(super) fn release_content(&self) {
        self.lock().release_content();
    }
}

pub(super) struct AgentRow {
    pub session_id: String,
    pub agent: Option<String>,
    pub tag: Option<String>,
    pub patch: String,
}

pub(super) struct Turn {
    pub generation: u64,
    pub checkpoint_id: String,
    pub agents: IndexMap<String, AgentRow>,
}

/// A completed worker review waiting to join (or joined into) a Lead turn.
pub(super) struct Review {
    pub key: String,
    pub source: Option<Arc<Tracker>>,
    pub tracked: bool,
    pub patch: String,
    pub agent: Option<String>,
    pub tag: Option<String>,
    pub release: bool,
}

#[derive(Default)]
pub(super) struct Reg {
    pub turns: IndexMap<String, Turn>,
    pub trackers: IndexMap<String, Arc<Tracker>>,
    // `${sessionId}\0${checkpointId}` → seals in flight. A sealing turn's change record is
    // `pending` and its session refuses Undo/Reapply until it lands.
    pub pending_freezes: HashMap<String, usize>,
    // → getTurnChanges reads in flight. A seal of that checkpoint landing marks them.
    pub change_reads: HashMap<String, Vec<Arc<AtomicBool>>>,
    // → path keys whose worktree state is unknown and whose record could not even be marked so.
    pub unknown_states: HashMap<String, IndexSet<String>>,
    // Owner session → worker key → completed worker review waiting for the owner's next turn.
    pub parked: IndexMap<String, IndexMap<String, Review>>,
    // Owner session → how many times its change history was deleted.
    pub epochs: HashMap<String, u64>,
    // Per-session Undo/Reapply chain: the lock and how many tasks hold or wait on it.
    pub mutations: HashMap<String, (Arc<tokio::sync::Mutex<()>>, usize)>,
}

pub(super) fn pending_key(owner: &str, checkpoint_id: &str) -> String {
    format!("{owner}\0{}", clean(checkpoint_id))
}

pub struct Inner {
    pub(super) cfg: Config,
    pub(super) differ: LineDiffer,
    pub(super) cards: CardDiffs,
    pub(super) store: Store,
    pub(super) disk: Arc<dyn ReviewDisk>,
    pub(super) git: Arc<dyn ReviewGit>,
    pub(super) worktrees: Arc<dyn ReviewWorktrees>,
    pub(super) reg: Mutex<Reg>,
    cpu: mixdog_rt::CpuInteractive,
    pub(super) ignored: super::reads::IgnoredCache,
    write_seq: AtomicU64,
    agent_seq: AtomicU64,
    freeze_seq: AtomicU64,
}

/// The turn review of one process.
#[derive(Clone)]
pub struct TurnReview {
    pub(super) inner: Arc<Inner>,
}

impl TurnReview {
    pub fn new(
        cfg: Config,
        cpu: mixdog_rt::CpuInteractive,
        data_dir: &std::path::Path,
        disk: Arc<dyn ReviewDisk>,
        git: Arc<dyn ReviewGit>,
        worktrees: Arc<dyn ReviewWorktrees>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                differ: LineDiffer::new(),
                cards: CardDiffs::default(),
                store: Store::new(disk.clone(), data_dir),
                disk,
                git,
                worktrees,
                reg: Mutex::new(Reg::default()),
                cpu,
                ignored: Mutex::new(IndexMap::new()),
                write_seq: AtomicU64::new(0),
                agent_seq: AtomicU64::new(0),
                freeze_seq: AtomicU64::new(0),
            }),
        }
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }
}

/// A call's changes as the review folds them: display names relative to the call's base path.
fn tracked_from_call(base_path: &str, change: CallChange) -> TrackedChange {
    let display = patch_header_path_for_resolved(base_path, &change.path);
    let new_display = change.new_path.as_deref().map(|p| patch_header_path_for_resolved(base_path, p));
    TrackedChange {
        path: change.path,
        display_path: display,
        new_path: change.new_path,
        new_display_path: new_display,
        before: change.before,
        after: change.after,
        additions: None,
        deletions: None,
    }
}

impl Inner {
    pub(super) fn reg(&self) -> std::sync::MutexGuard<'_, Reg> {
        self.reg.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs diff work on the interactive CPU lane, off the caller's poll. `Err` when the lane
    /// refused or dropped the job.
    pub(super) async fn on_cpu<R: Send + 'static>(&self, job: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
        use mixdog_rt::LaneToken;
        let cancel = tokio_util::sync::CancellationToken::new();
        let handle = self.cpu.submit_wait(&cancel, move |_| job()).await.map_err(|e| e.to_string())?;
        handle.await.map_err(|e| format!("{e:?}"))
    }

    pub(super) fn tracker_of(&self, session_id: &str) -> Option<Arc<Tracker>> {
        self.reg().trackers.get(session_id).cloned()
    }

    // ── recording ──────────────────────────────────────────────────────────

    /// Fold the call's measured changes into the turn review and publish its card diff. Both share
    /// one line-diff budget: the call is one operation.
    pub(super) fn record_call_changes(&self, call_id: &str, session_id: &str, base_path: &str, changes: Vec<CallChange>) {
        let tracked: Vec<TrackedChange> = changes.into_iter().map(|c| tracked_from_call(base_path, c)).collect();
        let mut budget = LineDiffBudget::default();
        let (diff, measured) = measure_call_changes(&self.differ, tracked, &mut budget);
        self.record_turn_diff_changes(session_id, measured, &mut budget);
        self.cards.register(call_id, &diff);
    }

    /// Writes of a tool without a per-call card (tidy, office): each change joins the turn review
    /// with its own line counts, like an edit-tool write.
    pub(super) fn record_tool_file_changes(&self, session_id: &str, base_path: &str, changes: Vec<CallChange>) {
        if session_id.is_empty() || changes.is_empty() {
            return;
        }
        let tracked: Vec<TrackedChange> = changes.into_iter().map(|c| tracked_from_call(base_path, c)).collect();
        let mut budget = LineDiffBudget::default();
        let (_, measured) = measure_call_changes(&self.differ, tracked, &mut budget);
        self.record_turn_diff_changes(session_id, measured, &mut budget);
    }

    /// Fold exact committed before/after file states into a session's current turn.
    pub(super) fn record_turn_diff_changes(&self, session_id: &str, changes: Vec<TrackedChange>, budget: &mut LineDiffBudget) {
        if self.cfg.disabled {
            return;
        }
        let id = clean(session_id);
        if id.is_empty() {
            return;
        }
        let (tracker, owner_tracker) = {
            let mut reg = self.reg();
            let tracker = match reg.trackers.get(id) {
                Some(tracker) => tracker.clone(),
                None => {
                    let tracker = Tracker::new(TrackerMeta::default());
                    reg.trackers.insert(id.to_owned(), tracker.clone());
                    tracker
                }
            };
            let owner_tracker = match &tracker.meta.owner_session_id {
                Some(owner) => reg.trackers.get(owner).cloned(),
                None => Some(tracker.clone()),
            };
            (tracker, owner_tracker)
        };
        let snapshot = owner_tracker.and_then(|t| t.snapshot());
        // Git reports the turn's root canonically (macOS /var -> /private/var): each written path
        // is spelled the same way, or it never relates to it.
        let list: Vec<TrackedChange> = if snapshot.as_ref().is_some_and(|s| !s.root().is_empty()) {
            changes
                .into_iter()
                .map(|mut raw| {
                    if nodepath::is_absolute_host(clean(&raw.path)) {
                        raw.path = self.worktrees.canonical_path(&raw.path);
                    }
                    if let Some(new_path) = &raw.new_path {
                        if nodepath::is_absolute_host(clean(new_path)) {
                            raw.new_path = Some(self.worktrees.canonical_path(new_path));
                        }
                    }
                    raw
                })
                .collect()
        } else {
            changes
        };
        let root = tracker.patch_root("");
        let mut state = tracker.lock();
        if state.valid && !tracker.sealed() {
            let mut next_seq = || self.write_seq.fetch_add(1, Ordering::SeqCst) + 1;
            fold_tracked_changes(&mut state, &list, snapshot.as_ref(), &mut next_seq);
        }
        tracker_view(&self.differ, &mut state, &root, budget);
    }

    // ── turn cache ─────────────────────────────────────────────────────────

    /// A parked review owns its worker's bound tracker content (`release`).
    pub(super) fn release_parked(review: &Review) {
        if review.release {
            if let Some(source) = &review.source {
                source.release_content();
            }
        }
    }

    pub(super) fn drop_parked(reg: &mut Reg, owner: &str) {
        if let Some(reviews) = reg.parked.shift_remove(owner) {
            for review in reviews.values() {
                Self::release_parked(review);
            }
        }
    }

    pub(super) fn trim_turn_cache(reg: &mut Reg) {
        while reg.turns.len() > TURN_CACHE_MAX {
            let Some(oldest) = reg.turns.keys().next().cloned() else { break };
            reg.turns.shift_remove(&oldest);
            Self::drop_parked(reg, &oldest);
            let doomed: Vec<String> = reg
                .trackers
                .iter()
                .filter(|(session, tracker)| **session == oldest || tracker.meta.owner_session_id.as_deref() == Some(oldest.as_str()))
                .map(|(session, _)| session.clone())
                .collect();
            for session in doomed {
                if let Some(tracker) = reg.trackers.shift_remove(&session) {
                    // A bound worker's content is read by nothing else; the Lead's own tracker may
                    // still be sealing, so it is only unregistered.
                    if session != oldest {
                        tracker.release_content();
                    }
                }
            }
        }
        // Parked reviews of a Lead with no turn in memory (a worker resumed after a restart) are
        // bounded on their own: oldest owner first.
        while reg.parked.len() > TURN_CACHE_MAX {
            let Some(oldest) = reg.parked.keys().next().cloned() else { break };
            Self::drop_parked(reg, &oldest);
        }
    }

    /// A whole-worktree baseline cannot attribute concurrent mutations to either of two live turns
    /// sharing it. Mark both permanently contended so they fall back to their exact session-owned
    /// mutation trackers. A SEALED turn is finished, so contention is decided between live turns
    /// only.
    pub(super) fn mark_worktree_contention(reg: &Reg, owner: &str, tracker: &Arc<Tracker>) {
        let root = tracker.snapshot().map(|s| s.root()).filter(|r| !r.is_empty());
        for (other_session, other) in &reg.trackers {
            if other_session == owner || other.sealed() {
                continue;
            }
            let same_request = !tracker.meta.worktree_request.is_empty() && other.meta.worktree_request == tracker.meta.worktree_request;
            let same_root = root.as_ref().is_some_and(|r| other.snapshot().is_some_and(|s| s.root() == *r));
            if !same_request && !same_root {
                continue;
            }
            tracker.contended.store(true, Ordering::SeqCst);
            other.contended.store(true, Ordering::SeqCst);
        }
    }

    /// A completion wake belongs to the user turn that launched its workers. It reopens that
    /// turn's review instead of replacing it.
    fn continue_turn_snapshot(reg: &mut Reg, owner: &str) -> bool {
        let Some(turn) = reg.turns.get(owner) else { return false };
        let generation = turn.generation;
        let Some(tracker) = reg.trackers.get(owner).cloned() else { return false };
        if tracker.meta.owner_generation != generation {
            return false;
        }
        let turn = reg.turns.shift_remove(owner).expect("turn");
        reg.turns.insert(owner.to_owned(), turn);
        tracker.set_sealed(false);
        tracker.seal_epoch.fetch_add(1, Ordering::SeqCst);
        Self::mark_worktree_contention(reg, owner, &tracker);
        Self::adopt_parked(reg, owner, &tracker);
        true
    }

    /// The synchronous half of a turn start: reopen (completion wake) or install the turn's
    /// tracker. The tracker is returned only for a new turn, whose Git baseline the caller
    /// captures next.
    fn open_turn_snapshot(self: &Arc<Self>, worktree: &str, owner: &str, open: &mixdog_core_api::turn_review::TurnOpen) -> (mixdog_core_api::turn_review::TurnToken, Option<Arc<Tracker>>) {
        use mixdog_core_api::turn_review::TurnToken;
        let mut reg = self.reg();
        if open.continue_turn && Self::continue_turn_snapshot(&mut reg, owner) {
            let reopened = reg.trackers.get(owner).expect("reopened tracker");
            return (TurnToken { generation: reopened.meta.owner_generation, checkpoint_id: reopened.meta.checkpoint_id.clone() }, None);
        }
        let generation = reg.turns.get(owner).map_or(0, |t| t.generation) + 1;
        let checkpoint_id = clean(&open.checkpoint_id).to_owned();
        // A turn replaced before it sealed (an abort whose delayed cleanup has not run yet) still
        // keeps its edits as a record. Its capture is queued ahead of this turn's baseline.
        if let Some(prior) = reg.trackers.get(owner).cloned() {
            if prior.meta.owner_generation > 0 && !prior.sealed() {
                // `void sealTurn(...)`: the seal runs on its own.
                let step = self.seal_begin(&mut reg, owner, &prior);
                mixdog_rt::spawn("turn_review.seal_prior", mixdog_rt::TaskClass::Work, self.seal_finish(owner.to_owned(), prior, step));
            }
        }
        // Workers still running keep their bound trackers across the new turn: their edits join
        // whichever turn is running when they complete.
        reg.turns.shift_remove(owner);
        reg.turns.insert(owner.to_owned(), Turn { generation, checkpoint_id: checkpoint_id.clone(), agents: IndexMap::new() });
        let tracker = Tracker::new(TrackerMeta {
            owner_session_id: None,
            owner_generation: generation,
            checkpoint_id: checkpoint_id.clone(),
            worktree_request: path_key(worktree),
            worktree_root: nodepath::resolve_host(&[if clean(worktree).is_empty() { "." } else { clean(worktree) }]),
        });
        reg.trackers.insert(owner.to_owned(), tracker.clone());
        Self::trim_turn_cache(&mut reg);
        Self::mark_worktree_contention(&reg, owner, &tracker);
        Self::adopt_parked(&mut reg, owner, &tracker);
        (TurnToken { generation, checkpoint_id }, Some(tracker))
    }

    pub(super) async fn begin_turn(
        self: &Arc<Self>,
        worktree: &str,
        session_id: &str,
        open: mixdog_core_api::turn_review::TurnOpen,
    ) -> Option<mixdog_core_api::turn_review::TurnToken> {
        let owner = clean(session_id).to_owned();
        if self.cfg.disabled || owner.is_empty() {
            return None;
        }
        // Turn start and Undo/Reapply share the per-session lock: a start waits for an in-flight
        // mutation, and a mutation queued after this start re-checks under the lock and finds the
        // turn running.
        let busy = self.reg().mutations.contains_key(&owner);
        let (token, tracker) = if busy {
            let inner = self.clone();
            let (worktree, owner2) = (worktree.to_owned(), owner.clone());
            self.serialize_mutation(&owner, async move { inner.open_turn_snapshot(&worktree, &owner2, &open) }).await
        } else {
            self.open_turn_snapshot(worktree, &owner, &open)
        };
        let Some(tracker) = tracker else { return Some(token) };
        let snapshot = self.worktrees.create(worktree).await;
        let current = self.tracker_of(&owner);
        if current.is_some_and(|t| Arc::ptr_eq(&t, &tracker)) {
            let has_root = snapshot.as_ref().is_some_and(|s| !s.root().is_empty());
            *tracker.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = snapshot;
            if has_root {
                Self::mark_worktree_contention(&self.reg(), &owner, &tracker);
            }
        }
        Some(token)
    }

    // ── per-session mutation chain ─────────────────────────────────────────

    pub(super) async fn serialize_mutation<T>(&self, owner: &str, task: impl Future<Output = T>) -> T {
        let lock = {
            let mut reg = self.reg();
            let entry = reg.mutations.entry(owner.to_owned()).or_insert_with(|| (Arc::new(tokio::sync::Mutex::new(())), 0));
            entry.1 += 1;
            entry.0.clone()
        };
        let guard = lock.lock_owned().await;
        let out = task.await;
        drop(guard);
        let mut reg = self.reg();
        if let Some(entry) = reg.mutations.get_mut(owner) {
            entry.1 -= 1;
            if entry.1 == 0 {
                reg.mutations.remove(owner);
            }
        }
        out
    }

    // ── workers ────────────────────────────────────────────────────────────

    /// Bound worker reviews keyed by worker (a turn's agents, an owner's parked reviews): oldest
    /// out first, by count and retained patch bytes.
    fn trim_agent_rows(rows: &mut IndexMap<String, AgentRow>) {
        loop {
            let bytes: usize = rows.values().map(|r| r.patch.len()).sum();
            if rows.len() > MAX_AGENT_REVIEWS_PER_TURN || bytes > MAX_AGENT_REVIEW_BYTES_PER_TURN {
                if rows.shift_remove_index(0).is_none() {
                    break;
                }
            } else {
                break;
            }
        }
    }

    fn trim_parked(reviews: &mut IndexMap<String, Review>) {
        loop {
            let bytes: usize = reviews.values().map(|r| r.patch.len()).sum();
            if reviews.len() > MAX_AGENT_REVIEWS_PER_TURN || bytes > MAX_AGENT_REVIEW_BYTES_PER_TURN {
                match reviews.shift_remove_index(0) {
                    Some((_, review)) => Self::release_parked(&review),
                    None => break,
                }
            } else {
                break;
            }
        }
    }

    fn merge_patches(values: &[&str]) -> String {
        let merged = values.iter().filter(|v| !clean(v).is_empty()).copied().collect::<Vec<_>>().join("\n");
        bound_review_patch(&merged, MAX_PATCH_BYTES).0
    }

    /// Fold a finished worker's owned paths, counts and own segments into `target`.
    fn fold_worker_tracker(target: &Arc<Tracker>, source: &Arc<Tracker>) {
        if Arc::ptr_eq(target, source) {
            return;
        }
        let mut target_state = target.lock();
        let source_state = source.lock();
        for path in source_state.owned_paths.iter() {
            target_state.owned_paths.insert(path.clone());
        }
        merge_own_stats(&mut target_state.own_stats, &source_state.own_stats);
        merge_tracked_content(&mut target_state, &source_state);
    }

    /// Attribute one completed worker review to `turn` and fold its own segments, owned paths and
    /// counts into the turn's tracker.
    fn join_worker_review(turn: &mut Turn, owner_tracker: &Arc<Tracker>, review: &Review) -> bool {
        let prior = turn.agents.get(&review.key);
        if review.patch.is_empty() {
            if !(review.tracked && prior.is_some()) {
                return false;
            }
            turn.agents.shift_remove(&review.key);
            return true;
        }
        let prior_row = turn.agents.shift_remove(&review.key);
        let patch = if review.tracked { review.patch.clone() } else { Self::merge_patches(&[prior_row.as_ref().map_or("", |p| p.patch.as_str()), &review.patch]) };
        turn.agents.insert(
            review.key.clone(),
            AgentRow {
                session_id: review.key.clone(),
                agent: review.agent.clone().or_else(|| prior_row.as_ref().and_then(|p| p.agent.clone())),
                tag: review.tag.clone().or_else(|| prior_row.as_ref().and_then(|p| p.tag.clone())),
                patch,
            },
        );
        if let Some(source) = &review.source {
            Self::fold_worker_tracker(owner_tracker, source);
        }
        Self::trim_agent_rows(&mut turn.agents);
        true
    }

    /// One parked review of a worker that completed again before its Lead's next turn: both runs'
    /// sources fold into one tracker this review owns, exactly as both would have joined a running
    /// turn.
    fn merge_parked_review(&self, prior: Review, review: Review) -> Review {
        let sources: Vec<Arc<Tracker>> = [prior.source.clone(), review.source.clone()].into_iter().flatten().collect();
        let mut source: Option<Arc<Tracker>> = None;
        if !sources.is_empty() {
            let own = if prior.release { prior.source.clone() } else { None };
            let target = own.unwrap_or_else(|| Tracker::new(TrackerMeta::default()));
            for other in &sources {
                if !Arc::ptr_eq(other, &target) {
                    Self::fold_worker_tracker(&target, other);
                }
            }
            source = Some(target);
        }
        Self::release_parked(&review);
        let tracked = prior.tracked || review.tracked;
        let patch = if tracked {
            let src = source.as_ref().expect("tracked review has a source");
            let root = src.patch_root("");
            let mut state = src.lock();
            tracker_view(&self.differ, &mut state, &root, &mut LineDiffBudget::default()).patch
        } else {
            Self::merge_patches(&[&prior.patch, &review.patch])
        };
        Review {
            key: review.key,
            tracked,
            patch,
            agent: review.agent.or(prior.agent),
            tag: review.tag.or(prior.tag),
            release: source.is_some(),
            source,
        }
    }

    /// Park a completed worker review for its Lead's next turn.
    fn park_worker_review(&self, reg: &mut Reg, owner: &str, review: Review) -> bool {
        let prior_exists = reg.parked.get(owner).is_some_and(|p| p.contains_key(&review.key));
        if !prior_exists && review.patch.is_empty() {
            Self::release_parked(&review);
            return false;
        }
        let mut parked = reg.parked.shift_remove(owner).unwrap_or_default();
        let prior = parked.shift_remove(&review.key);
        let key = review.key.clone();
        let next = match prior {
            Some(prior) => self.merge_parked_review(prior, review),
            None => review,
        };
        parked.insert(key, next);
        Self::trim_parked(&mut parked);
        // Map.set on an existing key keeps its position, a deleted one goes last.
        reg.parked.insert(owner.to_owned(), parked);
        Self::trim_turn_cache(reg);
        true
    }

    /// A turn that just opened (or reopened) takes the worker reviews that completed while its
    /// Lead had no running turn.
    fn adopt_parked(reg: &mut Reg, owner: &str, tracker: &Arc<Tracker>) {
        let Some(parked) = reg.parked.shift_remove(owner) else { return };
        let Some(turn) = reg.turns.get_mut(owner) else {
            for review in parked.values() {
                Self::release_parked(review);
            }
            return;
        };
        for review in parked.values() {
            Self::join_worker_review(turn, tracker, review);
            Self::release_parked(review);
        }
    }

    pub(super) fn begin_agent_review(&self, owner_session_id: &str, child_session_id: &str, agent: &str, tag: &str) -> Option<AgentHandle> {
        if self.cfg.disabled {
            return None;
        }
        let owner = clean(owner_session_id).to_owned();
        let child = clean(child_session_id).to_owned();
        if owner.is_empty() || child.is_empty() {
            return None;
        }
        let mut reg = self.reg();
        let generation = reg.turns.get(&owner).map_or(0, |t| t.generation);
        let reset = match reg.trackers.get(&child) {
            Some(existing) => existing.meta.owner_session_id.as_deref() != Some(owner.as_str()) || existing.meta.owner_generation != generation,
            None => true,
        };
        if reset {
            let tracker = Tracker::new(TrackerMeta { owner_session_id: Some(owner.clone()), owner_generation: generation, ..TrackerMeta::default() });
            reg.trackers.insert(child.clone(), tracker);
        }
        let seq = self.agent_seq.fetch_add(1, Ordering::SeqCst) + 1;
        Some(AgentHandle {
            id: format!("agent-review-{seq}"),
            owner_session_id: owner.clone(),
            generation,
            history_epoch: reg.epochs.get(&owner).copied().unwrap_or(0),
            session_id: child,
            agent: Some(clean(agent).to_owned()).filter(|a| !a.is_empty()),
            tag: Some(clean(tag).to_owned()).filter(|t| !t.is_empty()),
            completed: AtomicBool::new(false),
        })
    }

    /// The Lead turn is running: not sealed, not sealing.
    fn turn_running(turn: Option<&Turn>, tracker: Option<&Arc<Tracker>>) -> bool {
        match (turn, tracker) {
            (Some(turn), Some(tracker)) => tracker.meta.owner_generation == turn.generation && !tracker.sealed() && tracker.freezing().is_none() && !tracker.discarded(),
            _ => false,
        }
    }

    /// Hand a finished worker's own edits (its tracker, else its apply_patch diffs) to its Lead:
    /// into the Lead turn running now, or parked for the Lead's next turn to open or reopen.
    pub(super) fn complete_agent_review(&self, handle: &AgentHandle, patches: &[String]) -> bool {
        if handle.completed.swap(true, Ordering::SeqCst) {
            return false;
        }
        let owner = clean(&handle.owner_session_id).to_owned();
        let key = if clean(&handle.session_id).is_empty() { handle.id.clone() } else { clean(&handle.session_id).to_owned() };
        let mut reg = self.reg();
        let tracker = reg.trackers.get(&key).cloned();
        let matching = tracker
            .as_ref()
            .filter(|t| t.meta.owner_session_id.as_deref() == Some(owner.as_str()) && t.meta.owner_generation == handle.generation)
            .cloned();
        // This execution is over: its bound tracker leaves the registry, so a next execution of
        // the worker starts its own.
        if matching.is_some() {
            reg.trackers.shift_remove(&key);
        }
        // The Lead's change history was deleted after this worker was bound.
        if reg.epochs.get(&owner).copied().unwrap_or(0) != handle.history_epoch {
            if let Some(m) = &matching {
                m.release_content();
            }
            return false;
        }
        // A worker that runs its own session turn replaces the bound tracker with its turn's own
        // one (no owner). beginAgentTurnReview reset any older tracker, so an unowned one here
        // holds this execution's edits.
        let source = matching.clone().or_else(|| tracker.filter(|t| t.meta.owner_session_id.is_none()));
        let tracked = source.as_ref().is_some_and(|s| s.lock().revision > 0);
        let patch = if tracked {
            let src = source.as_ref().expect("source");
            let root = src.patch_root("");
            let mut state = src.lock();
            tracker_view(&self.differ, &mut state, &root, &mut LineDiffBudget::default()).patch
        } else {
            let refs: Vec<&str> = patches.iter().map(String::as_str).collect();
            Self::merge_patches(&refs)
        };
        let review = Review { key, source, tracked, patch, agent: handle.agent.clone(), tag: handle.tag.clone(), release: matching.is_some() };
        let owner_tracker = reg.trackers.get(&owner).cloned();
        let running = Self::turn_running(reg.turns.get(&owner), owner_tracker.as_ref());
        if running {
            let tracker = owner_tracker.expect("running turn has a tracker");
            let turn = reg.turns.get_mut(&owner).expect("running turn");
            let joined = Self::join_worker_review(turn, &tracker, &review);
            Self::release_parked(&review);
            return joined;
        }
        self.park_worker_review(&mut reg, &owner, review)
    }

    /// Workers attributed to the tracker's own turn (identities only: their patches stay review
    /// attribution and never join the net diff).
    pub(super) fn attributed_agents_in(reg: &Reg, owner: &str, tracker: &Tracker) -> Vec<Value> {
        let Some(turn) = reg.turns.get(owner) else { return Vec::new() };
        if turn.generation != tracker.meta.owner_generation {
            return Vec::new();
        }
        turn.agents
            .values()
            .map(|row| {
                let mut o = Obj::new();
                o.insert("sessionId".into(), Value::String(row.session_id.clone()));
                o.insert("agent".into(), row.agent.clone().map_or(Value::Null, Value::String));
                o.insert("tag".into(), row.tag.clone().map_or(Value::Null, Value::String));
                Value::Object(o)
            })
            .collect()
    }

    // ── seal ───────────────────────────────────────────────────────────────

    /// Persist the durable half of a finished review: the baseline tree hash plus the paths this
    /// session owns. Memory keeps the fast path; the record is what survives the next turn, a cache
    /// eviction and a runtime restart.
    pub(super) async fn persist_turn_snapshot_record(&self, owner: &str, tracker: &Tracker) {
        let Some(snapshot) = tracker.snapshot() else { return };
        let (root, baseline_tree) = (snapshot.root(), snapshot.baseline_tree());
        if owner.is_empty() || tracker.discarded() || baseline_tree.is_empty() || root.is_empty() {
            return;
        }
        let owned: Vec<String> = owned_paths_under(&root, &tracker.lock().owned_paths).into_iter().collect();
        if owned.is_empty() {
            return;
        }
        let generation = if tracker.meta.owner_generation != 0 {
            tracker.meta.owner_generation
        } else {
            self.reg().turns.get(owner).map_or(0, |t| t.generation)
        };
        let mut turn = Obj::new();
        turn.insert("generation".into(), Value::from(generation));
        turn.insert("checkpointId".into(), Value::String(tracker.meta.checkpoint_id.clone()));
        turn.insert("root".into(), Value::String(root));
        turn.insert("baselineTree".into(), Value::String(baseline_tree));
        turn.insert("baselineFiles".into(), Value::Array(snapshot.baseline_files()));
        turn.insert("toolFiles".into(), Value::Array(owned.into_iter().map(Value::String).collect()));
        turn.insert("sealed".into(), Value::Bool(true));
        // The record adds to a review, it is never required by one.
        let _ = self.store.save_turn_snapshot_record(owner, &turn).await;
    }

    /// Freeze the turn's own changes into its durable change record: per file, the session's own
    /// segments (its completed workers' included) as one replayable patch, never the worktree's net
    /// diff, counted by the summed deltas of those writes.
    async fn freeze_turn_changes(&self, owner: &str, tracker: &Tracker, agents: Vec<Value>) -> std::io::Result<()> {
        let checkpoint_id = clean(&tracker.meta.checkpoint_id).to_owned();
        if checkpoint_id.is_empty() {
            return Ok(());
        }
        let root = tracker.patch_root("");
        if root.root.is_empty() {
            return Ok(());
        }
        let (files, outside) = self.own_record_files(tracker, &root).await;
        let git = root.git;
        let files = if git { files } else { files.into_iter().chain(outside.iter().cloned()).collect() };
        let (stored_files, stored_outside) = {
            let state = tracker.lock();
            let find = |raw: Vec<RawFile>| with_own_counts_raw(raw, own_count_index(&state, &root.root, false));
            let f: Vec<Value> = find(files).into_iter().map(|file| Value::Object(stored_change_file(file))).collect();
            let o: Vec<Value> = if git { find(outside).into_iter().map(|file| Value::Object(stored_change_file(file))).collect() } else { Vec::new() };
            (f, o)
        };
        let mut next = Obj::new();
        next.insert("checkpointId".into(), Value::String(checkpoint_id.clone()));
        next.insert("kind".into(), Value::String(if git { "git" } else { "tracked" }.into()));
        next.insert("root".into(), Value::String(root.root.clone()));
        next.insert("agents".into(), Value::Array(agents));
        next.insert("counts".into(), Value::String("own".into()));
        next.insert("files".into(), Value::Array(stored_files));
        next.insert("outside".into(), Value::Array(stored_outside));
        self.store.upsert_turn_change_record(owner, &next).await?;
        // A fresh freeze measured the disk itself; nothing about it is unknown.
        self.reg().unknown_states.remove(&pending_key(owner, &checkpoint_id));
        Ok(())
    }

    /// Record files of the tracker's own changes. `outside` are those beyond the root (view-only
    /// beside a Git turn's files).
    pub(super) async fn own_record_files(&self, tracker: &Tracker, root: &PatchRoot) -> (Vec<RawFile>, Vec<RawFile>) {
        let (valid, edits) = {
            let state = tracker.lock();
            (state.valid, if state.valid { tracker_edits(&state, &root.root) } else { Vec::new() })
        };
        if !valid {
            let state = tracker.lock();
            return (invalid_tracker_files(&state, &root.root), Vec::new());
        }
        let object_format = self.edits_object_format(&edits, root).await;
        // One line-diff budget for the whole seal pass.
        let mut budget = LineDiffBudget::default();
        let (mut files, mut outside) = (Vec::new(), Vec::new());
        for edit in &edits {
            let file = edit_change_file(&self.differ, edit, &root.root, object_format, &mut budget);
            if edit.inside { files.push(file) } else { outside.push(file) }
        }
        (files, outside)
    }

    /// The object format the binary patches of `edits` hash with: resolved (one Git call) only
    /// when one of them replays binary content.
    pub(super) async fn edits_object_format(&self, edits: &[super::tracker::Edit], root: &PatchRoot) -> &'static str {
        if !needs_object_format(edits) {
            return "sha1";
        }
        if root.git { super::apply::repository_object_format(self.git.as_ref(), &root.root).await } else { "sha1" }
    }

    /// Seal a Lead turn: capture the worktree one last time, persist the review baseline and
    /// freeze the change record. Single-flight per tracker; a seal requested while another runs
    /// waits for it and then seals again only if a completion wake reopened the turn meanwhile.
    pub(super) fn seal(self: &Arc<Self>, owner: String, tracker: Arc<Tracker>) -> BoxFuture<'static, ()> {
        let step = {
            let mut reg = self.reg();
            self.seal_begin(&mut reg, &owner, &tracker)
        };
        self.seal_finish(owner, tracker, step)
    }

    /// The synchronous half of a seal: it reads the turn's workers and registers the seal in
    /// flight at the moment it is asked for, before any turn replaces them.
    pub(super) fn seal_begin(self: &Arc<Self>, reg: &mut Reg, owner: &str, tracker: &Arc<Tracker>) -> SealStep {
        // Its history was deleted (clearSessionChangeHistory): never written again.
        if tracker.discarded() {
            return SealStep::Done;
        }
        if let Some(freezing) = tracker.freezing() {
            return SealStep::Wait(freezing.done);
        }
        let epoch = tracker.seal_epoch();
        let agents = Self::attributed_agents_in(reg, owner, tracker);
        let key = pending_key(owner, &tracker.meta.checkpoint_id);
        *reg.pending_freezes.entry(key.clone()).or_insert(0) += 1;
        let id = self.freeze_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, done) = tokio::sync::watch::channel(false);
        *tracker.freezing.lock().unwrap_or_else(|e| e.into_inner()) = Some(Freezing { id, done: done.clone() });
        let run_inner = self.clone();
        let run_tracker = tracker.clone();
        let owner = owner.to_owned();
        mixdog_rt::spawn("turn_review.seal", mixdog_rt::TaskClass::Work, async move {
            if let Some(snapshot) = run_tracker.snapshot() {
                // Best-effort refresh: seal with the last captured worktree state.
                snapshot.refresh(true).await;
            }
            if !run_tracker.discarded() && run_tracker.seal_epoch() == epoch {
                run_tracker.set_sealed(true);
                run_inner.persist_turn_snapshot_record(&owner, &run_tracker).await;
                if !run_tracker.discarded() {
                    // The change record adds Undo history; it never fails a turn.
                    let _ = run_inner.freeze_turn_changes(&owner, &run_tracker, agents).await;
                }
                // The bounded own before/after content stays until the next turn: a completion
                // wake reopening it and an Undo/Reapply of this turn fold into it.
            }
            {
                let mut slot = run_tracker.freezing.lock().unwrap_or_else(|e| e.into_inner());
                if slot.as_ref().is_some_and(|f| f.id == id) {
                    *slot = None;
                }
            }
            let mut reg = run_inner.reg();
            match reg.pending_freezes.get(&key).copied().unwrap_or(1) {
                0 | 1 => {
                    reg.pending_freezes.remove(&key);
                }
                count => {
                    reg.pending_freezes.insert(key.clone(), count - 1);
                }
            }
            for read in reg.change_reads.get(&key).into_iter().flatten() {
                read.store(true, Ordering::SeqCst);
            }
            drop(reg);
            let _ = tx.send(true);
        });
        SealStep::Started(done)
    }

    pub(super) fn seal_finish(self: &Arc<Self>, owner: String, tracker: Arc<Tracker>, step: SealStep) -> BoxFuture<'static, ()> {
        let inner = self.clone();
        async move {
            match step {
                SealStep::Done => {}
                SealStep::Started(done) => wait_done(done).await,
                // A seal requested while another runs waits for it and then seals again only if a
                // completion wake reopened the turn meanwhile.
                SealStep::Wait(done) => {
                    wait_done(done).await;
                    if !tracker.sealed() {
                        inner.seal(owner, tracker).await;
                    }
                }
            }
        }
        .boxed()
    }

    /// Freeze a completed (or cancelled) Lead turn while retaining only its bounded review data.
    /// `expected` makes a delayed call a no-op once a newer turn began.
    pub(super) async fn complete_turn(self: &Arc<Self>, session_id: &str, expected: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        let owner = clean(session_id).to_owned();
        let Some(tracker) = self.tracker_of(&owner) else { return false };
        let generation = expected.map_or(0, |t| t.generation);
        if generation != 0 && tracker.meta.owner_generation != generation {
            return false;
        }
        self.seal(owner, tracker).await;
        true
    }

    /// Release a Lead session's in-memory change state: a worker bound before this finds its
    /// history epoch moved on, its parked worker reviews are dropped, and its own and bound worker
    /// trackers are discarded (anything earlier that seals writes nothing).
    pub(super) fn discard_session_change_state(&self, owner: &str) {
        let mut reg = self.reg();
        *reg.epochs.entry(owner.to_owned()).or_insert(0) += 1;
        Self::drop_parked(&mut reg, owner);
        let doomed: Vec<String> = reg
            .trackers
            .iter()
            .filter(|(session, tracker)| session.as_str() == owner || tracker.meta.owner_session_id.as_deref() == Some(owner))
            .map(|(session, _)| session.clone())
            .collect();
        for session in doomed {
            if let Some(tracker) = reg.trackers.shift_remove(&session) {
                tracker.discarded.store(true, Ordering::SeqCst);
                tracker.release_content();
            }
        }
        reg.turns.shift_remove(owner);
        let prefix = format!("{owner}\0");
        reg.unknown_states.retain(|key, _| !key.starts_with(&prefix));
    }

    /// The session was deleted: release its turn, parked worker reviews and bound worker trackers
    /// (its stored records go with the session purge).
    pub(super) fn forget_session(&self, session_id: &str) {
        let owner = clean(session_id);
        if !owner.is_empty() {
            self.discard_session_change_state(owner);
        }
    }

    pub(super) fn pending_view(tracker: &Tracker) -> Option<View> {
        tracker.lock().view.clone()
    }
}

/// What a seal request found: nothing to do, a seal already running to wait for, or the seal it
/// just started.
pub(super) enum SealStep {
    Done,
    Wait(Done),
    Started(Done),
}

/// A worker execution bound to its owner's review.
pub struct AgentHandle {
    pub(super) id: String,
    pub(super) owner_session_id: String,
    pub(super) generation: u64,
    pub(super) history_epoch: u64,
    pub(super) session_id: String,
    pub(super) agent: Option<String>,
    pub(super) tag: Option<String>,
    pub(super) completed: AtomicBool,
}

pub(super) struct OwnedAgentReview {
    pub inner: Arc<Inner>,
    pub handle: AgentHandle,
}

impl mixdog_core_api::turn_review::AgentReview for OwnedAgentReview {
    fn complete(&self, patches: Vec<String>) -> bool {
        self.inner.complete_agent_review(&self.handle, &patches)
    }
}

/// `ReviewContent` of nothing, for callers that only name a path.
pub fn absent() -> ReviewContent {
    ReviewContent::Absent
}
