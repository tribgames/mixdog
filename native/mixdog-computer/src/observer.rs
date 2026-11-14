//! Who is using the mouse and keyboard. A platform source records every input
//! event as this process's own or someone else's; the ledger counts the
//! foreign ones, and an action refuses to continue once input that could
//! reach it moves that count.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Instant;

fn epoch() -> &'static Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now)
}

/// Milliseconds on this process's monotonic clock; never zero.
pub fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64 + 1
}

/// Why the observation is not ready; only these names leave the observer
/// (ReasonName, InputObservation.cs).
pub const HOOKS_UNAVAILABLE: &str = "hooks_unavailable";
pub const INPUT_GAP: &str = "input_gap";
pub const MONITOR_UNRESPONSIVE: &str = "monitor_unresponsive";

/// MixInputLedger (InputObservation.cs): counts foreign input, remembers whom
/// each foreign event could reach, and latches a gap when the system's
/// last-input clock moved without an accounted event. Ticks are that clock's
/// values; they are only ever compared for equality.
#[derive(Default)]
pub struct InputLedger {
    foreign_sequence: i64,
    latest_tick: u32,
    latest_own: bool,
    /// An unaccounted change of the system's last-input clock. It counted once
    /// as foreign input and stays open until a confirmed quiet resync.
    gap: bool,
    quiet_count: u32,
    quiet_tick: u32,
    quiet_start: u64,
    quiet_confirmed: bool,
    /// The sequence of the last foreign event per process it went to, of the
    /// last foreign pointer event, and of the last one nobody can attribute.
    last_by_process: HashMap<u32, i64>,
    last_pointer: i64,
    last_unattributed: i64,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl InputLedger {
    pub const QUIET_OBSERVATIONS: u32 = 3;
    pub const QUIET_MS: u64 = 300;

    pub fn latest_tick(&self) -> u32 {
        self.latest_tick
    }
    pub fn gap(&self) -> bool {
        self.gap
    }

    /// Record: `processes` are the processes a foreign event went to; zeros
    /// are unknown, and an event with none known reaches every target.
    pub fn record(&mut self, own: bool, tick: u32, pointer: bool, processes: &[u32]) {
        self.latest_tick = tick;
        self.latest_own = own;
        if !own {
            self.foreign_sequence += 1;
            if pointer {
                self.last_pointer = self.foreign_sequence;
            }
            let mut attributed = false;
            for process in processes.iter().filter(|process| **process != 0) {
                self.last_by_process.insert(*process, self.foreign_sequence);
                attributed = true;
            }
            if !attributed {
                self.last_unattributed = self.foreign_sequence;
            }
        }
        self.reset_quiet();
    }

    /// LastRelevant: the last foreign sequence that could reach an action on
    /// `process`. Process 0 is an unknown target, which every foreign event
    /// reaches; an action driving the one shared pointer is reached by any
    /// pointer event.
    pub fn last_relevant(&self, process: u32, pointer: bool) -> i64 {
        if process == 0 {
            return self.foreign_sequence;
        }
        let mut last = self.last_unattributed;
        if pointer {
            last = last.max(self.last_pointer);
        }
        last.max(self.last_by_process.get(&process).copied().unwrap_or(0))
    }

    /// RecordNeutral: input nobody typed (a reserved key Windows injects
    /// during activation) moves the system clock without being anyone's.
    pub fn record_neutral(&mut self, tick: u32) {
        self.latest_tick = tick;
        self.reset_quiet();
    }

    /// Observe: compares the system's last-input clock with the last accounted
    /// event; false while a gap is open.
    pub fn observe(&mut self, system_tick: u32) -> bool {
        if !self.gap && system_tick != self.latest_tick {
            self.latch();
        }
        !self.gap
    }

    /// Latch: counts an unaccounted discontinuity as foreign input, once per gap.
    pub fn latch(&mut self) {
        if !self.gap {
            self.gap = true;
            self.foreign_sequence += 1;
            self.last_unattributed = self.foreign_sequence;
        }
        self.reset_quiet();
    }

    fn reset_quiet(&mut self) {
        self.quiet_count = 0;
        self.quiet_confirmed = false;
    }

    /// ObserveQuiet: one recovery observation on a monotonic elapsed clock.
    /// True once the desktop was accessible, nothing was held and the system
    /// clock stood still for enough observations spanning enough time.
    pub fn observe_quiet(
        &mut self,
        desktop_ready: bool,
        held: bool,
        system_tick: u32,
        elapsed_ms: u64,
    ) -> bool {
        if !self.gap {
            return false;
        }
        if !desktop_ready || held {
            self.reset_quiet();
            return false;
        }
        if self.quiet_count == 0 || system_tick != self.quiet_tick {
            self.reset_quiet();
            self.quiet_tick = system_tick;
            self.quiet_start = elapsed_ms;
            self.quiet_count = 1;
            return false;
        }
        self.quiet_count += 1;
        self.quiet_confirmed = self.quiet_count >= Self::QUIET_OBSERVATIONS
            && elapsed_ms.saturating_sub(self.quiet_start) >= Self::QUIET_MS;
        self.quiet_confirmed
    }

    /// Resynchronize: closes a gap only after confirmed quiet, with the
    /// desktop, held state and clock rechecked. The sequence is never lowered.
    pub fn resynchronize(&mut self, desktop_ready: bool, held: bool, system_tick: u32) -> bool {
        if !self.gap {
            return true;
        }
        if !self.quiet_confirmed || !desktop_ready || held || system_tick != self.quiet_tick {
            self.reset_quiet();
            return false;
        }
        self.latest_tick = system_tick;
        self.gap = false;
        self.reset_quiet();
        true
    }
}

/// The ledger plus when its events happened on this process's clock.
#[derive(Default)]
struct State {
    ledger: InputLedger,
    latest_at: u64,
    last_own_at: u64,
}

/// What a source with a thread and a system clock of its own adds to a read
/// (ReadMonitor): events the system already delivered are accounted for
/// before the ledger is judged.
pub trait Monitor: Send + Sync {
    /// Has the source's thread account for delivered input; false when it
    /// did not answer in time.
    fn drain(&self) -> bool;
    /// The system's last-input clock; None when it cannot be read.
    fn input_tick(&self) -> Option<u32>;
}

pub struct Shared {
    state: Mutex<State>,
    ready: AtomicBool,
    /// Injected input this process sends is its own until this instant; a
    /// source that cannot tag events tells them apart by time.
    own_until: AtomicU64,
    generation: String,
    monitor: OnceLock<Box<dyn Monitor>>,
    /// One drained read at a time.
    reads: Mutex<()>,
}

impl Shared {
    fn new() -> Shared {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Shared {
            state: Mutex::default(),
            ready: AtomicBool::new(false),
            own_until: AtomicU64::new(0),
            generation: format!("{:016x}{:08x}", seed as u64, std::process::id()),
            monitor: OnceLock::new(),
            reads: Mutex::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One input event: whose it was, when on the system's input clock,
    /// whether the pointer made it, and the processes it went to.
    pub fn record_event(&self, own: bool, tick: u32, pointer: bool, processes: &[u32]) {
        let at = now_ms();
        let mut state = self.state();
        state.latest_at = at;
        if own {
            state.last_own_at = at;
        }
        state.ledger.record(own, tick, pointer, processes);
    }
    /// An event from a source that knows neither a system clock nor a target.
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    pub fn record(&self, own: bool) {
        self.record_event(own, 0, false, &[]);
    }
    /// For sources that only see when input happened: input inside the
    /// window this process marked as its own is attributed to it.
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
    pub fn record_untagged(&self, at_ms: u64) {
        let own = at_ms <= self.own_until.load(Ordering::SeqCst);
        self.record(own);
    }
    /// The source's own thread working on the ledger: its gap and quiet steps.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn with_ledger<T>(&self, work: impl FnOnce(&mut InputLedger) -> T) -> T {
        work(&mut self.state().ledger)
    }
    /// Reads go through `monitor` from now on.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn set_monitor(&self, monitor: Box<dyn Monitor>) {
        let _ = self.monitor.set(monitor);
    }
    /// Whether the source can see input at all (its hooks are installed).
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }
    pub fn mark_own_input(&self, grace_ms: u64) {
        let until = now_ms() + grace_ms;
        self.own_until.fetch_max(until, Ordering::SeqCst);
        self.state().last_own_at = now_ms();
    }

