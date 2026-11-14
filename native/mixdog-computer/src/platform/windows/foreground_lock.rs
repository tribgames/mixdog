//! This process's own system-wide foreground lock around one background
//! delivery, and the clock its timestamps are on (MixForegroundLock.cs:1-307).
//! While the lock is held every app's programmatic foreground change fails, so
//! every hold ends at a deadline counted from acquisition, on a thread of its
//! own, whatever the delivery does. Windows lifts the lock early on the user's
//! Alt key or click, and grants it only to a process that may set the
//! foreground; a refused helper asks the desktop host for a lease instead
//! (lease_api), which activation-guard does with the facts kept here.
//!
//! Nothing here may panic: the release profile aborts on a panic, and an abort
//! with the lock held leaves it held system-wide.

use super::native;
use crate::protocol::Obj;
use serde_json::Value;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::UI::WindowsAndMessaging::{LockSetForegroundWindow, LSFW_LOCK, LSFW_UNLOCK};

/// Unlock attempts of one release of this process's own lock, 10 ms apart
/// (MixForegroundLock.UnlockAttempts).
const UNLOCK_ATTEMPTS: u32 = 3;
const UNLOCK_RETRY_MS: u32 = 10;

/// Milliseconds on QueryPerformanceCounter, the clock the desktop host's lease
/// thread reads too, so a lease deadline and the timestamps of both sides
/// compare across the two processes (MixLeaseClock.Now).
pub fn lease_now_ms() -> f64 {
    static TICKS_PER_MS: OnceLock<f64> = OnceLock::new();
    let ticks_per_ms = *TICKS_PER_MS.get_or_init(|| {
        let mut frequency = 0i64;
        // SAFETY: the out pointer is a live local.
        let _ = unsafe { QueryPerformanceFrequency(&mut frequency) };
        frequency as f64 / 1000.0
    });
    let mut count = 0i64;
    // SAFETY: the out pointer is a live local.
    let _ = unsafe { QueryPerformanceCounter(&mut count) };
    if ticks_per_ms > 0.0 {
        count as f64 / ticks_per_ms
    } else {
        0.0
    }
}

/// A lease-clock value as the facts carry it, to 0.1 ms (MixLeaseClock.Round;
/// Math.Round rounds a midpoint to even).
pub fn round1(value: f64) -> f64 {
    (value * 10.0).round_ties_even() / 10.0
}

/// Wall-clock milliseconds, which line the lease-clock timestamps up with
/// evidence taken outside this process (the requested_epoch_ms fact).
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// An unlock that did not unlock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UnlockError {
    /// The call answered false with this error code: this process holds no
    /// lock any more, which may be Windows having lifted it on the user's Alt
    /// key or click.
    NotHeld(u32),
    /// The call itself failed, so the lock may still be held (the C# call that
    /// threw). The Win32 call cannot fail this way; the word stays because the
    /// host's lease answers with it too.
    #[allow(dead_code, reason = "only the tests' natives fail the call")]
    Failed,
}

/// The native calls and the clock; replaced only by tests, which must not
/// touch the real lock (MixForegroundLock.Native).
pub trait LockNative: Send + Sync + 'static {
    /// Takes the lock, or says why not as a Win32 error code.
    fn lock(&self) -> Result<(), u32>;
    fn unlock(&self) -> Result<(), UnlockError>;
    /// The lease clock.
    fn now_ms(&self) -> f64;
    fn foreground_pid(&self) -> u32;
    fn sleep_ms(&self, ms: u32);
}

/// The low word of the error a refused call left, as native::close reads it.
fn win32_code(error: &windows::core::Error) -> u32 {
    error.code().0 as u32 & 0xFFFF
}

/// LockSetForegroundWindow on the real desktop.
pub struct SystemLock;

