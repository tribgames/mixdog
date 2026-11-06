//! The one owner of a worker session's turn status (Node `agent-tool/worker-turns.mjs`). Every
//! turn the worker runs (a send's or spawn's own, a follow-up queued behind it, one the drain
//! after a stopped turn starts) is reported by the route that runs it. At a turn's real start
//! the owner stamps the row `running`; at its outcome it settles the row as a send's result
//! reads it. Turns are keyed by their own id, so an earlier turn's late settle never touches the
//! next one.
//!
//! Not ported: the idle-progress watchdog the Node owner arms once a turn's ask has started
//! (`progressWatchdogs`, `watchdogPolicyFor`), and with it the stall verdict of a settled turn
//! and the in-turn progress stamps the watchdog's sweep drove. A turn is never stopped for
//! silence here; the row's live progress is read from the session (`Workers::live`).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use super::reconcile::FinalStatus;
use super::reconcile::JobHandle;
use super::result::abnormal_empty_finish_error;
use super::seams::RowUpdate;
use super::seams::SessionNames;
use super::seams::TurnListener;
use super::seams::TurnOutcome;
use super::seams::TurnSource;
use super::seams::TurnStart;
use super::seams::Unobserve;
use super::seams::WorkerRows;
use crate::agent_tool::stamp::iso_from_ms;
use crate::env::Clock;

/// The row's `failureReason` for a turn the process exit cut off.
pub const PROCESS_RESTART_FAILURE: &str = "process-restart";

static SUBMISSIONS: AtomicU64 = AtomicU64::new(1);

struct Current {
    turn_id: String,
    job: Option<Arc<JobHandle>>,
}

#[derive(Default)]
struct OwnerState {
    current: Option<Current>,
    /// Submission id → the job it submits.
    claims: HashMap<String, Option<Arc<JobHandle>>>,
    started: u64,
}

struct Owner {
    session_id: String,
    state: Mutex<OwnerState>,
    unobserve: Mutex<Option<Unobserve>>,
}

impl Owner {
    fn state(&self) -> std::sync::MutexGuard<'_, OwnerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Inner {
    source: Arc<dyn TurnSource>,
    rows: Arc<dyn WorkerRows>,
    names: Arc<dyn SessionNames>,
    clock: Arc<dyn Clock>,
    changed: Arc<dyn Fn() + Send + Sync>,
    owners: Mutex<HashMap<String, Arc<Owner>>>,
}

#[derive(Clone)]
pub struct WorkerTurns {
    inner: Arc<Inner>,
}

/// The turn a dispatch submits: its submission id, and the release for the dispatch's end.
pub struct Claim {
    pub submission_id: String,
    owner: Option<(Arc<Owner>, u64)>,
    turns: Option<WorkerTurns>,
    session_id: String,
    job: Option<Arc<JobHandle>>,
    /// A claim whose release is not the owner's (a host's own bookkeeping, or a test's).
    custom: Option<Box<dyn Fn(FinalStatus) + Send + Sync>>,
}

/// What a dispatch asks of the one owner of a worker's turn status: the claim of the turn it
/// submits and the observation of turns queued behind a running one.
pub trait TurnOwner: Send + Sync {
    fn claim(&self, session_id: &str, job: Option<Arc<JobHandle>>) -> Claim;
    fn observe(&self, session_id: &str) -> bool;
}

impl TurnOwner for WorkerTurns {
    fn claim(&self, session_id: &str, job: Option<Arc<JobHandle>>) -> Claim {
        WorkerTurns::claim(self, session_id, job)
    }

    fn observe(&self, session_id: &str) -> bool {
        WorkerTurns::observe(self, session_id)
    }
}

/// A settled turn's row status (`settledTurnStatus`, minus the watchdog's stall verdict): only a
/// cancel of the turn's job reads cancelled; any other unfinished turn (a pane stop included)
/// and an abnormal empty finish are errors.
fn settled_turn_status(outcome: &TurnOutcome, agent: &str, job: Option<&JobHandle>) -> FinalStatus {
    if job.is_some_and(JobHandle::is_cancelled) {
        return FinalStatus::Cancelled;
    }
    if !outcome.done {
        return FinalStatus::Error;
    }
    match &outcome.result {
        Some(result) if abnormal_empty_finish_error(result, agent).is_some() => FinalStatus::Error,
        _ => FinalStatus::Idle,
    }
}

impl WorkerTurns {
    pub fn new(
        source: Arc<dyn TurnSource>,
        rows: Arc<dyn WorkerRows>,
        names: Arc<dyn SessionNames>,
        clock: Arc<dyn Clock>,
        changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self { inner: Arc::new(Inner { source, rows, names, clock, changed, owners: Mutex::new(HashMap::new()) }) }
    }

    /// `settledWorkerStatus` then the write: the row settles on the turn's real outcome.
    fn settle_row(&self, session_id: &str, status: FinalStatus, job: Option<&JobHandle>) {
        let restarted = job.is_some_and(|j| j.is_cancelled() && j.terminal_reason().as_deref() == Some(PROCESS_RESTART_FAILURE));
        let mut update = if restarted {
            RowUpdate {
                status: Some("failed".into()),
                stage: Some("failed".into()),
                failure_reason: Some(PROCESS_RESTART_FAILURE.into()),
                task_id: job.map(|j| Some(j.task_id().to_owned())),
                ..RowUpdate::default()
            }
        } else {
            RowUpdate { status: Some(status.word().into()), stage: Some(status.word().into()), ..RowUpdate::default() }
        };
        update.finished_at = Some(iso_from_ms(self.inner.clock.now_ms()));
        let tag = self.inner.names.tag_for_session(session_id);
        self.inner.rows.upsert(session_id, tag.as_deref(), update);
        (self.inner.changed)();
    }