    /// Read: every foreign event counts.
    pub fn read(&self) -> Snapshot {
        self.read_for(0, false)
    }

    /// Read scoped to a target: `relevant_sequence` counts only input that
    /// could reach `process`, plus any pointer input when `pointer`.
    pub fn read_for(&self, process: u32, pointer: bool) -> Snapshot {
        let Some(monitor) = self.monitor.get() else {
            return self.snapshot(&self.state(), process, pointer, "");
        };
        let _reads = self
            .reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for attempt in 1.. {
            if !monitor.drain() {
                break;
            }
            let tick = monitor.input_tick();
            let state = self.state();
            let current = tick == Some(state.ledger.latest_tick);
            // Input after the drain is judged by the source itself on the
            // next one, which latches it as a gap if its hooks missed it.
            if !current && attempt < 3 {
                continue;
            }
            // A clock still moving after the last drain is a gap, whatever
            // else the source says (ReadMonitor: current ? reason : ReasonGap).
            let reason = if !current {
                INPUT_GAP
            } else if !self.ready.load(Ordering::SeqCst) {
                HOOKS_UNAVAILABLE
            } else if state.ledger.gap {
                INPUT_GAP
            } else {
                ""
            };
            return self.snapshot(&state, process, pointer, reason);
        }
        self.snapshot(&self.state(), process, pointer, MONITOR_UNRESPONSIVE)
    }

