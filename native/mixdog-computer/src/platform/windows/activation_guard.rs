//! The guard around one background accessibility call against the target
//! taking the foreground: no-activate hold, shield, foreground lock or lease,
//! steal watch and one restore (Invoke-BackgroundWindow,
//! input-semantic.ps1:32-141, :233-247).
//!
//! Nothing here may panic: the release profile aborts on a panic, and an
//! abort with the system-wide foreground lock held leaves it held.

use super::activation_restore;
use super::background::{hold_inactive, is_chromium, release_inactive};
use super::foreground_lock::{self, round1, Acquired};
use super::ledger;
use super::native;
use crate::lease_api::{ForegroundLease, LeaseAnswer};
use crate::observer::{Shared, Snapshot};
use crate::platform::Wid;
use crate::protocol::Obj;
use serde_json::Value;
use std::sync::atomic::{AtomicU32, Ordering};
use windows::core::w;
use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;

/// How long a self-activating host's hold lasts, and any other's
/// (`$lockMs`, :53).
const SELF_ACTIVATING_LOCK_MS: u32 = 250;
const LOCK_MS: u32 = 100;
/// The host's answer budget (MixForegroundLockHost.AnswerTimeoutMs).
const ANSWER_TIMEOUT_MS: f64 = 250.0;
/// The steal watch lasts at least this long after the call returned, and
/// polls this often (:106-118).
const WATCH_MS: f64 = 100.0;
const POLL_MS: u32 = 10;

/// This process's asks of the host's lease, numbered (MixForegroundLock.asks).
static ASKS: AtomicU32 = AtomicU32::new(0);

/// What the guard asks of the desktop and the clock; tests answer for it.
trait GuardPlatform {
    fn foreground(&self) -> Wid;
    fn is_window(&self, window: Wid) -> bool;
    /// A window the target is, holds, owns or shares its frame with
    /// (Test-TargetWindow, :233-247).
    fn is_target_window(&self, window: Wid, target: Wid) -> bool;
    fn self_activates(&self, target: Wid) -> bool;
    fn observe(&self) -> Snapshot;
    /// Why the observation no longer licenses a restore (Test-RestoreBaseline).
    fn superseded(&self, observed: &Snapshot, target: Wid) -> Option<String>;
    fn hold(&self, target: Wid) -> Wid;
    fn unhold(&self, root: Wid) -> Result<(), String>;
    /// Disables the window; whether it was enabled before.
    fn shield(&self, target: Wid) -> bool;
    fn unshield(&self, target: Wid);
    fn lock(&self, hold_ms: u32) -> Acquired;
    fn lock_held(&self) -> bool;
    fn lock_release(&self) -> String;
    fn mark(&self, name: &str) -> f64;
    fn note(&self, name: &str, value: Value);
    fn facts(&self) -> Obj;
    fn now_ms(&self) -> f64;
    fn sleep_ms(&self, ms: u32);
    fn restore(
        &self,
        target: Wid,
        before: Wid,
        observed: &Snapshot,
        release: &mut dyn FnMut() -> String,
    ) -> String;
}

struct Live<'a> {
    shared: &'a Shared,
}

