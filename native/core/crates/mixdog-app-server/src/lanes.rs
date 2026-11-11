//! The call lanes every request but the connection's own handshake is admitted through: Node's
//! `src/standalone/session-transport/call-lanes.mjs` (three lanes) over `src/runtime/shared/fair-call-scheduler.mjs` and its
//! `fair-call-scheduler/owner-groups.mjs` (one queue per owner, shares by owner count, smooth round-robin between owners).
//!
//! There is no active-call cap (Node's default; the `MIXDOG_SESSION_*` limits are not read). A call starts at once when its lane
//! does not yield; the normal and interactive lanes yield, so their calls queue and start one per event-loop turn
//! ([`CallLanes::check_phase`], Node's `setImmediate` check phase). Past a lane's queue a call is refused with Node's message.
//! Nothing here waits or spawns: the owner of the lanes decides when a check phase runs.

use std::collections::VecDeque;

/// The lanes of `callLane`: control calls never queue, interactive ones queue behind a smaller bound than the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    Critical,
    Interactive,
    Normal,
}

/// A call the lanes refused: Node's error message (the route answers `{ error: message }`) and its status code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub message: String,
    /// Node's `statusCode`; the route drops it (it answers `{ error: message }`), so only the replay reads it.
    #[cfg_attr(not(test), allow(dead_code, reason = "Node's status code is not on the wire"))]
    pub status: u16,
}

impl Refusal {
    fn new(message: String, status: u16) -> Self {
        Self { message, status }
    }
}

struct Group<T> {
    owner: String,
    /// Smooth weighted round-robin credit (every weight is 1: the route passes none).
    current: i64,
    active: usize,
    queue: VecDeque<T>,
}

/// One lane: Node's `createFairCallScheduler` with an unbounded active limit.
struct Scheduler<T> {
    name: &'static str,
    max_queued: usize,
    owner_floor: usize,
    burst: usize,
    yield_unbounded: bool,
    /// In the order the owners first appeared: Node's `Map` order, which breaks every tie.
    groups: Vec<Group<T>>,
    active: usize,
    queued: usize,
    scheduled: bool,
    closed: Option<String>,
}

/// What [`CallLanes::dispatch`] did with a call.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Placed<T> {
    /// The call starts now (the lane does not yield and nothing waits): the caller runs it, then reports [`CallLanes::finished`].
    Start(T),
    Queued,
}

/// The outcome of one [`CallLanes::dispatch`].
pub(crate) struct Dispatched<T> {
    /// A call the lane evicted from the largest borrower's tail to seat this one (`rejectBorrowedTail`).
    pub displaced: Option<(T, Refusal)>,
    pub placed: Result<Placed<T>, (T, Refusal)>,
}

impl<T> Scheduler<T> {
    fn new(name: &'static str, max_queued: usize, owner_floor: usize, burst: usize, yield_unbounded: bool) -> Self {
        let owner_floor = owner_floor.min(max_queued).max(1);
        Self { name, max_queued, owner_floor, burst, yield_unbounded, groups: Vec::new(), active: 0, queued: 0, scheduled: false, closed: None }
    }

    fn group_index(&mut self, owner: &str) -> usize {
        let id = owner_id(owner);
        if let Some(at) = self.groups.iter().position(|group| group.owner == id) {
            return at;
        }
        self.groups.push(Group { owner: id, current: 0, active: 0, queue: VecDeque::new() });
        self.groups.len() - 1
    }

    /// `maybeDeleteGroup`.
    fn forget_if_idle(&mut self, owner: &str) {
        self.groups.retain(|group| group.owner != owner || group.active > 0 || !group.queue.is_empty());
    }

    /// The owners holding a queue, and `extra` (the incoming owner) even with none: `queuedGroups`.
    fn contenders(&self, extra: usize) -> Vec<usize> {
        (0..self.groups.len()).filter(|&at| at == extra || !self.groups[at].queue.is_empty()).collect()
    }

    fn has_competitor(&self, at: usize) -> bool {
        self.contenders(at).into_iter().any(|other| other != at && !self.groups[other].queue.is_empty())
    }

    fn fair_queue_limit(&self, at: usize) -> usize {
        let contenders = self.contenders(at).len();
        if contenders <= 1 {
            return self.max_queued;
        }
        self.owner_floor.max(self.max_queued / contenders)
    }

