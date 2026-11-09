//! Process-wide admission for memory-heavy agent work and foreground child shells (Node
//! `shared/resource-admission.mjs`, `ResourceAdmissionController`), and the agent lane's
//! [`Admission`] seam over it.
//!
//! Running work is never revoked: a full pool keeps a new request in one bounded queue, shared by
//! both pools but drained per pool, so shell and agent waiters never delay each other. The queue
//! is served by priority (`user-blocking`, then `user-visible`, then `best-effort`) and, inside a
//! priority, round-robin by owner so one session's burst cannot starve another's.
//!
//! An agent's slot is only held while it does local work: [`Held::run_yielded`] hands it back
//! while a provider request is in flight and takes it again, in the queue, before the caller
//! goes on (`runYielded`). A nested agent acquired under a held one
//! ([`ResourceAdmission::acquire_under`]) suspends its parent the same way until it is released.
//! Node reaches both through an ambient async-local lease; here the lease is passed explicitly.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
pub use mixdog_agent::cancel::{ABORTED, Cancel, JOB_CANCELLED};
use mixdog_agent::agent_tool::flow::seams::{Admission, Lease};
use mixdog_agent::env::Yielder;
use mixdog_agent::env::Clock;
use tokio::sync::oneshot;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pool {
    Agent,
    Shell,
}

/// `PRIORITY_RANK`: lower runs first.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Priority {
    UserBlocking,
    UserVisible,
    BestEffort,
}

impl Priority {
    /// `normalizePriority`: anything unknown is `user-visible`.
    pub fn normalize(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "user-blocking" => Self::UserBlocking,
            "best-effort" => Self::BestEffort,
            _ => Self::UserVisible,
        }
    }
}

/// `RESOURCE_ADMISSION_DEFAULTS` after the environment overrides.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Limits {
    pub max_agents: usize,
    pub max_shells: usize,
    pub max_high_load: usize,
    pub max_queue: usize,
}

fn floored(value: Option<String>) -> Option<i64> {
    let parsed = mixdog_js::string_to_number(value?.as_str());
    parsed.is_finite().then(|| parsed.floor() as i64)
}

impl Limits {
    /// Two agent leases per core keep the host busy (their tool work is mostly child-process I/O);
    /// 8 is the floor for small hosts. `maxHighLoad` bounds agents only and defaults to the same.
    pub fn from_env(parallelism: usize, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let agent_limit = 8.max(2 * parallelism);
        let positive = |name: &str, default: usize| floored(env(name)).filter(|v| *v >= 1).map_or(default, |v| v as usize);
        Self {
            max_agents: positive("MIXDOG_MAX_CONCURRENT_AGENTS", agent_limit),
            max_shells: positive("MIXDOG_MAX_CONCURRENT_SHELLS", 64),
            max_high_load: positive("MIXDOG_MAX_CONCURRENT_HIGH_LOAD", agent_limit),
            max_queue: floored(env("MIXDOG_RESOURCE_MAX_QUEUE")).filter(|v| *v >= 0).map_or(1024, |v| v as usize),
        }
    }
}

/// `ResourceAdmissionQueueFullError`.
pub fn queue_full(max_queue: usize) -> String {
    format!("resource pressure: high-load admission queue full (maximum {max_queue}); retry after running work completes")
}

enum Entry {
    New { tx: oneshot::Sender<Option<u64>>, parent: Option<u64> },
    Restore { lease: u64, txs: Vec<oneshot::Sender<()>> },
}

struct Waiter {
    id: u64,
    pool: Pool,
    owner: String,
    priority: Priority,
    queued_at: i64,
    entry: Entry,
}

struct LeaseState {
    pool: Pool,
    owner: String,
    priority: Priority,
    counted: bool,
    depth: usize,
    restore: Option<u64>,
    parent: Option<u64>,
    cancel: Option<Cancel>,
}

#[derive(Default)]
struct Stats {
    admitted: u64,
    waited: u64,
    total_wait_ms: i64,
    max_wait_ms: i64,
}

#[derive(Default)]
struct State {
    active: [usize; 2],
    cursor: [Option<String>; 2],
    queue: Vec<Waiter>,
    leases: HashMap<u64, LeaseState>,
    next_id: u64,
    stats: HashMap<&'static str, Stats>,
}

fn idx(pool: Pool) -> usize {
    pool as usize
}

fn pool_name(pool: Pool, restore: bool) -> &'static str {
    match (pool, restore) {
        (Pool::Agent, false) => "agent",
        (Pool::Shell, false) => "shell",
        (Pool::Agent, true) => "agentRestore",
        (Pool::Shell, true) => "shellRestore",
    }
}