    fn snapshot(&self, state: &State, process: u32, pointer: bool, reason: &'static str) -> Snapshot {
        Snapshot {
            ready: reason.is_empty() && self.ready.load(Ordering::SeqCst),
            reason,
            generation: self.generation.clone(),
            sequence: state.ledger.foreign_sequence,
            relevant_sequence: state.ledger.last_relevant(process, pointer),
            tick: state.latest_at,
            own_tick: state.last_own_at,
        }
    }

    /// Milliseconds since input that was not this process's own.
    pub fn foreign_idle_ms(&self) -> u64 {
        let state = self.state();
        if state.ledger.foreign_sequence == 0 {
            return u32::MAX as u64;
        }
        if state.ledger.latest_own {
            // The newest event was ours; the foreign one is at least that old.
            return now_ms().saturating_sub(state.last_own_at);
        }
        now_ms().saturating_sub(state.latest_at)
    }
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub ready: bool,
    /// Why not, when the source can say: one of the reason names above.
    pub reason: &'static str,
    pub generation: String,
    pub sequence: i64,
    /// The last foreign sequence that could reach the target the read was
    /// scoped to; equal to `sequence` for an unscoped read.
    pub relevant_sequence: i64,
    pub tick: u64,
    pub own_tick: u64,
}

/// " (<reason>)" for an error text, when the source named one.
fn cause(reason: &str) -> String {
    if reason.is_empty() {
        String::new()
    } else {
        format!(" ({reason})")
    }
}

pub struct Observer {
    pub shared: Arc<Shared>,
}

impl Observer {
    pub fn new() -> Observer {
        Observer {
            shared: Arc::new(Shared::new()),
        }
    }
}

impl std::ops::Deref for Observer {
    type Target = Shared;
    fn deref(&self) -> &Shared {
        &self.shared
    }
}

/// One action's claim on the observation: begun at a sequence, it may
/// continue only while no input since could have reached it (the action
/// scope of MixInputObservation: Begin, BeginExpected, AssertContinue, End).
#[derive(Default)]
pub struct Scope {
    sequence: Option<i64>,
    /// The process the action targets; 0 is unknown, so any input counts.
    process: u32,
    /// Whether the action drives the one shared pointer.
    pointer: bool,
    depth: u32,
}

