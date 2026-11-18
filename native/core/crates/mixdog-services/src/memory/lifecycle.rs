//! The lifecycle owner of a database's work and transport (Rule A). Every operation, queued batch, descendant and connection driver that can touch the
//! database is a slot of one [`Owner`] registry from acceptance until the actor that owns its destruction published it done.
//!
//! - **Lifecycle** (monotonic): `Open → Draining → Revoking → Revoked`. [`Scope::begin_drain`] enters `Draining` and registers the shutdown work in the
//!   same critical section, so nothing outside the owner's own work is admitted after it and the shutdown's own finalizers are owned work.
//!   [`Scope::request_revoke`] enters `Revoking`; the registry publishes `Revoked` (local revocation acknowledged) only once every slot is done.
//! - **Slots**: `reserved → runnable/polling → dropping → done`. A slot stays outstanding until its future was destroyed and the destroying actor
//!   published done. Normal completion, runtime task destruction and forced revocation share one retirement ([`retire`]): the pump destroys the future
//!   it polls (a revocation marks the slot and wakes the pump, it never destroys a future another thread is polling), the pump's `Drop` destroys a
//!   future the runtime abandoned, and a reservation that never activated is retired by its holder. Concurrent revokers join one transition and wait
//!   for one acknowledgement; [`Scope::idle`] reads the same registry.
//! - The registry mutex is never held while polling, destroying a future or running application code.
//! - **Groups** share the owner's lifecycle: the work group, sub-scopes (the trace's), the transport group (connection drivers) and the shutdown work.
//!   Application-work quiescence and transport quiescence are separate waits ([`Scope::idle`] per group).
//! - **Service-owned accepted work**: a caller that stops waiting only drops its [`Owned`] handle. An accepted action runs to completion under the owner,
//!   as a Node promise outlives its caller, with no cap; only the owner's revocation ends it early. Work registered while the owner's own work is being
//!   polled (a child) is admitted until revocation even after the seal: the parent is outstanding while it registers the child, so responsibility is
//!   handed over before the parent can retire.
//! - **Admission without caller cleanup under caller locks**: [`Scope::reserve`] reserves an inert slot; the caller publishes any identity, releases its
//!   locks, then [`Reservation::activate`] installs the future, or, when the cut won, destroys it there (outside every lock) and retires the slot.
//!   [`Scope::coalesce`] keeps a keyed flight inside the registry, so the key is retired with its slot and no caller lock is re-taken.

use std::any::Any;
use std::cell::Cell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

thread_local! {
    /// The owner whose registered work this thread is polling now (its address; 0: none). Set only for the length of one poll.
    static POLLING: Cell<usize> = const { Cell::new(0) };
}

type GroupId = u32;
const WORK: GroupId = 0;
const TRANSPORT: GroupId = 1;
const SHUTDOWN: GroupId = 2;

/// The owner's lifecycle; it only moves forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    Open,
    /// Admission sealed for everything but the owner's own work; accepted work completes.
    Draining,
    /// Revocation requested: every slot is being destroyed.
    Revoking,
    /// Local revocation acknowledged: every slot was destroyed and published done.
    Revoked,
}