/// What a drain admitted, sent once the lock is released.
enum Delivery {
    New(oneshot::Sender<Option<u64>>, u64),
    Restore(Vec<oneshot::Sender<()>>),
}

struct Controller {
    limits: Limits,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// Told as a waiter joins the queue, for the tests to wait on.
    #[cfg(test)]
    queued: tokio::sync::Notify,
}

/// A restore in the queue: resolves when the slot is taken again.
type Restoring = Option<(oneshot::Receiver<()>, u64, Option<Cancel>)>;

impl Controller {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn can_start(&self, state: &State, pool: Pool) -> bool {
        match pool {
            Pool::Shell => state.active[idx(pool)] < self.limits.max_shells,
            Pool::Agent => state.active[idx(pool)] < self.limits.max_high_load && state.active[idx(pool)] < self.limits.max_agents,
        }
    }

    fn record(state: &mut State, name: &'static str, waited_ms: i64) {
        let stats = state.stats.entry(name).or_default();
        stats.admitted += 1;
        if waited_ms > 0 {
            stats.waited += 1;
            stats.total_wait_ms += waited_ms;
            stats.max_wait_ms = stats.max_wait_ms.max(waited_ms);
        }
    }

    fn new_lease(state: &mut State, pool: Pool, owner: &str, priority: Priority, parent: Option<u64>, cancel: Option<Cancel>, queued_ms: i64) -> u64 {
        state.active[idx(pool)] += 1;
        state.next_id += 1;
        let id = state.next_id;
        state.leases.insert(
            id,
            LeaseState { pool, owner: owner.to_owned(), priority, counted: true, depth: 0, restore: None, parent, cancel },
        );
        Self::record(state, pool_name(pool, false), queued_ms);
        id
    }

    /// Stop counting a lease against its pool (suspension or release).
    fn uncount(state: &mut State, id: u64) {
        if let Some(lease) = state.leases.get_mut(&id) {
            if lease.counted {
                lease.counted = false;
                let p = idx(lease.pool);
                state.active[p] = state.active[p].saturating_sub(1);
            }
        }
    }

    /// `_suspendParent`.
    fn suspend(state: &mut State, id: u64) -> bool {
        let Some(lease) = state.leases.get_mut(&id) else { return false };
        lease.depth += 1;
        Self::uncount(state, id);
        true
    }

