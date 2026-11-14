//! Keeping a background target inactive while input reaches it, and giving
//! the person their window back when the target raised itself anyway
//! (MixWin32Keyboard.cs:76-274).

use super::super::ledger::{self, WS_EX_NOACTIVATE};
use super::super::native;
use super::WinBackground;
use crate::platform::Wid;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const SETTLE_MS: u64 = 50;
const RESTORE_GAP_MS: u64 = 12;

/// Whether a hold in the current request went unledgered or was refused
/// (ActivationUnprotected, :50); the host reads and clears it per request.
static UNPROTECTED: AtomicBool = AtomicBool::new(false);

/// What a hold reads and writes of a window; tests answer for it.
trait Styles {
    fn foreground(&self) -> Wid;
    fn is_window(&self, root: Wid) -> bool;
    fn ex_style(&self, root: Wid) -> i32;
    fn set_ex_style(&self, root: Wid, style: i32);
    /// Records the bit going on or off in the ledger; false when it cannot be.
    fn record(&self, added: bool, root: Wid) -> bool;
}

struct Live;

impl Styles for Live {
    fn foreground(&self) -> Wid {
        native::foreground()
    }
    fn is_window(&self, root: Wid) -> bool {
        native::is_window(root)
    }
    fn ex_style(&self, root: Wid) -> i32 {
        ledger::ex_style(root)
    }
    fn set_ex_style(&self, root: Wid, style: i32) {
        ledger::set_ex_style(root, style);
    }
    fn record(&self, added: bool, root: Wid) -> bool {
        ledger::record(added, root)
    }
}

/// Roots whose no-activate bit this host added, with the holds still needing
/// it. Only the last holder clears the bit, so overlapping holds on one root
/// never expose it while another still relies on it.
static HOLDERS: Mutex<BTreeMap<Wid, usize>> = Mutex::new(BTreeMap::new());

/// HoldInactive on `root` (:76-118): the root this hold counts against, 0 when
/// there is nothing to release, and whether the hold was refused or unledgered.
fn hold(holders: &mut BTreeMap<Wid, usize>, styles: &dyn Styles, root: Wid) -> (Wid, bool) {
    if let Some(count) = holders.get_mut(&root) {
        *count += 1;
        return (root, false);
    }
    if root == styles.foreground() || styles.ex_style(root) & WS_EX_NOACTIVATE != 0 {
        return (0, false);
    }
    // Recorded before the write: a kill between the two leaves a harmless
    // entry. A bit that cannot be recorded is never written, since a killed
    // host could not have it cleared; delivery goes on unprotected instead.
    if !styles.record(true, root) {
        return (0, true);
    }
    styles.set_ex_style(root, styles.ex_style(root) | WS_EX_NOACTIVATE);
    if styles.ex_style(root) & WS_EX_NOACTIVATE == 0 {
        styles.record(false, root);
        return (0, true);
    }
    holders.insert(root, 1);
    (root, false)
}

/// ReleaseInactive (:120-149): the last holder clears the bit and reads it
/// back; a bit that stays set stays counted so a later release can retry.
fn release(
    holders: &mut BTreeMap<Wid, usize>,
    styles: &dyn Styles,
    root: Wid,
) -> Result<(), String> {
    let Some(count) = holders.get_mut(&root) else {
        return Ok(());
    };
    if *count > 1 {
        *count -= 1;
        return Ok(());
    }
    if !styles.is_window(root) {
        // The window is gone and its style with it.
        holders.remove(&root);
        styles.record(false, root);
        return Ok(());
    }
    styles.set_ex_style(root, styles.ex_style(root) & !WS_EX_NOACTIVATE);
    if styles.ex_style(root) & WS_EX_NOACTIVATE != 0 {
        *count = 0;
        return Err(
            "input_cleanup_unconfirmed: the background target could not be made activatable again"
                .into(),
        );
    }
    holders.remove(&root);
    styles.record(false, root);
    Ok(())
}

fn inactive_root(handle: Wid) -> Wid {
    if !native::is_window(handle) {
        return 0;
    }
    match native::root_of(handle) {
        0 => handle,
        root => root,
    }
}

/// Background input must not raise its target over the window the person is
/// in: a no-activate top level declines activation while the click, key or
/// accessibility call still lands. Returns the root to release, or 0 when
/// there is nothing to release (already foreground or non-activatable, or the
/// window refused the style or the ledger could not record it).
pub fn hold_inactive(handle: Wid) -> Wid {
    let root = inactive_root(handle);
    if root == 0 {
        return 0;
    }
    let mut holders = HOLDERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (held, unprotected) = hold(&mut holders, &Live, root);
    if unprotected {
        UNPROTECTED.store(true, Ordering::SeqCst);
    }
    held
}