impl LockNative for SystemLock {
    fn lock(&self) -> Result<(), u32> {
        // SAFETY: a plain value argument.
        unsafe { LockSetForegroundWindow(LSFW_LOCK) }.map_err(|error| win32_code(&error))
    }
    fn unlock(&self) -> Result<(), UnlockError> {
        // SAFETY: a plain value argument.
        unsafe { LockSetForegroundWindow(LSFW_UNLOCK) }
            .map_err(|error| UnlockError::NotHeld(win32_code(&error)))
    }
    fn now_ms(&self) -> f64 {
        lease_now_ms()
    }
    fn foreground_pid(&self) -> u32 {
        native::pid_of(native::foreground())
    }
    fn sleep_ms(&self, ms: u32) {
        std::thread::sleep(Duration::from_millis(u64::from(ms)));
    }
}

/// How a hold ended, in the words the facts, the host's lease answers and the
/// restore decision use (MixForegroundLock.Release).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReleaseOutcome {
    Released,
    /// The unlock answered false: no lock is held any more, though nothing
    /// proves it ended here.
    Unknown,
    /// The unlock call itself failed; the hold stays open and is retried.
    Failed,
    /// The host did not answer a release in time and may still hold its lease.
    #[allow(dead_code, reason = "the host lease answers no_ack as text; the lock's own release never does")]
    NoAck,
    /// Nothing was held.
    None,
}

impl ReleaseOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseOutcome::Released => "released",
            ReleaseOutcome::Unknown => "unknown",
            ReleaseOutcome::Failed => "failed",
            ReleaseOutcome::NoAck => "no_ack",
            ReleaseOutcome::None => "none",
        }
    }
}

/// What one acquire found.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Acquired {
    /// This process holds the lock until the deadline.
    Held,
    /// Windows refused this process the lock (the worker_error fact has the
    /// code), or its deadline thread is missing; the host's lease may be asked.
    Refused,
    /// An earlier hold of this process could not be ended and no new lock
    /// proves it gone; nothing new starts, a host lease included.
    AlreadyHeld,
}

struct State {
    /// What the last acquire found and how its hold went
    /// (MixForegroundLock.LastFacts).
    facts: Obj,
    /// This process's own hold, open until an unlock call has answered.
    open: bool,
    outcome: ReleaseOutcome,
    deadline_at: f64,
    generation: u64,
    /// The generation whose deadline the thread still has to serve.
    armed: Option<u64>,
    shutdown: bool,
}

struct Inner<N: LockNative> {
    native: N,
    state: Mutex<State>,
    wake: Condvar,
}

impl<N: LockNative> Inner<N> {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// MixForegroundLock.Stamp.
    fn stamp(&self, state: &mut State, name: &str) -> f64 {
        let now = self.native.now_ms();
        state.facts.insert(name.into(), round1(now).into());
        now
    }

    /// A deadline that fires after its own hold ended, or after a newer hold
    /// began, must not end the newer one (MixForegroundLock.Expire).
    fn expire(&self, state: &mut State, acquired: u64) {
        if acquired == state.generation && state.open {
            self.end_own(state, "deadline");
        }
    }

