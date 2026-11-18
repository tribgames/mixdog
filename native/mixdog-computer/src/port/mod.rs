//! The effect port: the only way an executor's code reaches an external mutation API.
//!
//! The contract. Revocation permanently closes a [`Scope`]. Every external submission (one invocation of one external mutation
//! API: one `SendInput` batch is one; `ShowWindow` then `SetForegroundWindow` is two) is individually arbitrated against that
//! closure by its port (`Scope::admit`, private to this module tree), and none is admitted afterwards. A call admitted before
//! may finish, or enter foreign code, after the acknowledgement; every following executor step needs a new admission. Only
//! receipt-derived teardown (the release a receipt names, the compensation a pending hold stored) is exempt.
//!
//! - The admission word ([`AdmissionWord`]): a terminal closed bit, an open bit (a pending scope admits nothing until it is
//!   granted, and a late grant never reopens a closed one), and the counts of admitted unfinished calls. Admission is one
//!   compare-exchange that increments a count only while open (its linearization point); revocation is one atomic `fetch_or`
//!   of the closed bit that reads the prior counts; completion decrements. An elevated worker's word lives in a section its
//!   unelevated parent created (`port::windows::shared`), so the helper and its elevated descendants are one admission domain.
//! - Two kinds of call (`Boundary`). A local one does not wait for a foreign process or thread, runs no foreign callback, and
//!   makes a local change or queue submission (`SendInput`, `PostMessageW`, a uinput write): the revocation waits for those in
//!   progress, which are bounded. Any other (unknown, provider-dependent, a foreign window's synchronous answer) is a hand-over:
//!   the revocation counts it and never waits for it.
//! - [`Scope::revoke`] answers a [`Closure`]: the first snapshot (kept for repeated revocations) of the calls unfinished at
//!   closure. [`Scope::report`] adds what is unfinished now and the cleanup: pending
//!   (receipts held or pending, calls unfinished, a fenced executor not settled), complete, or unconfirmed.
//! - A press a port accepts is a receipt of the executor, the scope epoch, the destination and the key or button. A release is a
//!   release only by consuming one, exactly once; the port builds it from the receipt and never forwards a caller's payload. A
//!   hold whose mutation is handed over is a pending receipt until its call completes: revocation or a release marks it
//!   release-requested; on completion it is retired (nothing applied), compensated (applied and release requested), kept held
//!   (applied, scope open), or kept as an unconfirmed obligation (uncertain).
//!
//! Stated limit: without waiting, a call admitted just before closure (even one whose thread has not yet entered the API) can
//! still execute once; its continuation cannot.

#[cfg(test)]
pub(crate) mod fake;
pub(crate) mod generic;
#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(windows)]
pub(crate) mod windows;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};

/// What a refused submission answers.
pub const REVOKED: &str = "computer_scope_revoked: Computer Use was switched off; nothing more is done under this session";

/// Each port is an executor of its own: a receipt names the one that took it.
static NEXT_EXECUTOR: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_executor() -> u64 {
    NEXT_EXECUTOR.fetch_add(1, Ordering::Relaxed)
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How one external call is admitted.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Boundary {
    /// Waits for no foreign process or thread and runs no foreign callback: the revocation waits for it.
    Local,
    /// Anything else: counted, never waited for.
    HandOver,
}

/// The admission word's layout.
pub(crate) mod word {
    /// Terminal: nothing is admitted once set, and nothing clears it.
    pub(crate) const CLOSED: u64 = 1 << 63;
    /// Granted: a pending scope admits nothing before it.
    pub(crate) const OPEN: u64 = 1 << 62;
    /// One admitted unfinished local call.
    pub(crate) const LOCAL: u64 = 1 << 32;
    pub(crate) const LOCAL_MASK: u64 = ((1 << 30) - 1) << 32;
    /// One admitted unfinished handed-over call.
    pub(crate) const HAND_OVER: u64 = 1;
    pub(crate) const HAND_OVER_MASK: u64 = (1 << 32) - 1;

    pub(crate) fn unfinished(value: u64) -> usize {
        ((value & HAND_OVER_MASK) + ((value & LOCAL_MASK) >> 32)) as usize
    }
}

/// Where a scope's admission word lives: in this process, or in a section shared with the executor's parent.
pub(crate) trait AdmissionWord: Send + Sync {
    fn word(&self) -> &AtomicU64;
}

impl AdmissionWord for AtomicU64 {
    fn word(&self) -> &AtomicU64 {
        self
    }
}

/// The cleanup state of what a scope's executors hold.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cleanup {
    /// Something is still held, pending, unfinished, or not yet released.
    Pending,
    Complete,
    /// A release or a compensation failed, or an outcome is uncertain: an obligation that cannot be confirmed.
    Unconfirmed,
}