/// A coalescing identity: the kind of flight and the address of the object it belongs to.
pub type Key = (&'static str, usize);

/// A coalesced flight's shared result; `None` when the owner revoked it or refused its activation.
pub type Flight<T> = Shared<BoxFuture<'static, Option<T>>>;

/// One owner's work. Clones share it; each handle addresses one group.
#[derive(Clone)]
pub struct Scope {
    owner: Arc<Owner>,
    group: GroupId,
}

struct Owner {
    registry: Mutex<Registry>,
    changed: tokio::sync::Notify,
}

struct Registry {
    phase: Phase,
    next_slot: u64,
    next_group: GroupId,
    slots: HashMap<u64, Arc<Slot>>,
    groups: HashMap<GroupId, Group>,
    keys: HashMap<Key, (u64, Box<dyn Any + Send + Sync>)>,
}

#[derive(Default)]
struct Group {
    sealed: bool,
    outstanding: usize,
}

struct Slot {
    id: u64,
    group: GroupId,
    key: Option<Key>,
    revoke: AtomicBool,
    stage: Mutex<Stage>,
}

enum Stage {
    Reserved,
    Runnable { future: BoxFuture<'static, ()>, waker: Option<Waker> },
    Polling,
    Dropping,
    Done,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Default for Scope {
    fn default() -> Self {
        Self::new()
    }
}

impl Scope {
    /// A new owner; the handle addresses its work group.
    pub fn new() -> Self {
        let groups = [WORK, TRANSPORT, SHUTDOWN].into_iter().map(|id| (id, Group::default())).collect();
        let registry =
            Registry { phase: Phase::Open, next_slot: 0, next_group: SHUTDOWN + 1, slots: HashMap::new(), groups, keys: HashMap::new() };
        Self { owner: Arc::new(Owner { registry: Mutex::new(registry), changed: tokio::sync::Notify::new() }), group: WORK }
    }

    /// A group of this owner with its own seal and idle wait (the trace's), revoked with the owner.
    pub fn sub_scope(&self) -> Self {
        let mut registry = locked(&self.owner.registry);
        let group = registry.next_group;
        registry.next_group += 1;
        registry.groups.insert(group, Group::default());
        Self { owner: self.owner.clone(), group }
    }

    /// The owner's transport group: the connection drivers.
    pub fn transport(&self) -> Self {
        Self { owner: self.owner.clone(), group: TRANSPORT }
    }

    /// The owner's work group (what a sub-scope's owner registers its ordinary work in).
    pub fn work(&self) -> Self {
        Self { owner: self.owner.clone(), group: WORK }
    }

    pub fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
    }

    pub fn phase(&self) -> Phase {
        locked(&self.owner.registry).phase
    }

    fn owner_mark(&self) -> usize {
        Arc::as_ptr(&self.owner) as usize
    }

    /// Whether this thread is polling work of this owner now (a child's registration).
    fn polling_own_work(&self) -> bool {
        POLLING.with(Cell::get) == self.owner_mark()
    }

    fn admits(&self, registry: &Registry, child: bool) -> bool {
        if registry.phase >= Phase::Revoking {
            return false;
        }
        if child {
            return true;
        }
        let sealed = registry.groups.get(&self.group).is_none_or(|group| group.sealed);
        // The transport serves the owner's work until revocation; its own seal closes it once the pools are closed.
        (registry.phase == Phase::Open || self.group == TRANSPORT) && !sealed
    }

    fn insert(&self, registry: &mut Registry, group: GroupId, key: Option<Key>) -> Arc<Slot> {
        registry.next_slot += 1;
        let slot = Arc::new(Slot { id: registry.next_slot, group, key, revoke: AtomicBool::new(false), stage: Mutex::new(Stage::Reserved) });
        registry.slots.insert(slot.id, slot.clone());
        registry.groups.entry(group).or_default().outstanding += 1;
        slot
    }

    /// Reserves an inert slot: `None` when admission is closed for this caller. The slot is outstanding from here; the holder activates it or drops
    /// the reservation, which retires it.
    pub fn reserve(&self) -> Option<Reservation> {
        let child = self.polling_own_work();
        let mut registry = locked(&self.owner.registry);
        if !self.admits(&registry, child) {
            return None;
        }
        let slot = self.insert(&mut registry, self.group, None);
        Some(Reservation { owner: self.owner.clone(), slot: Some(slot) })
    }

    /// Registers `work` and starts it: `None` (the work is dropped unstarted, outside every lock) when admission is closed for this caller. The returned
    /// handle only waits: dropping it leaves the work running and owned.
    pub fn spawn<F>(&self, name: &'static str, work: F) -> Option<Owned<F::Output>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.reserve()?.activate(name, work)
    }

    /// The flight under `key`: joins the one in progress, or reserves a slot, publishes its flight under the key inside the registry, and only then
    /// builds and activates the work (`make` runs outside the registry lock). The key is retired with the slot. `None` when admission is closed.
    pub fn coalesce<T, F>(&self, key: Key, name: &'static str, make: impl FnOnce() -> F) -> Option<Flight<T>>
    where
        T: Clone + Send + Sync + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let child = self.polling_own_work();
        let (reservation, flight, done) = {
            let mut registry = locked(&self.owner.registry);
            if let Some((_, flight)) = registry.keys.get(&key) {
                return flight.downcast_ref::<Flight<T>>().cloned();
            }
            if !self.admits(&registry, child) {
                return None;
            }
            let slot = self.insert(&mut registry, self.group, Some(key));
            let (done, outcome) = tokio::sync::oneshot::channel::<T>();
            let flight: Flight<T> = async move { outcome.await.ok() }.boxed().shared();
            registry.keys.insert(key, (slot.id, Box::new(flight.clone())));
            (Reservation { owner: self.owner.clone(), slot: Some(slot) }, flight, done)
        };
        let work = make();
        let _waiter = reservation.activate_with(name, async move {
            let _ = done.send(work.await);
        });
        Some(flight)
    }

    /// Enters `Draining` and registers the owner's shutdown work in the same critical section: from here nothing outside the owner's own work is
    /// admitted, and the shutdown work is a parent like any other (its children are admitted until revocation). `None` once the owner left `Open`.
    pub fn begin_drain<F>(&self, name: &'static str, work: F) -> Option<Owned<F::Output>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let slot = {
            let mut registry = locked(&self.owner.registry);
            if registry.phase != Phase::Open {
                return None;
            }
            registry.phase = Phase::Draining;
            self.insert(&mut registry, SHUTDOWN, None)
        };
        self.owner.changed.notify_waiters();
        Reservation { owner: self.owner.clone(), slot: Some(slot) }.activate(name, work)
    }

    /// Closes this group's admission: from here only the owner's own work registers in it.
    pub fn seal(&self) {
        locked(&self.owner.registry).groups.entry(self.group).or_default().sealed = true;
        self.owner.changed.notify_waiters();
    }

    /// Whether outside callers are refused by this group.
    pub fn is_sealed(&self) -> bool {
        !self.admits(&locked(&self.owner.registry), false)
    }

    /// Resolves once this group is closed to outside callers (sealed, or the owner left `Open`) and none of its slots is outstanding.
    pub async fn idle(&self) {
        loop {
            let changed = self.owner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let registry = locked(&self.owner.registry);
                let group = registry.groups.get(&self.group);
                let closed = registry.phase > Phase::Open || group.is_none_or(|group| group.sealed);
                if closed && group.is_none_or(|group| group.outstanding == 0) {
                    return;
                }
            }
            changed.await;
        }
    }

    /// Requests the forced cut of every group of the owner and returns at once: admission ends, every slot is marked and its pump woken. It destroys
    /// nothing itself, so a stuck poll or a slow destruction never delays the caller (the cluster stop is dispatched right after this).
    pub fn request_revoke(&self) {
        let slots: Vec<Arc<Slot>> = {
            let mut registry = locked(&self.owner.registry);
            if registry.phase < Phase::Revoking {
                registry.phase = Phase::Revoking;
            }
            if registry.phase == Phase::Revoking && registry.slots.is_empty() {
                registry.phase = Phase::Revoked;
            }
            // Marked in the same critical section that entered `Revoking`: whoever sees the phase sees every slot marked.
            for slot in registry.slots.values() {
                slot.revoke.store(true, Ordering::SeqCst);
            }
            registry.slots.values().cloned().collect()
        };
        self.owner.changed.notify_waiters();
        for slot in slots {
            let waker = match &mut *locked(&slot.stage) {
                Stage::Runnable { waker, .. } => waker.take(),
                _ => None,
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }

    /// Resolves once local revocation is acknowledged: every slot of every group was destroyed and published done. Every waiter joins the same fact.
    pub async fn revoked(&self) {
        // The waiter takes destruction of every marked slot that is not being polled, and rescans at every change of the registry: the
        // acknowledgement depends on no executor scheduling an idle pump (one the host stopped driving would hold it for good). A slot in a poll is
        // still destroyed by its pump when the poll returns.
        loop {
            let changed = self.owner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let slots: Vec<Arc<Slot>> = {
                let registry = locked(&self.owner.registry);
                match registry.phase {
                    Phase::Revoked => return,
                    Phase::Revoking => registry.slots.values().cloned().collect(),
                    _ => Vec::new(),
                }
            };
            for slot in slots {
                let taken = {
                    let mut stage = locked(&slot.stage);
                    match std::mem::replace(&mut *stage, Stage::Dropping) {
                        Stage::Runnable { future, .. } if slot.revoke.load(Ordering::SeqCst) => Some(future),
                        other => {
                            *stage = other;
                            None
                        }
                    }
                };
                if let Some(future) = taken {
                    destroy(&self.owner, &slot, future);
                }
            }
            if locked(&self.owner.registry).phase == Phase::Revoked {
                return;
            }
            changed.await;
        }
    }

    /// [`Self::request_revoke`], then [`Self::revoked`].
    pub async fn revoke(&self) {
        self.request_revoke();
        self.revoked().await;
    }

    /// This group's outstanding slots.
    #[cfg(test)]
    pub(crate) fn running(&self) -> usize {
        locked(&self.owner.registry).groups.get(&self.group).map_or(0, |group| group.outstanding)
    }
}

impl std::fmt::Debug for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let registry = locked(&self.owner.registry);
        f.debug_struct("Scope").field("phase", &registry.phase).field("group", &self.group).field("slots", &registry.slots.len()).finish()
    }
}