    /// `_resumeParent`: one dependency ends; when it was the last and the lease is wanted again, a
    /// restore waits in the queue.
    fn resume(&self, state: &mut State, id: u64, reacquire: bool) -> Restoring {
        let lease = state.leases.get_mut(&id)?;
        lease.depth = lease.depth.saturating_sub(1);
        if !reacquire || lease.depth > 0 || lease.counted {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        let own = lease.cancel.clone();
        if let Some(wid) = lease.restore {
            if let Some(Waiter { entry: Entry::Restore { txs, .. }, .. }) = state.queue.iter_mut().find(|w| w.id == wid) {
                txs.push(tx);
            }
            return Some((rx, wid, own));
        }
        let (pool, owner, priority) = (lease.pool, lease.owner.clone(), lease.priority);
        state.next_id += 1;
        let wid = state.next_id;
        if let Some(l) = state.leases.get_mut(&id) {
            l.restore = Some(wid);
        }
        state.queue.push(Waiter {
            id: wid,
            pool,
            owner,
            priority,
            queued_at: self.clock.now_ms(),
            entry: Entry::Restore { lease: id, txs: vec![tx] },
        });
        #[cfg(test)]
        self.queued.notify_waiters();
        Some((rx, wid, own))
    }

    /// `_nextFairIndex`.
    fn next_fair(&self, state: &mut State) -> Option<usize> {
        let runnable: Vec<usize> = (0..state.queue.len()).filter(|i| self.can_start(state, state.queue[*i].pool)).collect();
        let best = runnable.iter().map(|i| state.queue[*i].priority).min()?;
        let prioritized: Vec<usize> = runnable.into_iter().filter(|i| state.queue[*i].priority == best).collect();
        let pool = state.queue[prioritized[0]].pool;
        let rows: Vec<usize> = prioritized.into_iter().filter(|i| state.queue[*i].pool == pool).collect();
        let mut owners: Vec<&str> = Vec::new();
        for i in &rows {
            let owner = state.queue[*i].owner.as_str();
            if !owners.contains(&owner) {
                owners.push(owner);
            }
        }
        let mut selected = owners[0].to_owned();
        if owners.len() > 1 {
            let previous = state.cursor[idx(pool)].as_deref().and_then(|c| owners.iter().position(|o| *o == c));
            selected = owners[previous.map_or(0, |p| (p + 1) % owners.len())].to_owned();
        }
        let found = rows.iter().copied().find(|i| state.queue[*i].owner == selected).unwrap_or(rows[0]);
        state.cursor[idx(pool)] = Some(selected);
        Some(found)
    }

    fn drain(&self, state: &mut State) -> Vec<Delivery> {
        let mut out = Vec::new();
        while let Some(index) = self.next_fair(state) {
            let waiter = state.queue.remove(index);
            let waited = (self.clock.now_ms() - waiter.queued_at).max(0);
            match waiter.entry {
                Entry::Restore { lease, txs } => {
                    if let Some(l) = state.leases.get_mut(&lease) {
                        l.restore = None;
                        l.counted = true;
                    }
                    state.active[idx(waiter.pool)] += 1;
                    Self::record(state, pool_name(waiter.pool, true), waited);
                    out.push(Delivery::Restore(txs));
                }
                Entry::New { tx, parent } => {
                    let id = Self::new_lease(state, waiter.pool, &waiter.owner, waiter.priority, parent, None, waited);
                    out.push(Delivery::New(tx, id));
                }
            }
        }
        out
    }

    fn deliver(self: &Arc<Self>, deliveries: Vec<Delivery>) {
        for delivery in deliveries {
            match delivery {
                Delivery::Restore(txs) => txs.into_iter().for_each(|tx| {
                    tx.send(()).ok();
                }),
                // A closed receiver returns the lease; it frees itself again outside any lock.
                Delivery::New(tx, id) => {
                    if tx.send(Some(id)).is_err() {
                        drop(self.release_now(id));
                    }
                }
            }
        }
    }

    /// `lease.release()` up to the parent's re-acquisition, which the caller may await.
    fn release_now(self: &Arc<Self>, id: u64) -> Restoring {
        let (restoring, deliveries) = {
            let mut state = self.lock();
            let lease = state.leases.get(&id)?;
            let (parent, restore) = (lease.parent, lease.restore);
            let mut restore_txs = Vec::new();
            if let Some(wid) = restore {
                if let Some(at) = state.queue.iter().position(|w| w.id == wid) {
                    if let Entry::Restore { txs, .. } = state.queue.remove(at).entry {
                        restore_txs = txs;
                    }
                }
            }
            Self::uncount(&mut state, id);
            state.leases.remove(&id);
            let restoring = parent.and_then(|p| self.resume(&mut state, p, true));
            let mut deliveries = self.drain(&mut state);
            deliveries.push(Delivery::Restore(restore_txs));
            (restoring, deliveries)
        };
        self.deliver(deliveries);
        restoring
    }

    /// Waits for a restore; a cancel abandons it (the item leaves the queue and the cancel's
    /// reason is the error).
    async fn await_restore(self: &Arc<Self>, restoring: Restoring, extra: Option<&Cancel>) -> Result<(), String> {
        let Some((rx, wid, own)) = restoring else { return Ok(()) };
        let cancels: Vec<Cancel> = extra.cloned().into_iter().chain(own).collect();
        let fired = async {
            if cancels.is_empty() {
                std::future::pending::<()>().await;
            }
            let waits = cancels.iter().map(|c| Box::pin(c.cancelled()));
            let (_, index, _) = futures::future::select_all(waits).await;
            index
        };
        tokio::select! {
            _ = rx => Ok(()),
            index = fired => {
                let deliveries = {
                    let mut state = self.lock();
                    if let Some(at) = state.queue.iter().position(|w| w.id == wid) {
                        if let Entry::Restore { lease, .. } = state.queue.remove(at).entry {
                            if let Some(l) = state.leases.get_mut(&lease) {
                                l.restore = None;
                            }
                        }
                    }
                    self.drain(&mut state)
                };
                self.deliver(deliveries);
                Err(cancels[index].reason())
            }
        }
    }
}

pub struct ResourceAdmission {
    controller: Arc<Controller>,
}

/// A held slot of either pool; releasing it (or dropping it) frees the slot.
pub struct Held {
    controller: Arc<Controller>,
    id: u64,
}

impl Held {
    /// `lease.release()`: frees the slot, then waits for a suspended parent to get its own back.
    pub async fn release(self) {
        let restoring = self.controller.release_now(self.id);
        let _ = self.controller.await_restore(restoring, None).await;
    }

    /// Whether the lease holds a counted slot right now.
    pub fn counted(&self) -> bool {
        self.controller.lock().leases.get(&self.id).is_some_and(|l| l.counted)
    }