    fn turn_started(&self, owner: &Owner, start: TurnStart) {
        let (job, session_id) = {
            let mut state = owner.state();
            state.started += 1;
            let claim = start.submission_ids.iter().find(|id| state.claims.contains_key(*id)).cloned();
            let job = claim.and_then(|id| state.claims.remove(&id)).flatten();
            state.current = Some(Current { turn_id: start.turn_id.clone(), job: job.clone() });
            (job, owner.session_id.clone())
        };
        let tag = self.inner.names.tag_for_session(&session_id);
        self.inner.rows.upsert(
            &session_id,
            tag.as_deref(),
            RowUpdate {
                status: Some("running".into()),
                stage: Some("running".into()),
                // The turn's own task: a restart that ends this turn reports it by id.
                task_id: Some(job.as_ref().map(|j| j.task_id().to_owned())),
                turn_started_at: Some(iso_from_ms(start.started_at_ms)),
                ..RowUpdate::default()
            },
        );
        (self.inner.changed)();
    }

    fn turn_settled(&self, owner: &Owner, outcome: TurnOutcome) {
        let job = {
            let mut state = owner.state();
            match state.current.take() {
                Some(current) if current.turn_id == outcome.turn_id => current.job,
                other => {
                    state.current = other;
                    return;
                }
            }
        };
        let agent = self.inner.names.agent(&owner.session_id).unwrap_or_default();
        let status = settled_turn_status(&outcome, &agent, job.as_deref());
        self.settle_row(&owner.session_id, status, job.as_deref());
    }

    /// Observes `session_id`'s turns through the route that runs them; `false` when that route
    /// reports none.
    pub fn observe(&self, session_id: &str) -> bool {
        self.owner_of(session_id).is_some()
    }

    fn owner_of(&self, session_id: &str) -> Option<Arc<Owner>> {
        if session_id.is_empty() {
            return None;
        }
        let mut owners = self.inner.owners.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = owners.get(session_id) {
            return Some(existing.clone());
        }
        let owner = Arc::new(Owner { session_id: session_id.to_owned(), state: Mutex::default(), unobserve: Mutex::new(None) });
        let listener = Arc::new(OwnerListener { turns: Arc::downgrade(&self.inner), owner: owner.clone() });
        let unobserve = self.inner.source.observe_session_turns(session_id, listener)?;
        *owner.unobserve.lock().unwrap_or_else(|e| e.into_inner()) = Some(unobserve);
        owners.insert(session_id.to_owned(), owner.clone());
        Some(owner)
    }

    /// The turn `job` submits on `session_id`: its submission id, which the route reports on that
    /// turn's start (the turn then carries the job), and `release` for the dispatch's end. A
    /// dispatch that started no turn at all (it failed before one opened) settles the row itself.
    pub fn claim(&self, session_id: &str, job: Option<Arc<JobHandle>>) -> Claim {
        let submission_id = format!("agent-turn-{:016x}", SUBMISSIONS.fetch_add(1, Ordering::SeqCst));
        let owner = self.owner_of(session_id).map(|owner| {
            let started_before = {
                let mut state = owner.state();
                state.claims.insert(submission_id.clone(), job.clone());
                state.started
            };
            (owner, started_before)
        });
        Claim { submission_id, owner, turns: Some(self.clone()), session_id: session_id.to_owned(), job, custom: None }
    }

    /// A deleted session runs no further turn.
    pub fn forget(&self, session_id: &str) {
        let owner = self.inner.owners.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        if let Some(unobserve) = owner.and_then(|o| o.unobserve.lock().unwrap_or_else(|e| e.into_inner()).take()) {
            unobserve();
        }
    }

    pub fn dispose(&self) {
        let ids: Vec<String> = self.inner.owners.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        for id in ids {
            self.forget(&id);
        }
    }
}

impl Claim {
    /// A claim that releases through release.
    pub fn custom(submission_id: String, release: Box<dyn Fn(FinalStatus) + Send + Sync>) -> Self {
        Self { submission_id, owner: None, turns: None, session_id: String::new(), job: None, custom: Some(release) }
    }

    pub fn release(&self, status: FinalStatus) {
        if let Some(release) = &self.custom {
            release(status);
            return;
        }
        let (Some((owner, started_before)), Some(turns)) = (&self.owner, &self.turns) else { return };
        let settle = {
            let mut state = owner.state();
            if state.claims.remove(&self.submission_id).is_none() {
                return;
            }
            state.current.is_none() && state.started == *started_before
        };
        if settle {
            turns.settle_row(&self.session_id, status, self.job.as_deref());
        }
    }
}

struct OwnerListener {
    turns: Weak<Inner>,
    owner: Arc<Owner>,
}

impl TurnListener for OwnerListener {
    fn turn_started(&self, start: TurnStart) {
        if let Some(inner) = self.turns.upgrade() {
            WorkerTurns { inner }.turn_started(&self.owner, start);
        }
    }

    fn turn_settled(&self, outcome: TurnOutcome) {
        if let Some(inner) = self.turns.upgrade() {
            WorkerTurns { inner }.turn_settled(&self.owner, outcome);
        }
    }
}
