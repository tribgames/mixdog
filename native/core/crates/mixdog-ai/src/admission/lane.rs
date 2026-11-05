use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use arc_swap::ArcSwap;
use mixdog_protocol::ProviderId;
use mixdog_rt::TaskClass;
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// Waiting requests per lane before `QueueFull` (PW §7.2).
pub const DEFAULT_MAX_QUEUE: usize = 1024;

/// Only transient burst windows are coordinated locally: a longer
/// `Retry-After` can describe a model-specific subscription pool, and the
/// provider stays authoritative for it on every request.
pub const COOLDOWN_COORDINATION_CAP: Duration = Duration::from_secs(60);

/// A park behind a cooldown shorter than this is not announced.
pub const COOLDOWN_NOTICE_MIN: Duration = Duration::from_millis(250);

/// Dispatch order: lower first.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub enum Priority {
    UserBlocking,
    #[default]
    UserVisible,
    BestEffort,
}

impl Priority {
    const COUNT: usize = 3;

    fn rank(self) -> usize {
        self as usize
    }
}

/// `provider:account`, where `account` is the roster account id (never a
/// token hash) or `default`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct LaneKey {
    pub provider: ProviderId,
    pub account: Arc<str>,
}

impl LaneKey {
    pub fn new(provider: ProviderId, account: impl Into<Arc<str>>) -> Self {
        Self {
            provider,
            account: account.into(),
        }
    }
}

impl fmt::Display for LaneKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.provider, self.account)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LaneSettings {
    /// Operator-configured concurrency; `None` is unbounded.
    pub concurrency: Option<usize>,
    /// Waiting requests before `QueueFull`.
    pub max_queue: usize,
    /// The lane halves its limit on a 429 and recovers one slot per window of
    /// successes. A property the provider adapter declares, not a name list.
    pub adaptive: bool,
}

impl Default for LaneSettings {
    fn default() -> Self {
        Self {
            concurrency: None,
            max_queue: DEFAULT_MAX_QUEUE,
            adaptive: false,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AdmissionError {
    QueueFull { lane: String, max_queue: usize },
    Cancelled,
    Closed,
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueueFull { lane, max_queue } => {
                write!(f, "provider admission queue full for {lane} (maximum {max_queue})")
            }
            Self::Cancelled => f.write_str("admission cancelled"),
            Self::Closed => f.write_str("admission closed"),
        }
    }
}

impl std::error::Error for AdmissionError {}

/// Called once, synchronously, when a request parks behind a rate-limit
/// cooldown longer than [`COOLDOWN_NOTICE_MIN`]: display only.
pub type CooldownNotice = Arc<dyn Fn(Duration) + Send + Sync>;

#[derive(Clone, Default)]
pub struct AdmissionRequest {
    /// Fairness key: the admission owner, else the session id.
    pub owner: Arc<str>,
    pub priority: Priority,
    pub on_cooldown_wait: Option<CooldownNotice>,
}

/// What the request saw at admission.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AdmissionMetrics {
    pub queue_wait: Duration,
    pub active: usize,
    pub queued: usize,
    pub limit: Option<usize>,
}

/// Why a request that must not wait (a cache warm) cannot start now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Block {
    Cooldown,
    Throttled,
}

/// How an admitted request ended, for the lane's adaptive accounting.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome {
    Success,
    /// A failed request; `status`/`retry_after` as classified on the error.
    Failure {
        status: Option<u16>,
        retry_after: Option<Duration>,
    },
    /// Ended without an outcome (cancelled): no accounting.
    Abandoned,
}

#[derive(Clone, PartialEq, Debug)]
pub struct LaneSnapshot {
    pub key: String,
    pub active: usize,
    pub queued: usize,
    pub owners: usize,
    pub limit: Option<usize>,
    pub cooldown: Duration,
    pub oldest_wait: Duration,
}

struct Waiter {
    id: u64,
    owner: Arc<str>,
    queued_at: Instant,
    grant: oneshot::Sender<()>,
}

#[derive(Default)]
struct State {
    active: usize,
    limit: Option<usize>,
    queues: [VecDeque<Waiter>; Priority::COUNT],
    next_id: u64,
    fair_cursor: Option<Arc<str>>,
    cooldown_until: Option<Instant>,
    timer_armed: bool,
    recovery_successes: usize,
    recovery_target: Option<usize>,
    closed: bool,
}

