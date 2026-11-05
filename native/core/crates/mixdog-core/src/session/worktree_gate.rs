//! The admission gate shared by Lead workspace transitions, turn admission and worker
//! spawning (Node `admission-gate.mjs`), with the in-process activity ledger that replaces the
//! cross-process one (one core owns the data dir):
//!
//! - a transition and a worker spawn of the same Lead never overlap;
//! - turns and transitions are mutually exclusive: an admitted turn is registered until it
//!   settles, and a turn that arrives while its own session transitions, or while another
//!   session changes the checkout its cwd lies in, waits for that change to settle;
//! - turn readers share a checkout freely; a management hold refuses while a reader (not the
//!   actor's) overlaps an affected folder and excludes later readers until released;
//! - each worktree-bound Lead's execution root, which every worker of that Lead runs in.
//!
//! One short critical section guards the maps (O(1) work, never held across an await); waiters
//! sleep on one change notification, so nothing polls.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_protocol::DomainErrorDetail;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::errors;
use mixdog_scm::worktree::errors::RefusalReason;
use tokio::sync::Notify;

use super::worktree_state::is_within;
use super::worktree_state::plain;

/// A live cwd: a turn's folder follows its session's workspace.
pub type Cwd = Arc<dyn Fn() -> String + Send + Sync>;

/// A git checkout as the ledger sees it.
#[derive(Clone, Debug)]
pub struct Checkout {
    pub top_level: String,
    /// A linked checkout Mixdog did not create: never lock-blocked by what is held elsewhere.
    pub external: bool,
}

/// Resolves the checkout containing a folder (`None` outside a git checkout). Reads the disk,
/// so the gate asks before it takes its lock.
#[async_trait]
pub trait Checkouts: Send + Sync {
    async fn of(&self, folder: &str, cancel: &CancellationToken) -> Result<Option<Checkout>, ScmFailure>;
}

struct Turn {
    session: String,
    cwd: Cwd,
    readers: Vec<u64>,
}

struct Reader {
    session: String,
    path: String,
}

struct Hold {
    session: String,
    folder: String,
}

#[derive(Default)]
struct State {
    transitions: HashMap<String, String>,
    spawns: HashMap<String, u32>,
    cwd_locks: HashMap<String, String>,
    turns: HashMap<u64, Turn>,
    folder_holds: HashMap<u64, Hold>,
    readers: HashMap<u64, Reader>,
    managers: HashMap<u64, String>,
}

#[derive(Default)]
pub struct AdmissionGate {
    state: Mutex<State>,
    changed: Notify,
    next: AtomicU64,
}

fn busy(reason: &str, fill: impl FnOnce(&mut DomainErrorDetail)) -> ScmFailure {
    let mut detail = DomainErrorDetail::WorktreeBusyJobs {
        reason: reason.to_owned(),
        outcome: None,
        admission: None,
        sessions: None,
        entry_id: None,
        kept: None,
        workers: None,
        jobs: None,
        shell_jobs: None,
        starting: None,
        session_id: None,
    };
    fill(&mut detail);
    ScmFailure::coded(errors::WORKTREE_BUSY_JOBS, detail)
}

pub(super) fn folder_in_use(sessions: Vec<String>) -> ScmFailure {
    errors::busy_with(RefusalReason::FolderInUse.wire(), Some(sessions), None, None)
}

fn key(session_id: &str) -> String {
    session_id.trim().to_owned()
}

fn norm(path: &str) -> String {
    mixdog_scm::locks::path_key(std::path::Path::new(path))
}