/// Ends one hold; the last holder clears the bit and reads it back.
pub fn release_inactive(root: Wid) -> Result<(), String> {
    if root == 0 {
        return Ok(());
    }
    let mut holders = HOLDERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    release(&mut holders, &Live, root)
}

/// Whether a hold this request asked for went unledgered or was refused;
/// reading it clears it (the request loop's reset and read of
/// ActivationUnprotected, runtime.ps1:225).
pub(super) fn take_activation_unprotected() -> bool {
    UNPROTECTED.swap(false, Ordering::SeqCst)
}

/// One open scope: a hold kept across several deliveries (InactiveScope).
struct Scope {
    top: Wid,
    root: Wid,
    held: Wid,
    foreground_before: Wid,
    /// The person's input count when the scope began, the observer's
    /// generation then, and whether it was observing (Read().Ready: false
    /// also on an input gap or an unresponsive monitor).
    input_before: i64,
    generation: String,
    ready: bool,
}

/// The open scopes, innermost last (inactiveScopes, :36-37).
static SCOPES: Mutex<Vec<Scope>> = Mutex::new(Vec::new());

fn scopes() -> MutexGuard<'static, Vec<Scope>> {
    SCOPES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_scoped(open: &[Scope], root: Wid) -> bool {
    root != 0 && open.iter().any(|scope| scope.root == root)
}

/// The innermost scope opened for `top`, taken out of the list.
fn take_scope(open: &mut Vec<Scope>, top: Wid) -> Option<Scope> {
    let at = open.iter().rposition(|scope| scope.top == top)?;
    Some(open.remove(at))
}

/// RunInactiveRecovery (:199-216): the restore attempts made. Each attempt
/// first re-checks that the target still holds the foreground; a restore
/// refused for the person's input ends recovery without another attempt.
fn run_recovery(
    mut target_holds_foreground: impl FnMut() -> bool,
    mut guarded_restore: impl FnMut() -> Result<(), String>,
    mut sleep: impl FnMut(u64),
) -> Result<u32, String> {
    let mut attempts = 0;
    for attempt in 0..2 {
        if attempt > 0 {
            sleep(RESTORE_GAP_MS);
        }
        if !target_holds_foreground() {
            break;
        }
        attempts += 1;
        if let Err(error) = guarded_restore() {
            // The person moved: the desktop is theirs, so nothing is restored.
            if error.starts_with("user_input_active")
                || error.starts_with("input_observation_unavailable")
            {
                break;
            }
            return Err(error);
        }
    }
    Ok(attempts)
}

/// Whether recovery has nothing to give back: the person was already in the
/// target itself (a sibling of the same process is theirs, so a steal from it
/// is restored) or the observer was not watching (InactiveRestoreSkipped,
/// :190-193; the not-ready return, :221).
fn recovery_skipped(root: Wid, before: Wid, ready: bool) -> bool {
    root == 0
        || !ready
        || !native::is_window(before)
        || before == root
        || native::root_of(before) == root
        || native::is_owned_by(before, root)
}

impl WinBackground {
    /// Runs one delivery with the target held inactive. Inside an open scope
    /// the delivery only holds; otherwise it is a scope of its own, so the
    /// settle and the foreground recovery run once after it (WhileInactive,
    /// :260-274).
    pub fn while_inactive<T>(
        &self,
        top: Wid,
        deliver: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if is_scoped(&scopes(), inactive_root(top)) {
            let held = hold_inactive(top);
            let outcome = deliver();
            let released = release_inactive(held);
            // The release in C#'s finally throws over the delivery's error: a
            // bit left set (input_cleanup_unconfirmed) is never hidden.
            released?;
            return outcome;
        }
        self.begin_inactive_scope(top)?;
        let outcome = deliver();
        let ended = self.end_inactive_scope(top);
        ended?;
        outcome
    }

    /// A target that refused the style, or raised itself anyway, gives the
    /// person's window back (RecoverInactiveForeground, :218-237).
    fn recover_foreground(&self, scope: &Scope) -> Result<(), String> {
        let (root, before) = (scope.root, scope.foreground_before);
        if recovery_skipped(root, before, scope.ready) {
            return Ok(());
        }
        run_recovery(
            || {
                let current = native::foreground();
                current == root
                    || native::root_of(current) == root
                    || native::is_owned_by(current, root)
                    || native::shares_process(current, root)
            },
            || {
                // Each try runs under BeginExpected + AssertContinue: input, a
                // gap or a lost observer since the scope began stops it.
                let mut guard = crate::observer::Scope::default();
                guard.begin_expected(&self.shared, &scope.generation, scope.input_before)?;
                let allowed = guard.assert_continue(&self.shared);
                if allowed.is_ok() {
                    // One activation try per attempt: a focus that retried would
                    // relax the foreground lock with no input check in between.
                    native::try_focus_attached(before);
                }
                guard.end();
                allowed
            },
            |ms| std::thread::sleep(Duration::from_millis(ms)),
        )
        .map(|_| ())
    }