    /// The other owner holding the longest queue above the floor.
    fn largest_borrower(&self, incoming: usize) -> Option<usize> {
        let mut borrower: Option<usize> = None;
        for (at, group) in self.groups.iter().enumerate() {
            if at == incoming || group.queue.len() <= self.owner_floor {
                continue;
            }
            if borrower.is_none_or(|b| group.queue.len() > self.groups[b].queue.len()) {
                borrower = Some(at);
            }
        }
        borrower
    }

    /// Smooth weighted round-robin over the owners holding a queue.
    fn pick_group(&mut self) -> Option<usize> {
        let ready = self.contenders(usize::MAX);
        if ready.is_empty() {
            return None;
        }
        let total = ready.len() as i64;
        let mut chosen: Option<usize> = None;
        for &at in &ready {
            self.groups[at].current += 1;
            if chosen.is_none_or(|c| self.groups[at].current > self.groups[c].current) {
                chosen = Some(at);
            }
        }
        let chosen = chosen?;
        self.groups[chosen].current -= total;
        Some(chosen)
    }

    /// `admissionError`: the refusal, after any eviction that made room.
    fn admission(&mut self, at: usize) -> Result<Option<(T, Refusal)>, Refusal> {
        if self.has_competitor(at) && self.groups[at].queue.len() >= self.fair_queue_limit(at) {
            return Err(Refusal::new(format!("{} client queue is full; retry after this client's running work completes", self.name), 429));
        }
        if self.queued >= self.max_queued {
            let Some(borrower) = self.largest_borrower(at) else {
                return Err(Refusal::new(format!("{} queue is full", self.name), 503));
            };
            let displaced = self.groups[borrower].queue.pop_back().expect("a borrower holds a queue");
            self.queued -= 1;
            let owner = self.groups[borrower].owner.clone();
            self.forget_if_idle(&owner);
            return Ok(Some((displaced, Refusal::new(format!("{} queue rebalanced for another client; retry after running work completes", self.name), 503))));
        }
        Ok(None)
    }

    /// `enqueue`. `Err` of a closed lane carries the item back.
    fn dispatch(&mut self, owner: &str, item: T) -> Dispatched<T> {
        if self.closed.is_some() {
            return Dispatched { displaced: None, placed: Err((item, Refusal::new(format!("{} scheduler is closed", self.name), 503))) };
        }
        let at = self.group_index(owner);
        // Default daemon lanes are unbounded: a lane that does not yield starts a call in this very step.
        if !self.yield_unbounded && self.queued == 0 {
            self.active += 1;
            self.groups[at].active += 1;
            return Dispatched { displaced: None, placed: Ok(Placed::Start(item)) };
        }
        let displaced = match self.admission(at) {
            Ok(displaced) => displaced,
            Err(refusal) => {
                let owner = self.groups[at].owner.clone();
                self.forget_if_idle(&owner);
                return Dispatched { displaced: None, placed: Err((item, refusal)) };
            }
        };
        // The eviction may have removed the incoming owner's own index: look it up again.
        let at = self.group_index(owner);
        self.groups[at].queue.push_back(item);
        self.queued += 1;
        self.scheduled = true;
        Dispatched { displaced, placed: Ok(Placed::Queued) }
    }

    /// One check phase of this lane: starts up to `burst` queued calls and says whether it wants another phase.
    fn check_phase(&mut self, started: &mut Vec<(String, T)>) -> bool {
        self.scheduled = false;
        let mut begun = 0;
        while self.closed.is_none() && self.queued > 0 && begun < self.burst {
            let Some(at) = self.pick_group() else { break };
            let Some(item) = self.groups[at].queue.pop_front() else { break };
            self.queued -= 1;
            begun += 1;
            self.active += 1;
            self.groups[at].active += 1;
            started.push((self.groups[at].owner.clone(), item));
        }
        if self.closed.is_none() && self.queued > 0 {
            self.scheduled = true;
        }
        self.scheduled
    }

    fn finished(&mut self, owner: &str) {
        let id = owner_id(owner);
        self.active = self.active.saturating_sub(1);
        if let Some(group) = self.groups.iter_mut().find(|group| group.owner == id) {
            group.active = group.active.saturating_sub(1);
        }
        self.forget_if_idle(&id);
        if self.closed.is_none() && self.queued > 0 {
            self.scheduled = true;
        }
    }

    #[cfg(test)]
    fn close(&mut self, reason: &str) -> Vec<(T, Refusal)> {
        if self.closed.is_some() {
            return Vec::new();
        }
        self.closed = Some(reason.to_owned());
        let refused: Vec<(T, Refusal)> =
            self.groups.iter_mut().flat_map(|group| group.queue.drain(..)).map(|item| (item, Refusal::new(reason.to_owned(), 503))).collect();
        self.queued = 0;
        self.groups.retain(|group| group.active > 0);
        refused
    }
}