fn overlaps(a: &str, b: &str) -> bool {
    is_within(a, b) || is_within(b, a)
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl State {
    /// A reader of `checkout` at `path`, or `None` while a management hold refuses it.
    fn admit_reader(&mut self, id: u64, session: &str, path: &str, checkout: &Checkout) -> bool {
        let held = self.managers.values().any(|other| {
            if checkout.external { is_within(&checkout.top_level, other) } else { overlaps(other, path) }
        });
        if held {
            return false;
        }
        self.readers.insert(id, Reader { session: session.to_owned(), path: norm(path) });
        true
    }

    /// Whether `session` must wait before a turn in `path` may start.
    fn blocked(&self, session: &str, path: &str) -> bool {
        self.transitions.contains_key(session)
            || self.folder_holds.values().any(|hold| hold.session != session && is_within(&hold.folder, path))
    }
}

impl AdmissionGate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// Enter a transition for `session`; dropping the guard leaves it.
    pub fn begin_transition(self: &Arc<Self>, session: &str, tx_id: &str) -> Result<TransitionGuard, ScmFailure> {
        let id = key(session);
        if id.is_empty() {
            return Err(plain("workspace transition requires a session id."));
        }
        let mut state = self.state();
        if state.transitions.contains_key(&id) {
            return Err(errors::busy_with("transition", None, None, None));
        }
        if let Some(starting) = state.spawns.get(&id).copied().filter(|n| *n > 0) {
            return Err(busy("workers", |d| {
                if let DomainErrorDetail::WorktreeBusyJobs { starting: slot, .. } = d {
                    *slot = Some(u64::from(starting));
                }
            }));
        }
        state.transitions.insert(id.clone(), if tx_id.is_empty() { "tx".into() } else { tx_id.to_owned() });
        Ok(TransitionGuard { gate: self.clone(), session: id })
    }

    /// Hold `folder` (a checkout root) while its branch changes or a merge lands in it. Refuses
    /// `folder-in-use` while another session's admitted turn runs inside it and `transition`
    /// while another change holds an overlapping checkout; turns arriving meanwhile wait.
    /// `hold: false` (an external checkout) only refuses.
    pub fn hold_checkout_folder(self: &Arc<Self>, session: &str, folder: &str, hold: bool) -> Result<FolderGuard, ScmFailure> {
        let id = key(session);
        let mut state = self.state();
        let mut users: Vec<String> = state
            .turns
            .values()
            .filter(|turn| turn.session != id && is_within(folder, &(turn.cwd)()))
            .map(|turn| turn.session.clone())
            .collect();
        users.sort();
        users.dedup();
        if !users.is_empty() {
            return Err(folder_in_use(users));
        }
        if !hold {
            return Ok(FolderGuard { gate: self.clone(), token: None });
        }
        if state.folder_holds.values().any(|h| overlaps(&h.folder, folder)) {
            return Err(errors::busy_with("transition", None, None, None));
        }
        let token = self.id();
        state.folder_holds.insert(token, Hold { session: id, folder: folder.to_owned() });
        Ok(FolderGuard { gate: self.clone(), token: Some(token) })
    }

    /// Writers refuse while a reader that is not `actor`'s overlaps an affected folder, then
    /// exclude later readers until the guard drops. External checkouts are only checked.
    pub fn hold_activity(
        self: &Arc<Self>,
        folders: &[(String, Checkout)],
        actor: Option<&str>,
    ) -> Result<ActivityGuard, ScmFailure> {
        let mut state = self.state();
        let conflicts: Vec<String> = state
            .readers
            .values()
            .filter(|r| actor.is_none_or(|a| r.session != a) && folders.iter().any(|(f, _)| overlaps(f, &r.path)))
            .map(|r| r.session.clone())
            .collect();
        if !conflicts.is_empty() {
            return Err(errors::busy(RefusalReason::FolderInUse));
        }
        let mut tokens = Vec::new();
        for (folder, checkout) in folders {
            if checkout.external {
                continue;
            }
            let token = self.id();
            state.managers.insert(token, norm(folder));
            tokens.push(token);
        }
        Ok(ActivityGuard { gate: self.clone(), tokens })
    }

    /// Admit one turn of `session` whose live cwd is `cwd()`: waits while the session itself
    /// transitions or another session holds the checkout the cwd lies in, then registers the
    /// turn until the guard drops. An abort while waiting registers nothing.
    pub async fn admit_turn(
        self: &Arc<Self>,
        session: &str,
        cwd: Cwd,
        checkouts: &dyn Checkouts,
        cancel: &CancellationToken,
    ) -> Result<TurnGuard, ScmFailure> {
        let id = key(session);
        loop {
            if cancel.is_cancelled() {
                return Err(ScmFailure::Cancelled);
            }
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let path = cwd();
            let checkout = checkouts.of(&path, cancel).await?;
            let granted = {
                let mut state = self.state();
                let now = cwd();
                if now != path {
                    None
                } else if state.blocked(&id, &path) {
                    Some(false)
                } else {
                    let reader = self.id();
                    let admitted = match &checkout {
                        Some(co) => state.admit_reader(reader, &id, &path, co),
                        None => true,
                    };
                    if admitted {
                        let readers = if checkout.is_some() { vec![reader] } else { Vec::new() };
                        let token = self.id();
                        state.turns.insert(token, Turn { session: id.clone(), cwd: cwd.clone(), readers });
                        return Ok(TurnGuard { gate: self.clone(), token });
                    }
                    Some(false)
                }
            };
            if granted.is_none() {
                continue;
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = cancel.cancelled() => return Err(ScmFailure::Cancelled),
            }
        }
    }

    /// Keep the old root protected and acquire the destination before an admitted turn moves.
    pub fn retain_admitted_turn_workspace(&self, session: &str, cwd: &str, checkout: Option<&Checkout>) -> Result<(), ScmFailure> {
        let id = key(session);
        let mut state = self.state();
        let moving: Vec<u64> = state
            .turns
            .iter()
            .filter(|(_, turn)| turn.session == id && norm(&(turn.cwd)()) != norm(cwd))
            .map(|(token, _)| *token)
            .collect();
        for token in moving {
            let Some(checkout) = checkout else { continue };
            let reader = self.id();
            if !state.admit_reader(reader, &id, cwd, checkout) {
                return Err(errors::busy(RefusalReason::FolderInUse));
            }
            if let Some(turn) = state.turns.get_mut(&token) {
                turn.readers.push(reader);
            }
        }
        Ok(())
    }

    /// Admit one worker-spawn preparation for the Leads in `session_ids`.
    pub fn enter_worker_spawn(self: &Arc<Self>, session_ids: &[&str]) -> Result<SpawnGuard, ScmFailure> {
        let mut ids: Vec<String> = session_ids.iter().map(|s| key(s)).filter(|s| !s.is_empty()).collect();
        ids.sort();
        ids.dedup();
        let mut state = self.state();
        if ids.iter().any(|id| state.transitions.contains_key(id)) {
            return Err(errors::busy_with("transition", None, None, None));
        }
        for id in &ids {
            *state.spawns.entry(id.clone()).or_default() += 1;
        }
        Ok(SpawnGuard { gate: self.clone(), ids })
    }

    /// Record (or clear with `None`) the worktree root a Lead's workers must run in.
    pub fn set_workspace_cwd_lock(&self, session: &str, cwd: Option<&str>) {
        let id = key(session);
        if id.is_empty() {
            return;
        }
        let mut state = self.state();
        match cwd {
            Some(cwd) if !cwd.is_empty() => state.cwd_locks.insert(id, cwd.to_owned()),
            _ => state.cwd_locks.remove(&id),
        };
    }

    /// The locked worker cwd for the first Lead id that has one.
    pub fn workspace_cwd_lock(&self, session_ids: &[&str]) -> Option<String> {
        let state = self.state();
        session_ids.iter().find_map(|id| state.cwd_locks.get(&key(id)).cloned())
    }

    fn release(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.state());
        self.changed.notify_waiters();
    }
}