impl GuardPlatform for Live<'_> {
    fn foreground(&self) -> Wid {
        native::foreground()
    }
    fn is_window(&self, window: Wid) -> bool {
        native::is_window(window)
    }
    fn is_target_window(&self, window: Wid, target: Wid) -> bool {
        activation_restore::is_target_window(window, target)
    }
    fn self_activates(&self, target: Wid) -> bool {
        if !native::is_window(target) {
            return false;
        }
        // A WinUI 3 app keeps its own top-level class and hosts its content
        // in this island, which raises the app on invoke.
        // SAFETY: plain child lookup on a window that exists.
        let island = unsafe {
            FindWindowExW(
                Some(native::hwnd(target)),
                None,
                w!("Microsoft.UI.Content.DesktopChildSiteBridge"),
                None,
            )
        }
        .is_ok_and(|child| !child.is_invalid());
        island || self_activating_class(&native::class_name(target))
    }
    fn observe(&self) -> Snapshot {
        self.shared.read()
    }
    fn superseded(&self, observed: &Snapshot, target: Wid) -> Option<String> {
        activation_restore::superseded(self.shared, &observed.generation, observed.sequence, target)
    }
    fn hold(&self, target: Wid) -> Wid {
        hold_inactive(target)
    }
    fn unhold(&self, root: Wid) -> Result<(), String> {
        release_inactive(root)
    }
    fn shield(&self, target: Wid) -> bool {
        if !native::is_window(target) {
            return true;
        }
        // Already disabled: not ours to enable again.
        if !ledger::is_enabled(target) {
            return false;
        }
        // Durable before the window is disabled: without a record nothing
        // could enable it again after a kill, so it is not disabled.
        if !ledger::record_shield(true, target) {
            return false;
        }
        // SAFETY: plain value arguments.
        let _ = unsafe { EnableWindow(native::hwnd(target), false) };
        true
    }
    fn unshield(&self, target: Wid) {
        if native::is_window(target) {
            // SAFETY: plain value arguments.
            let _ = unsafe { EnableWindow(native::hwnd(target), true) };
        }
        ledger::record_shield(false, target);
    }
    fn lock(&self, hold_ms: u32) -> Acquired {
        foreground_lock::process().acquire(hold_ms, false)
    }
    fn lock_held(&self) -> bool {
        foreground_lock::process().held()
    }
    fn lock_release(&self) -> String {
        foreground_lock::process().release().as_str().into()
    }
    fn mark(&self, name: &str) -> f64 {
        foreground_lock::process().mark(name)
    }
    fn note(&self, name: &str, value: Value) {
        foreground_lock::process().note(name, value);
    }
    fn facts(&self) -> Obj {
        foreground_lock::process().facts()
    }
    fn now_ms(&self) -> f64 {
        foreground_lock::lease_now_ms()
    }
    fn sleep_ms(&self, ms: u32) {
        std::thread::sleep(std::time::Duration::from_millis(u64::from(ms)));
    }
    fn restore(
        &self,
        target: Wid,
        before: Wid,
        observed: &Snapshot,
        release: &mut dyn FnMut() -> String,
    ) -> String {
        activation_restore::restore(
            self.shared,
            &observed.generation,
            observed.sequence,
            target,
            before,
            release,
        )
        .as_text()
    }
}