impl Cleanup {
    fn name(self) -> &'static str {
        match self {
            Cleanup::Pending => "pending",
            Cleanup::Complete => "complete",
            Cleanup::Unconfirmed => "unconfirmed",
        }
    }

    fn and(self, other: Cleanup) -> Cleanup {
        match (self, other) {
            (Cleanup::Unconfirmed, _) | (_, Cleanup::Unconfirmed) => Cleanup::Unconfirmed,
            (Cleanup::Pending, _) | (_, Cleanup::Pending) => Cleanup::Pending,
            _ => Cleanup::Complete,
        }
    }
}

/// An executor in another process fenced by a scope. Its closure is always confirmed: it is one atomic write of a word this
/// process created and the executor can only admit through.
pub(crate) trait Endpoint: Send + Sync {
    /// Closes the executor's admission without waiting for it; its calls admitted and unfinished at that moment.
    fn close(&self) -> usize;
    /// What the executor still holds or runs.
    fn cleanup(&self) -> Cleanup;
}

/// A port that may hold input when the scope is revoked.
pub(crate) trait Holder: Send + Sync {
    /// Lets go of every receipt still held, and asks every pending one to be released once it completes; false when one could
    /// not be released.
    fn release_held(&self) -> bool;
    fn cleanup(&self) -> Cleanup;
}

/// The first snapshot of a scope's closure.
#[derive(Clone, Debug, PartialEq)]
pub struct Closure {
    pub epoch: u64,
    /// Calls (handed-over ones of this executor, all of a fenced one) admitted and unfinished at closure: a diagnostic.
    pub unfinished: usize,
}

/// One acknowledgement of a revocation: admission closed (or not known closed), and how far its effects settled.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub closure: Closure,
    pub unfinished_now: usize,
    pub cleanup: Cleanup,
}

impl Report {
    pub fn json(&self) -> Value {
        json!({
            "scope": self.closure.epoch,
            "admission": "closed",
            "unfinished_at_closure": self.closure.unfinished,
            "unfinished": self.unfinished_now,
            "cleanup": self.cleanup.name(),
        })
    }
}

type Listener = Box<dyn Fn(&Report) + Send + Sync>;

struct Gate {
    epoch: u64,
    word: Box<dyn AdmissionWord>,
    /// Wakes a pending admission and a revocation waiting for local calls; never decides anything.
    wake: Mutex<()>,
    changed: Condvar,
    endpoints: Mutex<Vec<Arc<dyn Endpoint>>>,
    holders: Mutex<Vec<Weak<dyn Holder>>>,
    closure: OnceLock<Closure>,
    released: AtomicBool,
    listener: Mutex<Option<Listener>>,
    this: Weak<Gate>,
}

/// One executor's revocation endpoint for one scope epoch; clones are the same scope. A new epoch is a new scope: work that holds
/// a port of an older one stays refused.
#[derive(Clone)]
pub struct Scope(Arc<Gate>);

/// One admitted call until it completes.
pub(crate) struct Admitted<'a> {
    gate: &'a Gate,
    one: u64,
}

impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        let prior = self.gate.word.word().fetch_sub(self.one, Ordering::SeqCst);
        if prior & word::CLOSED != 0 {
            {
                let _wake = locked(&self.gate.wake);
                self.gate.changed.notify_all();
            }
            // A handed-over call that finishes after the closure changes the report.
            if let (true, Some(gate)) = (self.one == word::HAND_OVER, self.gate.this.upgrade()) {
                Scope(gate).notify();
            }
        }
    }
}

