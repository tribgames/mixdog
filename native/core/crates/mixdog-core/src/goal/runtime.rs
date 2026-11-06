//! `goal-runtime.mjs` + `goal-store.mjs`: the per-session Goal record, its serialized mutations,
//! the commit, listener publication and the visible/stored snapshots.
//!
//! A mutation is one job on the durability lane: it holds the record's file lock, reads the
//! record from disk, edits and writes it, and runs to its end on one thread, so two sessions never
//! wait on each other and one session's mutations run in the order they were asked. Reads outside
//! a mutation answer from the session's in-memory copy of the committed record.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use async_trait::async_trait;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken, TaskClass};
use serde_json::Value;

use super::error::{GoalError, GoalResult};
use super::js::{Goal, clean, now_wall_ms, put, put_num, string, truthy};
use super::state::{
    DEFAULT_COMPLETED_GOAL_TTL_MS, DEFAULT_GOAL_DEADLINE_WARNING_MS, DEFAULT_GOAL_TIME_LIMIT_MS, assert_session_id,
    completed_goal_expired, discard_unobserved_time, normalize_stored_goal, normalized_completed_goal_ttl_ms, public_goal,
};
use super::storage::{self, delete_stored_goal_file, goals_root, record_path};

/// The wall clock and, where it can show a suspend, the monotonic clock paired with it.
pub trait GoalClock: Send + Sync {
    /// `Date.now()`.
    fn now(&self) -> f64;
    /// `performance.now()`, or `None` when no monotonic clock pairs with `now`.
    fn monotonic(&self) -> Option<f64>;
}

pub struct SystemClock {
    start: std::time::Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self { start: std::time::Instant::now() }
    }
}

impl GoalClock for SystemClock {
    fn now(&self) -> f64 {
        now_wall_ms()
    }
    fn monotonic(&self) -> Option<f64> {
        Some(self.start.elapsed().as_secs_f64() * 1000.0)
    }
}

/// Cancels one registered timer. Dropping it does not cancel.
pub struct Timer(Option<Box<dyn FnOnce() + Send>>);

impl Timer {
    pub fn new(cancel: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(cancel)))
    }
    pub fn cancel(mut self) {
        if let Some(cancel) = self.0.take() {
            cancel();
        }
    }
}

/// The deadline facility: `callback` runs once after `delay_ms`. Callbacks only hand work to a
/// task; they never block.
pub trait GoalTimers: Send + Sync {
    fn after(&self, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) -> Timer;
}

/// The process ticker (`mixdog_rt::ticker`): one task serves every deadline; nothing polls.
pub struct TickerTimers;

impl GoalTimers for TickerTimers {
    fn after(&self, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) -> Timer {
        let at = std::time::Instant::now() + std::time::Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
        let handle = mixdog_rt::ticker().register(at, callback);
        Timer::new(move || {
            handle.cancel();
        })
    }
}

/// The title model (`generateTitle(objective, { signal })`).
#[async_trait]
pub trait GoalTitles: Send + Sync {
    async fn generate(&self, objective: &str, cancel: &CancellationToken) -> GoalResult<String>;
}

pub struct GoalConfig {
    pub data_dir: String,
    pub default_time_limit_ms: f64,
    pub completed_goal_ttl_ms: f64,
    pub deadline_warning_ms: Vec<f64>,
    /// Whether the monotonic clock stops while the OS sleeps (not on Windows).
    pub suspend_detectable: bool,
}

impl GoalConfig {
    pub fn new(data_dir: impl Into<String>) -> Self {
        Self {
            data_dir: data_dir.into(),
            default_time_limit_ms: DEFAULT_GOAL_TIME_LIMIT_MS,
            completed_goal_ttl_ms: DEFAULT_COMPLETED_GOAL_TTL_MS,
            deadline_warning_ms: DEFAULT_GOAL_DEADLINE_WARNING_MS.to_vec(),
            suspend_detectable: !cfg!(windows),
        }
    }
}

pub struct GoalEnv {
    pub clock: Arc<dyn GoalClock>,
    pub timers: Arc<dyn GoalTimers>,
    pub titles: Option<Arc<dyn GoalTitles>>,
    pub on_storage_error: Arc<dyn Fn(&GoalError) + Send + Sync>,
    pub lane: DurabilityIo,
}

