//! The one restore of the person's window after a target took the foreground
//! (Test-RestoreBaseline, Restore-UserForeground and Test-TargetWindow,
//! input-semantic.ps1:143-194; RestoreForeground, MixWin32Foreground.cs:97-103).
//! activation-guard calls `restore` when its watch sees the steal.

use super::native;
use crate::observer::{Scope, Shared};
use crate::platform::Wid;
use std::cell::RefCell;

/// How the restore ended, as the `restore` fact reads.
#[derive(Debug, PartialEq)]
pub enum RestoreOutcome {
    Restored,
    /// The one activation try did not bring the person's window forward.
    Refused,
    /// Why the person's window was left alone.
    Skipped(String),
}

impl RestoreOutcome {
    pub fn as_text(&self) -> String {
        match self {
            RestoreOutcome::Restored => "restored".into(),
            RestoreOutcome::Refused => "refused".into(),
            RestoreOutcome::Skipped(reason) => format!("skipped:{reason}"),
        }
    }
}

/// What the restore asks of the desktop, so its decisions run on a fake.
trait Ground {
    /// BeginRestore on the observation the delivery began under; the error is
    /// the observer's own refusal text.
    fn begin(&self) -> Result<(), String>;
    fn end(&self);
    fn window_exists(&self) -> bool;
    /// Test-TargetWindow on the current foreground.
    fn target_in_front(&self) -> bool;
    /// One activation try with no retry, sleep or lock-timeout change.
    fn focus(&self) -> bool;
}

/// The code of an observer refusal, which is all a skip reports.
fn refusal_code(error: &str) -> String {
    error.split(':').next().unwrap_or(error).trim().to_string()
}

/// Test-RestoreBaseline: the code of the observer's refusal when the
/// observation the delivery began under no longer licenses a restore.
fn baseline(ground: &impl Ground) -> Option<String> {
    match ground.begin() {
        Ok(()) => {
            ground.end();
            None
        }
        Err(error) => Some(refusal_code(&error)),
    }
}

/// Restore-UserForeground, after Test-RestoreBaseline. The lock comes off
/// first, whatever else happens, so it cannot refuse the restore too;
/// `release` says how that ended (released, failed, unknown, none or no_ack).
/// The restore runs only if that release neither failed nor went unanswered,
/// the observation still holds, the person's window still exists and the
/// target, not a third window, is in front. No retry.
fn run(ground: &impl Ground, release: &mut dyn FnMut() -> String) -> RestoreOutcome {
    let baseline = baseline(ground);
    let released = release();
    if let Some(reason) = baseline {
        return RestoreOutcome::Skipped(reason);
    }
    if released == "failed" || released == "no_ack" {
        return RestoreOutcome::Skipped(format!("release_{released}"));
    }
    if !ground.window_exists() {
        return RestoreOutcome::Skipped("window_gone".into());
    }
    if let Err(error) = ground.begin() {
        return RestoreOutcome::Skipped(refusal_code(&error));
    }
    let outcome = if !ground.target_in_front() {
        RestoreOutcome::Skipped("foreground_moved".into())
    } else if ground.focus() {
        RestoreOutcome::Restored
    } else {
        RestoreOutcome::Refused
    };
    ground.end();
    outcome
}

/// Test-TargetWindow: the target itself, a window inside it, or one it owns or
/// hosts in its process.
pub fn is_target_window(window: Wid, target: Wid) -> bool {
    target != 0
        && (window == target
            || native::root_of(window) == target
            || native::is_contained_same_process(window, target)
            || native::is_owned_by(window, target))
}

struct Desktop<'a> {
    shared: &'a Shared,
    generation: &'a str,
    sequence: i64,
    target: Wid,
    before: Wid,
    scope: RefCell<Scope>,
}

impl Ground for Desktop<'_> {
    fn begin(&self) -> Result<(), String> {
        self.scope.borrow_mut().begin_restore(
            self.shared,
            self.generation,
            self.sequence,
            native::pid_of(self.target),
        )
    }
    fn end(&self) {
        self.scope.borrow_mut().end();
    }
    fn window_exists(&self) -> bool {
        native::is_window(self.before)
    }
    fn target_in_front(&self) -> bool {
        is_target_window(native::foreground(), self.target)
    }
    /// RestoreForeground: a handle gone by now is not tried.
    fn focus(&self) -> bool {
        native::is_window(self.before) && native::try_focus_attached(self.before)
    }
}

/// Test-RestoreBaseline on its own, for the guard's check once the lock is
/// granted (input-semantic.ps1:76-82).
pub fn superseded(shared: &Shared, generation: &str, sequence: i64, target: Wid) -> Option<String> {
    baseline(&desktop(shared, generation, sequence, target, 0))
}