impl Scope {
    fn with(epoch: u64, word: Box<dyn AdmissionWord>) -> Scope {
        Scope(Arc::new_cyclic(|this| Gate {
            epoch,
            word,
            wake: Mutex::new(()),
            changed: Condvar::new(),
            endpoints: Mutex::new(Vec::new()),
            holders: Mutex::new(Vec::new()),
            closure: OnceLock::new(),
            released: AtomicBool::new(false),
            listener: Mutex::new(None),
            this: this.clone(),
        }))
    }

    /// A scope open from the start: the executor the core started.
    pub fn open(epoch: u64) -> Scope {
        Scope::with(epoch, Box::new(AtomicU64::new(word::OPEN)))
    }

    /// A scope that admits nothing until [`Scope::grant`] (an executor's own child uses [`Scope::shared`] instead).
    #[cfg(test)]
    pub fn pending(epoch: u64) -> Scope {
        Scope::with(epoch, Box::new(AtomicU64::new(0)))
    }

    /// A scope whose word another process (the parent that granted it) shares: the parent's revocation closes it directly.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn shared(epoch: u64, word: Box<dyn AdmissionWord>) -> Scope {
        Scope::with(epoch, word)
    }

    pub fn epoch(&self) -> u64 {
        self.0.epoch
    }

    /// Opens a pending scope; false once it was closed (a late grant never reopens it).
    #[cfg(test)]
    pub fn grant(&self) -> bool {
        let open = grant_word(self.0.word.word());
        self.wake();
        open
    }

    /// Wakes a waiting admission to read the word again (a grant or a closure another process wrote).
    pub fn wake(&self) {
        let _wake = locked(&self.0.wake);
        self.0.changed.notify_all();
    }

    /// Closes admission for good, waits only for the local calls in progress (bounded: none waits for a foreign process), and
    /// closes every fenced executor without waiting for it. Answers the first closure snapshot.
    pub fn revoke(&self) -> Closure {
        // The snapshot is the closing transition's own: the `fetch_or` that closes the word answers the prior word, and the same
        // critical section (the endpoints' lock, which `fence` takes too) closes the fenced executors and stores it. A later
        // revoker reads it and never takes a snapshot of its own. A word another process closed first (the parent of a shared
        // word) answers it closed: this side's first revoker stores the count it read, the closer keeps the closure's.
        let closure = {
            let endpoints = locked(&self.0.endpoints);
            match self.0.closure.get() {
                Some(closure) => closure.clone(),
                None => {
                    let prior = self.0.word.word().fetch_or(word::CLOSED, Ordering::SeqCst);
                    let fenced: usize = endpoints.iter().map(|endpoint| endpoint.close()).sum();
                    let closure = Closure { epoch: self.0.epoch, unfinished: (prior & word::HAND_OVER_MASK) as usize + fenced };
                    let _ = self.0.closure.set(closure.clone());
                    closure
                }
            }
        };
        let mut wake = locked(&self.0.wake);
        self.0.changed.notify_all();
        while self.0.word.word().load(Ordering::SeqCst) & word::LOCAL_MASK != 0 {
            wake = self.0.changed.wait(wake).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        closure
    }

    /// The acknowledgement now: the closure snapshot, what is unfinished now, and the cleanup.
    pub fn report(&self) -> Report {
        let closure = self.revoke();
        let value = self.0.word.word().load(Ordering::SeqCst);
        let unfinished_now = word::unfinished(value);
        let mut cleanup = if self.0.released.load(Ordering::SeqCst) { Cleanup::Complete } else { Cleanup::Pending };
        if unfinished_now > 0 {
            cleanup = cleanup.and(Cleanup::Pending);
        }
        for holder in locked(&self.0.holders).iter().filter_map(Weak::upgrade) {
            cleanup = cleanup.and(holder.cleanup());
        }
        for endpoint in locked(&self.0.endpoints).iter() {
            cleanup = cleanup.and(endpoint.cleanup());
        }
        Report { closure, unfinished_now, cleanup }
    }

    /// Calls `listener` with the report whenever it may have changed after the closure (a pending hold completed, a handed-over
    /// call finished, a fenced executor ended).
    pub fn on_report(&self, listener: impl Fn(&Report) + Send + Sync + 'static) {
        *locked(&self.0.listener) = Some(Box::new(listener));
    }

    /// Something a report reads changed.
    pub(crate) fn notify(&self) {
        if !self.is_revoked() {
            return;
        }
        let report = self.report();
        if let Some(listener) = locked(&self.0.listener).as_ref() {
            listener(&report);
        }
    }

    /// Lets go of every receipt the scope's ports still hold; false when one could not be released.
    pub fn release_held(&self) -> bool {
        let holders: Vec<Arc<dyn Holder>> = locked(&self.0.holders).iter().filter_map(Weak::upgrade).collect();
        let released = holders.iter().fold(true, |released, holder| holder.release_held() && released);
        self.0.released.store(true, Ordering::SeqCst);
        released
    }

    pub fn is_revoked(&self) -> bool {
        self.0.word.word().load(Ordering::SeqCst) & word::CLOSED != 0
    }

    /// The early refusal of a request read after the revocation. Not a fence: every effect is arbitrated by its port.
    pub fn check(&self) -> Result<(), String> {
        if self.is_revoked() { Err(REVOKED.into()) } else { Ok(()) }
    }

    /// Fences an executor of another process by this scope: false (and nothing registered) once closed, in which case the
    /// executor must never be granted admission. It stays registered for good, so a later revocation reads it again.
    pub(crate) fn fence(&self, endpoint: Arc<dyn Endpoint>) -> bool {
        let mut endpoints = locked(&self.0.endpoints);
        if self.is_revoked() {
            return false;
        }
        endpoints.push(endpoint);
        true
    }

    fn hold(&self, holder: Weak<dyn Holder>) {
        let mut holders = locked(&self.0.holders);
        holders.retain(|known| known.strong_count() > 0);
        holders.push(holder);
    }

    /// Admits one external call: refused once closed, waiting (holding nothing) only for a pending grant.
    fn admit(&self, boundary: Boundary) -> Result<Admitted<'_>, String> {
        let one = match boundary {
            Boundary::Local => word::LOCAL,
            Boundary::HandOver => word::HAND_OVER,
        };
        let cell = self.0.word.word();
        let mut value = cell.load(Ordering::SeqCst);
        loop {
            if value & word::CLOSED != 0 {
                return Err(REVOKED.into());
            }
            if value & word::OPEN == 0 {
                let wake = locked(&self.0.wake);
                if cell.load(Ordering::SeqCst) & (word::OPEN | word::CLOSED) == 0 {
                    drop(self.0.changed.wait(wake).unwrap_or_else(|poisoned| poisoned.into_inner()));
                }
                value = cell.load(Ordering::SeqCst);
                continue;
            }
            match cell.compare_exchange(value, value + one, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Ok(Admitted { gate: &self.0, one }),
                Err(actual) => value = actual,
            }
        }
    }
}