/// SelfActivatesOnSemanticInput's class half (MixWin32Keyboard.cs:12-23).
fn self_activating_class(class: &str) -> bool {
    ["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "WinUIDesktopWin32WindowClass"]
        .iter()
        .any(|name| class.eq_ignore_ascii_case(name))
        || is_chromium(class)
}

/// Who holds the system-wide lock for one call: this process, or the desktop
/// host's lease (MixForegroundLock.holder).
enum Holder {
    None,
    Own,
    /// `lease` is 0 while the host may still take the lock after no answer
    /// arrived; `deadline_at` is on the lease clock.
    Host { action: i64, seq: u32, lease: u32, deadline_at: Option<f64> },
}

struct Hold {
    holder: Holder,
    /// How the hold ended once released; later releases return the same.
    ended: Option<String>,
}

impl Hold {
    /// The acquire half of MixForegroundLock.Acquire: the own lock first,
    /// then the host's lease when this process is refused (:90-194).
    fn acquire(
        platform: &dyn GuardPlatform,
        lease: &dyn ForegroundLease,
        request_id: i64,
        hold_ms: u32,
    ) -> (Hold, bool) {
        let none = || Hold { holder: Holder::None, ended: None };
        match platform.lock(hold_ms) {
            Acquired::Held => return (Hold { holder: Holder::Own, ended: None }, true),
            Acquired::AlreadyHeld => return (none(), false),
            Acquired::Refused => {}
        }
        if !lease.offered() {
            platform.note("host_answer", "not_offered".into());
            return (none(), false);
        }
        if request_id <= 0 {
            platform.note("host_answer", "no_request".into());
            return (none(), false);
        }
        let seq = ASKS.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        let answer_by = platform.now_ms() + ANSWER_TIMEOUT_MS;
        platform.note("seq", seq.into());
        platform.note("answer_by", round1(answer_by).into());
        let answer = lease.acquire(request_id, seq, hold_ms, answer_by);
        platform.mark("answered_at");
        platform.note("host_answer", answer.as_str().into());
        let host = |lease: u32, deadline_at: Option<f64>| Hold {
            holder: Holder::Host { action: request_id, seq, lease, deadline_at },
            ended: None,
        };
        match answer {
            // The host may take the lock after this wait; its deadline ends it,
            // and the release asks it to end it sooner.
            LeaseAnswer::NoAnswer => (host(0, None), false),
            LeaseAnswer::NotOffered | LeaseAnswer::NoRequest | LeaseAnswer::Refused(_) => {
                (none(), false)
            }
            LeaseAnswer::ExpiredOnArrival { lease, deadline_at } => {
                platform.note("lease", lease.into());
                platform.note("deadline_at", round1(deadline_at).into());
                (host(lease, Some(deadline_at)), false)
            }
            LeaseAnswer::Locked { lease, deadline_at } => {
                platform.note("lease", lease.into());
                if lease == 0 {
                    return (none(), false);
                }
                platform.note("deadline_at", round1(deadline_at).into());
                if platform.now_ms() >= deadline_at {
                    platform.note("host_answer", "expired_on_arrival".into());
                    return (host(lease, Some(deadline_at)), false);
                }
                platform.note("holder", "host".into());
                (host(lease, Some(deadline_at)), true)
            }
        }
    }

    /// Whether the lock still protects: until its deadline (Held).
    fn held(&self, platform: &dyn GuardPlatform) -> bool {
        if self.ended.is_some() {
            return false;
        }
        match self.holder {
            Holder::None => false,
            Holder::Own => platform.lock_held(),
            Holder::Host { lease, deadline_at, .. } => {
                lease > 0 && deadline_at.is_some_and(|deadline| platform.now_ms() < deadline)
            }
        }
    }

    /// Ends the hold once and says how it ended (Release).
    fn release(&mut self, platform: &dyn GuardPlatform, lease: &dyn ForegroundLease) -> String {
        if let Some(outcome) = &self.ended {
            return outcome.clone();
        }
        let outcome = match self.holder {
            Holder::None | Holder::Own => platform.lock_release(),
            Holder::Host { action, seq, lease: id, .. } => {
                platform.mark("release_requested_at");
                let outcome = lease.release(action, seq, id);
                platform.mark("released_at");
                platform.note("release", outcome.clone().into());
                if outcome == "no_ack" {
                    platform.note("release_answer", "no_answer".into());
                }
                outcome
            }
        };
        self.ended = Some(outcome.clone());
        outcome
    }
}

/// Whether the foreground is the target's own, which is a steal.
fn took_focus(platform: &dyn GuardPlatform, target: Wid) -> bool {
    platform.is_target_window(platform.foreground(), target)
}

/// Runs `op` on `target` while the person is elsewhere, and returns the
/// facts of the hold and any restore beside its result.
fn run(
    platform: &dyn GuardPlatform,
    lease: &dyn ForegroundLease,
    target: Wid,
    request_id: i64,
    op: &mut dyn FnMut() -> Result<Obj, String>,
) -> (Result<Obj, String>, Option<Value>) {
    let before = platform.foreground();
    if target == 0 || before == target {
        return (op(), None);
    }
    let observed = platform.observe();
    // A window that would activate itself is held disabled for the call: the
    // steal never happens instead of being undone.
    let shielded = platform.self_activates(target);
    // Held through the steal watch: a target that accepts the no-activate
    // style declines activation. One that refuses it is only watched.
    let inactive = platform.hold(target);
    let lock_ms = if shielded { SELF_ACTIVATING_LOCK_MS } else { LOCK_MS };
    let mut can_restore = observed.ready && before != 0 && platform.is_window(before);
    let mut restored = String::from("not_needed");
    let (mut hold, locked) = Hold::acquire(platform, lease, request_id, lock_ms);
    // The host's answer can take a moment, and the person may act in it: a
    // restore must not later undo a choice made before the action began.
    if locked && can_restore {
        let superseded = platform.superseded(&observed, target).or_else(|| {
            (platform.foreground() != before).then(|| "foreground_moved".to_string())
        });
        if let Some(reason) = superseded {
            can_restore = false;
            restored = format!("skipped:{reason}");
        }
    }
    platform.mark("dispatched_at");
    let dispatched = platform.now_ms();
    let was_enabled = shielded && platform.shield(target);
    let result = op();
    platform.mark("returned_at");
    // A XAML host honours the shield outright; a Chromium host activates
    // itself once the window is enabled again, which only the lock refuses.
    if was_enabled {
        platform.unshield(target);
    }
    // The frame raised itself 5-30 ms after the call returned on Windows 11
    // Settings, so one check right away saw nothing: every restorable target
    // is watched for a short window, and a steal gets one restore at most.
    let watching = can_restore || hold.held(platform);
    let watch_from = platform.now_ms();
    loop {
        if can_restore && took_focus(platform, target) {
            platform.mark("steal_seen_at");
            let mut release = || hold.release(platform, lease);
            restored = platform.restore(target, before, &observed, &mut release);
            break;
        }
        if !watching {
            break;
        }
        let now = platform.now_ms();
        let settled = now - dispatched >= f64::from(lock_ms);
        if settled && now - watch_from >= WATCH_MS && !hold.held(platform) {
            break;
        }
        platform.sleep_ms(POLL_MS);
    }
    // Unconditional: a second release after the restore's own only reads how
    // that one ended.
    hold.release(platform, lease);
    let released = platform.unhold(inactive);
    platform.note("restore", restored.into());
    let result = match (result, released) {
        (Ok(_), Err(error)) => Err(error),
        (result, _) => result,
    };
    (result, Some(Value::Object(platform.facts())))
}

/// One background accessibility call on `target` under the guard. The facts
/// are None when the person was already in the target.
pub fn guard(
    shared: &Shared,
    target: Wid,
    request_id: i64,
    lease: &dyn ForegroundLease,
    op: &mut dyn FnMut() -> Result<Obj, String>,
) -> (Result<Obj, String>, Option<Value>) {
    run(&Live { shared }, lease, target, request_id, op)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lease_api::NoLease;
    use crate::obj;
    use std::cell::{Cell, RefCell};

    const TARGET: Wid = 1;
    const USER: Wid = 2;
    const THIRD: Wid = 3;

    /// A desktop on a fake clock that logs every call in order.
    struct Fake {
        clock: Cell<f64>,
        foreground: Cell<Wid>,
        log: RefCell<Vec<String>>,
        self_activating: bool,
        ready: bool,
        acquired: Acquired,
        locked_until: Cell<Option<f64>>,
        superseded: Option<&'static str>,
        /// When the target takes the foreground; a held lock refuses it.
        steal_at: Cell<Option<f64>>,
        lock_stops_steal: bool,
        restore_answer: &'static str,
        enabled: bool,
        facts: RefCell<Obj>,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                clock: Cell::new(1000.0),
                foreground: Cell::new(USER),
                log: RefCell::new(Vec::new()),
                self_activating: false,
                ready: true,
                acquired: Acquired::Held,
                locked_until: Cell::new(None),
                superseded: None,
                steal_at: Cell::new(None),
                lock_stops_steal: true,
                restore_answer: "restored",
                enabled: true,
                facts: RefCell::new(Obj::new()),
            }
        }
        fn log(&self, line: &str) {
            self.log.borrow_mut().push(line.into());
        }
        fn events(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
        fn count(&self, line: &str) -> usize {
            self.log.borrow().iter().filter(|entry| entry.as_str() == line).count()
        }
        fn steal_in(&self, ms: f64) {
            self.steal_at.set(Some(self.clock.get() + ms));
        }
        /// A pending steal lands once its time came, unless the lock refuses it.
        fn tick(&self) {
            let Some(at) = self.steal_at.get() else { return };
            if self.clock.get() < at {
                return;
            }
            self.steal_at.set(None);
            if self.lock_stops_steal && self.lock_held() {
                self.log("steal_refused");
            } else {
                self.foreground.set(TARGET);
            }
        }
        fn run(
            &self,
            lease: &dyn ForegroundLease,
            op: &mut dyn FnMut() -> Result<Obj, String>,
        ) -> (Result<Obj, String>, Option<Value>) {
            run(self, lease, TARGET, 5, op)
        }
    }

    fn fact(facts: &Option<Value>, name: &str) -> Value {
        facts.as_ref().map_or(Value::Null, |facts| facts[name].clone())
    }

    impl GuardPlatform for Fake {
        fn foreground(&self) -> Wid {
            self.tick();
            self.foreground.get()
        }
        fn is_window(&self, _window: Wid) -> bool {
            true
        }
        fn is_target_window(&self, window: Wid, target: Wid) -> bool {
            window == target
        }
        fn self_activates(&self, _target: Wid) -> bool {
            self.self_activating
        }
        fn observe(&self) -> Snapshot {
            Snapshot {
                ready: self.ready,
                reason: "",
                generation: "g".into(),
                sequence: 7,
                relevant_sequence: 7,
                tick: 0,
                own_tick: 0,
            }
        }
        fn superseded(&self, _observed: &Snapshot, _target: Wid) -> Option<String> {
            self.superseded.map(str::to_string)
        }
        fn hold(&self, _target: Wid) -> Wid {
            self.log("hold");
            TARGET
        }
        fn unhold(&self, _root: Wid) -> Result<(), String> {
            self.log("unhold");
            Ok(())
        }
        fn shield(&self, _target: Wid) -> bool {
            self.log("disable");
            self.enabled
        }
        fn unshield(&self, _target: Wid) {
            self.log("enable");
        }
        fn lock(&self, hold_ms: u32) -> Acquired {
            self.log(&format!("lock {hold_ms}"));
            if self.acquired == Acquired::Held {
                self.locked_until.set(Some(self.clock.get() + f64::from(hold_ms)));
            }
            self.acquired
        }
        fn lock_held(&self) -> bool {
            self.locked_until.get().is_some_and(|until| self.clock.get() < until)
        }
        fn lock_release(&self) -> String {
            if self.locked_until.take().is_some() {
                self.log("unlock");
                "released".into()
            } else {
                "none".into()
            }
        }
        fn mark(&self, name: &str) -> f64 {
            self.log(&format!("mark {name}"));
            self.facts.borrow_mut().insert(name.into(), self.clock.get().into());
            self.clock.get()
        }
        fn note(&self, name: &str, value: Value) {
            self.facts.borrow_mut().insert(name.into(), value);
        }
        fn facts(&self) -> Obj {
            self.facts.borrow().clone()
        }
        fn now_ms(&self) -> f64 {
            self.clock.get()
        }
        fn sleep_ms(&self, ms: u32) {
            self.clock.set(self.clock.get() + f64::from(ms));
        }
        fn restore(
            &self,
            target: Wid,
            before: Wid,
            _observed: &Snapshot,
            release: &mut dyn FnMut() -> String,
        ) -> String {
            self.log("restore");
            release();
            if took_focus(self, target) && self.restore_answer == "restored" {
                self.foreground.set(before);
            }
            self.restore_answer.into()
        }
    }

    struct FakeLease {
        answer: LeaseAnswer,
        released: RefCell<Vec<(i64, u32, u32)>>,
    }

    impl FakeLease {
        fn answering(answer: LeaseAnswer) -> FakeLease {
            FakeLease { answer, released: RefCell::new(Vec::new()) }
        }
    }

    impl ForegroundLease for FakeLease {
        fn acquire(&self, _action: i64, _seq: u32, _hold_ms: u32, _answer_by: f64) -> LeaseAnswer {
            self.answer.clone()
        }
        fn release(&self, action: i64, seq: u32, lease: u32) -> String {
            self.released.borrow_mut().push((action, seq, lease));
            "released".into()
        }
        fn offered(&self) -> bool {
            true
        }
    }

    fn done() -> Result<Obj, String> {
        Ok(obj! { "text" => "done" })
    }

    #[test]
    fn a_target_that_stays_back_is_never_restored() {
        let fake = Fake::new();
        let (result, facts) = fake.run(&NoLease, &mut done);
        assert_eq!(result, done());
        assert_eq!(fact(&facts, "restore"), "not_needed");
        assert_eq!(fake.count("restore"), 0);
        assert_eq!((fake.count("hold"), fake.count("unhold"), fake.count("unlock")), (1, 1, 1));
    }

    #[test]
    fn a_person_already_in_the_target_is_not_guarded() {
        let fake = Fake::new();
        fake.foreground.set(TARGET);
        let (result, facts) = fake.run(&NoLease, &mut done);
        assert_eq!((result, facts), (done(), None));
        assert!(fake.events().is_empty());
    }

    #[test]
    fn a_lost_observer_leaves_a_steal_alone() {
        let mut fake = Fake::new();
        fake.ready = false;
        fake.lock_stops_steal = false;
        let _ = fake.run(&NoLease, &mut || {
            fake.foreground.set(TARGET);
            done()
        });
        assert_eq!(fake.count("restore"), 0);
    }

    #[test]
    fn a_window_the_person_moved_to_is_left_alone() {
        let fake = Fake::new();
        let (_, facts) = fake.run(&NoLease, &mut || {
            fake.foreground.set(THIRD);
            done()
        });
        assert_eq!(fake.count("restore"), 0);
        assert_eq!(fact(&facts, "restore"), "not_needed");
    }

    #[test]
    fn a_self_activating_target_is_disabled_once_and_enabled_once() {
        let mut fake = Fake::new();
        fake.self_activating = true;
        let (result, _) = fake.run(&NoLease, &mut || {
            fake.log("op");
            done()
        });
        assert!(result.is_ok());
        let events = fake.events();
        let position = |line: &str| events.iter().position(|entry| entry == line);
        assert_eq!((fake.count("disable"), fake.count("enable")), (1, 1));
        assert_eq!((fake.count("hold"), fake.count("unhold")), (1, 1));
        assert!(position("disable") < position("op") && position("op") < position("enable"));
        assert!(events.contains(&"lock 250".to_string()), "a self-activating host gets the longer lock");
    }

    #[test]
    fn a_window_that_was_disabled_stays_disabled() {
        let mut fake = Fake::new();
        fake.self_activating = true;
        fake.enabled = false;
        let _ = fake.run(&NoLease, &mut done);
        assert_eq!((fake.count("disable"), fake.count("enable")), (1, 0));
    }

    #[test]
    fn a_steal_after_the_call_returns_is_restored_once() {
        let mut fake = Fake::new();
        fake.lock_stops_steal = false;
        let (_, facts) = fake.run(&NoLease, &mut || {
            fake.steal_in(20.0);
            done()
        });
        assert_eq!(fake.count("restore"), 1);
        assert_eq!(fake.foreground.get(), USER);
        assert_eq!(fact(&facts, "restore"), "restored");
        assert!(fact(&facts, "steal_seen_at").is_number());
    }

    #[test]
    fn a_steal_the_lock_refuses_is_not_restored() {
        let fake = Fake::new();
        let (_, facts) = fake.run(&NoLease, &mut || {
            fake.steal_in(20.0);
            done()
        });
        assert_eq!(fake.count("steal_refused"), 1);
        assert_eq!(fake.count("restore"), 0);
        assert_eq!(fake.foreground.get(), USER);
        assert_eq!(fact(&facts, "restore"), "not_needed");
        assert_eq!(fake.count("unlock"), 1, "the lock comes off at the end");
    }

    #[test]
    fn a_refused_restore_is_tried_once() {
        let mut fake = Fake::new();
        fake.restore_answer = "refused";
        let (_, facts) = fake.run(&NoLease, &mut || {
            fake.foreground.set(TARGET);
            done()
        });
        assert_eq!(fake.count("restore"), 1);
        assert_eq!(fake.foreground.get(), TARGET);
        assert_eq!(fact(&facts, "restore"), "refused");
    }

    #[test]
    fn input_during_the_lock_wait_cancels_the_restore() {
        let mut fake = Fake::new();
        fake.superseded = Some("user_input_active");
        let (_, facts) = fake.run(&NoLease, &mut || {
            fake.foreground.set(TARGET);
            done()
        });
        assert_eq!(fake.count("restore"), 0);
        assert_eq!(fact(&facts, "restore"), "skipped:user_input_active");
    }

    #[test]
    fn a_slow_operation_does_not_extend_the_lock() {
        let fake = Fake::new();
        let (result, _) = fake.run(&NoLease, &mut || {
            fake.sleep_ms(400);
            done()
        });
        assert!(result.is_ok());
        assert!(!fake.lock_held(), "the deadline passed while the call ran");
        assert_eq!(fake.count("unlock"), 1);
        // The watch ends as soon as the 100 ms after the return are over.
        assert!(fake.clock.get() <= 1000.0 + 400.0 + WATCH_MS + f64::from(POLL_MS));
    }

    #[test]
    fn a_failed_operation_still_releases_everything() {
        let mut fake = Fake::new();
        fake.self_activating = true;
        let (result, facts) = fake.run(&NoLease, &mut || Err("provider_failed".into()));
        assert_eq!(result, Err("provider_failed".into()));
        assert_eq!((fake.count("enable"), fake.count("unlock"), fake.count("unhold")), (1, 1, 1));
        assert!(facts.is_some());
    }

    #[test]
    fn without_a_lock_or_a_host_the_facts_say_why() {
        let mut fake = Fake::new();
        fake.acquired = Acquired::Refused;
        let (_, facts) = fake.run(&NoLease, &mut done);
        assert_eq!(fact(&facts, "host_answer"), "not_offered");
        assert_eq!(fact(&facts, "holder"), Value::Null);
    }

    #[test]
    fn a_host_lease_stands_in_for_the_refused_lock_and_is_released_once() {
        let mut fake = Fake::new();
        fake.acquired = Acquired::Refused;
        let lease = FakeLease::answering(LeaseAnswer::Locked { lease: 4, deadline_at: 6000.0 });
        let (_, facts) = fake.run(&lease, &mut done);
        assert_eq!(fact(&facts, "host_answer"), "locked");
        assert_eq!(fact(&facts, "holder"), "host");
        assert_eq!(fact(&facts, "release"), "released");
        assert_eq!(lease.released.borrow().len(), 1);
        let (action, _, id) = lease.released.borrow()[0];
        assert_eq!((action, id), (5, 4));
        assert_eq!(fake.count("unlock"), 0, "the own lock was never taken");
    }

    #[test]
    fn a_refusing_host_leaves_no_hold() {
        let mut fake = Fake::new();
        fake.acquired = Acquired::Refused;
        let lease = FakeLease::answering(LeaseAnswer::Refused("refused".into()));
        let (_, facts) = fake.run(&lease, &mut done);
        assert_eq!(fact(&facts, "host_answer"), "refused");
        assert_eq!(fact(&facts, "holder"), Value::Null);
        assert!(lease.released.borrow().is_empty());
    }

    #[test]
    fn a_host_that_did_not_answer_is_still_asked_to_release() {
        let mut fake = Fake::new();
        fake.acquired = Acquired::Refused;
        let lease = FakeLease::answering(LeaseAnswer::NoAnswer);
        let (_, facts) = fake.run(&lease, &mut done);
        assert_eq!(fact(&facts, "host_answer"), "no_answer");
        assert_eq!(lease.released.borrow().len(), 1);
    }

    #[test]
    fn a_steal_past_the_lease_is_restored_after_its_release() {
        let mut fake = Fake::new();
        fake.acquired = Acquired::Refused;
        let lease = FakeLease::answering(LeaseAnswer::Locked { lease: 2, deadline_at: 9000.0 });
        let (_, facts) = fake.run(&lease, &mut || {
            fake.foreground.set(TARGET);
            done()
        });
        assert_eq!(fake.count("restore"), 1);
        assert_eq!(fact(&facts, "restore"), "restored");
        assert_eq!(lease.released.borrow().len(), 1, "the restore's release is the only one");
    }

    #[test]
    fn the_class_predicate_names_the_self_activating_hosts() {
        for class in [
            "ApplicationFrameWindow",
            "applicationframewindow",
            "Windows.UI.Core.CoreWindow",
            "WinUIDesktopWin32WindowClass",
            "Chrome_WidgetWin_1",
            "chrome_renderwidgethosthwnd",
        ] {
            assert!(self_activating_class(class), "{class}");
        }
        for class in ["Notepad", "MSPaintApp", "", "Chrome", "CabinetWClass"] {
            assert!(!self_activating_class(class), "{class}");
        }
    }
}