impl GoalEnv {
    pub fn system(lane: DurabilityIo) -> Self {
        Self {
            clock: Arc::new(SystemClock::default()),
            timers: Arc::new(TickerTimers),
            titles: None,
            on_storage_error: Arc::new(storage::report_storage_error),
            lane,
        }
    }
}

/// A change heard by the listeners: the session and its visible Goal (none: cleared or retired).
#[derive(Clone, PartialEq, Debug)]
pub struct GoalEvent {
    pub session_id: String,
    pub goal: Option<Goal>,
}

type Listener = Arc<dyn Fn(&GoalEvent) + Send + Sync>;

/// Dropping it stops the notifications.
pub struct Subscription {
    id: u64,
    inner: Weak<Inner>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner.listeners.lock().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
        }
    }
}

/// `isCurrent` / `accept` of a quota resume: the commit stands only while both hold, else the
/// record is put back. Both run on the lane thread and must not block.
#[derive(Default)]
pub struct Admission {
    pub is_current: Option<Box<dyn Fn() -> GoalResult<bool> + Send>>,
    pub accept: Option<Box<dyn Fn() -> GoalResult<bool> + Send>>,
}

pub(crate) struct TitleJob {
    pub id: u64,
    pub cancel: CancellationToken,
}

#[derive(Default)]
pub(crate) struct SlotMem {
    /// The committed record as last read or written; `None` before the first load.
    pub cache: Option<Option<Goal>>,
    pub adopted: bool,
    pub turn_goal_id: Option<String>,
    pub turn_started_at: Option<f64>,
    pub turn_objective_revision: Option<f64>,
    pub idle_review: Option<String>,
    pub continuation_tier: Option<String>,
    pub unsaved_stop: Option<String>,
    pub anchor: Option<(f64, f64)>,
    pub deadline_timer: Option<Timer>,
    pub warning_timer: Option<Timer>,
    pub heartbeat: Option<Timer>,
    pub heartbeat_gen: u64,
    pub expiry_pending: bool,
    pub warning_pending: bool,
    pub title_job: Option<TitleJob>,
}

pub(crate) struct Slot {
    /// One mutation at a time, in the order asked.
    pub chain: Arc<tokio::sync::Mutex<()>>,
    pub mem: Mutex<SlotMem>,
}

impl Slot {
    pub fn mem(&self) -> std::sync::MutexGuard<'_, SlotMem> {
        self.mem.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default)]
struct Background {
    count: AtomicUsize,
    changed: tokio::sync::Notify,
}

pub(crate) struct Inner {
    pub root: PathBuf,
    pub env: GoalEnv,
    pub default_time_limit_ms: f64,
    pub completed_retention_ms: f64,
    pub warning_thresholds: Vec<f64>,
    pub suspend_detectable: bool,
    pub closed: AtomicBool,
    sessions: Mutex<HashMap<String, Arc<Slot>>>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
    pub next_title_job: AtomicU64,
    background: Background,
}

/// The work a mutation does, on the lane thread, under the record's lock.
pub(crate) struct Tx<'a> {
    pub inner: &'a Arc<Inner>,
    pub slot: &'a Arc<Slot>,
    pub id: &'a str,
    pub lane: &'a InLane<DurabilityIo>,
    pub path: PathBuf,
    pub held: Vec<Option<Goal>>,
}

type Turn = std::pin::Pin<Box<dyn Future<Output = tokio::sync::OwnedMutexGuard<()>> + Send>>;

/// Joins the session's queue now: the first poll registers the waiter, which keeps its place.
fn reserve_turn(slot: &Slot) -> Turn {
    let mut waiting = Box::pin(slot.chain.clone().lock_owned());
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match waiting.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(guard) => Box::pin(std::future::ready(guard)),
        std::task::Poll::Pending => waiting,
    }
}

fn normalize_thresholds(values: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for value in values {
        let n = value.floor();
        if n.is_finite() && n > 0.0 && !out.contains(&n) {
            out.push(n);
        }
    }
    out.sort_by(|a, b| b.total_cmp(a));
    out
}

impl Inner {
    pub fn now(&self) -> f64 {
        self.env.clock.now()
    }