/// Sets the open bit unless closed; whether the word is open afterwards.
pub(crate) fn grant_word(cell: &AtomicU64) -> bool {
    let mut value = cell.load(Ordering::SeqCst);
    loop {
        if value & word::CLOSED != 0 {
            return false;
        }
        match cell.compare_exchange(value, value | word::OPEN, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(actual) => value = actual,
        }
    }
}

/// Closes a word for good; the calls admitted and unfinished at that moment.
pub(crate) fn close_word(cell: &AtomicU64) -> usize {
    word::unfinished(cell.fetch_or(word::CLOSED, Ordering::SeqCst))
}

/// What a port records of an accepted press: who took it, under which epoch, and what it holds. Opaque outside the port: only
/// a port makes one, and only the port that made it redeems it, once.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Receipt<H> {
    executor: u64,
    epoch: u64,
    id: u64,
    pub(crate) hold: H,
}

/// A hold whose mutation was handed over and has not completed.
pub(crate) struct Ticket {
    id: u64,
}

/// How a handed-over mutation came out.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Outcome {
    /// Nothing was changed.
    NotApplied,
    Applied,
    /// It may or may not have been applied (an X request whose acknowledgement failed; no Windows primitive answers so).
    #[cfg_attr(windows, allow(dead_code))]
    Uncertain,
}