/// Destroys a slot's future, then retires the slot. The retirement follows the destruction on every path: a destructor that panics is contained
/// here, so its slot never stays outstanding and no waiter of the acknowledgement inherits the panic.
fn destroy(owner: &Owner, slot: &Slot, future: BoxFuture<'static, ()>) {
    *locked(&slot.stage) = Stage::Dropping;
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(future))).is_err() {
        tracing::warn!("[memory] a destroyed operation's destructor panicked; its slot is retired");
    }
    retire(owner, slot);
}

/// Publishes a slot done and removes it from the registry. Called only by the actor that destroyed the slot's future (or that owned an inert
/// reservation), after the destruction, never under the registry lock.
fn retire(owner: &Owner, slot: &Slot) {
    *locked(&slot.stage) = Stage::Done;
    let key = {
        let mut registry = locked(&owner.registry);
        if registry.slots.remove(&slot.id).is_some()
            && let Some(group) = registry.groups.get_mut(&slot.group)
        {
            group.outstanding -= 1;
        }
        let key = slot.key.and_then(|key| match registry.keys.get(&key) {
            Some((id, _)) if *id == slot.id => registry.keys.remove(&key),
            _ => None,
        });
        if registry.phase == Phase::Revoking && registry.slots.is_empty() {
            registry.phase = Phase::Revoked;
        }
        key
    };
    drop(key);
    owner.changed.notify_waiters();
}