pub struct TransitionGuard {
    gate: Arc<AdmissionGate>,
    session: String,
}

impl Drop for TransitionGuard {
    fn drop(&mut self) {
        self.gate.release(|s| {
            s.transitions.remove(&self.session);
        });
    }
}

pub struct FolderGuard {
    gate: Arc<AdmissionGate>,
    token: Option<u64>,
}

impl Drop for FolderGuard {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            self.gate.release(|s| {
                s.folder_holds.remove(&token);
            });
        }
    }
}

pub struct ActivityGuard {
    gate: Arc<AdmissionGate>,
    tokens: Vec<u64>,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.gate.release(|s| {
            for token in &self.tokens {
                s.managers.remove(token);
            }
        });
    }
}

pub struct TurnGuard {
    gate: Arc<AdmissionGate>,
    token: u64,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.gate.release(|s| {
            if let Some(turn) = s.turns.remove(&self.token) {
                for reader in turn.readers {
                    s.readers.remove(&reader);
                }
            }
        });
    }
}

pub struct SpawnGuard {
    gate: Arc<AdmissionGate>,
    ids: Vec<String>,
}

impl Drop for SpawnGuard {
    fn drop(&mut self) {
        self.gate.release(|s| {
            for id in &self.ids {
                match s.spawns.get(id).copied().unwrap_or(1) {
                    0 | 1 => {
                        s.spawns.remove(id);
                    }
                    n => {
                        s.spawns.insert(id.clone(), n - 1);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    struct Plain;

    #[async_trait]
    impl Checkouts for Plain {
        async fn of(&self, folder: &str, _cancel: &CancellationToken) -> Result<Option<Checkout>, ScmFailure> {
            Ok(Some(Checkout { top_level: folder.to_owned(), external: false }))
        }
    }

    fn cwd(path: &str) -> Cwd {
        let path = path.to_owned();
        Arc::new(move || path.clone())
    }

    #[test]
    fn a_transition_and_a_worker_spawn_never_overlap() {
        let gate = AdmissionGate::new();
        let spawn = gate.enter_worker_spawn(&["lead"]).unwrap();
        assert_eq!(gate.begin_transition("lead", "t").err().and_then(|e| e.code()), Some("WORKTREE_BUSY_JOBS"));
        drop(spawn);
        let transition = gate.begin_transition("lead", "t").unwrap();
        assert!(gate.begin_transition("lead", "t2").is_err());
        assert!(gate.enter_worker_spawn(&["lead"]).is_err());
        drop(transition);
        assert!(gate.begin_transition("lead", "t3").is_ok());
    }

    #[tokio::test]
    async fn a_turn_waits_for_its_sessions_transition_and_runs_after_it() {
        let gate = AdmissionGate::new();
        let transition = gate.begin_transition("lead", "t").unwrap();
        let waiting = {
            let gate = gate.clone();
            let admitted = Arc::new(AtomicBool::new(false));
            let flag = admitted.clone();
            let task = tokio::spawn(async move {
                let guard = gate.admit_turn("lead", cwd("/p"), &Plain, &CancellationToken::new()).await.unwrap();
                flag.store(true, Ordering::SeqCst);
                guard
            });
            (task, admitted)
        };
        tokio::task::yield_now().await;
        assert!(!waiting.1.load(Ordering::SeqCst));
        drop(transition);
        let _guard = waiting.0.await.unwrap();
        assert!(waiting.1.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn an_abort_while_waiting_registers_nothing() {
        let gate = AdmissionGate::new();
        let _transition = gate.begin_transition("lead", "t").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let refused = gate.admit_turn("lead", cwd("/p"), &Plain, &cancel).await;
        assert!(matches!(refused, Err(ScmFailure::Cancelled)));
        assert!(gate.state().turns.is_empty());
    }

    #[tokio::test]
    async fn a_held_folder_refuses_while_another_session_runs_in_it_and_blocks_new_turns() {
        let gate = AdmissionGate::new();
        let turn = gate.admit_turn("other", cwd("/p/sub"), &Plain, &CancellationToken::new()).await.unwrap();
        let refused = gate.hold_checkout_folder("lead", "/p", true).err().unwrap();
        assert_eq!(refused.code(), Some("WORKTREE_BUSY_JOBS"));
        drop(turn);
        let hold = gate.hold_checkout_folder("lead", "/p", true).unwrap();
        assert!(gate.hold_checkout_folder("x", "/p/sub", true).is_err());
        assert!(gate.state().blocked("other", "/p/sub"));
        assert!(!gate.state().blocked("lead", "/p/sub"));
        drop(hold);
        assert!(!gate.state().blocked("other", "/p/sub"));
    }

    #[tokio::test]
    async fn management_and_readers_exclude_each_other_except_the_actors_own() {
        let gate = AdmissionGate::new();
        let co = Checkout { top_level: "/p".into(), external: false };
        let turn = gate.admit_turn("lead", cwd("/p"), &Plain, &CancellationToken::new()).await.unwrap();
        assert!(gate.hold_activity(&[("/p".into(), co.clone())], Some("other")).is_err());
        let hold = gate.hold_activity(&[("/p".into(), co.clone())], Some("lead")).unwrap();
        assert!(!gate.state().admit_reader(99, "late", "/p", &co));
        drop(hold);
        drop(turn);
        assert!(gate.state().admit_reader(100, "late", "/p", &co));
    }

    #[test]
    fn worker_cwd_locks_follow_the_first_lead_with_one() {
        let gate = AdmissionGate::new();
        gate.set_workspace_cwd_lock("a", Some("/w"));
        assert_eq!(gate.workspace_cwd_lock(&["x", "a"]).as_deref(), Some("/w"));
        gate.set_workspace_cwd_lock("a", None);
        assert_eq!(gate.workspace_cwd_lock(&["a"]), None);
    }
}