/// What the port does once a pending hold completed.
#[derive(Debug, PartialEq)]
pub(crate) enum Settled<H> {
    /// Nothing to undo; or held now (the scope open, no release asked).
    Done,
    /// Applied while its release was asked for: run the stored compensation, then [`Ledger::compensated`].
    Compensate(Receipt<H>),
}

/// Where a receipt stands. Every state but the end of a release keeps it accounted, so the cleanup reads pending until its
/// release or compensation returned.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    /// Its mutation was handed over and has not completed; `requested`: its release was asked for meanwhile.
    Pending { requested: bool },
    Held,
    /// Its release (or the compensation of a pending one) is under way.
    Releasing,
}

struct Entry<H> {
    receipt: Receipt<H>,
    state: State,
}

/// Everything a ledger tracks, behind one lock: a receipt moves between states in one critical section, so the cleanup
/// (`drain`) never runs between two halves of a transition.
struct Entries<H> {
    live: Vec<Entry<H>>,
    /// Holds the revocation cleanup let go of (an operation's later release of one sends nothing).
    drained: Vec<H>,
    /// Obligations that could not be confirmed (a failed release or compensation, an uncertain mutation compensated): kept in
    /// the same locked state as the entries, so one report reads both in one observation.
    unconfirmed: u64,
}

/// The receipts one port holds: pending (handed over, not completed), held, releasing, and the ones the revocation cleanup
/// already let go of, with the obligations that could not be confirmed.
pub(crate) struct Ledger<H> {
    executor: u64,
    epoch: u64,
    next: AtomicU64,
    entries: Mutex<Entries<H>>,
    releasing: Mutex<()>,
    /// The scope told of every transition that changes what its report says (`changed`).
    observer: OnceLock<Weak<Gate>>,
}

/// What a release finds in a ledger.
#[derive(Debug, PartialEq)]
pub(crate) enum Owned<H> {
    /// A receipt of this port, now releasing: the release goes out whatever the scope says, then [`Ledger::released`] (or
    /// [`Ledger::restore`] when it did not go out).
    Held(Receipt<H>),
    /// Already let go of by the revocation cleanup, or asked to be once its pending mutation completes: nothing to send now.
    Drained,
    /// No receipt: not a release of this port's, an ordinary submission.
    None,
}

impl<H: Clone + PartialEq> Ledger<H> {
    pub(crate) fn new(epoch: u64) -> Ledger<H> {
        Ledger {
            executor: next_executor(),
            epoch,
            next: AtomicU64::new(1),
            entries: Mutex::new(Entries { live: Vec::new(), drained: Vec::new(), unconfirmed: 0 }),
            releasing: Mutex::new(()),
            observer: OnceLock::new(),
        }
    }

    /// The scope this ledger's port works under: told of each change of what its report would say.
    pub(crate) fn observe(&self, scope: &Scope) {
        let _ = self.observer.set(Arc::downgrade(&scope.0));
    }

    /// The one place a transition is published: a release or compensation returned (either way), a pending hold completed.
    /// Called with no lock held; the scope reports only once closed.
    fn changed(&self) {
        if let Some(gate) = self.observer.get().and_then(Weak::upgrade) {
            Scope(gate).notify();
        }
    }