    /// Opens a scope that keeps `top`'s root inactive across deliveries
    /// (BeginInactive, :153-167); scopes nest.
    pub(super) fn begin_inactive_scope(&self, top: Wid) -> Result<(), String> {
        let observed = self.shared.read();
        let scope = Scope {
            top,
            root: inactive_root(top),
            foreground_before: native::foreground(),
            input_before: observed.sequence,
            generation: observed.generation,
            ready: observed.ready,
            held: hold_inactive(top),
        };
        scopes().push(scope);
        Ok(())
    }

    /// Closes the innermost scope opened for `top`: settles, recovers the
    /// foreground once, then releases (EndInactive, :169-197). A scope not
    /// open is left alone.
    pub(super) fn end_inactive_scope(&self, top: Wid) -> Result<(), String> {
        let Some(scope) = take_scope(&mut scopes(), top) else {
            return Ok(());
        };
        std::thread::sleep(Duration::from_millis(SETTLE_MS));
        let recovered = self.recover_foreground(&scope);
        let released = release_inactive(scope.held);
        released?;
        recovered
    }

    /// Holds `window` inactive past one call, for a pointer button left down
    /// (input-pointer.ps1:93-114 HoldInactive): the root to release, 0 when
    /// there is nothing to release. The hold counts beside the press call's own
    /// scope, so the call's end never clears the bit.
    pub(super) fn hold_past_call(&self, window: Wid) -> Result<Wid, String> {
        Ok(hold_inactive(window))
    }

    /// Ends a hold `hold_past_call` took (ReleaseInactive).
    pub(super) fn release_past_call(&self, root: Wid) -> Result<(), String> {
        release_inactive(root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// One window's style, with a switch for a window that refuses the bit
    /// and one for a ledger that cannot be written.
    struct Fake {
        foreground: Wid,
        style: Cell<i32>,
        refuses: bool,
        ledgered: bool,
        log: RefCell<Vec<(bool, Wid)>>,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                foreground: 99,
                style: Cell::new(0),
                refuses: false,
                ledgered: true,
                log: RefCell::new(Vec::new()),
            }
        }
        fn bit(&self) -> bool {
            self.style.get() & WS_EX_NOACTIVATE != 0
        }
    }

    impl Styles for Fake {
        fn foreground(&self) -> Wid {
            self.foreground
        }
        fn is_window(&self, _: Wid) -> bool {
            true
        }
        fn ex_style(&self, _: Wid) -> i32 {
            self.style.get()
        }
        fn set_ex_style(&self, _: Wid, style: i32) {
            if !self.refuses || style & WS_EX_NOACTIVATE == 0 {
                self.style.set(style);
            }
        }
        fn record(&self, added: bool, root: Wid) -> bool {
            if self.ledgered {
                self.log.borrow_mut().push((added, root));
            }
            self.ledgered
        }
    }

    #[test]
    fn overlapping_holds_clear_the_bit_only_with_the_last_holder() {
        let (fake, mut holders) = (Fake::new(), BTreeMap::new());
        assert_eq!(hold(&mut holders, &fake, 1), (1, false));
        assert!(fake.bit());
        assert_eq!(
            hold(&mut holders, &fake, 1),
            (1, false),
            "an overlapping hold counts against the same root"
        );
        release(&mut holders, &fake, 1).unwrap();
        assert!(fake.bit(), "kept while another holder needs it");
        release(&mut holders, &fake, 1).unwrap();
        assert!(!fake.bit());
        release(&mut holders, &fake, 1).unwrap();
        assert!(!fake.bit(), "a spare release changes nothing");
        assert_eq!(
            *fake.log.borrow(),
            [(true, 1), (false, 1)],
            "recorded before the write and after the clear"
        );
    }

    #[test]
    fn a_needless_hold_is_not_an_unprotected_one() {
        let mut fake = Fake::new();
        let mut holders = BTreeMap::new();
        fake.foreground = 1;
        assert_eq!(
            hold(&mut holders, &fake, 1),
            (0, false),
            "the foreground needs no bit"
        );
        fake.foreground = 99;
        fake.style.set(WS_EX_NOACTIVATE);
        assert_eq!(
            hold(&mut holders, &fake, 1),
            (0, false),
            "a bit someone else set is not needed"
        );
        release(&mut holders, &fake, 0).unwrap();
        assert!(fake.bit(), "and it stays");
    }