impl Scope {
    /// Begin with an unknown target: any foreign input interrupts.
    pub fn begin(&mut self, shared: &Shared) -> Result<(), String> {
        self.begin_for(shared, 0, false)
    }

    /// Begin(target, pointer): the action is interrupted only by input into
    /// `process`, and by any pointer input while it drives the pointer.
    pub fn begin_for(
        &mut self,
        shared: &Shared,
        process: u32,
        pointer: bool,
    ) -> Result<(), String> {
        if self.depth > 0 {
            self.assert_continue(shared)?;
            self.depth += 1;
            return Ok(());
        }
        let value = shared.read_for(process, false);
        if !value.ready {
            return Err(format!(
                "input_observation_unavailable: input origin cannot be observed{}",
                cause(value.reason)
            ));
        }
        self.claim(value.sequence, process, pointer);
        Ok(())
    }

    /// BeginExpected(generation, sequence, target, pointer): input since the
    /// observation counts only when it went to `process`; the pointer joins
    /// the scope once the action itself drives it.
    pub fn begin_expected_for(
        &mut self,
        shared: &Shared,
        generation: &str,
        sequence: i64,
        process: u32,
        pointer: bool,
    ) -> Result<(), String> {
        self.begin_observed(shared, generation, sequence, process, pointer, false)
    }

    /// BeginExpected with an unknown target.
    pub fn begin_expected(
        &mut self,
        shared: &Shared,
        generation: &str,
        sequence: i64,
    ) -> Result<(), String> {
        self.begin_expected_for(shared, generation, sequence, 0, false)
    }