    fn entries(&self) -> MutexGuard<'_, Entries<H>> {
        locked(&self.entries)
    }

    fn receipt(&self, hold: H) -> Receipt<H> {
        Receipt { executor: self.executor, epoch: self.epoch, id: self.next.fetch_add(1, Ordering::Relaxed), hold }
    }

    /// A press accepted by the system: held from now.
    pub(crate) fn record(&self, hold: H) -> Receipt<H> {
        let receipt = self.receipt(hold);
        self.entries().live.push(Entry { receipt: receipt.clone(), state: State::Held });
        receipt
    }

    /// A hold whose mutation is about to be handed over: pending until [`Ledger::settle`].
    pub(crate) fn begin(&self, hold: H) -> Ticket {
        let receipt = self.receipt(hold);
        let id = receipt.id;
        self.entries().live.push(Entry { receipt, state: State::Pending { requested: false } });
        Ticket { id }
    }

    /// The pending hold's mutation completed with `outcome`: its next state is set in one critical section (no cleanup sees it
    /// in neither). A compensation stays accounted as releasing until [`Ledger::compensated`].
    pub(crate) fn settle(&self, ticket: Ticket, outcome: Outcome) -> Settled<H> {
        let settled = {
            let mut entries = self.entries();
            Self::settle_locked(&mut entries, ticket, outcome)
        };
        self.changed();
        settled
    }

    fn settle_locked(entries: &mut Entries<H>, ticket: Ticket, outcome: Outcome) -> Settled<H> {
        let at = entries.live.iter().position(|entry| entry.receipt.id == ticket.id).expect("a ticket of this ledger");
        let State::Pending { requested } = entries.live[at].state else { unreachable!("a ticket settles once") };
        match (outcome, requested) {
            (Outcome::NotApplied, _) => {
                entries.live.remove(at);
                Settled::Done
            }
            (Outcome::Applied, false) | (Outcome::Uncertain, false) => {
                entries.live[at].state = State::Held;
                Settled::Done
            }
            (Outcome::Applied, true) | (Outcome::Uncertain, true) => {
                if outcome == Outcome::Uncertain {
                    // Its compensation cannot be ordered against a mutation that may not have landed: an obligation.
                    entries.unconfirmed += 1;
                }
                entries.live[at].state = State::Releasing;
                Settled::Compensate(entries.live[at].receipt.clone())
            }
        }
    }

    /// A compensation returned: let go of, or failed (an obligation that stays unconfirmed).
    pub(crate) fn compensated(&self, receipt: Receipt<H>, done: bool) {
        {
            let mut entries = self.entries();
            entries.live.retain(|entry| entry.receipt.id != receipt.id);
            if done {
                entries.drained.push(receipt.hold);
            } else {
                entries.unconfirmed += 1;
            }
        }
        self.changed();
    }

    /// The first held receipt matching `wanted`, left in place.
    pub(crate) fn find(&self, wanted: impl Fn(&H) -> bool) -> Option<Receipt<H>> {
        let entries = self.entries();
        entries.live.iter().find(|entry| entry.state == State::Held && wanted(&entry.receipt.hold)).map(|entry| entry.receipt.clone())
    }

    /// Takes the receipt `wanted` for its release: held (now releasing), drained (once) or still pending (then marked
    /// release-requested, not consumed: its completion runs the compensation), or none.
    pub(crate) fn take(&self, wanted: impl Fn(&H) -> bool) -> Owned<H> {
        let mut entries = self.entries();
        if let Some(entry) = entries.live.iter_mut().find(|entry| entry.state == State::Held && wanted(&entry.receipt.hold)) {
            entry.state = State::Releasing;
            return Owned::Held(entry.receipt.clone());
        }
        if let Some(entry) = entries.live.iter_mut().find(|entry| matches!(entry.state, State::Pending { .. }) && wanted(&entry.receipt.hold)) {
            entry.state = State::Pending { requested: true };
            return Owned::Drained;
        }
        match entries.drained.iter().position(|hold| wanted(hold)) {
            Some(at) => {
                entries.drained.remove(at);
                Owned::Drained
            }
            None => Owned::None,
        }
    }

    /// Consumes exactly `receipt`: held (now releasing; its release goes out), drained or pending (nothing to send now), or none
    /// (forged, of another executor or epoch, already consumed, or being released).
    pub(crate) fn consume(&self, receipt: &Receipt<H>) -> Owned<H> {
        if receipt.executor != self.executor || receipt.epoch != self.epoch {
            return Owned::None;
        }
        let mut entries = self.entries();
        if let Some(entry) = entries.live.iter_mut().find(|entry| entry.receipt.id == receipt.id) {
            return match entry.state {
                State::Held => {
                    entry.state = State::Releasing;
                    Owned::Held(entry.receipt.clone())
                }
                State::Pending { .. } => {
                    entry.state = State::Pending { requested: true };
                    Owned::Drained
                }
                State::Releasing => Owned::None,
            };
        }
        match entries.drained.iter().position(|hold| *hold == receipt.hold) {
            Some(at) => {
                entries.drained.remove(at);
                Owned::Drained
            }
            None => Owned::None,
        }
    }

    /// Takes exactly `receipt` out, refusing a forged one, one of another executor or epoch, or one already redeemed.
    #[cfg(test)]
    pub(crate) fn redeem(&self, receipt: &Receipt<H>) -> Result<Receipt<H>, String> {
        if receipt.executor != self.executor || receipt.epoch != self.epoch {
            return Err(NOT_OWNED.into());
        }
        let mut entries = self.entries();
        match entries.live.iter().position(|entry| entry.state == State::Held && entry.receipt == *receipt) {
            Some(at) => Ok(entries.live.remove(at).receipt),
            None => Err(NOT_OWNED.into()),
        }
    }

    /// A releasing receipt's release went out: it is consumed.
    pub(crate) fn released(&self, receipt: &Receipt<H>) {
        self.entries().live.retain(|entry| entry.receipt.id != receipt.id);
        self.changed();
    }

    /// A releasing receipt whose release did not go out: held again.
    pub(crate) fn restore(&self, receipt: Receipt<H>) {
        Self::hold_again(&mut self.entries(), receipt);
        self.changed();
    }

    fn hold_again(entries: &mut Entries<H>, receipt: Receipt<H>) {
        match entries.live.iter_mut().find(|entry| entry.receipt.id == receipt.id) {
            Some(entry) => entry.state = State::Held,
            None => entries.live.push(Entry { receipt, state: State::Held }),
        }
    }

    /// The cleanup's release of a receipt failed: it stays held, as an obligation that cannot be confirmed.
    pub(crate) fn fail(&self, receipt: Receipt<H>) {
        {
            let mut entries = self.entries();
            entries.unconfirmed += 1;
            Self::hold_again(&mut entries, receipt);
        }
        self.changed();
    }

    /// Replaces the hold of a receipt still held (a held button whose release point moved with an accepted motion).
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub(crate) fn update(&self, wanted: impl Fn(&H) -> bool, change: impl Fn(&mut H)) {
        for entry in self.entries().live.iter_mut().filter(|entry| entry.state == State::Held && wanted(&entry.receipt.hold)) {
            change(&mut entry.receipt.hold);
        }
    }

    /// Every held receipt, taken (now releasing) for the revocation cleanup, and every pending one asked to be released once it
    /// completes: one critical section.
    pub(crate) fn drain(&self) -> Vec<Receipt<H>> {
        let mut entries = self.entries();
        let mut taken = Vec::new();
        for entry in entries.live.iter_mut() {
            match entry.state {
                State::Pending { .. } => entry.state = State::Pending { requested: true },
                State::Held => {
                    entry.state = State::Releasing;
                    taken.push(entry.receipt.clone());
                }
                State::Releasing => {}
            }
        }
        taken
    }

    /// The cleanup let go of a drained receipt.
    pub(crate) fn drained(&self, receipt: Receipt<H>) {
        {
            let mut entries = self.entries();
            entries.live.retain(|entry| entry.receipt.id != receipt.id);
            entries.drained.push(receipt.hold);
        }
        self.changed();
    }

    pub(crate) fn holds(&self) -> Vec<H> {
        self.entries().live.iter().filter(|entry| entry.state == State::Held).map(|entry| entry.receipt.hold.clone()).collect()
    }

    /// Unconfirmed once an obligation could not be confirmed; pending while a receipt is pending, held or releasing. One
    /// observation: the failures and the entries are read in one critical section.
    pub(crate) fn cleanup(&self) -> Cleanup {
        let entries = self.entries();
        if entries.unconfirmed > 0 {
            Cleanup::Unconfirmed
        } else if !entries.live.is_empty() {
            Cleanup::Pending
        } else {
            Cleanup::Complete
        }
    }

    /// Serializes a normal release with the revocation cleanup; never held across a provider call.
    pub(crate) fn releasing(&self) -> MutexGuard<'_, ()> {
        locked(&self.releasing)
    }
}

/// A release without a receipt of the port it is offered to.
pub(crate) const NOT_OWNED: &str = "input_cleanup_unconfirmed: the release names nothing this executor holds";

#[cfg(test)]
mod tests;