    /// `runYielded`: hands the slot back while `task` (a provider request) is in flight and takes
    /// it again, in the queue, before returning. Only an agent lease yields; a shell's lease just
    /// runs the task. A failed task (`Err`) keeps the lease suspended — the owner's next
    /// successful call takes it again, or the owner releases it — so the failure reaches the
    /// caller even when every slot is busy, as in Node. `on_restore_wait` runs when the slot
    /// cannot be had at once (a display hint). A cancelled re-acquisition is the outer error.
    pub async fn run_yielded<T, E>(
        &self,
        task: impl Future<Output = Result<T, E>>,
        cancel: Option<&Cancel>,
        on_restore_wait: Option<&(dyn Fn() + Send + Sync)>,
    ) -> Result<Result<T, E>, String> {
        self.slot().run_yielded(task, cancel, on_restore_wait).await
    }

    /// The handle the loop yields through; it does not own the lease.
    pub fn slot(&self) -> Slot {
        Slot { controller: self.controller.clone(), id: self.id }
    }
}

/// A lease's yield handle (runYielded), shared with the loop while the lease stays with its owner.
#[derive(Clone)]
pub struct Slot {
    controller: Arc<Controller>,
    id: u64,
}

impl Slot {
    pub async fn run_yielded<T, E>(
        &self,
        task: impl Future<Output = Result<T, E>>,
        cancel: Option<&Cancel>,
        on_restore_wait: Option<&(dyn Fn() + Send + Sync)>,
    ) -> Result<Result<T, E>, String> {
        let c = &self.controller;
        let suspended = {
            let mut state = c.lock();
            let yields = state.leases.get(&self.id).is_some_and(|l| l.pool == Pool::Agent);
            if yields && Controller::suspend(&mut state, self.id) { Some(c.drain(&mut state)) } else { None }
        };
        let Some(deliveries) = suspended else { return Ok(task.await) };
        c.deliver(deliveries);
        let result = task.await;
        let succeeded = result.is_ok();
        let (restoring, pool_full, deliveries) = {
            let mut state = c.lock();
            let pool_full = succeeded && !c.can_start(&state, Pool::Agent);
            let restoring = c.resume(&mut state, self.id, succeeded);
            (restoring, pool_full, c.drain(&mut state))
        };
        if pool_full {
            if let Some(hint) = on_restore_wait {
                hint();
            }
        }
        c.deliver(deliveries);
        c.await_restore(restoring, cancel).await?;
        Ok(result)
    }
}

#[async_trait]
impl Yielder for Slot {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, cancel: Option<&Cancel>) -> Result<(), String> {
        Slot::run_yielded(self, async { if task.await { Ok(()) } else { Err(()) } }, cancel, None).await.map(drop)
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        drop(self.controller.release_now(self.id));
    }
}

#[async_trait]
impl Lease for Held {
    async fn release(self: Box<Self>) {
        Held::release(*self).await;
    }

    fn yielder(&self) -> Arc<dyn Yielder> {
        Arc::new(self.slot())
    }
}

/// `{ admitted, waited, totalWaitMs, maxWaitMs }` of `snapshot().waitStats[pool]`.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct WaitStats {
    pub admitted: u64,
    pub waited: u64,
    pub total_wait_ms: i64,
    pub max_wait_ms: i64,
}

impl ResourceAdmission {
    pub fn new(limits: Limits, clock: Arc<dyn Clock>) -> Self {
        Self { controller: Arc::new(Controller {
                limits,
                clock,
                state: Mutex::new(State::default()),
                #[cfg(test)]
                queued: tokio::sync::Notify::new(),
            }) }
    }

    /// `acquire(kind, { signal, ownerKey, priority })`. The owner key is trimmed and cut to 240
    /// characters; `cancel` abandons the wait with its reason.
    pub async fn acquire_in(&self, pool: Pool, owner_key: Option<&str>, priority: Priority, cancel: &Cancel) -> Result<Held, String> {
        self.acquire_under(None, pool, owner_key, priority, cancel).await
    }