impl State {
    fn queued(&self) -> usize {
        self.queues.iter().map(VecDeque::len).sum()
    }

    fn cooling(&self, now: Instant) -> Option<Duration> {
        self.cooldown_until
            .and_then(|until| until.checked_duration_since(now))
            .filter(|left| !left.is_zero())
    }

    fn has_room(&self) -> bool {
        self.limit.is_none_or(|limit| self.active < limit)
    }

    /// Best priority first; within it the owner after the last served one.
    fn pop_next(&mut self) -> Option<Waiter> {
        let queue = self.queues.iter_mut().find(|queue| !queue.is_empty())?;
        let mut owners: Vec<&Arc<str>> = Vec::new();
        for waiter in queue.iter() {
            if !owners.contains(&&waiter.owner) {
                owners.push(&waiter.owner);
            }
        }
        let chosen = match self
            .fair_cursor
            .as_ref()
            .and_then(|last| owners.iter().position(|owner| *owner == last))
        {
            Some(prior) if owners.len() > 1 => owners[(prior + 1) % owners.len()].clone(),
            _ => owners[0].clone(),
        };
        let index = queue.iter().position(|w| w.owner == chosen)?;
        self.fair_cursor = Some(chosen);
        queue.remove(index)
    }
}

pub struct Lane {
    key: LaneKey,
    settings: LaneSettings,
    state: Mutex<State>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Lane {
    fn new(key: LaneKey, settings: LaneSettings) -> Arc<Self> {
        Arc::new(Self {
            key,
            settings,
            state: Mutex::new(State {
                limit: settings.concurrency,
                ..State::default()
            }),
        })
    }

    pub fn key(&self) -> &LaneKey {
        &self.key
    }

    /// Hands free slots to waiters, or arms the cooldown timer.
    fn drain(self: &Arc<Self>, st: &mut State) {
        if st.cooling(Instant::now()).is_some() {
            self.arm_timer(st);
            return;
        }
        while st.has_room() {
            let Some(waiter) = st.pop_next() else { break };
            st.active += 1;
            if waiter.grant.send(()).is_err() {
                st.active -= 1;
            }
        }
    }

    /// One timer task per lane at a time, ending when the cooldown has.
    fn arm_timer(self: &Arc<Self>, st: &mut State) {
        if st.timer_armed || st.closed || st.cooling(Instant::now()).is_none() {
            return;
        }
        st.timer_armed = true;
        let lane = self.clone();
        mixdog_rt::spawn("ai.admission.cooldown", TaskClass::Control, async move {
            loop {
                let until = locked(&lane.state).cooldown_until;
                match until {
                    Some(until) if until > Instant::now() => tokio::time::sleep_until(until).await,
                    _ => break,
                }
            }
            let mut st = locked(&lane.state);
            st.timer_armed = false;
            lane.drain(&mut st);
        });
    }

    fn release(self: &Arc<Self>) {
        let mut st = locked(&self.state);
        st.active -= 1;
        self.drain(&mut st);
    }

    /// Adaptive lanes only: a 429 halves the limit and parks the lane for the
    /// advised burst window. Returns whether it was recorded.
    fn record_rate_limit(self: &Arc<Self>, retry_after: Option<Duration>) -> bool {
        if !self.settings.adaptive {
            return false;
        }
        let advice = retry_after.unwrap_or_default();
        if advice > COOLDOWN_COORDINATION_CAP {
            return false;
        }
        let mut st = locked(&self.state);
        if st.closed {
            return false;
        }
        let observed = st.limit.unwrap_or_else(|| st.active.max(1));
        st.recovery_target = Some(st.recovery_target.unwrap_or(0).max(observed));
        st.limit = Some((observed / 2).max(1));
        st.recovery_successes = 0;
        let until = Instant::now() + advice;
        st.cooldown_until = Some(st.cooldown_until.map_or(until, |current| current.max(until)));
        self.arm_timer(&mut st);
        true
    }

    /// One slot back per window of `limit` successes, up to the limit seen
    /// before the 429, which restores the configured one.
    fn record_success(self: &Arc<Self>) {
        if !self.settings.adaptive {
            return;
        }
        let mut st = locked(&self.state);
        let Some(limit) = st.limit else { return };
        st.recovery_successes += 1;
        if st.recovery_successes >= limit {
            st.limit = Some(limit + 1);
            st.recovery_successes = 0;
            if st.recovery_target.is_some_and(|target| limit + 1 >= target) {
                st.limit = self.settings.concurrency;
                st.recovery_target = None;
            }
            self.drain(&mut st);
        }
    }
}

/// A claimed slot. Dropping it releases the slot; [`Permit::finish`] also
/// feeds the lane's adaptive accounting.
pub struct Permit {
    lane: Arc<Lane>,
    metrics: AdmissionMetrics,
    rate_limit_reported: bool,
    released: bool,
}

impl Permit {
    pub fn metrics(&self) -> AdmissionMetrics {
        self.metrics
    }