    /// Ends this process's own hold. A false unlock says the lock is no longer
    /// held, so the hold is over and reported unknown; only an unlock call
    /// that failed outright leaves it open, for release, the deadline and the
    /// next acquire to retry (MixForegroundLock.EndOwn).
    fn end_own(&self, state: &mut State, by: &str) {
        self.stamp(state, "unlock_requested_at");
        let mut outcome = ReleaseOutcome::Unknown;
        let mut attempts = 0u32;
        // The error code of each attempt: 0 for the one that unlocked, "threw"
        // for a call that failed outright.
        let mut errors: Vec<Value> = Vec::new();
        while attempts < UNLOCK_ATTEMPTS {
            if attempts > 0 {
                self.native.sleep_ms(UNLOCK_RETRY_MS);
            }
            attempts += 1;
            match self.native.unlock() {
                Ok(()) => {
                    outcome = ReleaseOutcome::Released;
                    errors.push(0.into());
                    break;
                }
                Err(UnlockError::NotHeld(code)) => {
                    outcome = ReleaseOutcome::Unknown;
                    errors.push(code.into());
                }
                Err(UnlockError::Failed) => {
                    outcome = ReleaseOutcome::Failed;
                    errors.push("threw".into());
                }
            }
        }
        state.outcome = outcome;
        if outcome != ReleaseOutcome::Failed {
            state.open = false;
            state.armed = None;
        }
        let ended = self.stamp(state, "ended_at");
        let late_ms = round1(ended - state.deadline_at);
        state.facts.insert("release".into(), outcome.as_str().into());
        state.facts.insert("released_by".into(), by.into());
        state.facts.insert("unlock_attempts".into(), attempts.into());
        state.facts.insert("unlock_errors".into(), errors.into());
        state.facts.insert("late_ms".into(), late_ms.into());
    }

    /// The deadline thread: one unlock try at each hold's deadline, whatever
    /// the thread that took the lock is blocked in (the C# deadline Timer).
    fn serve_deadlines(&self) {
        let mut state = self.state();
        while !state.shutdown {
            let Some(acquired) = state.armed else {
                state = self.wake.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
                continue;
            };
            let left = state.deadline_at - self.native.now_ms();
            if left > 0.0 {
                let wait = Duration::try_from_secs_f64(left.ceil() / 1000.0)
                    .unwrap_or(Duration::from_millis(u64::from(UNLOCK_RETRY_MS)));
                state = self
                    .wake
                    .wait_timeout(state, wait)
                    .map(|(state, _)| state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner().0);
                continue;
            }
            state.armed = None;
            self.expire(&mut state, acquired);
        }
    }
}

/// The lock. One per process (`process`), since the system lock belongs to
/// the process: any thread may end a hold another thread began.
pub struct ForegroundLock<N: LockNative = SystemLock> {
    inner: Arc<Inner<N>>,
    /// Whether the deadline thread runs; without it the lock is never taken.
    timed: bool,
}

/// This process's lock on the real desktop; its deadline thread starts with
/// the first call.
pub fn process() -> &'static ForegroundLock {
    static LOCK: OnceLock<ForegroundLock> = OnceLock::new();
    LOCK.get_or_init(|| ForegroundLock::new(SystemLock))
}

impl<N: LockNative> ForegroundLock<N> {
    pub fn new(native: N) -> Self {
        let mut lock = Self::untimed(native);
        let inner = Arc::clone(&lock.inner);
        lock.timed = std::thread::Builder::new()
            .name("mixdog foreground lock deadline".into())
            .spawn(move || inner.serve_deadlines())
            .is_ok();
        lock
    }

    fn untimed(native: N) -> Self {
        Self {
            inner: Arc::new(Inner {
                native,
                state: Mutex::new(State {
                    facts: Obj::new(),
                    open: false,
                    outcome: ReleaseOutcome::None,
                    deadline_at: 0.0,
                    generation: 0,
                    armed: None,
                    shutdown: false,
                }),
                wake: Condvar::new(),
            }),
            timed: false,
        }
    }