    #[test]
    fn a_refused_style_is_taken_back_out_of_the_ledger_and_reported() {
        let mut fake = Fake::new();
        fake.refuses = true;
        let mut holders = BTreeMap::new();
        assert_eq!(hold(&mut holders, &fake, 1), (0, true));
        assert!(holders.is_empty());
        assert_eq!(*fake.log.borrow(), [(true, 1), (false, 1)]);
    }

    #[test]
    fn a_bit_the_ledger_cannot_record_is_never_written() {
        let mut fake = Fake::new();
        fake.ledgered = false;
        let mut holders = BTreeMap::new();
        assert_eq!(hold(&mut holders, &fake, 1), (0, true));
        assert!(!fake.bit());
        assert!(holders.is_empty());
    }

    #[test]
    fn a_bit_that_stays_set_is_a_cleanup_failure_kept_for_retry() {
        // The target sets the bit again after every clear.
        struct Sticky<'a>(&'a Fake);
        impl Styles for Sticky<'_> {
            fn foreground(&self) -> Wid {
                self.0.foreground()
            }
            fn is_window(&self, root: Wid) -> bool {
                self.0.is_window(root)
            }
            fn ex_style(&self, root: Wid) -> i32 {
                self.0.ex_style(root)
            }
            fn set_ex_style(&self, _: Wid, _: i32) {}
            fn record(&self, added: bool, root: Wid) -> bool {
                self.0.record(added, root)
            }
        }
        let fake = Fake::new();
        let mut holders = BTreeMap::new();
        hold(&mut holders, &fake, 1);
        let error = release(&mut holders, &Sticky(&fake), 1).unwrap_err();
        assert!(error.starts_with("input_cleanup_unconfirmed"));
        assert_eq!(holders.get(&1), Some(&0), "still recorded");
        release(&mut holders, &fake, 1).unwrap();
        assert!(holders.is_empty() && !fake.bit());
    }

    fn scope(top: Wid, root: Wid) -> Scope {
        Scope {
            top,
            root,
            held: 0,
            foreground_before: 0,
            input_before: 0,
            generation: String::new(),
            ready: true,
        }
    }

    #[test]
    fn scopes_nest_and_end_innermost_first() {
        let mut open = vec![scope(1, 1)];
        assert!(is_scoped(&open, 1));
        assert!(!is_scoped(&open, 2) && !is_scoped(&open, 0));
        open.push(scope(1, 1));
        open.push(scope(2, 2));
        assert_eq!(take_scope(&mut open, 1).map(|scope| scope.root), Some(1));
        assert!(
            is_scoped(&open, 1),
            "the outer scope on the root stays open"
        );
        assert!(take_scope(&mut open, 1).is_some());
        assert!(!is_scoped(&open, 1) && is_scoped(&open, 2));
        assert!(
            take_scope(&mut open, 1).is_none(),
            "a scope not open is left alone"
        );
    }

    #[test]
    fn recovery_makes_two_attempts_a_gap_apart() {
        let (tries, gaps) = (Cell::new(0), RefCell::new(Vec::new()));
        let attempts = run_recovery(
            || true,
            || {
                tries.set(tries.get() + 1);
                Ok(())
            },
            |ms| gaps.borrow_mut().push(ms),
        );
        assert_eq!((attempts, tries.get()), (Ok(2), 2));
        assert_eq!(*gaps.borrow(), [12]);
    }

    #[test]
    fn recovery_stops_when_the_target_let_go_or_the_person_moved() {
        let tries = Cell::new(0);
        let held = Cell::new(true);
        let attempts = run_recovery(
            || held.replace(false),
            || {
                tries.set(tries.get() + 1);
                Ok(())
            },
            |_| {},
        );
        assert_eq!(
            (attempts, tries.get()),
            (Ok(1), 1),
            "the second attempt finds the foreground given back"
        );
        tries.set(0);
        let attempts = run_recovery(
            || true,
            || {
                tries.set(tries.get() + 1);
                Err("user_input_active: moved".into())
            },
            |_| {},
        );
        assert_eq!((attempts, tries.get()), (Ok(1), 1));
        let attempts = run_recovery(
            || true,
            || Err("input_observation_unavailable: no".into()),
            |_| {},
        );
        assert_eq!(attempts, Ok(1));
        assert_eq!(
            run_recovery(|| true, || Err("other".into()), |_| {}),
            Err("other".to_string())
        );
        assert_eq!(
            run_recovery(|| false, || Err("never".into()), |_| {}),
            Ok(0)
        );
    }

    #[test]
    fn nothing_is_recovered_when_the_observer_was_not_ready() {
        assert!(recovery_skipped(5, 7, false));
        assert!(recovery_skipped(0, 7, true));
    }
}