/// An inert slot reserved for work not yet built: outstanding until it is activated, or retired when dropped.
pub struct Reservation {
    owner: Arc<Owner>,
    slot: Option<Arc<Slot>>,
}

impl Reservation {
    /// Installs `work` and starts its pump: `None` when the cut won since the reservation (the work is destroyed here, outside every lock, and the
    /// slot retired). Call it after releasing the locks the reservation was published under.
    pub fn activate<F>(self, name: &'static str, work: F) -> Option<Owned<F::Output>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (done, outcome) = tokio::sync::oneshot::channel();
        let slot = self.slot.clone();
        self.activate_with(name, async move {
            let _ = done.send(work.await);
        })
        .map(|()| Owned { outcome, slot })
    }

    fn activate_with(mut self, name: &'static str, work: impl Future<Output = ()> + Send + 'static) -> Option<()> {
        let slot = self.slot.take().expect("a reservation activates once");
        let mut work: Option<BoxFuture<'static, ()>> = Some(Box::pin(work));
        {
            // Decided and installed under the registry lock, which a revocation takes to enter `Revoking` before it marks any slot: a slot the
            // revocation can mark is never made runnable from an earlier decision.
            let registry = locked(&self.owner.registry);
            let refused = registry.phase >= Phase::Revoking || slot.revoke.load(Ordering::SeqCst);
            let mut stage = locked(&slot.stage);
            if !refused && matches!(*stage, Stage::Reserved) {
                *stage = Stage::Runnable { future: work.take().expect("work"), waker: None };
            }
            drop(stage);
            drop(registry);
        }
        if let Some(refused) = work {
            destroy(&self.owner, &slot, refused);
            return None;
        }
        drop(mixdog_rt::spawn(name, mixdog_rt::TaskClass::Work, Pump { owner: self.owner.clone(), slot }));
        Some(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            retire(&self.owner, &slot);
        }
    }
}