    /// Takes this process's own lock for `hold_ms` from the moment it is
    /// granted, and starts the facts of a new hold (the own-lock half of
    /// MixForegroundLock.Acquire, :90-154). `host_open` says the desktop
    /// host's lease for an earlier request is still open, which refuses the
    /// own lock before it is asked for (:113-117).
    pub fn acquire(&self, hold_ms: u32, host_open: bool) -> Acquired {
        let inner = &*self.inner;
        let mut guard = inner.state();
        let state = &mut *guard;
        // An own lock still open is retried first, its account going to the
        // facts of the request that held it.
        if state.open {
            inner.end_own(state, "retry");
        }
        let stale = state.open;
        let stale_outcome = state.outcome;
        state.facts = Obj::new();
        state.facts.insert("worker_pid".into(), std::process::id().into());
        state.facts.insert("foreground_pid".into(), inner.native.foreground_pid().into());
        state.facts.insert("hold_ms".into(), hold_ms.into());
        inner.stamp(state, "requested_at");
        state.facts.insert("requested_epoch_ms".into(), epoch_ms().into());
        state.facts.insert("holder".into(), "none".into());
        if host_open && !stale {
            state.facts.insert("worker_error".into(), "already_held".into());
            return Acquired::AlreadyHeld;
        }
        if !self.timed {
            // Nothing would end the hold if the delivery never returned.
            state.facts.insert("worker_error".into(), "no_deadline_thread".into());
            return Acquired::Refused;
        }
        let own = inner.native.lock();
        if stale {
            state.facts.insert("stale_release".into(), stale_outcome.as_str().into());
            // The unlock failed again, so this process may still hold its own
            // lock, which would refuse a host lease too. A lock granted now
            // proves the old one gone, since Windows grants none while one is
            // held.
            if own.is_err() {
                state.facts.insert("worker_error".into(), "already_held".into());
                return Acquired::AlreadyHeld;
            }
            state.facts.insert("stale_resolved".into(), "own_lock".into());
            state.armed = None;
            state.open = false;
        }
        state.outcome = ReleaseOutcome::None;
        match own {
            Ok(()) => {
                let at = inner.stamp(state, "acquired_at");
                state.open = true;
                state.deadline_at = at + f64::from(hold_ms);
                state.facts.insert("holder".into(), "worker".into());
                state.facts.insert("deadline_at".into(), round1(state.deadline_at).into());
                state.generation += 1;
                state.armed = Some(state.generation);
                inner.wake.notify_all();
                Acquired::Held
            }
            Err(code) => {
                state.facts.insert("worker_error".into(), code.into());
                Acquired::Refused
            }
        }
    }

    /// Whether the own lock still protects: until its deadline. A hold still
    /// open after it is only an unlock left to retry (MixForegroundLock.Held).
    pub fn held(&self) -> bool {
        let state = self.inner.state();
        state.open && self.inner.native.now_ms() < state.deadline_at
    }

    /// Ends the own hold once and says how it ended. The hold stays open only
    /// after an unlock call that failed, and each later call retries it;
    /// otherwise a later call returns the same (MixForegroundLock.Release).
    pub fn release(&self) -> ReleaseOutcome {
        let mut state = self.inner.state();
        if state.open {
            self.inner.end_own(&mut state, "worker");
        }
        state.outcome
    }

    /// Records when a step of the delivery happened, on the lease clock, and
    /// returns that time (MixForegroundLock.Mark).
    pub fn mark(&self, name: &str) -> f64 {
        let mut state = self.inner.state();
        self.inner.stamp(&mut state, name)
    }

    /// Adds a fact to the current hold's (MixForegroundLock.Note).
    pub fn note(&self, name: &str, value: Value) {
        self.inner.state().facts.insert(name.into(), value);
    }

    /// The facts of the last acquire and its hold, as they stand now
    /// (MixForegroundLock.LastFacts).
    pub fn facts(&self) -> Obj {
        self.inner.state().facts.clone()
    }
}

impl<N: LockNative> Drop for ForegroundLock<N> {
    /// Ends the deadline thread, which keeps the state alive otherwise.
    fn drop(&mut self) {
        let mut state = self.inner.state();
        // The lock is system-wide: a hold still open is ended before the
        // thread whose deadline would have ended it goes.
        if state.open {
            self.inner.end_own(&mut state, "worker");
        }
        state.shutdown = true;
        drop(state);
        self.inner.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};

    const WAIT: Duration = Duration::from_secs(10);