    /// Records a 429 the request received (also one it retried through), so
    /// the lane throttles at once rather than at the end of the send.
    pub fn report_rate_limit(&mut self, retry_after: Option<Duration>) -> bool {
        let recorded = self.lane.record_rate_limit(retry_after);
        self.rate_limit_reported |= recorded;
        recorded
    }

    pub fn finish(mut self, outcome: Outcome) {
        match outcome {
            Outcome::Success if !self.rate_limit_reported => self.lane.record_success(),
            Outcome::Failure {
                status: Some(429),
                retry_after,
            } if !self.rate_limit_reported => {
                self.lane.record_rate_limit(retry_after);
            }
            _ => {}
        }
        self.released = true;
        self.lane.release();
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if !self.released {
            self.lane.release();
        }
    }
}

/// A queued request. Dropped while queued, it leaves the queue; dropped after
/// a grant it never claimed, it gives the slot back.
struct Queued {
    lane: Arc<Lane>,
    id: u64,
    granted: oneshot::Receiver<()>,
    queued_at: Instant,
    claimed: bool,
}

impl Drop for Queued {
    fn drop(&mut self) {
        if self.claimed {
            return;
        }
        let mut st = locked(&self.lane.state);
        for queue in &mut st.queues {
            if let Some(index) = queue.iter().position(|w| w.id == self.id) {
                queue.remove(index);
                return;
            }
        }
        if self.granted.try_recv().is_ok() {
            st.active -= 1;
            self.lane.drain(&mut st);
        }
    }
}

/// The lanes of one runtime configuration. Lookups are lock-free.
pub struct Admission {
    lanes: ArcSwap<HashMap<LaneKey, Arc<Lane>>>,
}

impl Default for Admission {
    fn default() -> Self {
        Self::new()
    }
}

impl Admission {
    pub fn new() -> Self {
        Self {
            lanes: ArcSwap::from_pointee(HashMap::new()),
        }
    }

    /// The lane for `key`, created with `settings` on first use. Settings of
    /// an existing lane are not changed.
    pub fn lane(&self, key: &LaneKey, settings: LaneSettings) -> Arc<Lane> {
        if let Some(lane) = self.lanes.load().get(key) {
            return lane.clone();
        }
        let fresh = Lane::new(key.clone(), settings);
        let mut chosen = fresh.clone();
        self.lanes.rcu(|current| {
            let mut next = HashMap::clone(current);
            chosen = next.entry(key.clone()).or_insert_with(|| fresh.clone()).clone();
            next
        });
        chosen
    }