    pub fn on_error(&self, error: &GoalError) {
        (self.env.on_storage_error)(error);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn slot(&self, id: &str) -> Arc<Slot> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Slot { chain: Arc::new(tokio::sync::Mutex::new(())), mem: Mutex::default() }))
            .clone()
    }

    pub fn slots(&self) -> Vec<Arc<Slot>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner).values().cloned().collect()
    }

    /// Runs `fut` as a tracked background task (`close` and `settled` wait for it).
    pub fn spawn_task(self: &Arc<Self>, fut: impl Future<Output = ()> + Send + 'static) {
        self.background.count.fetch_add(1, Ordering::SeqCst);
        let inner = self.clone();
        mixdog_rt::spawn("goal-background", TaskClass::Work, async move {
            fut.await;
            if inner.background.count.fetch_sub(1, Ordering::SeqCst) == 1 {
                inner.background.changed.notify_waiters();
            }
        });
    }

    pub async fn settled(&self) {
        loop {
            let changed = self.background.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.background.count.load(Ordering::SeqCst) == 0 {
                return;
            }
            changed.await;
        }
    }

    /// A mutation whose failure is only reported (`.catch(onStorageError)`).
    pub fn spawn_mutation(
        self: &Arc<Self>,
        id: String,
        op: impl FnOnce(&mut Tx<'_>) -> GoalResult<()> + Send + 'static,
        finally: impl FnOnce(&Arc<Inner>) + Send + 'static,
    ) {
        let inner = self.clone();
        // Node's `withMutation` takes its place in the chain when called, not when the task
        // first runs, so a mutation asked before a later one runs before it.
        let reserved = assert_session_id(&id).map(|id| {
            let slot = self.slot(&id);
            let turn = reserve_turn(&slot);
            (id, slot, turn)
        });
        self.spawn_task(async move {
            let result = match reserved {
                Ok((id, slot, turn)) => inner.run_mutation(&id, &slot, turn, op).await,
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                inner.on_error(&error);
            }
            finally(&inner);
        });
    }

    /// `withMutation`: serialized per session, under the record's lock, reading from disk; the
    /// publications it made go out once it has settled.
    pub async fn with_mutation<R: Send + 'static>(
        self: &Arc<Self>,
        id: &str,
        op: impl FnOnce(&mut Tx<'_>) -> GoalResult<R> + Send + 'static,
    ) -> GoalResult<R> {
        let id = assert_session_id(id)?;
        let slot = self.slot(&id);
        let turn = reserve_turn(&slot);
        self.run_mutation(&id, &slot, turn, op).await
    }

    async fn run_mutation<R: Send + 'static>(
        self: &Arc<Self>,
        id: &str,
        slot: &Arc<Slot>,
        turn: Turn,
        op: impl FnOnce(&mut Tx<'_>) -> GoalResult<R> + Send + 'static,
    ) -> GoalResult<R> {
        let id = id.to_owned();
        let _turn = turn.await;
        let (inner, job_slot, job_id) = (self.clone(), slot.clone(), id.clone());
        let job = move |lane: &InLane<DurabilityIo>| {
            let path = record_path(&inner.root, &job_id);
            let mut tx = Tx { inner: &inner, slot: &job_slot, id: &job_id, lane, path: path.clone(), held: Vec::new() };
            let result = storage::locked(lane, &path, || op(&mut tx)).and_then(|r| r);
            (result, tx.held)
        };
        let submitted = self
            .env
            .lane
            .submit(&CancellationToken::new(), job)
            .map_err(|_| GoalError::new("goal storage is busy"))?;
        let (result, held) = submitted.await.map_err(|_| GoalError::new("goal storage stopped"))?;
        // A mutation takes the record's lock in the goals directory; the directory watch of
        // Node's cache answers with a re-read of the file as stored, which replaces a copy the
        // first load had charged the unobserved stretch to.
        slot.mem().cache = None;
        for goal in held {
            self.notify(&id, goal);
        }
        result
    }

    pub fn notify(&self, id: &str, goal: Option<Goal>) {
        let listeners: Vec<Listener> =
            self.listeners.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, l)| l.clone()).collect();
        let event = GoalEvent { session_id: id.to_owned(), goal };
        for listener in listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&event)));
        }
    }

    pub fn subscribe(self: &Arc<Self>, listener: impl Fn(&GoalEvent) + Send + Sync + 'static) -> Subscription {
        let id = self.next_listener.fetch_add(1, Ordering::SeqCst);
        self.listeners.lock().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(listener)));
        Subscription { id, inner: Arc::downgrade(self) }
    }

    /// The first load of a record in this runtime drops the stretch of an open clock segment no
    /// live runtime ran (closed app, sleeping PC).
    fn load(&self, lane: &InLane<DurabilityIo>, slot: &Slot, id: &str) -> GoalResult<Option<Goal>> {
        let at = self.now();
        let mut normalize = |value: &Value| -> GoalResult<Option<Goal>> {
            let mut goal = normalize_stored_goal(value, id, at)?;
            if let Some(goal) = goal.as_mut() {
                let mut mem = slot.mem();
                if !mem.adopted {
                    mem.adopted = true;
                    discard_unobserved_time(goal, at, 0.0);
                }
            }
            Ok(goal)
        };
        storage::read_record(lane, &record_path(&self.root, id), id, at, &mut normalize)
    }

    /// `readStoredRecord` for an observer: the cached committed record, loaded once.
    pub(crate) async fn cached(self: &Arc<Self>, slot: &Arc<Slot>, id: &str) -> GoalResult<Option<Goal>> {
        if let Some(cached) = slot.mem().cache.clone() {
            return Ok(cached);
        }
        let (inner, slot, id) = (self.clone(), slot.clone(), id.to_owned());
        let job = move |lane: &InLane<DurabilityIo>| -> GoalResult<Option<Goal>> {
            let goal = inner.load(lane, &slot, &id)?;
            slot.mem().cache = Some(goal.clone());
            Ok(goal)
        };
        self.env
            .lane
            .submit(&CancellationToken::new(), job)
            .map_err(|_| GoalError::new("goal storage is busy"))?
            .await
            .map_err(|_| GoalError::new("goal storage stopped"))?
    }

    /// `readRecord(id).goal` for an observer: the committed record with a pending suspend charged
    /// to the copy.
    pub async fn read_view(self: &Arc<Self>, slot: &Arc<Slot>, id: &str) -> GoalResult<Option<Goal>> {
        let mut goal = self.cached(slot, id).await?;
        if let Some(goal) = goal.as_mut() {
            self.drop_suspended(slot, id, goal, self.now());
        }
        Ok(goal)
    }

    pub fn emit_direct(&self, id: &str, goal: Option<Goal>) {
        self.notify(id, goal);
    }

    /// `visibleSnapshot` for an observer.
    pub async fn visible_snapshot(self: &Arc<Self>, id: &str) -> GoalResult<Option<Goal>> {
        let id = assert_session_id(id)?;
        let slot = self.slot(&id);
        // `limitIfExpired` reads the stored record and settles the suspend itself, so that a
        // drop shows as a change to commit and publish.
        let record = self.cached(&slot, &id).await;
        let (goal, expired) = self.snapshot_from(&slot, &id, record);
        if expired {
            let (inner, id) = (self.clone(), id.clone());
            let job = move |_: &InLane<DurabilityIo>| {
                delete_stored_goal_file(&inner.root, &id);
            };
            if let Ok(done) = self.env.lane.submit(&CancellationToken::new(), job) {
                let _ = done.await;
            }
        }
        Ok(goal.filter(|g| !truthy(g.get("archivedAt"))))
    }

    /// `storedSnapshot` from a record already read: the public Goal, and whether it is an expired
    /// completed one whose file the caller deletes.
    pub fn snapshot_from(self: &Arc<Self>, slot: &Arc<Slot>, id: &str, record: GoalResult<Option<Goal>>) -> (Option<Goal>, bool) {
        let at = self.now();
        let goal = match record {
            Ok(goal) => self.limit_if_expired_with(slot, id, goal),
            Err(error) => {
                self.on_error(&error);
                return (None, false);
            }
        };
        let goal = public_goal(goal.as_ref(), at);
        let ttl = normalized_completed_goal_ttl_ms(self.completed_retention_ms);
        if !completed_goal_expired(goal.as_ref(), at, ttl) {
            return (goal, false);
        }
        self.clear_deadline(slot);
        slot.mem().cache = Some(None);
        (None, true)
    }

    pub fn tx_new_title_job_id(&self) -> u64 {
        self.next_title_job.fetch_add(1, Ordering::SeqCst)
    }
}