    /// `acquire` made while `parent` (an agent lease) is held, the scoped dependency of Node's
    /// ambient lease: the parent gives its slot up until this lease is released, so nested work
    /// cannot starve its own caller. A shell never suspends its agent.
    pub async fn acquire_under(
        &self,
        parent: Option<&Held>,
        pool: Pool,
        owner_key: Option<&str>,
        priority: Priority,
        cancel: &Cancel,
    ) -> Result<Held, String> {
        let owner: String = owner_key.map(|k| mixdog_js::js_trim(k).chars().take(240).collect()).unwrap_or_default();
        if cancel.is_aborted() {
            return Err(cancel.reason());
        }
        let c = &self.controller;
        let (rx, id, deliveries) = {
            let mut state = c.lock();
            let parent_id = parent.filter(|_| pool == Pool::Agent).map(|p| p.id).filter(|id| Controller::suspend(&mut state, *id));
            let queued_in_pool = state.queue.iter().any(|w| w.pool == pool);
            if c.can_start(&state, pool) && !queued_in_pool {
                let id = Controller::new_lease(&mut state, pool, &owner, priority, parent_id, Some(cancel.clone()), 0);
                return Ok(Held { controller: c.clone(), id });
            }
            if state.queue.len() >= c.limits.max_queue {
                if let Some(p) = parent_id {
                    drop(c.resume(&mut state, p, false));
                }
                return Err(queue_full(c.limits.max_queue));
            }
            let (tx, rx) = oneshot::channel();
            state.next_id += 1;
            let id = state.next_id;
            state.queue.push(Waiter { id, pool, owner, priority, queued_at: c.clock.now_ms(), entry: Entry::New { tx, parent: parent_id } });
            #[cfg(test)]
            c.queued.notify_waiters();
            let deliveries = c.drain(&mut state);
            (rx, id, deliveries)
        };
        c.deliver(deliveries);
        let granted = tokio::select! {
            granted = rx => granted.ok().flatten(),
            () = cancel.cancelled() => None,
        };
        if let Some(lease) = granted {
            if let Some(l) = c.lock().leases.get_mut(&lease) {
                l.cancel = Some(cancel.clone());
            }
            return Ok(Held { controller: c.clone(), id: lease });
        }
        let deliveries = {
            let mut state = c.lock();
            if let Some(at) = state.queue.iter().position(|w| w.id == id) {
                if let Entry::New { parent: Some(p), .. } = state.queue.remove(at).entry {
                    drop(c.resume(&mut state, p, false));
                }
            }
            c.drain(&mut state)
        };
        c.deliver(deliveries);
        Err(cancel.reason())
    }

    pub fn active(&self, pool: Pool) -> usize {
        self.controller.lock().active[idx(pool)]
    }

    pub fn queued(&self) -> usize {
        self.controller.lock().queue.len()
    }

    /// `snapshot().waitStats[name]` for `agent`, `shell`, `agentRestore` or `shellRestore`.
    pub fn wait_stats(&self, name: &str) -> WaitStats {
        let state = self.controller.lock();
        state.stats.get(name).map_or_else(WaitStats::default, |s| WaitStats {
            admitted: s.admitted,
            waited: s.waited,
            total_wait_ms: s.total_wait_ms,
            max_wait_ms: s.max_wait_ms,
        })
    }
}