/// The task that polls one slot. It is the only actor that destroys the future while the task lives; a revocation marks the slot and wakes it.
struct Pump {
    owner: Arc<Owner>,
    slot: Arc<Slot>,
}

/// Restores the polling mark when a poll ends, however it ends.
struct Polling(usize);

impl Drop for Polling {
    fn drop(&mut self) {
        POLLING.with(|current| current.set(self.0));
    }
}

impl Pump {
    /// Destroys `future` and publishes the slot done.
    fn destroy(&self, future: BoxFuture<'static, ()>) -> Poll<()> {
        destroy(&self.owner, &self.slot, future);
        Poll::Ready(())
    }
}

impl Future for Pump {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        // Declared before the future: a poll that panics drops the future first, then this retires the slot (the same retirement).
        let _unwinding = Unwinding(&self);
        let mut future = {
            let mut stage = locked(&self.slot.stage);
            match std::mem::replace(&mut *stage, Stage::Polling) {
                Stage::Runnable { future, .. } => future,
                other => {
                    *stage = other;
                    return Poll::Ready(());
                }
            }
        };
        if self.slot.revoke.load(Ordering::SeqCst) {
            return self.destroy(future);
        }
        let polled = {
            let _polling = Polling(POLLING.with(|current| current.replace(Arc::as_ptr(&self.owner) as usize)));
            future.as_mut().poll(cx)
        };
        if polled.is_ready() {
            return self.destroy(future);
        }
        let mut stage = locked(&self.slot.stage);
        // Checked under the stage lock: a revocation that marked the slot before this point finds no waker and relies on this check.
        if self.slot.revoke.load(Ordering::SeqCst) {
            drop(stage);
            return self.destroy(future);
        }
        *stage = Stage::Runnable { future, waker: Some(cx.waker().clone()) };
        Poll::Pending
    }
}

/// Retires a slot whose poll panicked, after the unwinding dropped its future.
struct Unwinding<'a>(&'a Pump);

impl Drop for Unwinding<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() && matches!(*locked(&self.0.slot.stage), Stage::Polling) {
            retire(&self.0.owner, &self.0.slot);
        }
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        // A runtime that drops the task (its shutdown) destroys the future here: the same retirement as a completion or a revocation.
        let left = {
            let mut stage = locked(&self.slot.stage);
            match std::mem::replace(&mut *stage, Stage::Dropping) {
                Stage::Runnable { future, .. } => Some(future),
                other => {
                    *stage = other;
                    None
                }
            }
        };
        if let Some(future) = left {
            destroy(&self.owner, &self.slot, future);
        }
    }
}

/// The result of registered work, `None` when the owner revoked it. Dropping it stops the wait, never the work.
pub struct Owned<T> {
    outcome: tokio::sync::oneshot::Receiver<T>,
    slot: Option<Arc<Slot>>,
}