impl<'a> Tx<'a> {
    pub fn now(&self) -> f64 {
        self.inner.now()
    }

    /// `readStoredRecord` inside a mutation: the record from disk.
    pub fn read_stored(&self) -> GoalResult<Option<Goal>> {
        let goal = self.inner.load(self.lane, self.slot, self.id)?;
        self.slot.mem().cache = Some(goal.clone());
        Ok(goal)
    }

    /// `readRecord(id).goal`: from disk, with a pending suspend charged to the copy.
    pub fn read_record(&self) -> GoalResult<Option<Goal>> {
        let mut goal = self.read_stored()?;
        if let Some(goal) = goal.as_mut() {
            self.inner.drop_suspended(self.slot, self.id, goal, self.now());
        }
        Ok(goal)
    }

    pub fn require_goal(&self) -> GoalResult<Goal> {
        self.read_record()?.ok_or_else(|| GoalError::new("no Goal exists for this session"))
    }

    /// `storedSnapshot` inside a mutation.
    pub fn stored_snapshot(&self) -> Option<Goal> {
        let (goal, expired) = self.inner.snapshot_from(self.slot, self.id, self.read_stored());
        if expired {
            delete_stored_goal_file(&self.inner.root, self.id);
        }
        goal
    }

    pub fn visible_snapshot(&self) -> Option<Goal> {
        self.stored_snapshot().filter(|g| !truthy(g.get("archivedAt")))
    }