    /// LeaseFixture of foreground-lock-worker.test.mjs: no real lock, and a
    /// clock only the test and the retry sleeps move.
    struct Fake {
        clock: Mutex<f64>,
        /// 0: the unlock succeeds; 1: it answers false; 2: it fails outright.
        unlock_mode: AtomicU8,
        lock_refused: AtomicBool,
        lock_calls: AtomicU32,
        unlock_calls: AtomicU32,
        unlocked: Mutex<Sender<()>>,
    }

    impl Fake {
        fn mode(&self, mode: u8) {
            self.unlock_mode.store(mode, Ordering::SeqCst);
        }
        fn unlocks(&self) -> u32 {
            self.unlock_calls.load(Ordering::SeqCst)
        }
    }

    impl LockNative for Arc<Fake> {
        fn lock(&self) -> Result<(), u32> {
            self.lock_calls.fetch_add(1, Ordering::SeqCst);
            if self.lock_refused.load(Ordering::SeqCst) {
                Err(5)
            } else {
                Ok(())
            }
        }
        fn unlock(&self) -> Result<(), UnlockError> {
            self.unlock_calls.fetch_add(1, Ordering::SeqCst);
            let _ = self.unlocked.lock().unwrap().send(());
            match self.unlock_mode.load(Ordering::SeqCst) {
                0 => Ok(()),
                1 => Err(UnlockError::NotHeld(0)),
                _ => Err(UnlockError::Failed),
            }
        }
        fn now_ms(&self) -> f64 {
            *self.clock.lock().unwrap()
        }
        fn foreground_pid(&self) -> u32 {
            4242
        }
        fn sleep_ms(&self, ms: u32) {
            *self.clock.lock().unwrap() += f64::from(ms);
        }
    }

    fn fake(mode: u8) -> (Arc<Fake>, Receiver<()>) {
        let (unlocked, calls) = channel();
        let fake = Arc::new(Fake {
            clock: Mutex::new(1000.0),
            unlock_mode: AtomicU8::new(mode),
            lock_refused: AtomicBool::new(false),
            lock_calls: AtomicU32::new(0),
            unlock_calls: AtomicU32::new(0),
            unlocked: Mutex::new(unlocked),
        });
        (fake, calls)
    }

    fn granted(mode: u8) -> (ForegroundLock<Arc<Fake>>, Arc<Fake>, Receiver<()>) {
        let (fake, calls) = fake(mode);
        (ForegroundLock::new(Arc::clone(&fake)), fake, calls)
    }

    /// Moves the clock with the state held, so the deadline thread is either
    /// waiting (and woken) or has yet to read the clock.
    fn advance(lock: &ForegroundLock<Arc<Fake>>, fake: &Fake, ms: f64) {
        let _state = lock.inner.state();
        *fake.clock.lock().unwrap() += ms;
        lock.inner.wake.notify_all();
    }

    #[test]
    fn clock_is_monotonic_and_in_milliseconds() {
        let first = lease_now_ms();
        let second = lease_now_ms();
        assert!(first > 0.0 && second >= first);
        // Milliseconds, not ticks or seconds: two reads are well under a minute apart.
        assert!(second - first < 60_000.0);
    }

    #[test]
    fn round1_keeps_a_tenth_of_a_millisecond() {
        assert_eq!(round1(12.34), 12.3);
        assert_eq!(round1(12.36), 12.4);
        assert_eq!(round1(-0.26), -0.3);
        assert_eq!(round1(7.0), 7.0);
        // A midpoint goes to even, as Math.Round does.
        assert_eq!(round1(0.25), 0.2);
        assert_eq!(round1(0.75), 0.8);
    }

    #[test]
    fn outcome_words_match_the_lease_protocol() {
        let words: Vec<&str> = [
            ReleaseOutcome::Released,
            ReleaseOutcome::Unknown,
            ReleaseOutcome::Failed,
            ReleaseOutcome::NoAck,
            ReleaseOutcome::None,
        ]
        .into_iter()
        .map(ReleaseOutcome::as_str)
        .collect();
        assert_eq!(words, ["released", "unknown", "failed", "no_ack", "none"]);
    }