fn desktop<'a>(
    shared: &'a Shared,
    generation: &'a str,
    sequence: i64,
    target: Wid,
    before: Wid,
) -> Desktop<'a> {
    Desktop {
        shared,
        generation,
        sequence,
        target,
        before,
        scope: RefCell::new(Scope::default()),
    }
}

/// Puts `before`, the person's window, back after `target` took the
/// foreground, once. `generation` and `sequence` are the input observation the
/// delivery began under; `release` ends the foreground lock first.
pub fn restore(
    shared: &Shared,
    generation: &str,
    sequence: i64,
    target: Wid,
    before: Wid,
    release: &mut dyn FnMut() -> String,
) -> RestoreOutcome {
    run(&desktop(shared, generation, sequence, target, before), release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A scripted desktop; `begins` answers each BeginRestore in turn.
    struct Fake {
        begins: RefCell<Vec<Result<(), String>>>,
        exists: bool,
        in_front: bool,
        focused: bool,
        log: RefCell<Vec<&'static str>>,
        tries: Cell<u32>,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                begins: RefCell::new(vec![Ok(()), Ok(())]),
                exists: true,
                in_front: true,
                focused: true,
                log: RefCell::new(Vec::new()),
                tries: Cell::new(0),
            }
        }
    }

    impl Ground for Fake {
        fn begin(&self) -> Result<(), String> {
            self.log.borrow_mut().push("begin");
            self.begins.borrow_mut().remove(0)
        }
        fn end(&self) {
            self.log.borrow_mut().push("end");
        }
        fn window_exists(&self) -> bool {
            self.exists
        }
        fn target_in_front(&self) -> bool {
            self.in_front
        }
        fn focus(&self) -> bool {
            self.tries.set(self.tries.get() + 1);
            self.focused
        }
    }

    fn outcome(fake: &Fake, released: &str) -> String {
        run(fake, &mut || released.to_string()).as_text()
    }

    #[test]
    fn a_clean_restore_tries_exactly_once() {
        let fake = Fake::new();
        assert_eq!(outcome(&fake, "released"), "restored");
        assert_eq!(fake.tries.get(), 1);
        assert_eq!(*fake.log.borrow(), ["begin", "end", "begin", "end"]);
    }

    #[test]
    fn an_unknown_or_absent_release_still_restores() {
        for released in ["unknown", "none"] {
            assert_eq!(outcome(&Fake::new(), released), "restored");
        }
    }

    #[test]
    fn a_failed_or_unanswered_release_skips() {
        for released in ["failed", "no_ack"] {
            let fake = Fake::new();
            assert_eq!(outcome(&fake, released), format!("skipped:release_{released}"));
            assert_eq!(fake.tries.get(), 0);
        }
    }

    #[test]
    fn input_since_the_observation_skips_and_still_releases() {
        for (message, code) in [
            (
                "user_input_active: observation was superseded by external input",
                "user_input_active",
            ),
            (
                "input_observation_unavailable: original observation is unavailable",
                "input_observation_unavailable",
            ),
        ] {
            let fake = Fake::new();
            fake.begins.borrow_mut()[0] = Err(message.into());
            let mut released = false;
            let outcome = run(&fake, &mut || {
                released = true;
                "released".into()
            });
            assert_eq!(outcome.as_text(), format!("skipped:{code}"));
            assert!(released);
            assert_eq!(fake.tries.get(), 0);
        }
    }

    #[test]
    fn input_during_the_release_skips() {
        let fake = Fake::new();
        fake.begins.borrow_mut()[1] =
            Err("user_input_active: external input interrupted this action".into());
        assert_eq!(outcome(&fake, "released"), "skipped:user_input_active");
        assert_eq!(fake.tries.get(), 0);
    }

    #[test]
    fn a_gone_window_or_a_third_window_skips() {
        let mut fake = Fake::new();
        fake.exists = false;
        assert_eq!(outcome(&fake, "released"), "skipped:window_gone");
        let mut fake = Fake::new();
        fake.in_front = false;
        assert_eq!(outcome(&fake, "released"), "skipped:foreground_moved");
        assert_eq!(fake.tries.get(), 0);
        assert_eq!(fake.log.borrow().last(), Some(&"end"));
    }

    #[test]
    fn a_window_that_stays_back_is_refused_without_a_retry() {
        let mut fake = Fake::new();
        fake.focused = false;
        assert_eq!(outcome(&fake, "released"), "refused");
        assert_eq!(fake.tries.get(), 1);
    }
}