    /// `emit`: held until the mutation has settled.
    pub fn emit(&mut self) {
        let goal = self.visible_snapshot();
        self.held.push(goal);
    }

    fn write(&self, goal: Option<&Goal>) -> GoalResult<()> {
        storage::write_record(self.lane, &self.path, goal)?;
        let at = self.now();
        let cached = goal.and_then(|g| normalize_stored_goal(&Value::Object(g.clone()), self.id, at).ok().flatten());
        let ok = goal.is_none() || cached.is_some();
        self.slot.mem().cache = if ok { Some(cached) } else { None };
        Ok(())
    }

    /// The heartbeat's write: durable liveness only.
    pub fn stamp_live(&self, goal: &Goal) -> GoalResult<()> {
        let mut goal = goal.clone();
        put(&mut goal, "sessionId", self.id);
        self.write(Some(&goal))
    }

    /// `commit`: writes `goal` (`None` clears the record), then re-arms the deadline and
    /// publishes. With an admission the write stands only while it holds, else the record is
    /// put back and `Ok(None)` answers.
    pub fn commit(&mut self, goal: Option<Goal>, admission: Option<&Admission>) -> GoalResult<Option<Goal>> {
        let id = self.id;
        let previous = if goal.is_some() { self.read_stored()? } else { None };
        let stamped_at = self.now();
        let committed = goal.map(|goal| {
            let mut committed = goal;
            put(&mut committed, "sessionId", id);
            if string(&committed, "status") == "active" {
                self.inner.drop_suspended(self.slot, id, &mut committed, stamped_at);
                put_num(&mut committed, "liveAt", stamped_at);
            }
            committed
        });
        let guarded = admission.is_some_and(|a| a.is_current.is_some() || a.accept.is_some());
        if let Err(error) = self.write(committed.as_ref()) {
            if guarded {
                self.rollback(previous.as_ref())?;
            }
            return Err(error);
        }
        if let Some(admission) = admission.filter(|_| guarded) {
            let mut failure = None;
            let mut accepted = true;
            let mut check = |f: &(dyn Fn() -> GoalResult<bool> + Send)| match f() {
                Ok(ok) => ok,
                Err(error) => {
                    failure = Some(error);
                    false
                }
            };
            if let Some(is_current) = &admission.is_current {
                accepted = check(is_current.as_ref());
            }
            if accepted {
                if let Some(accept) = &admission.accept {
                    accepted = check(accept.as_ref());
                }
            }
            if !accepted {
                self.rollback(previous.as_ref())?;
                return match failure {
                    Some(error) => Err(error),
                    None => Ok(None),
                };
            }
        }
        if let Some(committed) = &committed {
            self.inner.observe(self.slot, id, stamped_at, committed);
        }
        self.arm_after_write();
        self.emit();
        Ok(public_goal(committed.as_ref(), self.now()))
    }

    fn rollback(&mut self, previous: Option<&Goal>) -> GoalResult<()> {
        if let Err(mut error) = self.write(previous) {
            error.rollback_failed = true;
            return Err(error);
        }
        self.arm_after_write();
        Ok(())
    }

    /// `armDeadline(id)` right after a write of the record.
    fn arm_after_write(&self) {
        let goal = self.read_stored().ok().flatten();
        self.inner.arm_deadline(self.slot, self.id, goal);
    }

    pub fn schedule_title(&self, goal: &Goal) {
        self.inner.schedule_title(self.id, goal);
    }
}