    // own0: only a successful unlock is released, at the first attempt.
    #[test]
    fn a_granted_lock_is_held_and_released_once() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.release(), ReleaseOutcome::None);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert!(lock.held());
        let facts = lock.facts();
        assert_eq!(facts["holder"], "worker");
        assert_eq!(facts["worker_pid"], std::process::id());
        assert_eq!(facts["foreground_pid"], 4242);
        assert_eq!(facts["hold_ms"], 1000);
        assert_eq!(facts["requested_at"], 1000.0);
        assert_eq!(facts["acquired_at"], 1000.0);
        assert_eq!(facts["deadline_at"], 2000.0);
        assert!(facts["requested_epoch_ms"].as_u64().unwrap() > 1_600_000_000_000);
        assert!(!facts.contains_key("worker_error"));

        advance(&lock, &fake, 40.0);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert!(!lock.held());
        let facts = lock.facts();
        assert_eq!(facts["release"], "released");
        assert_eq!(facts["released_by"], "worker");
        assert_eq!(facts["unlock_attempts"], 1);
        assert_eq!(facts["unlock_errors"], serde_json::json!([0]));
        assert_eq!(facts["unlock_requested_at"], 1040.0);
        assert_eq!(facts["ended_at"], 1040.0);
        // Ended 960 ms before the deadline.
        assert_eq!(facts["late_ms"], -960.0);
        // A second release returns the same and unlocks nothing.
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(fake.unlocks(), 1);
    }

    // own1: an unlock that answers false ends the hold, reported unknown.
    #[test]
    fn a_false_unlock_is_unknown_after_three_attempts_and_ends_the_hold() {
        let (lock, fake, _calls) = granted(1);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Unknown);
        let facts = lock.facts();
        assert_eq!(facts["release"], "unknown");
        assert_eq!(facts["unlock_attempts"], 3);
        assert_eq!(facts["unlock_errors"], serde_json::json!([0, 0, 0]));
        // Two retry sleeps of 10 ms.
        assert_eq!(facts["ended_at"], 1020.0);
        assert!(!lock.held());
        assert_eq!(lock.release(), ReleaseOutcome::Unknown);
        assert_eq!(fake.unlocks(), 3);
        // afterFalse: the hold is over, so the next request is refused its own
        // lock plainly (the host's lease may be asked), not already_held.
        fake.lock_refused.store(true, Ordering::SeqCst);
        assert_eq!(lock.acquire(100, false), Acquired::Refused);
        let facts = lock.facts();
        assert_eq!(facts["worker_error"], 5);
        assert_eq!(facts["holder"], "none");
        assert!(!facts.contains_key("stale_release"));
        assert_eq!(lock.release(), ReleaseOutcome::None);
        assert_eq!(fake.unlocks(), 3);
    }

    // own2 and retry: an unlock call that fails leaves the hold open, and each
    // later release retries it until one succeeds.
    #[test]
    fn a_failed_unlock_stays_open_and_the_next_release_retries_it() {
        let (lock, fake, _calls) = granted(2);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        let facts = lock.facts();
        assert_eq!(facts["release"], "failed");
        assert_eq!(facts["unlock_attempts"], 3);
        assert_eq!(facts["unlock_errors"], serde_json::json!(["threw", "threw", "threw"]));
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        assert_eq!(fake.unlocks(), 6);
        fake.mode(0);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(fake.unlocks(), 7);
        assert_eq!(lock.facts()["unlock_attempts"], 1);
    }

    // nextRequest: the next acquire retries the unlock first, on the facts of
    // the request that held it, before anything new starts.
    #[test]
    fn the_next_acquire_retries_a_failed_unlock_first() {
        let (lock, fake, _calls) = granted(2);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        fake.mode(0);
        let before = fake.unlocks();
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(fake.unlocks() - before, 1);
        let facts = lock.facts();
        assert_eq!(facts["holder"], "worker");
        assert!(!facts.contains_key("stale_release"));
        assert!(!facts.contains_key("release"));
        assert_eq!(lock.release(), ReleaseOutcome::Released);

        // The retry's account, seen before the new facts replace the old.
        fake.mode(2);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        fake.mode(0);
        let mut state = lock.inner.state();
        lock.inner.end_own(&mut state, "retry");
        assert_eq!(state.facts["release"], "released");
        assert_eq!(state.facts["released_by"], "retry");
        assert!(!state.open);
    }

    // A hold still open when the next request arrives is ended by that
    // request's retry, and the new hold gets a deadline of its own.
    #[test]
    fn an_acquire_over_an_open_hold_ends_it_and_starts_a_new_one() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        advance(&lock, &fake, 300.0);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(fake.unlocks(), 1);
        assert_eq!(lock.facts()["deadline_at"], 2300.0);
        assert!(lock.held());
    }

    // stillOpen: while the retry still fails and no new lock proves the old
    // one gone, nothing new starts.
    #[test]
    fn an_unproven_stale_hold_refuses_the_next_acquire() {
        let (lock, fake, _calls) = granted(2);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        fake.lock_refused.store(true, Ordering::SeqCst);
        assert_eq!(lock.acquire(1000, false), Acquired::AlreadyHeld);
        let facts = lock.facts();
        assert_eq!(facts["worker_error"], "already_held");
        assert_eq!(facts["stale_release"], "failed");
        assert_eq!(facts["holder"], "none");
        assert!(!facts.contains_key("stale_resolved"));
        // Still open: a release retries it again.
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
    }

    // An open host lease refuses the own lock before it is asked for, on the
    // new request's facts.
    #[test]
    fn an_open_host_lease_refuses_the_own_lock() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.acquire(1000, true), Acquired::AlreadyHeld);
        assert_eq!(fake.lock_calls.load(Ordering::SeqCst), 0);
        let facts = lock.facts();
        assert_eq!(facts["worker_error"], "already_held");
        assert_eq!(facts["holder"], "none");
        assert_eq!(facts["hold_ms"], 1000);
    }

    #[test]
    fn dropping_the_lock_mid_hold_unlocks_it() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.acquire(10_000, false), Acquired::Held);
        drop(lock);
        assert_eq!(fake.unlocks(), 1);
    }

    // A lock granted over a stale hold proves the old one gone.
    #[test]
    fn a_granted_lock_resolves_a_stale_hold() {
        let (lock, fake, _calls) = granted(2);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Failed);
        advance(&lock, &fake, 500.0);
        assert_eq!(lock.acquire(200, false), Acquired::Held);
        let facts = lock.facts();
        assert_eq!(facts["stale_release"], "failed");
        assert_eq!(facts["stale_resolved"], "own_lock");
        assert_eq!(facts["holder"], "worker");
        assert!(lock.held());
        fake.mode(0);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
    }

    // deadline: the hold ends at its deadline on the deadline thread, while
    // the thread that took it does nothing (a delivery blocked in its call).
    #[test]
    fn the_deadline_thread_ends_a_hold_the_caller_never_released() {
        let (lock, fake, calls) = granted(0);
        assert_eq!(lock.acquire(50, false), Acquired::Held);
        advance(&lock, &fake, 49.0);
        assert!(lock.held());
        assert_eq!(fake.unlocks(), 0);
        advance(&lock, &fake, 3.0);
        calls.recv_timeout(WAIT).expect("the deadline thread unlocks");
        // facts() waits for the deadline thread to finish its account.
        let facts = lock.facts();
        assert_eq!(facts["release"], "released");
        assert_eq!(facts["released_by"], "deadline");
        assert_eq!(facts["late_ms"], 2.0);
        assert!(!lock.held());
        // The caller's own release afterwards returns the same, unlocking nothing.
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(lock.facts()["released_by"], "deadline");
        assert_eq!(fake.unlocks(), 1);
    }

    // Protection lasts to the deadline: a hold whose deadline unlock failed is
    // open but no longer held, and the deadline tries only once.
    #[test]
    fn held_is_false_at_the_deadline_with_an_unlock_still_to_retry() {
        let (lock, fake, calls) = granted(2);
        assert_eq!(lock.acquire(50, false), Acquired::Held);
        advance(&lock, &fake, 50.0);
        for _ in 0..UNLOCK_ATTEMPTS {
            calls.recv_timeout(WAIT).expect("the deadline thread tries the unlock");
        }
        let facts = lock.facts();
        assert_eq!(facts["release"], "failed");
        assert_eq!(facts["released_by"], "deadline");
        assert!(!lock.held());
        assert!(lock.inner.state().open);
        assert_eq!(lock.inner.state().armed, None);
        fake.mode(0);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(lock.facts()["released_by"], "worker");
        assert_eq!(fake.unlocks(), UNLOCK_ATTEMPTS + 1);
    }

    // A stale timer leaves a newer hold.
    #[test]
    fn a_stale_deadline_does_not_end_a_newer_hold() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        let first = lock.inner.state().generation;
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        assert_eq!(lock.acquire(1000, false), Acquired::Held);
        {
            let mut state = lock.inner.state();
            assert_ne!(first, state.generation);
            lock.inner.expire(&mut state, first);
            assert!(state.open);
        }
        assert!(lock.held());
        assert_eq!(fake.unlocks(), 1);
        assert!(!lock.facts().contains_key("released_by"));
        // The hold's own generation does end it.
        {
            let mut state = lock.inner.state();
            let current = state.generation;
            lock.inner.expire(&mut state, current);
            assert!(!state.open);
            // A deadline after its own hold ended does nothing more.
            lock.inner.expire(&mut state, current);
        }
        assert_eq!(fake.unlocks(), 2);
        assert_eq!(lock.facts()["released_by"], "deadline");
    }

    // A released hold disarms its deadline: passing it later unlocks nothing.
    #[test]
    fn a_released_hold_has_no_deadline_left() {
        let (lock, fake, calls) = granted(0);
        assert_eq!(lock.acquire(50, false), Acquired::Held);
        assert_eq!(lock.release(), ReleaseOutcome::Released);
        calls.recv_timeout(WAIT).expect("the release unlocked");
        assert_eq!(lock.inner.state().armed, None);
        advance(&lock, &fake, 500.0);
        assert!(calls.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(lock.facts()["released_by"], "worker");
    }

    // Without its deadline thread the lock is never taken.
    #[test]
    fn no_deadline_thread_means_no_lock() {
        let (fake, _calls) = fake(0);
        let lock = ForegroundLock::untimed(Arc::clone(&fake));
        assert_eq!(lock.acquire(100, false), Acquired::Refused);
        assert_eq!(fake.lock_calls.load(Ordering::SeqCst), 0);
        assert_eq!(lock.facts()["worker_error"], "no_deadline_thread");
        assert!(!lock.held());
        assert_eq!(lock.release(), ReleaseOutcome::None);
    }

    #[test]
    fn marks_and_notes_join_the_holds_facts() {
        let (lock, fake, _calls) = granted(0);
        assert_eq!(lock.acquire(100, false), Acquired::Held);
        advance(&lock, &fake, 12.25);
        assert_eq!(lock.mark("dispatched_at"), 1012.25);
        lock.note("host_answer", "not_offered".into());
        let facts = lock.facts();
        assert_eq!(facts["dispatched_at"], 1012.2);
        assert_eq!(facts["host_answer"], "not_offered");
        // A new acquire starts new facts.
        assert_eq!(lock.acquire(100, false), Acquired::Held);
        assert!(!lock.facts().contains_key("dispatched_at"));
    }
}