/// `ownerId`: the trimmed key cut to 240 characters, `anonymous` when empty.
fn owner_id(owner: &str) -> String {
    let clean = owner.trim();
    if clean.is_empty() { "anonymous".to_owned() } else { clean.chars().take(240).collect() }
}

/// The three lanes of `createCallLanes`.
pub(crate) struct CallLanes<T> {
    critical: Scheduler<T>,
    interactive: Scheduler<T>,
    normal: Scheduler<T>,
    /// The lanes with a check phase scheduled, in the order they were scheduled (`setImmediate` runs them in that order).
    checks: Vec<Lane>,
}

/// A lane's counters (`snapshot()`).
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Counters {
    pub active: usize,
    pub queued: usize,
    pub queue_max: usize,
}

impl<T> CallLanes<T> {
    pub(crate) fn new() -> Self {
        // `CALL_QUEUE_MAX` at its default; the critical lane's burst is the scheduler's default (8) and it does not yield.
        let call_queue = 1024;
        Self {
            normal: Scheduler::new("session service call", call_queue, (call_queue / 16).max(8), 1, true),
            critical: Scheduler::new("session service critical call", 32usize.max(256.min(call_queue)), 8, 8, false),
            interactive: Scheduler::new("session service interactive call", 64usize.max(512.min(call_queue)), 8, 1, true),
            checks: Vec::new(),
        }
    }

    fn lane_mut(&mut self, lane: Lane) -> &mut Scheduler<T> {
        match lane {
            Lane::Critical => &mut self.critical,
            Lane::Interactive => &mut self.interactive,
            Lane::Normal => &mut self.normal,
        }
    }

    fn lane(&self, lane: Lane) -> &Scheduler<T> {
        match lane {
            Lane::Critical => &self.critical,
            Lane::Interactive => &self.interactive,
            Lane::Normal => &self.normal,
        }
    }

    /// `dispatch(ownerKey, run, { lane })`.
    pub(crate) fn dispatch(&mut self, owner: &str, lane: Lane, item: T) -> Dispatched<T> {
        let scheduler = self.lane_mut(lane);
        let was_scheduled = scheduler.scheduled;
        let dispatched = scheduler.dispatch(owner, item);
        if scheduler.scheduled && !was_scheduled {
            self.checks.push(lane);
        }
        dispatched
    }

    /// A call that started has ended (its slot is free).
    pub(crate) fn finished(&mut self, owner: &str, lane: Lane) {
        let scheduler = self.lane_mut(lane);
        let was_scheduled = scheduler.scheduled;
        scheduler.finished(owner);
        if scheduler.scheduled && !was_scheduled {
            self.checks.push(lane);
        }
    }

    /// Whether a check phase is owed.
    pub(crate) fn wants_check(&self) -> bool {
        !self.checks.is_empty()
    }

    /// One event-loop check phase: each lane that scheduled one runs it, in the order they were scheduled, and the calls they start
    /// come back with their owner and lane. A lane with calls left schedules the next phase.
    pub(crate) fn check_phase(&mut self) -> Vec<(Lane, String, T)> {
        let due = std::mem::take(&mut self.checks);
        let mut out = Vec::new();
        for lane in due {
            let mut started = Vec::new();
            if self.lane_mut(lane).check_phase(&mut started) {
                self.checks.push(lane);
            }
            out.extend(started.into_iter().map(|(owner, item)| (lane, owner, item)));
        }
        out
    }

    /// `close(reason)`: every queued call is refused with `reason`; later calls are refused as the lane being closed. The server
    /// stops by its lifecycle gate (new work refused while draining), not by closing the lanes, so only the replay closes them.
    #[cfg(test)]
    pub(crate) fn close(&mut self, reason: &str) -> Vec<(T, Refusal)> {
        let mut refused = Vec::new();
        for lane in [Lane::Normal, Lane::Interactive, Lane::Critical] {
            refused.extend(self.lane_mut(lane).close(reason));
        }
        self.checks.clear();
        refused
    }

    #[cfg(test)]
    pub(crate) fn counters(&self, lane: Lane) -> Counters {
        let scheduler = self.lane(lane);
        Counters { active: scheduler.active, queued: scheduler.queued, queue_max: scheduler.max_queued }
    }
}