/// The Goal runtime of a daemon: every session's record, deadlines, turns and titles.
#[derive(Clone)]
pub struct GoalRuntime {
    pub(crate) inner: Arc<Inner>,
}

impl GoalRuntime {
    pub fn new(config: GoalConfig, env: GoalEnv) -> Self {
        let root = goals_root(&config.data_dir);
        let completed = normalized_completed_goal_ttl_ms(config.completed_goal_ttl_ms);
        Self {
            inner: Arc::new(Inner {
                root,
                env,
                default_time_limit_ms: config.default_time_limit_ms,
                completed_retention_ms: completed,
                warning_thresholds: normalize_thresholds(&config.deadline_warning_ms),
                suspend_detectable: config.suspend_detectable,
                closed: AtomicBool::new(false),
                sessions: Mutex::default(),
                listeners: Mutex::default(),
                next_listener: AtomicU64::new(0),
                next_title_job: AtomicU64::new(0),
                background: Background::default(),
            }),
        }
    }

    pub fn subscribe(&self, listener: impl Fn(&GoalEvent) + Send + Sync + 'static) -> Subscription {
        self.inner.subscribe(listener)
    }

    /// `snapshot`: the visible Goal, arming its deadline.
    pub async fn snapshot(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        let goal = self.inner.visible_snapshot(session_id).await?;
        if goal.is_some() {
            self.inner.arm_observed(session_id).await?;
        }
        Ok(goal)
    }

    /// `storedSnapshot`: the Goal including an archived one.
    pub async fn stored_snapshot(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        let id = assert_session_id(session_id)?;
        let slot = self.inner.slot(&id);
        let record = self.inner.cached(&slot, &id).await;
        let (goal, expired) = self.inner.snapshot_from(&slot, &id, record);
        if expired {
            let root = self.inner.root.clone();
            let job = move |_: &InLane<DurabilityIo>| {
                delete_stored_goal_file(&root, &id);
            };
            if let Ok(done) = self.inner.env.lane.submit(&CancellationToken::new(), job) {
                let _ = done.await;
            }
        }
        Ok(goal)
    }

    /// `watchSession`: the visible Goal, arming its deadline and telling the listeners.
    pub async fn watch_session(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        if clean(Some(&Value::String(session_id.to_owned()))).is_empty() {
            return Ok(None);
        }
        let goal = self.inner.visible_snapshot(session_id).await?;
        if goal.is_some() {
            self.inner.arm_observed(session_id).await?;
        }
        self.inner.emit_direct(&assert_session_id(session_id)?, goal.clone());
        Ok(goal)
    }

    /// Tasks a legacy record still carries for the session's todo list to adopt.
    pub async fn legacy_tasks(&self, session_id: &str) -> Vec<Value> {
        let read = async {
            let id = assert_session_id(session_id)?;
            let slot = self.inner.slot(&id);
            self.inner.read_view(&slot, &id).await
        };
        match read.await {
            Ok(Some(goal)) => goal.get("legacyTasks").and_then(Value::as_array).cloned().unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    pub async fn clear_legacy_tasks(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        self.inner
            .with_mutation(session_id, |tx| {
                let Some(mut goal) = tx.read_record()? else { return Ok(None) };
                if goal.get("legacyTasks").and_then(Value::as_array).is_none_or(|t| t.is_empty()) {
                    return Ok(None);
                }
                put(&mut goal, "legacyTasks", Vec::<Value>::new());
                tx.commit(Some(goal), None)
            })
            .await
    }

    /// Waits for the background work (expiries, warnings, titles) that has been started.
    pub async fn settled(&self) {
        self.inner.settled().await;
    }

    /// `close`: timers and title jobs stop, listeners go, and the accepted mutations finish.
    pub async fn close(&self) {
        let inner = &self.inner;
        inner.closed.store(true, Ordering::SeqCst);
        for slot in inner.slots() {
            let mut mem = slot.mem();
            if let Some(job) = mem.title_job.take() {
                job.cancel.cancel();
            }
            inner.close_deadlines(&mut mem);
            mem.turn_goal_id = None;
            mem.turn_started_at = None;
            mem.turn_objective_revision = None;
            mem.idle_review = None;
            mem.continuation_tier = None;
            mem.unsaved_stop = None;
        }
        inner.listeners.lock().unwrap_or_else(PoisonError::into_inner).clear();
        for slot in inner.slots() {
            drop(slot.chain.lock().await);
        }
        inner.settled().await;
    }
}