impl<T> Owned<T> {
    /// Requests the revocation of this one slot (a connection whose client is gone): its pump destroys it and publishes it done.
    pub(crate) fn cut(&self) {
        let Some(slot) = &self.slot else { return };
        slot.revoke.store(true, Ordering::SeqCst);
        let waker = match &mut *locked(&slot.stage) {
            Stage::Runnable { waker, .. } => waker.take(),
            _ => None,
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Future for Owned<T> {
    type Output = Option<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<T>> {
        Pin::new(&mut self.outcome).poll(cx).map(Result::ok)
    }
}

/// Named fences a forced-order test arms inside real operations (a statement's connection checked out, a transaction begun, a connect started):
/// the first operation that passes an armed name announces itself and waits until the test releases it, or is destroyed while it waits.
#[cfg(test)]
pub(crate) mod fences {
    use std::sync::Mutex;

    type Armed = (&'static str, tokio::sync::mpsc::UnboundedSender<()>, tokio::sync::oneshot::Receiver<()>);

    static ARMED: Mutex<Vec<Armed>> = Mutex::new(Vec::new());

    /// Arms `name`: the receiver hears when an operation reached it, the sender releases it.
    pub(crate) fn arm(name: &'static str) -> (tokio::sync::mpsc::UnboundedReceiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (entered_tx, entered) = tokio::sync::mpsc::unbounded_channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        ARMED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((name, entered_tx, gate));
        (entered, release)
    }

    /// Holds the calling thread at `name` when a test armed it (once): an active poll stopped where no await lets revocation cut it (a thread
    /// preempted there).
    pub(crate) fn hold(name: &str) {
        let hit = {
            let mut armed = ARMED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            armed.iter().position(|(armed, ..)| *armed == name).map(|at| armed.remove(at))
        };
        if let Some((_, entered, gate)) = hit {
            let _ = entered.send(());
            let _ = futures::executor::block_on(gate);
        }
    }

    /// Waits at `name` when a test armed it (once).
    pub(crate) async fn pass(name: &str) {
        let hit = {
            let mut armed = ARMED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            armed.iter().position(|(armed, ..)| *armed == name).map(|at| armed.remove(at))
        };
        if let Some((_, entered, gate)) = hit {
            let _ = entered.send(());
            let _ = gate.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    /// Counts its drops; with a gate, its drop blocks until the gate opens (a fenced destruction).
    struct Probe {
        dropped: Arc<AtomicUsize>,
        gate: Option<std::sync::mpsc::Receiver<()>>,
        entered: Option<std::sync::mpsc::Sender<()>>,
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            if let Some(entered) = self.entered.take() {
                let _ = entered.send(());
            }
            if let Some(gate) = self.gate.take() {
                let _ = gate.recv();
            }
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn probe(dropped: &Arc<AtomicUsize>) -> Probe {
        Probe { dropped: dropped.clone(), gate: None, entered: None }
    }

    #[tokio::test]
    async fn a_registration_after_the_seal_is_refused_before_the_work_starts() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let started = Arc::new(AtomicUsize::new(0));
        scope.seal();
        let seen = started.clone();
        assert!(scope.spawn("test", async move { seen.fetch_add(1, Ordering::SeqCst) }).is_none());
        scope.idle().await;
        tokio::task::yield_now().await;
        assert_eq!(started.load(Ordering::SeqCst), 0, "refused work never runs");
    }

    /// A child the parent registers while it runs is admitted after the drain began and held by the idle wait; the parent ending first leaves the child
    /// owned.
    #[tokio::test]
    async fn a_child_registered_by_running_work_after_the_drain_keeps_the_group_busy() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let (sealed_tx, sealed_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_child, child_held) = tokio::sync::oneshot::channel::<()>();
        let inner = scope.clone();
        let parent = scope
            .spawn("parent", async move {
                let _ = sealed_rx.await;
                inner.spawn("child", async move { let _ = child_held.await; }).is_some()
            })
            .expect("admitted");
        let _drain = scope.begin_drain("shutdown", async {}).expect("drain");
        let _ = sealed_tx.send(());
        assert_eq!(parent.await, Some(true), "the child of registered work is admitted while draining");
        assert!(scope.spawn("outside", async {}).is_none(), "outside work is refused while draining");
        let mut idle = Box::pin(scope.idle());
        assert!(futures::poll!(&mut idle).is_pending(), "the child holds the idle wait after its parent ended");
        assert_eq!(scope.running(), 1);
        let _ = release_child.send(());
        idle.await;
    }

    /// A caller that stops waiting leaves the work owned and running; the revocation's acknowledgement comes only after the work was destroyed.
    #[tokio::test]
    async fn a_dropped_waiter_leaves_the_work_owned_until_the_revocation_destroys_it() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let dropped = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
        let held = probe(&dropped);
        let waiter = scope
            .spawn("held", async move {
                let _probe = held;
                let _ = entered_tx.send(());
                std::future::pending::<()>().await
            })
            .expect("admitted");
        entered.await.expect("the work runs");
        drop(waiter);
        tokio::task::yield_now().await;
        assert_eq!((scope.running(), dropped.load(Ordering::SeqCst)), (1, 0), "a dropped waiter is not completion");
        scope.revoke().await;
        assert_eq!(dropped.load(Ordering::SeqCst), 1, "the acknowledgement follows the destruction");
        assert_eq!(scope.running(), 0);
        assert_eq!(scope.phase(), Phase::Revoked);
        assert!(scope.spawn("late", async {}).is_none(), "nothing is admitted after a revocation");
    }

    #[tokio::test]
    async fn a_sub_scope_and_the_transport_are_revoked_with_their_owner() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let (sub, transport) = (scope.sub_scope(), scope.transport());
        let dropped = Arc::new(AtomicUsize::new(0));
        let (one, two) = (probe(&dropped), probe(&dropped));
        let waiter = sub.spawn("held", async move { let _probe = one; std::future::pending::<()>().await }).expect("admitted");
        let _driver = transport.spawn("driver", async move { let _probe = two; std::future::pending::<()>().await }).expect("admitted");
        // An idle driver never holds up the work drain.
        let _drain = scope.begin_drain("shutdown", async {}).expect("drain");
        scope.work().idle().await;
        scope.revoke().await;
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        assert_eq!(waiter.await, None, "revoked work answers nothing");
    }

    /// A poll held on another thread: two revokers and the idle wait stay pending; the poll ends and the pump's fenced destruction runs; all stay pending
    /// until it ends, then all resolve on one acknowledgement.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_revokers_and_the_idle_wait_join_one_acknowledgement_after_the_fenced_destruction() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let dropped = Arc::new(AtomicUsize::new(0));
        let (in_poll_tx, in_poll) = std::sync::mpsc::channel::<()>();
        let (release_poll, poll_gate) = std::sync::mpsc::channel::<()>();
        let (in_drop_tx, in_drop) = std::sync::mpsc::channel::<()>();
        let (release_drop, drop_gate) = std::sync::mpsc::channel::<()>();
        let held = Probe { dropped: dropped.clone(), gate: Some(drop_gate), entered: Some(in_drop_tx) };
        let _waiter = scope
            .spawn("held", async move {
                let _probe = held;
                // The poll blocks its worker thread until released: a poll in progress on another thread.
                let _ = in_poll_tx.send(());
                let _ = poll_gate.recv();
                std::future::pending::<()>().await
            })
            .expect("admitted");
        // The test body runs on the runtime's own thread, not a worker: blocking it here holds no poll.
        in_poll.recv().expect("the poll began");
        let (a, b) = (scope.clone(), scope.clone());
        let mut revoke_a = Box::pin(async move { a.revoke().await });
        let mut revoke_b = Box::pin(async move { b.revoke().await });
        let mut idle = Box::pin(scope.idle());
        assert!(futures::poll!(&mut revoke_a).is_pending());
        assert!(futures::poll!(&mut revoke_b).is_pending());
        assert!(futures::poll!(&mut idle).is_pending());
        assert_eq!(scope.phase(), Phase::Revoking);
        release_poll.send(()).expect("release the poll");
        in_drop.recv().expect("the pump destroys the future");
        assert!(futures::poll!(&mut revoke_a).is_pending(), "no acknowledgement while the destruction is fenced");
        assert!(futures::poll!(&mut revoke_b).is_pending());
        assert!(futures::poll!(&mut idle).is_pending());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        release_drop.send(()).expect("release the destruction");
        revoke_a.await;
        revoke_b.await;
        idle.await;
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    /// A destructor that panics while the revocation destroys its operation: the slot still retires and the acknowledgement completes.
    #[tokio::test]
    async fn a_panicking_destructor_still_retires_its_slot_and_the_revocation_completes() {
        mixdog_rt::testing::tokens();
        struct Panics;
        impl Drop for Panics {
            fn drop(&mut self) {
                panic!("the destructor panics");
            }
        }
        let scope = Scope::new();
        let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
        let held = Panics;
        let _waiter = scope
            .spawn("panicking", async move {
                let _held = held;
                let _ = entered_tx.send(());
                std::future::pending::<()>().await
            })
            .expect("admitted");
        entered.await.expect("the work runs");
        scope.revoke().await;
        assert_eq!((scope.running(), scope.phase()), (0, Phase::Revoked));
    }

    /// A reservation the revocation marked before its activation is never made runnable (the decision and the install are one step under the
    /// registry lock), and the acknowledgement completes.
    #[tokio::test]
    async fn an_activation_after_the_revocation_marked_its_reservation_is_refused() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let reservation = scope.reserve().expect("reserved");
        scope.request_revoke();
        let ran = Arc::new(AtomicUsize::new(0));
        let seen = ran.clone();
        assert!(reservation.activate("late", async move { seen.fetch_add(1, Ordering::SeqCst) }).is_none(), "refused at install");
        scope.revoked().await;
        tokio::task::yield_now().await;
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    /// Work activated before the revocation whose pump no executor has polled yet (this single-threaded test never yields to it): the waiter
    /// destroys it itself, so the acknowledgement does not depend on the pump being scheduled.
    #[tokio::test]
    async fn the_acknowledgement_does_not_wait_for_an_unscheduled_pump() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let dropped = Arc::new(AtomicUsize::new(0));
        let held = probe(&dropped);
        let _waiter = scope.spawn("unscheduled", async move { let _held = held; std::future::pending::<()>().await }).expect("admitted");
        scope.request_revoke();
        let mut acknowledged = Box::pin(scope.revoked());
        assert!(futures::poll!(&mut acknowledged).is_ready(), "acknowledged in the waiter's own poll");
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    /// A coalesced start whose reservation the cut overtook: no future runs, the reservation retires (the key with it) and no caller lock is re-taken.
    #[tokio::test]
    async fn a_refused_coalesced_start_runs_nothing_and_retires_its_key() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let started = Arc::new(AtomicUsize::new(0));
        let caller_lock = Mutex::new(());
        let held = caller_lock.lock().expect("the caller's lock");
        let seen = started.clone();
        let flight = scope
            .coalesce::<u32, _>(("test", 1), "flight", || {
                // The cut wins between the key's publication and the activation.
                scope.request_revoke();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    7
                }
            })
            .expect("reserved before the cut");
        drop(held);
        assert_eq!(flight.await, None, "the refused flight answers nothing");
        assert_eq!(started.load(Ordering::SeqCst), 0, "no future ran");
        scope.revoked().await;
        assert!(caller_lock.try_lock().is_ok(), "nothing re-took the caller's lock");
        assert!(locked(&scope.owner.registry).keys.is_empty(), "the key retired with its slot");
    }

    #[tokio::test]
    async fn a_coalesced_flight_is_shared_and_its_key_retires_with_its_completion() {
        mixdog_rt::testing::tokens();
        let scope = Scope::new();
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let first = scope.coalesce::<u32, _>(("test", 2), "flight", || async move { let _ = gate.await; 3 }).expect("admitted");
        let second = scope.coalesce::<u32, _>(("test", 2), "flight", || async { 9 }).expect("joined");
        let _ = release.send(());
        assert_eq!((first.await, second.await), (Some(3), Some(3)));
        let _drain = scope.begin_drain("shutdown", async {}).expect("drain");
        scope.idle().await;
        assert!(locked(&scope.owner.registry).keys.is_empty());
    }
}