#[async_trait]
impl Admission for ResourceAdmission {
    async fn acquire(&self, _label: &str, owner_key: Option<&str>, cancel: &Cancel) -> Result<Box<dyn Lease>, String> {
        self.acquire_in(Pool::Agent, owner_key, Priority::UserVisible, cancel)
            .await
            .map(|held| Box::new(held) as Box<dyn Lease>)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn admission(agents: usize, queue: usize) -> Arc<ResourceAdmission> {
        let limits = Limits { max_agents: agents, max_shells: 2, max_high_load: agents, max_queue: queue };
        Arc::new(ResourceAdmission::new(limits, Arc::new(Fixed(0))))
    }

    /// Returns once `n` waiters are in the queue; fails by assertion if `task`, the acquire that should be queuing, ends first.
    async fn queued_is(a: &ResourceAdmission, n: usize, task: &mut tokio::task::JoinHandle<impl std::fmt::Debug>) {
        mixdog_core_session::session::testing::eventually_on_until(&[&a.controller.queued], || (a.queued() == n).then_some(()), task).await;
    }

    fn spawn_acquire(a: &Arc<ResourceAdmission>, pool: Pool, owner: &'static str, priority: Priority, order: &Arc<Mutex<Vec<String>>>, tag: &'static str) -> tokio::task::JoinHandle<()> {
        let (a, order) = (a.clone(), order.clone());
        tokio::spawn(async move {
            let held = a.acquire_in(pool, Some(owner), priority, &Cancel::new()).await.unwrap();
            order.lock().unwrap().push(tag.to_owned());
            // Hold it until the test frees the pool by dropping a sibling; then let go.
            drop(held);
        })
    }

    #[test]
    fn limits_follow_the_defaults_and_the_environment() {
        let none = |_: &str| None;
        assert_eq!(Limits::from_env(2, &none), Limits { max_agents: 8, max_shells: 64, max_high_load: 8, max_queue: 1024 });
        assert_eq!(Limits::from_env(20, &none).max_agents, 40);
        let set = |name: &str| match name {
            "MIXDOG_MAX_CONCURRENT_AGENTS" => Some("3.9".to_owned()),
            "MIXDOG_MAX_CONCURRENT_SHELLS" => Some("0".to_owned()),
            "MIXDOG_RESOURCE_MAX_QUEUE" => Some("0".to_owned()),
            "MIXDOG_MAX_CONCURRENT_HIGH_LOAD" => Some("nope".to_owned()),
            _ => None,
        };
        // 3.9 floors to 3; 0 is not a positive shell cap; a queue of 0 is allowed; junk keeps the default.
        assert_eq!(Limits::from_env(2, &set), Limits { max_agents: 3, max_shells: 64, max_high_load: 8, max_queue: 0 });
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_pool_queues_in_order_and_a_full_queue_refuses_with_nodes_text() {
        let a = admission(1, 2);
        let cancel = Cancel::new();
        let first = a.acquire_in(Pool::Agent, Some("s1"), Priority::UserVisible, &cancel).await.unwrap();
        assert_eq!((a.active(Pool::Agent), a.queued()), (1, 0));
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut w1 = spawn_acquire(&a, Pool::Agent, "s1", Priority::UserVisible, &order, "one");
        queued_is(&a, 1, &mut w1).await;
        let mut w2 = spawn_acquire(&a, Pool::Agent, "s1", Priority::UserVisible, &order, "two");
        queued_is(&a, 2, &mut w2).await;
        assert_eq!(a.queued(), 2);
        let refused = a.acquire_in(Pool::Agent, Some("s1"), Priority::UserVisible, &cancel).await.err().unwrap();
        assert_eq!(refused, "resource pressure: high-load admission queue full (maximum 2); retry after running work completes");
        drop(first);
        w1.await.unwrap();
        w2.await.unwrap();
        assert_eq!(*order.lock().unwrap(), ["one", "two"]);
        assert_eq!((a.active(Pool::Agent), a.queued()), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn priority_beats_arrival_and_owners_take_turns() {
        let a = admission(1, 16);
        let first = a.acquire_in(Pool::Agent, Some("x"), Priority::UserVisible, &Cancel::new()).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut tasks = Vec::new();
        for (queued, (owner, priority, tag)) in [
            ("a", Priority::BestEffort, "a-best"),
            ("a", Priority::UserVisible, "a1"),
            ("a", Priority::UserVisible, "a2"),
            ("b", Priority::UserVisible, "b1"),
            ("c", Priority::UserBlocking, "c-blocking"),
        ]
        .into_iter()
        .enumerate()
        {
            tasks.push(spawn_acquire(&a, Pool::Agent, owner, priority, &order, tag));
            queued_is(&a, queued + 1, tasks.last_mut().unwrap()).await;
        }
        drop(first);
        for t in tasks {
            t.await.unwrap();
        }
        // user-blocking first; then a and b alternate (a's first waiter, then b); best-effort last.
        assert_eq!(*order.lock().unwrap(), ["c-blocking", "a1", "b1", "a2", "a-best"]);
    }

    #[tokio::test(start_paused = true)]
    async fn shells_and_agents_never_wait_behind_each_other() {
        let a = admission(1, 4);
        let cancel = Cancel::new();
        let _agent = a.acquire_in(Pool::Agent, None, Priority::UserVisible, &cancel).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut queued_agent = spawn_acquire(&a, Pool::Agent, "o", Priority::UserVisible, &order, "agent");
        queued_is(&a, 1, &mut queued_agent).await;
        // The agent pool has a waiter; a shell still starts at once.
        let shell = a.acquire_in(Pool::Shell, None, Priority::UserVisible, &cancel).await.unwrap();
        assert_eq!((a.active(Pool::Shell), a.queued()), (1, 1));
        drop(shell);
        queued_agent.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_wait_leaves_the_queue_and_a_freed_slot_is_not_lost() {
        let a = admission(1, 4);
        let first = a.acquire_in(Pool::Agent, None, Priority::UserVisible, &Cancel::new()).await.unwrap();
        let cancel = Cancel::new();
        let mut waiting = {
            let (a, cancel) = (a.clone(), cancel.clone());
            tokio::spawn(async move { a.acquire_in(Pool::Agent, Some("o"), Priority::UserVisible, &cancel).await.err() })
        };
        queued_is(&a, 1, &mut waiting).await;
        cancel.abort(JOB_CANCELLED);
        assert_eq!(waiting.await.unwrap().as_deref(), Some(JOB_CANCELLED));
        assert_eq!(a.queued(), 0);
        // A token cancelled before the call never queues.
        let done = Cancel::new();
        done.abort_default();
        assert_eq!(a.acquire_in(Pool::Agent, None, Priority::UserVisible, &done).await.err().as_deref(), Some(ABORTED));
        drop(first);
        assert_eq!(a.active(Pool::Agent), 0);
        a.acquire_in(Pool::Agent, None, Priority::UserVisible, &Cancel::new()).await.unwrap();
    }

    /// Node's real controller on three queues: the grant order and the refusal.
    #[tokio::test(start_paused = true)]
    async fn grant_order_and_refusal_follow_node() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("golden/admission.json")).unwrap();
        let scenarios: [(&str, usize, Vec<(&'static str, Priority, &'static str)>); 3] = [
            ("priority", 16, vec![("a", Priority::BestEffort, "a-best"), ("a", Priority::UserVisible, "a1"), ("a", Priority::UserVisible, "a2"), ("b", Priority::UserVisible, "b1"), ("c", Priority::UserBlocking, "c-blocking")]),
            ("three_owners", 16, vec![("a", Priority::UserVisible, "a1"), ("a", Priority::UserVisible, "a2"), ("b", Priority::UserVisible, "b1"), ("b", Priority::UserVisible, "b2"), ("c", Priority::UserVisible, "c1")]),
            ("full", 2, vec![("s1", Priority::UserVisible, "one"), ("s1", Priority::UserVisible, "two")]),
        ];
        for (name, queue, requests) in scenarios {
            let a = admission(1, queue);
            let first = a.acquire_in(Pool::Agent, Some("x"), Priority::UserVisible, &Cancel::new()).await.unwrap();
            let order = Arc::new(Mutex::new(Vec::new()));
            let mut tasks = Vec::new();
            for (queued, (owner, priority, tag)) in requests.into_iter().enumerate() {
                tasks.push(spawn_acquire(&a, Pool::Agent, owner, priority, &order, tag));
                queued_is(&a, queued + 1, tasks.last_mut().unwrap()).await;
            }
            if name == "full" {
                let refused = a.acquire_in(Pool::Agent, Some("z"), Priority::UserVisible, &Cancel::new()).await.err().unwrap();
                assert_eq!(serde_json::json!(refused), golden[name]["full"]["message"]);
            }
            drop(first);
            for t in tasks {
                t.await.unwrap();
            }
            assert_eq!(serde_json::json!(*order.lock().unwrap()), golden[name]["order"], "{name}");
        }
    }

    fn yield_golden() -> serde_json::Value {
        serde_json::from_str(include_str!("golden/admission_yield.json")).unwrap()
    }

    /// Node's real controller: a yielded agent lets another run; its slot comes back in the
    /// queue, behind an owner that was already waiting.
    #[tokio::test(start_paused = true)]
    async fn a_yielded_agent_lets_another_run_and_gets_its_slot_back_in_order() {
        let a = admission(1, 16);
        let ev: Arc<Mutex<Vec<String>>> = Arc::default();
        let push = |ev: &Arc<Mutex<Vec<String>>>, s: String| ev.lock().unwrap().push(s);
        let held_a = Arc::new(a.acquire_in(Pool::Agent, Some("a"), Priority::UserVisible, &Cancel::new()).await.unwrap());
        push(&ev, "A-acquired".into());
        let (b_tx, b_rx) = oneshot::channel();
        let (c_tx, c_rx) = oneshot::channel();
        for (queued, (owner, tag, tx)) in [("b", "B-granted", b_tx), ("c", "C-granted", c_tx)].into_iter().enumerate() {
            let (host, ev) = (a.clone(), ev.clone());
            let mut waiter = tokio::spawn(async move {
                let held = host.acquire_in(Pool::Agent, Some(owner), Priority::UserVisible, &Cancel::new()).await.unwrap();
                ev.lock().unwrap().push(tag.into());
                drop(tx.send(held));
            });
            queued_is(&a, queued + 1, &mut waiter).await;
        }
        let gate = Arc::new(tokio::sync::Notify::new());
        let started = Arc::new(tokio::sync::Notify::new());
        let mut run = {
            let (held, ev, gate, started) = (held_a.clone(), ev.clone(), gate.clone(), started.clone());
            tokio::spawn(async move {
                let value = held
                    .run_yielded(
                        async {
                            ev.lock().unwrap().push("A-request-start".into());
                            started.notify_one();
                            gate.notified().await;
                            ev.lock().unwrap().push("A-request-done".into());
                            Ok::<_, ()>("ok")
                        },
                        None,
                        None,
                    )
                    .await
                    .unwrap();
                ev.lock().unwrap().push(format!("A-restored:{}", value.unwrap()));
            })
        };
        tokio::select! {
            biased;
            () = started.notified() => {}
            ended = &mut run => panic!("the yielded run ended before its request started: {ended:?}"),
        }
        let b = b_rx.await.unwrap();
        push(&ev, format!("active-while-B:{}", a.active(Pool::Agent)));
        gate.notify_one();
        // The request ends and A joins the queue behind C.
        queued_is(&a, 2, &mut run).await;
        push(&ev, format!("A-waiting-for-slot:{}", a.queued() > 0));
        b.release().await;
        let c = c_rx.await.unwrap();
        push(&ev, "C-held".into());
        c.release().await;
        run.await.unwrap();
        Arc::try_unwrap(held_a).ok().unwrap().release().await;
        push(&ev, format!("active-end:{}", a.active(Pool::Agent)));
        let golden = yield_golden();
        assert_eq!(serde_json::json!(*ev.lock().unwrap()), golden["yield"]["events"]);
        assert_eq!(a.wait_stats("agentRestore").admitted, golden["yield"]["restoreStats"].as_u64().unwrap());
    }

    #[tokio::test]
    async fn a_failed_request_keeps_the_lease_suspended_until_it_is_released() {
        let a = admission(1, 16);
        let held = a.acquire_in(Pool::Agent, Some("a"), Priority::UserVisible, &Cancel::new()).await.unwrap();
        let outcome = held.run_yielded(async { Err::<(), _>("boom") }, None, None).await.unwrap();
        let golden = yield_golden();
        assert_eq!(outcome.err(), golden["failed"]["err"].as_str().map(|_| "boom"));
        assert_eq!(serde_json::json!(held.counted()), golden["failed"]["counted"]);
        // Another agent starts at once; the suspended lease releases cleanly.
        let b = a.acquire_in(Pool::Agent, Some("b"), Priority::UserVisible, &Cancel::new()).await.unwrap();
        b.release().await;
        held.release().await;
        assert_eq!(serde_json::json!(a.active(Pool::Agent)), golden["failed"]["active"]);
    }

    #[tokio::test]
    async fn a_nested_agent_suspends_its_parent_until_it_is_released() {
        let a = admission(1, 16);
        let parent = a.acquire_in(Pool::Agent, Some("p"), Priority::UserVisible, &Cancel::new()).await.unwrap();
        let child = a.acquire_under(Some(&parent), Pool::Agent, Some("k"), Priority::UserVisible, &Cancel::new()).await.unwrap();
        let mut ev = vec![format!("child-held:{}:{}", a.active(Pool::Agent), parent.counted())];
        child.release().await;
        ev.push(format!("child-released:{}", parent.counted()));
        parent.release().await;
        assert_eq!(serde_json::json!(ev), yield_golden()["nested"]);
    }

    /// What Node's cancelled wait says per source of the cancel.
    #[tokio::test(start_paused = true)]
    async fn a_cancelled_wait_says_what_its_source_said() {
        let golden = yield_golden();
        let probe = |abort: Box<dyn Fn(&Cancel)>| async move {
            let a = admission(1, 16);
            let held = a.acquire_in(Pool::Agent, None, Priority::UserVisible, &Cancel::new()).await.unwrap();
            let cancel = Cancel::new();
            let mut waiting = {
                let (a, cancel) = (a.clone(), cancel.clone());
                tokio::spawn(async move { a.acquire_in(Pool::Agent, None, Priority::UserVisible, &cancel).await.err() })
            };
            queued_is(&a, 1, &mut waiting).await;
            abort(&cancel);
            let text = waiting.await.unwrap().unwrap();
            held.release().await;
            text
        };
        assert_eq!(probe(Box::new(|c| c.abort_default())).await, golden["reasons"]["default"].as_str().unwrap());
        assert_eq!(probe(Box::new(|c| c.abort("parent session closed"))).await, golden["reasons"]["error"].as_str().unwrap());
        assert_eq!(probe(Box::new(|c| c.abort("stopped by user"))).await, golden["reasons"]["string"].as_str().unwrap());
        assert_eq!(probe(Box::new(|c| c.abort(JOB_CANCELLED))).await, golden["reasons"]["job"].as_str().unwrap());
        // A composed signal keeps the reason of the source that fired first.
        let (parent, call) = (Cancel::new(), Cancel::new());
        let linked = Cancel::linked(&[parent.clone(), call.clone()]);
        call.abort("call stopped");
        linked.cancelled().await;
        parent.abort("too late");
        assert_eq!(linked.reason(), "call stopped");
    }

    #[tokio::test]
    async fn the_seam_hands_out_a_lease_that_releases() {
        let a = admission(1, 4);
        let admission: &dyn Admission = a.as_ref();
        let lease = admission.acquire("tag", Some("  s1  "), &Cancel::new()).await.unwrap();
        assert_eq!(a.active(Pool::Agent), 1);
        lease.release().await;
        assert_eq!(a.active(Pool::Agent), 0);
        assert_eq!(a.wait_stats("agent").admitted, 1);
    }
}