    /// Waits for a slot on `lane`. Ends early with `Cancelled` when `cancel`
    /// fires; dropping the future also leaves the queue.
    pub async fn acquire(
        &self,
        lane: &Arc<Lane>,
        request: AdmissionRequest,
        cancel: &CancellationToken,
    ) -> Result<Permit, AdmissionError> {
        if cancel.is_cancelled() {
            return Err(AdmissionError::Cancelled);
        }
        let now = Instant::now();
        let (mut queued, parked_for) = {
            let mut st = locked(&lane.state);
            if st.closed {
                return Err(AdmissionError::Closed);
            }
            if st.cooling(now).is_none() && st.has_room() && st.queued() == 0 {
                st.active += 1;
                return Ok(Permit {
                    lane: lane.clone(),
                    metrics: AdmissionMetrics {
                        queue_wait: Duration::ZERO,
                        active: st.active,
                        queued: 0,
                        limit: st.limit,
                    },
                    rate_limit_reported: false,
                    released: false,
                });
            }
            if st.queued() >= lane.settings.max_queue {
                return Err(AdmissionError::QueueFull {
                    lane: lane.key.to_string(),
                    max_queue: lane.settings.max_queue,
                });
            }
            let (grant, granted) = oneshot::channel();
            let id = st.next_id;
            st.next_id += 1;
            st.queues[request.priority.rank()].push_back(Waiter {
                id,
                owner: request.owner.clone(),
                queued_at: now,
                grant,
            });
            lane.drain(&mut st);
            let parked_for = st.cooling(now).filter(|left| *left > COOLDOWN_NOTICE_MIN);
            let queued = Queued {
                lane: lane.clone(),
                id,
                granted,
                queued_at: now,
                claimed: false,
            };
            (queued, parked_for)
        };
        if let (Some(left), Some(notice)) = (parked_for, &request.on_cooldown_wait) {
            notice(left);
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(AdmissionError::Cancelled),
            granted = &mut queued.granted => {
                if granted.is_err() {
                    return Err(AdmissionError::Closed);
                }
                queued.claimed = true;
                let st = locked(&lane.state);
                Ok(Permit {
                    lane: lane.clone(),
                    metrics: AdmissionMetrics {
                        queue_wait: queued.queued_at.elapsed(),
                        active: st.active,
                        queued: st.queued(),
                        limit: st.limit,
                    },
                    rate_limit_reported: false,
                    released: false,
                })
            }
        }
    }

    /// Why a request that must not wait cannot start on `lane` now.
    pub fn immediate_block(&self, lane: &Arc<Lane>) -> Option<Block> {
        let st = locked(&lane.state);
        if st.cooling(Instant::now()).is_some() {
            Some(Block::Cooldown)
        } else if st.queued() > 0 || !st.has_room() {
            Some(Block::Throttled)
        } else {
            None
        }
    }

    /// Records a 429 received outside an admitted request (a cache warm).
    pub fn record_rate_limit(&self, lane: &Arc<Lane>, retry_after: Option<Duration>) -> bool {
        lane.record_rate_limit(retry_after)
    }

    /// Clears the cooldown and limit of the adaptive lanes of `provider` (all
    /// providers for `None`): a re-login or account switch invalidates the
    /// old account's window. Returns the number of lanes reset.
    pub fn reset_cooldowns(&self, provider: Option<&ProviderId>) -> usize {
        let mut count = 0;
        for lane in self.lanes.load().values() {
            if !lane.settings.adaptive || provider.is_some_and(|p| *p != lane.key.provider) {
                continue;
            }
            let mut st = locked(&lane.state);
            if st.cooldown_until.is_none() && st.limit == lane.settings.concurrency {
                continue;
            }
            st.cooldown_until = None;
            st.limit = lane.settings.concurrency;
            st.recovery_successes = 0;
            st.recovery_target = None;
            count += 1;
            lane.drain(&mut st);
        }
        count
    }

    pub fn snapshot(&self) -> Vec<LaneSnapshot> {
        let now = Instant::now();
        self.lanes
            .load()
            .values()
            .map(|lane| {
                let st = locked(&lane.state);
                let mut owners: Vec<&Arc<str>> = Vec::new();
                for waiter in st.queues.iter().flatten() {
                    if !owners.contains(&&waiter.owner) {
                        owners.push(&waiter.owner);
                    }
                }
                LaneSnapshot {
                    key: lane.key.to_string(),
                    active: st.active,
                    queued: st.queued(),
                    owners: owners.len(),
                    limit: st.limit,
                    cooldown: st.cooling(now).unwrap_or_default(),
                    oldest_wait: st
                        .queues
                        .iter()
                        .flatten()
                        .map(|w| now.saturating_duration_since(w.queued_at))
                        .max()
                        .unwrap_or_default(),
                }
            })
            .collect()
    }

    /// Rejects every queued request and every later one. Running requests
    /// are ended by their owners' cancellation tokens.
    pub fn shutdown(&self) {
        for lane in self.lanes.load().values() {
            let mut st = locked(&lane.state);
            st.closed = true;
            for queue in &mut st.queues {
                queue.clear();
            }
        }
    }
}