    /// BeginRestore: putting the person's window back after `process` took
    /// the foreground. Pointer input counts from the observation on: a click
    /// anywhere since may be the person choosing a window. Keys count when
    /// they reached `process`.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn begin_restore(
        &mut self,
        shared: &Shared,
        generation: &str,
        sequence: i64,
        process: u32,
    ) -> Result<(), String> {
        self.begin_observed(shared, generation, sequence, process, true, true)
    }

    fn begin_observed(
        &mut self,
        shared: &Shared,
        generation: &str,
        sequence: i64,
        process: u32,
        pointer: bool,
        pointer_since_observation: bool,
    ) -> Result<(), String> {
        let value = shared.read_for(process, pointer_since_observation);
        // Another generation's observer is not this process's to read.
        if !value.ready || value.generation != generation {
            let reason = if value.ready {
                MONITOR_UNRESPONSIVE
            } else {
                value.reason
            };
            return Err(format!(
                "input_observation_unavailable: original observation is unavailable{}",
                cause(reason)
            ));
        }
        if sequence > value.sequence || value.relevant_sequence > sequence {
            return Err("user_input_active: observation was superseded by external input".into());
        }
        self.claim(value.sequence, process, pointer);
        if let Err(error) = self.assert_continue(shared) {
            self.end();
            return Err(error);
        }
        Ok(())
    }

    fn claim(&mut self, sequence: i64, process: u32, pointer: bool) {
        self.sequence = Some(sequence);
        self.process = process;
        self.pointer = pointer;
        self.depth = 1;
    }

    /// AssertContinue.
    pub fn assert_continue(&self, shared: &Shared) -> Result<(), String> {
        let value = shared.read_for(self.process, self.pointer);
        if !value.ready {
            return Err(format!(
                "input_observation_unavailable: input observation lost{}",
                cause(value.reason)
            ));
        }
        if let Some(sequence) = self.sequence {
            if value.sequence < sequence || value.relevant_sequence > sequence {
                return Err("user_input_active: external input interrupted this action".into());
            }
        }
        Ok(())
    }

    pub fn end(&mut self) {
        self.depth = self.depth.saturating_sub(1);
        if self.depth == 0 {
            *self = Scope::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    fn ready() -> Observer {
        let observer = Observer::new();
        observer.set_ready(true);
        observer
    }

    #[test]
    fn foreign_input_breaks_a_scope() {
        let observer = ready();
        let mut scope = Scope::default();
        scope.begin(&observer).unwrap();
        observer.record(true);
        scope.assert_continue(&observer).unwrap();
        observer.record(false);
        assert!(scope
            .assert_continue(&observer)
            .unwrap_err()
            .starts_with("user_input_active"));
        scope.end();
        observer.record(false);
        scope.assert_continue(&observer).unwrap();
    }

    #[test]
    fn unready_observer_refuses_input() {
        let observer = Observer::new();
        let mut scope = Scope::default();
        assert_eq!(
            scope.begin(&observer).unwrap_err(),
            "input_observation_unavailable: input origin cannot be observed"
        );
    }

    #[test]
    fn untagged_events_inside_own_window_are_own() {
        let observer = ready();
        observer.mark_own_input(10_000);
        observer.record_untagged(now_ms());
        assert_eq!(observer.read().sequence, 0);
    }

    // The ledger vectors of backend/input-observation.test.mjs.
    #[test]
    fn ledger_keeps_origin_and_counts_a_gap_once() {
        let mut ledger = InputLedger::default();
        ledger.record_neutral(1000);
        ledger.record(true, 1001, false, &[]);
        ledger.record(false, 1001, false, &[]);
        ledger.record(true, 1002, false, &[]);
        assert_eq!(ledger.foreign_sequence, 1, "intervention lost under a later own input");
        assert!(ledger.latest_own);
        ledger.record(true, u32::MAX, false, &[]);
        ledger.record(true, 0, false, &[]);
        assert_eq!((ledger.foreign_sequence, ledger.latest_tick), (1, 0));
        ledger.record(false, 0, false, &[]);
        assert_eq!(ledger.foreign_sequence, 2, "same-tick external event was missed");
        ledger.record_neutral(5);
        assert_eq!((ledger.foreign_sequence, ledger.latest_tick), (2, 5));
        assert!(ledger.observe(5) && !ledger.gap, "an accounted clock opened a gap");
        assert!(!ledger.observe(4), "an earlier unaccounted tick was accepted");
        assert!(ledger.gap && ledger.foreign_sequence == 3);
        assert!(!ledger.observe(9) && ledger.foreign_sequence == 3, "one gap counted twice");
        ledger.record(true, 9, false, &[]);
        assert!(!ledger.observe(9) && ledger.gap, "own input closed the gap");
        assert_eq!(ledger.foreign_sequence, 3);
        ledger.record(false, 9, false, &[]);
        assert_eq!(ledger.foreign_sequence, 4, "foreign event during a gap was missed");
    }

    #[test]
    fn ledger_closes_a_gap_only_after_confirmed_quiet() {
        let mut ledger = InputLedger::default();
        ledger.record_neutral(9);
        assert!(!ledger.observe_quiet(true, false, 9, 0), "quiet without a gap");
        ledger.latch();
        assert!(!ledger.observe_quiet(true, false, 9, 0), "one observation confirmed quiet");
        assert!(!ledger.observe_quiet(true, false, 9, 50), "two observations confirmed quiet");
        assert!(!ledger.observe_quiet(true, false, 9, 100), "quiet before the elapsed window");
        assert!(!ledger.resynchronize(true, false, 9) && ledger.gap);
        for (desktop, held) in [(false, false), (true, true)] {
            ledger.observe_quiet(true, false, 9, 1000);
            ledger.observe_quiet(true, false, 9, 1100);
            assert!(!ledger.observe_quiet(desktop, held, 9, 1400));
        }
        ledger.observe_quiet(true, false, 9, 2000);
        ledger.observe_quiet(true, false, 9, 2100);
        ledger.record(true, 10, false, &[]);
        assert!(!ledger.observe_quiet(true, false, 10, 2400), "quiet survived an input event");
        ledger.observe_quiet(true, false, 10, 2500);
        assert!(!ledger.observe_quiet(true, false, 11, 2900), "quiet survived a clock change");
        ledger.observe_quiet(true, false, 11, 3000);
        assert!(ledger.observe_quiet(true, false, 11, 3300), "confirmed quiet not recognized");
        assert!(!ledger.resynchronize(true, false, 12) && ledger.gap, "resynced across a clock change");
        for elapsed in [4000, 4100, 4400] {
            ledger.observe_quiet(true, false, 11, elapsed);
        }
        assert!(!ledger.resynchronize(true, true, 11) && ledger.gap, "resynced with input held");
        for elapsed in [5000, 5100, 5400] {
            ledger.observe_quiet(true, false, 11, elapsed);
        }
        let sequence = ledger.foreign_sequence;
        assert!(ledger.resynchronize(true, false, 11) && !ledger.gap);
        assert_eq!((ledger.foreign_sequence, ledger.latest_tick), (sequence, 11));
        assert!(ledger.observe(11));
        // Equality only: a wrapped tick is just another unequal tick.
        assert!(!ledger.observe(u32::MAX));
        assert_eq!(ledger.foreign_sequence, sequence + 1);
    }

    #[test]
    fn ledger_scopes_input_to_the_process_it_reached() {
        let mut ledger = InputLedger::default();
        ledger.record(false, 2, false, &[77]);
        assert_eq!(ledger.last_relevant(55, false), 0, "typing elsewhere reached the target");
        assert_eq!(ledger.last_relevant(55, true), 0);
        assert_eq!(ledger.last_relevant(77, false), 1);
        assert_eq!(ledger.last_relevant(0, false), 1, "an unknown target is reached by all");
        ledger.record(false, 3, true, &[77, 77, 0]);
        assert_eq!(ledger.last_relevant(55, false), 0, "pointer input reached a keyboard action");
        assert_eq!(ledger.last_relevant(55, true), 2, "pointer input missed a pointer action");
        ledger.record(false, 4, true, &[66, 55, 0]);
        assert_eq!(ledger.last_relevant(55, false), 3, "a click through a child window was missed");
        ledger.record(true, 5, true, &[55]);
        assert_eq!((ledger.foreign_sequence, ledger.last_relevant(55, true)), (3, 3));
        ledger.record(false, 5, false, &[]);
        assert_eq!(ledger.last_relevant(77, false), 4, "unattributed input reaches every target");
        ledger.latch();
        assert_eq!((ledger.foreign_sequence, ledger.last_relevant(55, false)), (5, 5));
    }

    #[test]
    fn pointer_input_does_not_break_a_focus_only_scope() {
        let observer = ready();
        let mut scope = Scope::default();
        // Activating a window of process 55 drives no pointer.
        scope.begin_for(&observer, 55, false).unwrap();
        observer.record_event(false, 1, true, &[77]);
        observer.record_event(false, 2, false, &[77]);
        scope.assert_continue(&observer).unwrap();
        observer.record_event(false, 3, false, &[55]);
        assert!(scope
            .assert_continue(&observer)
            .unwrap_err()
            .starts_with("user_input_active"));
        scope.end();
        // Foreground input into the same window drives the shared pointer.
        scope.begin_for(&observer, 55, true).unwrap();
        observer.record_event(false, 4, false, &[77]);
        scope.assert_continue(&observer).unwrap();
        observer.record_event(false, 5, true, &[77]);
        assert!(scope
            .assert_continue(&observer)
            .unwrap_err()
            .starts_with("user_input_active"));
    }

    #[test]
    fn an_observed_scope_counts_only_input_that_reached_its_target() {
        let observer = ready();
        let observed = observer.read();
        observer.record_event(false, 1, true, &[77]);
        let mut scope = Scope::default();
        // The pointer joins once the action drives it, not since the observation.
        scope
            .begin_expected_for(&observer, &observed.generation, observed.sequence, 55, true)
            .unwrap();
        scope.end();
        observer.record_event(false, 2, false, &[55]);
        assert_eq!(
            scope
                .begin_expected_for(&observer, &observed.generation, observed.sequence, 55, true)
                .unwrap_err(),
            "user_input_active: observation was superseded by external input"
        );
        assert_eq!(
            scope.begin_expected(&observer, "other", 0).unwrap_err(),
            "input_observation_unavailable: original observation is unavailable (monitor_unresponsive)"
        );
        // A sequence this observer never reached is not its observation.
        assert!(scope
            .begin_expected(&observer, &observed.generation, 99)
            .unwrap_err()
            .starts_with("user_input_active"));
    }

    #[test]
    fn a_restore_ignores_keys_typed_into_the_persons_own_window() {
        let observer = ready();
        let observed = observer.read();
        let mut scope = Scope::default();
        // The person keeps typing into their own window (process 77).
        observer.record_event(false, 1, false, &[77]);
        assert_eq!(observer.read_for(55, true).relevant_sequence, observed.sequence);
        scope
            .begin_restore(&observer, &observed.generation, observed.sequence, 55)
            .unwrap();
        scope.end();
        // Keys that reached the target (process 55) are the person using it.
        observer.record_event(false, 2, false, &[55]);
        assert_eq!(observer.read_for(55, true).relevant_sequence, 2);
        assert!(scope
            .begin_restore(&observer, &observed.generation, observed.sequence, 55)
            .unwrap_err()
            .starts_with("user_input_active"));
        // A click anywhere since the observation may be the person choosing a window.
        let observed = observer.read();
        observer.record_event(false, 3, true, &[77]);
        assert_eq!(observer.read_for(55, true).relevant_sequence, 3);
        assert!(scope
            .begin_restore(&observer, &observed.generation, observed.sequence, 55)
            .unwrap_err()
            .starts_with("user_input_active"));
    }

    /// A source whose thread answers or not, with a settable system clock.
    struct FakeMonitor {
        answers: Arc<AtomicBool>,
        tick: Arc<AtomicU32>,
    }

    impl Monitor for FakeMonitor {
        fn drain(&self) -> bool {
            self.answers.load(Ordering::SeqCst)
        }
        fn input_tick(&self) -> Option<u32> {
            Some(self.tick.load(Ordering::SeqCst))
        }
    }

    #[test]
    fn a_monitored_read_names_why_it_is_not_ready() {
        let observer = Observer::new();
        let answers = Arc::new(AtomicBool::new(true));
        let tick = Arc::new(AtomicU32::new(7));
        observer.set_monitor(Box::new(FakeMonitor {
            answers: answers.clone(),
            tick: tick.clone(),
        }));
        observer.with_ledger(|ledger| ledger.record_neutral(7));
        let mut scope = Scope::default();
        assert_eq!(observer.read().reason, HOOKS_UNAVAILABLE);
        assert_eq!(
            scope.begin(&observer).unwrap_err(),
            "input_observation_unavailable: input origin cannot be observed (hooks_unavailable)"
        );
        observer.set_ready(true);
        let value = observer.read();
        assert!(value.ready && value.reason.is_empty());
        scope.begin(&observer).unwrap();
        // The system clock moved and no hook accounted for it.
        tick.store(8, Ordering::SeqCst);
        let value = observer.read();
        assert!(!value.ready);
        assert_eq!(value.reason, INPUT_GAP);
        assert_eq!(
            scope.assert_continue(&observer).unwrap_err(),
            "input_observation_unavailable: input observation lost (input_gap)"
        );
        // The source latched it: one foreign event that reaches every target.
        observer.with_ledger(|ledger| ledger.observe(8));
        let value = observer.read_for(55, false);
        assert_eq!(
            (value.reason, value.sequence, value.relevant_sequence),
            (INPUT_GAP, 1, 1)
        );
        answers.store(false, Ordering::SeqCst);
        assert_eq!(observer.read().reason, MONITOR_UNRESPONSIVE);
    }
}
